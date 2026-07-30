"""The ego-centric endpoints: who I am, and how everyone relates to a chosen focus.

The load-bearing test here is the query count. Labelling a screenful of cards is the whole
feature, and doing it pair-by-pair would be several hundred round trips that get repeated
every time the focus changes — fast enough on a fixture family, unusable on a real one.
So the count is pinned, and pinned again at a larger size to prove it does not grow.
"""

import uuid

import pytest
from django.contrib.auth import get_user_model

from apps.genealogy.factories import make_person, make_union
from apps.genealogy.graph import MAX_TARGETS, naming
from apps.genealogy.models import Person

pytestmark = pytest.mark.django_db

ME_URL = "/api/v1/me/"
ANCHOR_URL = "/api/v1/me/anchor/"
BULK_URL = "/api/v1/relate-bulk/"

PERSON_FIELDS = {
    "id",
    "name_en",
    "name_ml",
    "display_name",
    "house_name",
    "gender",
    "is_living",
    "birth_display",
    "death_display",
    "lifespan_compact",
    "place_origin",
}
RESULT_FIELDS = {
    "labels",
    "kind",
    "degree",
    "up_subject",
    "up_other",
    "half",
    "step",
    "common_ancestors",
}
FORBIDDEN = {"notes", "created_by", "password", "email", "is_superuser"}


@pytest.fixture
def staff_client(client):
    staff = get_user_model().objects.create_user(
        email="owner@example.invalid", password="secret-x", is_staff=True
    )
    client.force_login(staff)
    client.user = staff
    return client


def bulk(staff_client, subject, targets):
    return staff_client.get(
        BULK_URL, {"from": str(subject.pk), "to": ",".join(str(t.pk) for t in targets)}
    )


def labels(staff_client, subject, targets):
    payload = bulk(staff_client, subject, targets).json()["results"]
    return {
        t.display_name: (payload[str(t.pk)]["labels"] if payload[str(t.pk)] else None)
        for t in targets
    }


# ------------------------------------------------------------------ auth


@pytest.mark.parametrize("url", [ME_URL, BULK_URL])
def test_anonymous_is_refused(client, url, family_a):
    assert client.get(url).status_code == 403


def test_anonymous_cannot_set_an_anchor(client, family_a):
    response = client.patch(
        ANCHOR_URL, {"person_id": str(family_a.thomas.pk)}, content_type="application/json"
    )
    assert response.status_code == 403


def test_non_staff_is_refused(client, family_a):
    get_user_model().objects.create_user(email="m@example.invalid", password="secret-x")
    client.login(email="m@example.invalid", password="secret-x")
    assert client.get(ME_URL).status_code == 403


# --------------------------------------------------------------------- me


def test_me_starts_with_no_anchor(staff_client):
    payload = staff_client.get(ME_URL).json()
    assert set(payload) == {"id", "anchor_person"}
    assert payload["anchor_person"] is None


def test_setting_an_anchor_and_reading_it_back(staff_client, family_a):
    response = staff_client.patch(
        ANCHOR_URL, {"person_id": str(family_a.jose.pk)}, content_type="application/json"
    )
    assert response.status_code == 200
    assert response.json()["anchor_person"]["display_name"] == "Jose"

    # It persists — a reload restores "me" rather than asking again.
    assert staff_client.get(ME_URL).json()["anchor_person"]["id"] == str(family_a.jose.pk)
    staff_client.user.refresh_from_db()
    assert staff_client.user.anchor_person_id == family_a.jose.pk


def test_the_anchor_payload_is_a_plain_person(staff_client, family_a):
    staff_client.patch(
        ANCHOR_URL, {"person_id": str(family_a.jose.pk)}, content_type="application/json"
    )
    assert set(staff_client.get(ME_URL).json()["anchor_person"]) == PERSON_FIELDS


def test_me_never_leaks_account_fields(staff_client, family_a):
    Person.objects.filter(pk=family_a.jose.pk).update(notes="private working note")
    staff_client.patch(
        ANCHOR_URL, {"person_id": str(family_a.jose.pk)}, content_type="application/json"
    )
    body = staff_client.get(ME_URL).content.decode()

    assert "private working note" not in body
    for field in FORBIDDEN:
        assert f'"{field}"' not in body


