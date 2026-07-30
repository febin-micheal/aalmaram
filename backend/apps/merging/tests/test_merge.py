"""Merging and un-merging.

The Phase 1 acceptance check is strict: un-merging must restore the *exact* prior state.
`full_state()` below serialises every row that a merge can touch — field values and
timestamps included — so the reversibility tests compare reality rather than a summary.
"""

import pytest
from django.contrib.auth import get_user_model

from apps.claims.models import Claim, Predicate
from apps.genealogy.factories import make_person, make_union
from apps.genealogy.graph import traversal
from apps.genealogy.models import Person, PersonStatus, Union, UnionMembership
from apps.mediastore.models import MediaItem, MediaType
from apps.merging.models import CandidateStatus, MergeCandidate
from apps.merging.services import MergeError, merge_persons, unmerge

pytestmark = pytest.mark.django_db


def full_state():
    """Every row a merge can touch, in a stable, comparable form.

    MergeRecord itself is excluded: it is the audit trail of the merge and is *meant* to
    outlive an un-merge.
    """
    return {
        "persons": _dump(Person.objects.order_by("id")),
        "unions": _dump(Union.objects.order_by("id")),
        "memberships": _dump(UnionMembership.objects.order_by("id")),
        "claims": _dump(Claim.objects.order_by("id")),
        "media_tags": sorted(
            (str(item.pk), sorted(str(p.pk) for p in item.persons.all()))
            for item in MediaItem.objects.all()
        ),
        "anchors": sorted(
            (str(pk), str(anchor) if anchor else None)
            for pk, anchor in get_user_model().objects.values_list("pk", "anchor_person_id")
        ),
    }


def _dump(queryset):
    # Raw column values, not a JSON round-trip: a serializer that truncates timestamps
    # on the way out would hide exactly the kind of drift these tests exist to catch.
    return list(queryset.values())


def names(links):
    return {link.person.display_name for link in links}


# ------------------------------------------------------------------- merging


def test_merge_marks_the_absorbed_person_without_deleting_it(duplicate_pair):
    merge_persons(duplicate_pair.primary, duplicate_pair.duplicate)

    absorbed = Person.objects.get(pk=duplicate_pair.duplicate.pk)
    assert absorbed.status == PersonStatus.MERGED_INTO
    assert absorbed.merged_into_id == duplicate_pair.primary.pk
    assert absorbed.canonical_id == duplicate_pair.primary.pk
    assert absorbed not in Person.objects.canonical()


def test_merge_moves_the_edges_to_the_canonical_person(duplicate_pair):
    merge_persons(duplicate_pair.primary, duplicate_pair.duplicate)

    primary = Person.objects.get(pk=duplicate_pair.primary.pk)
    # The duplicate's union with an unrecorded wife now belongs to the survivor.
    assert names(traversal.children(primary)) == {"Jacob", "Annie"}
    assert names(traversal.partners(primary)) == {"Mariamma"}
    assert names(traversal.parents(duplicate_pair.daughter)) == {"Ouseph"}


def test_merge_resolves_the_duplicate_child_membership(duplicate_pair):
    """Both rows were children of the same union — repointing would break uniqueness."""
    memberships = UnionMembership.objects.filter(union=duplicate_pair.u_birth, role="child")
    assert memberships.count() == 3

    merge_persons(duplicate_pair.primary, duplicate_pair.duplicate)

    remaining = set(memberships.values_list("person_id", flat=True))
    assert remaining == {duplicate_pair.sister.pk, duplicate_pair.primary.pk}
    assert names(traversal.siblings(duplicate_pair.primary)) == {"Aleyamma"}


def test_merge_fills_blanks_from_the_absorbed_record(duplicate_pair):
    merge_persons(duplicate_pair.primary, duplicate_pair.duplicate)

    primary = Person.objects.get(pk=duplicate_pair.primary.pk)
    assert primary.name_en == "Ouseph"  # the survivor's own value is never overwritten
    assert primary.name_ml == "ഔസേഫ്"  # but the Malayalam spelling only one of them had
    assert set(primary.nicknames) == {"Outha", "Ousepachan"}


def test_merge_repoints_claims_and_media_and_anchors(duplicate_pair):
    person_claim = Claim.objects.create(
        subject=duplicate_pair.duplicate,
        predicate=Predicate.HOUSE_NAME,
        value={"text": "Vazhakkunnathil"},
    )
    photo = MediaItem.objects.create(media_type=MediaType.PHOTO, caption="Family group")
    photo.persons.add(duplicate_pair.duplicate)
    member = get_user_model().objects.create_user(
        email="member@example.invalid", password="x", anchor_person=duplicate_pair.duplicate
    )

    merge_persons(duplicate_pair.primary, duplicate_pair.duplicate)

    person_claim.refresh_from_db()
    member.refresh_from_db()
    assert person_claim.subject_id == duplicate_pair.primary.pk
    assert list(photo.persons.all()) == [duplicate_pair.primary]
    assert member.anchor_person_id == duplicate_pair.primary.pk


def test_merging_closes_the_candidate(duplicate_pair):
    candidate = MergeCandidate.objects.create(
        person_a=duplicate_pair.primary, person_b=duplicate_pair.duplicate, score=0.9
    )
    record = merge_persons(duplicate_pair.primary, duplicate_pair.duplicate, candidate=candidate)

    candidate.refresh_from_db()
    assert candidate.status == CandidateStatus.MERGED
    assert record.candidate_id == candidate.pk


