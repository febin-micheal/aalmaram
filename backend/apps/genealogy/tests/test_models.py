"""Model-level guarantees: the constraints that keep the graph representable."""

import pytest
from django.db import IntegrityError, transaction

from apps.genealogy.factories import PersonFactory, make_person, make_union
from apps.genealogy.models import Gender, Person, PersonStatus, Role, UnionMembership

pytestmark = pytest.mark.django_db


def test_merged_status_requires_a_target():
    person = PersonFactory()
    person.status = PersonStatus.MERGED_INTO
    with pytest.raises(IntegrityError):
        with transaction.atomic():
            person.save()


def test_merged_target_requires_merged_status():
    survivor = PersonFactory()
    person = PersonFactory()
    person.merged_into = survivor
    with pytest.raises(IntegrityError):
        with transaction.atomic():
            person.save()


def test_person_cannot_be_merged_into_itself():
    person = PersonFactory()
    with pytest.raises(IntegrityError):
        with transaction.atomic():
            Person.objects.filter(pk=person.pk).update(
                status=PersonStatus.MERGED_INTO, merged_into=person
            )


def test_birth_year_range_must_be_ordered():
    with pytest.raises(IntegrityError):
        with transaction.atomic():
            PersonFactory(birth_year_min=1950, birth_year_max=1940)


def test_open_ended_birth_range_is_allowed():
    """ "Born some time after 1900, nobody knows when" has to be recordable."""
    person = PersonFactory(birth_year_min=1900, birth_year_max=None)
    assert person.birth_year_display == "≥1900"


def test_a_person_cannot_hold_the_same_role_twice_in_one_union():
    person = PersonFactory()
    union = make_union(person)
    with pytest.raises(IntegrityError):
        with transaction.atomic():
            UnionMembership.objects.create(union=union, person=person, role=Role.PARTNER)


def test_canonical_queryset_excludes_merged_and_tombstoned():
    live = PersonFactory()
    survivor = PersonFactory()
    merged = PersonFactory()
    Person.objects.filter(pk=merged.pk).update(
        status=PersonStatus.MERGED_INTO, merged_into=survivor
    )
    tombstoned = PersonFactory(status=PersonStatus.TOMBSTONE)

    canonical_ids = set(Person.objects.canonical().values_list("id", flat=True))
    assert {live.id, survivor.id} <= canonical_ids
    assert merged.id not in canonical_ids
    assert tombstoned.id not in canonical_ids
    # The rows are kept, not deleted — merges must stay reversible.
    assert Person.objects.filter(pk=merged.pk).exists()


def test_canonical_id_follows_the_merge_pointer():
    survivor = PersonFactory()
    merged = PersonFactory()
    Person.objects.filter(pk=merged.pk).update(
        status=PersonStatus.MERGED_INTO, merged_into=survivor
    )
    merged.refresh_from_db()
    assert merged.canonical_id == survivor.id
    assert merged.resolve_canonical() == survivor
    assert survivor.canonical_id == survivor.id


def test_display_name_falls_back_across_scripts():
    assert make_person("Thoma").display_name == "Thoma"
    assert PersonFactory(name_en="", name_ml="തോമ്മാ").display_name == "തോമ്മാ"
    anonymous = PersonFactory(name_en="", name_ml="")
    assert anonymous.display_name.startswith("Unnamed")


def test_lifespan_display_handles_uncertainty():
    dead = make_person(
        "Ittira", gender=Gender.MALE, birth=1890, death_year_min=1960, death_year_max=1965
    )
    assert dead.birth_year_display == "1888–1892"
    assert dead.death_year_display == "1960–1965"
    assert dead.lifespan_display == "1888–1892–1960–1965"

    living = make_person("Kiran", birth=2022, living=True)
    assert living.lifespan_display.endswith("–")

    unknown = PersonFactory(name_en="Nobody knows")
    assert unknown.birth_year_display == ""


def test_birth_year_estimate_prefers_exact_then_midpoint():
    import datetime

    exact = PersonFactory(birth_date_exact=datetime.date(1943, 4, 2))
    assert exact.birth_year_estimate == 1943
    ranged = PersonFactory(birth_year_min=1940, birth_year_max=1950)
    assert ranged.birth_year_estimate == 1945
    one_sided = PersonFactory(birth_year_min=1940)
    assert one_sided.birth_year_estimate == 1940
    assert PersonFactory().birth_year_estimate is None


def test_search_matches_both_scripts_nicknames_and_house():
    target = PersonFactory(
        name_en="Ouseph", name_ml="ഔസേഫ്", nicknames=["Outha"], house_name="Vazhakkunnathil"
    )
    PersonFactory(name_en="Unrelated")

    for term in ["Ouse", "ഔസേ", "Outha", "Vazhak"]:
        assert list(Person.objects.search(term)) == [target], f"search failed for {term!r}"