def test_the_anchor_can_be_unset(staff_client, family_a):
    staff_client.patch(
        ANCHOR_URL, {"person_id": str(family_a.jose.pk)}, content_type="application/json"
    )
    response = staff_client.patch(ANCHOR_URL, {"person_id": None}, content_type="application/json")
    assert response.status_code == 200
    assert response.json()["anchor_person"] is None


def test_an_unknown_person_cannot_be_the_anchor(staff_client):
    response = staff_client.patch(
        ANCHOR_URL,
        {"person_id": "11111111-1111-4111-8111-111111111111"},
        content_type="application/json",
    )
    assert response.status_code == 400


def test_one_anchor_per_user(staff_client, family_a):
    """Phase 2's privacy radius measures from this field; two "me"s would mean two answers."""
    staff_client.patch(
        ANCHOR_URL, {"person_id": str(family_a.jose.pk)}, content_type="application/json"
    )
    staff_client.patch(
        ANCHOR_URL, {"person_id": str(family_a.thomas.pk)}, content_type="application/json"
    )

    staff_client.user.refresh_from_db()
    assert staff_client.user.anchor_person_id == family_a.thomas.pk


# ------------------------------------------------------------- query budget


def test_bulk_relate_is_three_queries_regardless_of_size(
    staff_client, family_a, django_assert_num_queries
):
    """The point of the endpoint. Four queries, and four however many people are asked about:

    1. validating the `from` person,
    2. one recursive walk giving every seed's ancestors,
    3. the memberships among everyone that walk touched,
    4. those people's fields.

    Plus two for the test client's session and user lookup.
    """
    targets = [
        family_a.chacko,
        family_a.rosy,
        family_a.joseph,
        family_a.ittira,
        family_a.jose,
        family_a.kiran,
        family_a.varkey,
        family_a.deepa,
    ]
    with django_assert_num_queries(6):
        bulk(staff_client, family_a.thomas, targets)


def test_the_query_count_does_not_grow_with_the_number_of_targets(
    staff_client, family_a, django_assert_num_queries
):
    everyone = list(Person.objects.canonical())
    assert len(everyone) > 25, "fixture should be big enough for this to mean something"

    with django_assert_num_queries(6):
        bulk(staff_client, family_a.thomas, everyone)


def test_too_many_targets_is_refused_rather_than_served_slowly(staff_client, family_a):
    targets = ",".join(str(family_a.thomas.pk) for _ in range(MAX_TARGETS + 1))
    response = staff_client.get(BULK_URL, {"from": str(family_a.thomas.pk), "to": targets})
    assert response.status_code == 400
    assert response.json()["code"] == "too_many_targets"


# ------------------------------------------------------------- correctness


def test_payload_shape(staff_client, family_a):
    payload = bulk(staff_client, family_a.jose, [family_a.thomas]).json()
    assert set(payload) == {"from", "results"}
    assert set(payload["results"][str(family_a.thomas.pk)]) == RESULT_FIELDS


def test_core_kin_labels_match_the_single_pair_view(staff_client, family_a):
    """Two labelling paths would drift. There is one, and this proves it."""
    from apps.genealogy.graph import describe_relationship

    targets = [
        family_a.thomas,
        family_a.gracy,
        family_a.mini,
        family_a.rosy,
        family_a.joseph,
        family_a.chacko,
        family_a.ittira,
        family_a.arun,
        family_a.kiran,
        family_a.bibin,
        family_a.sunil,
        family_a.deepa,
        family_a.ouseph,
    ]
    payload = bulk(staff_client, family_a.jose, targets).json()["results"]

    for target in targets:
        expected = describe_relationship(family_a.jose, target)
        got = payload[str(target.pk)]
        if not expected.is_related:
            assert got is None, f"{target.display_name} should be unrelated"
            continue
        assert got["labels"] == expected.labels(), f"label drift for {target.display_name}"