def test_merge_records_who_did_it(duplicate_pair):
    arbiter = get_user_model().objects.create_user(email="arbiter@example.invalid", password="x")
    record = merge_persons(duplicate_pair.primary, duplicate_pair.duplicate, performed_by=arbiter)
    assert record.performed_by == arbiter
    assert record.performed_at is not None
    assert not record.is_reverted


# ----------------------------------------------------------------- un-merging


def test_unmerge_restores_exact_prior_state(duplicate_pair):
    """The Phase 1 acceptance check, stated literally."""
    before = full_state()

    record = merge_persons(duplicate_pair.primary, duplicate_pair.duplicate)
    assert full_state() != before

    unmerge(record)
    assert full_state() == before


def test_unmerge_restores_exact_prior_state_with_claims_media_and_anchors(duplicate_pair):
    Claim.objects.create(
        subject=duplicate_pair.duplicate, predicate=Predicate.BIRTH_YEAR, value={"year": 1930}
    )
    photo = MediaItem.objects.create(media_type=MediaType.PHOTO, caption="Wedding")
    photo.persons.add(duplicate_pair.duplicate, duplicate_pair.sister)
    get_user_model().objects.create_user(
        email="member@example.invalid", password="x", anchor_person=duplicate_pair.duplicate
    )
    before = full_state()

    record = merge_persons(duplicate_pair.primary, duplicate_pair.duplicate)
    unmerge(record)

    assert full_state() == before


def test_unmerge_restores_the_deleted_membership_with_its_original_id(duplicate_pair):
    original = UnionMembership.objects.get(
        union=duplicate_pair.u_birth, person=duplicate_pair.duplicate, role="child"
    )
    record = merge_persons(duplicate_pair.primary, duplicate_pair.duplicate)
    assert not UnionMembership.objects.filter(pk=original.pk).exists()

    unmerge(record)

    restored = UnionMembership.objects.get(pk=original.pk)
    assert restored.person_id == duplicate_pair.duplicate.pk
    assert restored.sibling_order == original.sibling_order
    assert restored.relation_type == original.relation_type
    assert restored.created_at == original.created_at


def test_unmerge_marks_the_record_and_reopens_the_candidate(duplicate_pair):
    candidate = MergeCandidate.objects.create(
        person_a=duplicate_pair.primary, person_b=duplicate_pair.duplicate, score=0.8
    )
    arbiter = get_user_model().objects.create_user(email="arbiter@example.invalid", password="x")
    record = merge_persons(duplicate_pair.primary, duplicate_pair.duplicate, candidate=candidate)

    record = unmerge(record, performed_by=arbiter)

    assert record.is_reverted
    assert record.reverted_by == arbiter
    candidate.refresh_from_db()
    assert candidate.status == CandidateStatus.OPEN


def test_unmerge_restores_traversal(duplicate_pair):
    record = merge_persons(duplicate_pair.primary, duplicate_pair.duplicate)
    unmerge(record)

    assert names(traversal.children(duplicate_pair.primary)) == {"Jacob"}
    assert names(traversal.children(duplicate_pair.duplicate)) == {"Annie"}
    assert names(traversal.siblings(duplicate_pair.primary)) == {"Aleyamma", "Yousef"}


def test_unmerging_twice_is_refused(duplicate_pair):
    record = merge_persons(duplicate_pair.primary, duplicate_pair.duplicate)
    unmerge(record)
    with pytest.raises(MergeError):
        unmerge(record)


def test_merge_and_unmerge_round_trips_repeatedly(duplicate_pair):
    before = full_state()
    for _ in range(3):
        record = merge_persons(duplicate_pair.primary, duplicate_pair.duplicate)
        unmerge(record)
    assert full_state() == before


# ------------------------------------------------------------------ guard rails


def test_a_person_cannot_be_merged_into_themselves(duplicate_pair):
    with pytest.raises(MergeError):
        merge_persons(duplicate_pair.primary, duplicate_pair.primary)


def test_an_already_merged_person_cannot_be_merged_again(duplicate_pair):
    merge_persons(duplicate_pair.primary, duplicate_pair.duplicate)
    third = make_person("Ouseph again", birth=1930)
    with pytest.raises(MergeError):
        merge_persons(third, duplicate_pair.duplicate)


def test_merging_an_ancestor_with_a_descendant_is_refused(family_a):
    """It would make Thomas his own grandfather, and the walk would loop."""
    with pytest.raises(MergeError):
        merge_persons(family_a.chacko, family_a.thomas)
    with pytest.raises(MergeError):
        merge_persons(family_a.thomas, family_a.chacko)


def test_unrelated_people_can_still_be_merged():
    """Duplicates usually share no edges at all when two contributors work apart."""
    one = make_person("Kunjumon", birth=1920)
    other = make_person("Kunjumon", birth=1921)
    make_union(one, children=[make_person("Child A", birth=1950)])
    make_union(other, children=[make_person("Child B", birth=1952)])

    record = merge_persons(one, other)
    assert names(traversal.children(one)) == {"Child A", "Child B"}

    unmerge(record)
    assert names(traversal.children(one)) == {"Child A"}


def test_chained_merges_keep_one_hop_resolution():
    """Merging B into A, then A into C, must leave B pointing at C, not at A."""
    first = make_person("Record One", birth=1900)
    second = make_person("Record Two", birth=1900)
    third = make_person("Record Three", birth=1900)

    merge_persons(first, second)
    merge_persons(third, first)

    second.refresh_from_db()
    assert second.merged_into_id == third.pk
    assert traversal.resolve_id(second.id) == third.pk