@pytest.mark.parametrize(
    ("subject", "target", "en", "ml"),
    [
        ("jose", "thomas", "father", "അച്ഛൻ"),
        ("jose", "gracy", "mother", "അമ്മ"),
        ("thomas", "jose", "son", "മകൻ"),
        ("thomas", "rosy", "sister", "അനിയത്തി"),
        ("rosy", "thomas", "brother", "ചേട്ടൻ"),
        ("thomas", "joseph", "half-brother", "അർദ്ധസഹോദരൻ"),
        ("jose", "chacko", "grandfather", "മുത്തച്ഛൻ"),
        ("jose", "rosy", "aunt", "അമ്മായി"),
        ("deepa", "ouseph", "uncle", "അമ്മാവൻ"),
        ("rosy", "jose", "nephew", "അനന്തരവൻ"),
        ("sunil", "jose", "second cousin", "രണ്ടാം കസിൻ"),
        ("thomas", "gracy", "wife", "ഭാര്യ"),
        ("kiran", "ittira", "great-great-great-grandfather", "5 തലമുറ മുകളിലുള്ള പൂർവികൻ"),
    ],
)
def test_label_snapshots_in_both_languages(staff_client, family_a, subject, target, en, ml):
    subject_person = getattr(family_a, subject)
    target_person = getattr(family_a, target)
    result = bulk(staff_client, subject_person, [target_person]).json()["results"]
    assert result[str(target_person.pk)]["labels"] == {"en": en, "ml": ml}


def test_the_subject_themself_is_labelled_self(staff_client, family_a):
    result = bulk(staff_client, family_a.jose, [family_a.jose]).json()["results"]
    assert result[str(family_a.jose.pk)]["kind"] == naming.SELF


def test_a_disconnected_person_gets_an_explicit_null(staff_client, two_families):
    family_a, family_b = two_families
    result = bulk(staff_client, family_a.jose, [family_b.manoj, family_a.thomas]).json()["results"]

    assert result[str(family_b.manoj.pk)] is None, "no relationship must be an explicit null"
    assert result[str(family_a.thomas.pk)] is not None


def test_a_marriage_across_families_is_still_not_a_blood_relation(staff_client, bridged_families):
    result = bulk(staff_client, bridged_families.a.arun, [bridged_families.b.athira]).json()[
        "results"
    ]
    assert result[str(bridged_families.b.athira.pk)] is None


def test_a_spouse_is_labelled_even_with_no_common_ancestor(staff_client, bridged_families):
    result = bulk(staff_client, bridged_families.a.anju, [bridged_families.b.vishnu]).json()[
        "results"
    ]
    assert result[str(bridged_families.b.vishnu.pk)]["kind"] == naming.PARTNER


def test_half_siblings_are_distinguished_from_full(staff_client, family_a):
    result = labels(staff_client, family_a.thomas, [family_a.rosy, family_a.joseph])
    assert result["Rosy"]["en"] == "sister"
    assert result["Joseph"]["en"] == "half-brother"


def test_a_second_marriage_changes_the_cousin_degree(staff_client, family_a):
    """Jose and Bibin descend from Chacko's two different wives."""
    result = labels(staff_client, family_a.jose, [family_a.bibin])
    assert result["Bibin"]["en"] == "half-first cousin"


def test_an_unknown_parent_does_not_make_full_siblings_look_half(staff_client, family_a):
    """Varkey's father is unrecorded; his mother's siblings are still full siblings."""
    result = labels(staff_client, family_a.varkey, [family_a.chacko, family_a.devassy])
    assert result["Chacko"]["en"] == "uncle"
    assert result["Devassy"]["en"] == "uncle"


def test_switching_the_focus_changes_every_label(staff_client, family_a):
    """The whole point of a focus bar: the same people, seen from somewhere else."""
    from_jose = labels(staff_client, family_a.jose, [family_a.thomas, family_a.chacko])
    from_kiran = labels(staff_client, family_a.kiran, [family_a.thomas, family_a.chacko])

    assert from_jose["Thomas"]["en"] == "father"
    assert from_kiran["Thomas"]["en"] == "great-grandfather"
    assert from_jose["Chacko"]["en"] != from_kiran["Chacko"]["en"]


def test_a_lone_person_relates_to_nobody(staff_client, family_a):
    lonely = make_person("Unconnected", birth=1930)
    result = bulk(staff_client, family_a.jose, [lonely]).json()["results"]
    assert result[str(lonely.pk)] is None


def test_step_siblings_are_labelled_without_a_common_ancestor(staff_client):
    father = make_person("Chandy", birth=1930)
    first_wife = make_person("Thresia", birth=1934)
    ego = make_person("Jacob", birth=1958)
    make_union(father, first_wife, children=[ego], year=1955)

    second_wife = make_person("Sosamma", birth=1940)
    her_ex = make_person("Varghese", birth=1936)
    step = make_person("Mercy", birth=1962)
    make_union(her_ex, second_wife, children=[step], year=1960)
    make_union(father, second_wife, year=1970)

    result = bulk(staff_client, ego, [step]).json()["results"]
    assert result[str(step.pk)]["step"] is True


def test_bulk_tolerates_junk_ids(staff_client, family_a):
    response = staff_client.get(BULK_URL, {"from": str(family_a.jose.pk), "to": "not-a-uuid,,   ,"})
    assert response.status_code == 200


def test_bulk_needs_a_from(staff_client, family_a):
    assert staff_client.get(BULK_URL, {"to": str(family_a.jose.pk)}).status_code == 400


# --- The totality contract (DECISIONS.md #24) --------------------------------------------
#
# A live 400 sent the explorer an error toast for a call it should never have made: the
# focus id in localStorage outlived the person it pointed at, so `from` no longer resolved.
# These pin the rule that came out of it — labelling fails only on a malformed *request*,
# never on the state of the graph.


def test_a_from_that_no_longer_exists_is_answered_not_refused(staff_client, family_a):
    """The exact live repro: a focus id cached before the row went away."""
    dead = uuid.uuid4()
    response = staff_client.get(BULK_URL, {"from": str(dead), "to": str(family_a.jose.pk)})

    assert response.status_code == 200
    payload = response.json()
    # `from: null` is the signal the client acts on to drop the stale id.
    assert payload["from"] is None
    assert payload["results"] == {str(family_a.jose.pk): None}


def test_a_deleted_focus_person_stops_being_a_viewpoint(staff_client, family_a):
    """Not a synthetic uuid — a real person, deleted, exactly as undo does it."""
    subject, target = family_a.jose, family_a.thomas
    assert staff_client.get(BULK_URL, {"from": str(subject.pk), "to": str(target.pk)}).json()[
        "results"
    ][str(target.pk)] is not None

    Person.objects.filter(pk=subject.pk).delete()

    response = staff_client.get(BULK_URL, {"from": str(subject.pk), "to": str(target.pk)})
    assert response.status_code == 200
    assert response.json()["from"] is None


def test_only_a_missing_from_is_a_bad_request(staff_client, family_a):
    """Blank and absent are client bugs; unresolvable is a fact about the graph."""
    for params in ({"to": str(family_a.jose.pk)}, {"from": "", "to": str(family_a.jose.pk)}):
        response = staff_client.get(BULK_URL, params)
        assert response.status_code == 400
        assert response.json()["code"] == "missing_from"


def test_to_equal_to_from_is_served(staff_client, family_a):
    """One person in the graph, anchored to them: the canvas's first-ever labelling call."""
    only = family_a.jose
    response = staff_client.get(BULK_URL, {"from": str(only.pk), "to": str(only.pk)})

    assert response.status_code == 200
    assert response.json()["results"][str(only.pk)]["kind"] == "self"


@pytest.mark.parametrize("params", [{"to": ""}, {}])
def test_an_empty_target_list_is_an_empty_answer(staff_client, family_a, params):
    response = staff_client.get(BULK_URL, {"from": str(family_a.jose.pk), **params})

    assert response.status_code == 200
    assert response.json() == {"from": str(family_a.jose.pk), "results": {}}


def test_unknown_targets_are_null_beside_real_answers(staff_client, family_a):
    """A half-stale batch still labels everyone it can."""
    ghost = str(uuid.uuid4())
    response = staff_client.get(
        BULK_URL,
        {"from": str(family_a.jose.pk), "to": f"{ghost},{family_a.thomas.pk}"},
    )

    payload = response.json()["results"]
    assert payload[ghost] is None
    assert payload[str(family_a.thomas.pk)] is not None


def test_the_single_person_database_labels_without_error(staff_client):
    """End to end on the reported state: one person, anchored to them, nothing else."""
    user = staff_client.user
    only = Person.objects.create(name_en="Only", created_by=user)
    user.anchor_person = only
    user.save(update_fields=["anchor_person"])

    assert staff_client.get("/api/v1/me/").json()["anchor_person"]["id"] == str(only.pk)
    # Whatever the canvas asks — itself, nothing, or a ghost — nothing 400s.
    for to in (str(only.pk), "", str(uuid.uuid4())):
        assert staff_client.get(BULK_URL, {"from": str(only.pk), "to": to}).status_code == 200
