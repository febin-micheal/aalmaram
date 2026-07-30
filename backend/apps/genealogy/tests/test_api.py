"""Tests for the Phase 1.5 read-only API.

Same discipline as test_admin_urls.py, for the same reason: every endpoint is addressed
by **literal URL string**, because these are addresses the frontend hard-codes and a
route that quietly moves is exactly the failure this suite exists to catch.

Payload shape is asserted as an exact key set, not with `in` checks. A serializer that
starts leaking `notes` or `created_by` has to fail here.
"""

import pytest
from django.contrib.auth import get_user_model

pytestmark = pytest.mark.django_db

PERSONS_URL = "/api/v1/persons/"
SUGGESTED_URL = "/api/v1/persons/suggested/"
RELATE_URL = "/api/v1/relate/"
HEALTH_URL = "/api/v1/health/"


def neighborhood_url(person_id):
    return f"/api/v1/persons/{person_id}/neighborhood/"


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
PERSON_NODE_FIELDS = PERSON_FIELDS | {"generation", "hidden_up", "hidden_down"}
UNION_FIELDS = {"id", "union_type", "status", "year_display", "place", "generation"}
MEMBERSHIP_FIELDS = {"union", "person", "role", "relation_type", "sibling_order"}

#: Fields that must never reach the client. Notes and provenance are contributor-private,
#: and the claim trail says who disagreed with whom.
FORBIDDEN_FIELDS = {"notes", "created_by", "created_at", "updated_at", "source_invite", "claims"}


@pytest.fixture
def staff_client(client):
    staff = get_user_model().objects.create_user(
        email="owner@example.invalid", password="secret-x", is_staff=True
    )
    client.force_login(staff)
    return client


# ------------------------------------------------------------------ authentication


@pytest.mark.parametrize("url", [PERSONS_URL, SUGGESTED_URL, RELATE_URL])
def test_anonymous_requests_are_refused(client, url):
    assert client.get(url).status_code == 403


def test_anonymous_neighborhood_request_is_refused(client, family_a):
    assert client.get(neighborhood_url(family_a.thomas.pk)).status_code == 403


@pytest.mark.parametrize("url", [PERSONS_URL, SUGGESTED_URL, RELATE_URL])
def test_signed_in_non_staff_users_are_refused(client, url):
    get_user_model().objects.create_user(email="member@example.invalid", password="secret-x")
    client.login(email="member@example.invalid", password="secret-x")
    assert client.get(url).status_code == 403


def test_staff_sessions_are_allowed(staff_client, family_a):
    assert staff_client.get(PERSONS_URL).status_code == 200
    assert staff_client.get(neighborhood_url(family_a.thomas.pk)).status_code == 200


def test_health_stays_open(client):
    assert client.get(HEALTH_URL).status_code == 200


# --------------------------------------------------------------------- person list


def test_person_list_is_paginated(staff_client, family_a):
    payload = staff_client.get(PERSONS_URL).json()
    assert set(payload) == {"count", "next", "previous", "results"}
    assert payload["count"] > 0


def test_person_payload_has_exactly_the_intended_fields(staff_client, family_a):
    row = staff_client.get(PERSONS_URL).json()["results"][0]
    assert set(row) == PERSON_FIELDS


def test_person_payload_leaks_nothing_private(staff_client, family_a):
    from apps.genealogy.models import Person

    Person.objects.filter(pk=family_a.thomas.pk).update(notes="private working note")
    body = staff_client.get(PERSONS_URL, {"search": "Thomas"}).content.decode()

    assert "private working note" not in body
    for field in FORBIDDEN_FIELDS:
        assert f'"{field}"' not in body


def test_person_list_excludes_merged_and_tombstoned(staff_client, family_a):
    from apps.genealogy.models import Person, PersonStatus

    Person.objects.filter(pk=family_a.rosy.pk).update(
        status=PersonStatus.MERGED_INTO, merged_into=family_a.thomas
    )
    names = [row["display_name"] for row in staff_client.get(PERSONS_URL).json()["results"]]
    assert "Rosy" not in names
    assert "Thomas" in names


def test_search_matches_english_names(staff_client, family_a):
    results = staff_client.get(PERSONS_URL, {"search": "Thomas"}).json()["results"]
    assert "Thomas" in [row["display_name"] for row in results]


def test_search_matches_house_names(staff_client, family_a):
    results = staff_client.get(PERSONS_URL, {"search": "Kavunkal"}).json()["results"]
    assert [row for row in results if row["house_name"] == "Kavunkal"]


def test_search_matches_malayalam_script(staff_client, duplicate_pair):
    results = staff_client.get(PERSONS_URL, {"search": "ഔസേഫ്"}).json()["results"]
    assert "ഔസേഫ്" in [row["name_ml"] for row in results]


def test_search_tolerates_a_spelling_variant(staff_client, duplicate_pair):
    """Trigram search is what makes Ouseph findable when you typed Ousep."""
    results = staff_client.get(PERSONS_URL, {"search": "Ousep"}).json()["results"]
    assert "Ouseph" in [row["display_name"] for row in results]


def test_search_for_nonsense_returns_nothing_rather_than_everything(staff_client, family_a):
    assert staff_client.get(PERSONS_URL, {"search": "zzzzqqqq"}).json()["count"] == 0


def test_suggested_returns_well_connected_people(staff_client, family_a):
    payload = staff_client.get(SUGGESTED_URL).json()
    assert payload["results"]
    assert set(payload["results"][0]) == PERSON_FIELDS
    # Chacko has two marriages and four children, so he outranks a leaf like Kiran.
    names = [row["display_name"] for row in payload["results"]]
    assert names.index("Chacko") < names.index("Kiran") if "Kiran" in names else True


def test_year_displays_are_compact(staff_client, family_a):
    results = staff_client.get(PERSONS_URL, {"search": "Ittira"}).json()["results"]
    ittira = next(row for row in results if row["display_name"] == "Ittira")
    # Born 1888–1892 in the fixture: a tight range reads as an approximation.
    assert ittira["birth_display"] == "c. 1890"
    assert ittira["death_display"] == "?"


# -------------------------------------------------------------------- neighborhood


def test_neighborhood_payload_shape(staff_client, family_a):
    payload = staff_client.get(neighborhood_url(family_a.thomas.pk)).json()

    assert set(payload) == {
        "center",
        "generations_up",
        "generations_down",
        "persons",
        "unions",
        "memberships",
    }
    assert payload["center"] == str(family_a.thomas.pk)
    assert set(payload["persons"][0]) == PERSON_NODE_FIELDS
    assert set(payload["unions"][0]) == UNION_FIELDS
    assert set(payload["memberships"][0]) == MEMBERSHIP_FIELDS


def test_neighborhood_leaks_nothing_private(staff_client, family_a):
    from apps.genealogy.models import Person

    Person.objects.filter(pk=family_a.thomas.pk).update(notes="private working note")
    body = staff_client.get(neighborhood_url(family_a.thomas.pk)).content.decode()

    assert "private working note" not in body
    for field in FORBIDDEN_FIELDS:
        assert f'"{field}"' not in body


def test_neighborhood_includes_the_family_not_just_the_bloodline(staff_client, family_a):
    """Ancestors and descendants alone would draw a pedigree, not a family."""
    payload = staff_client.get(neighborhood_url(family_a.thomas.pk)).json()
    names = {row["display_name"] for row in payload["persons"]}

    assert "Thomas" in names  # centre
    assert {"Chacko", "Annamma"} <= names  # parents
    assert {"Ittira", "Mariam"} <= names  # grandparents
    assert "Rosy" in names  # full sibling
    assert {"Joseph", "Lucy"} <= names  # half siblings, via the father's second union
    assert {"Eliyamma", "Devassy"} <= names  # aunt and uncle
    assert "Gracy" in names  # spouse
    assert {"Jose", "Mini"} <= names  # children
    assert {"Arun", "Anju"} <= names  # grandchildren


def test_neighborhood_stops_at_cousins(staff_client, family_a):
    """Cousins are one expand-click away, not loaded by default."""
    payload = staff_client.get(neighborhood_url(family_a.thomas.pk)).json()
    names = {row["display_name"] for row in payload["persons"]}
    assert "Varkey" not in names  # a first cousin, child of aunt Eliyamma


def test_generations_are_relative_to_the_centre(staff_client, family_a):
    payload = staff_client.get(neighborhood_url(family_a.thomas.pk)).json()
    generation = {row["display_name"]: row["generation"] for row in payload["persons"]}

    assert generation["Thomas"] == 0
    assert generation["Gracy"] == 0  # spouse shares the row
    assert generation["Rosy"] == 0  # sibling
    assert generation["Chacko"] == -1
    assert generation["Ittira"] == -2
    assert generation["Jose"] == 1
    assert generation["Arun"] == 2


def test_generation_bounds_are_respected(staff_client, family_a):
    payload = staff_client.get(
        neighborhood_url(family_a.thomas.pk), {"generations_up": 1, "generations_down": 1}
    ).json()
    names = {row["display_name"] for row in payload["persons"]}

    assert "Chacko" in names
    assert "Ittira" not in names  # two up
    assert "Jose" in names
    assert "Arun" not in names  # two down


def test_generation_bounds_are_clamped(staff_client, family_a):
    payload = staff_client.get(
        neighborhood_url(family_a.thomas.pk),
        {"generations_up": 99, "generations_down": "nonsense"},
    ).json()
    assert payload["generations_up"] == 4  # MAX_GENERATIONS
    assert payload["generations_down"] == 2  # the default, for an unparseable value


def test_hidden_counts_drive_the_expand_affordance(staff_client, family_a):
    """A node has to advertise that there is more of the graph behind it."""
    payload = staff_client.get(
        neighborhood_url(family_a.thomas.pk), {"generations_up": 1, "generations_down": 1}
    ).json()
    by_name = {row["display_name"]: row for row in payload["persons"]}

    assert by_name["Chacko"]["hidden_up"] >= 1  # his parents were not loaded
    assert by_name["Jose"]["hidden_down"] >= 1  # his children were not loaded
    assert by_name["Thomas"]["hidden_up"] == 0  # both parents are on screen


def test_remarriage_appears_as_two_unions(staff_client, family_a):
    """The drawing has to reflect the Union model, not one merged parent blob."""
    payload = staff_client.get(neighborhood_url(family_a.thomas.pk)).json()
    chacko_unions = {
        m["union"]
        for m in payload["memberships"]
        if m["person"] == str(family_a.chacko.pk) and m["role"] == "partner"
    }
    assert len(chacko_unions) == 2

    # And the half-siblings hang off the second one, not off Chacko directly.
    second = str(family_a.u_chacko_2.pk)
    children_of_second = {
        m["person"] for m in payload["memberships"] if m["union"] == second and m["role"] == "child"
    }
    assert {str(family_a.joseph.pk), str(family_a.lucy.pk)} <= children_of_second


def test_adopted_children_keep_their_relation_type(staff_client, family_a):
    payload = staff_client.get(neighborhood_url(family_a.devassy.pk)).json()
    ouseph = [
        m
        for m in payload["memberships"]
        if m["person"] == str(family_a.ouseph.pk) and m["role"] == "child"
    ]
    assert ouseph and ouseph[0]["relation_type"] == "adopted"


def test_union_generations_sit_with_their_partners(staff_client, family_a):
    payload = staff_client.get(neighborhood_url(family_a.thomas.pk)).json()
    unions = {row["id"]: row["generation"] for row in payload["unions"]}
    assert unions[str(family_a.u_thomas.pk)] == 0  # Thomas & Gracy's own union
    assert unions[str(family_a.u_chacko_1.pk)] == -1  # his parents' union


def test_neighborhood_of_an_isolated_person(staff_client):
    from apps.genealogy.factories import make_person

    lonely = make_person("Unconnected", birth=1900)
    payload = staff_client.get(neighborhood_url(lonely.pk)).json()

    assert [row["display_name"] for row in payload["persons"]] == ["Unconnected"]
    assert payload["unions"] == []
    assert payload["memberships"] == []


def test_neighborhood_of_an_unknown_person_is_404(staff_client):
    assert (
        staff_client.get(neighborhood_url("11111111-1111-4111-8111-111111111111")).status_code
        == 404
    )


# --------------------------------------------------------------------------- relate


def test_relate_returns_labels_ancestors_and_both_paths(staff_client, family_a):
    payload = staff_client.get(
        RELATE_URL, {"a": str(family_a.kiran.pk), "b": str(family_a.bibin.pk)}
    ).json()

    assert set(payload) == {"a", "b", "is_related", "kind", "labels", "common_ancestors"}
    assert payload["is_related"] is True
    assert payload["labels"]["en"]
    assert payload["labels"]["ml"]

    common = payload["common_ancestors"][0]
    assert set(common) == {"person", "depth_subject", "depth_other", "path_subject", "path_other"}
    assert common["person"]["display_name"] == "Chacko"
    # Paths run ancestor-first, which is the direction the UI draws them.
    assert [step["display_name"] for step in common["path_subject"]] == [
        "Chacko",
        "Thomas",
        "Jose",
        "Arun",
        "Kiran",
    ]
    assert [step["display_name"] for step in common["path_other"]] == ["Chacko", "Joseph", "Bibin"]


def test_relate_gives_both_languages(staff_client, family_a):
    payload = staff_client.get(
        RELATE_URL, {"a": str(family_a.jose.pk), "b": str(family_a.rosy.pk)}
    ).json()
    assert payload["labels"] == {"en": "aunt", "ml": "അമ്മായി"}


def test_relate_reports_no_relation_for_disconnected_people(staff_client, two_families):
    family_a, family_b = two_families
    payload = staff_client.get(
        RELATE_URL, {"a": str(family_a.jose.pk), "b": str(family_b.manoj.pk)}
    ).json()

    assert payload["is_related"] is False
    assert payload["kind"] == "unrelated"
    assert payload["common_ancestors"] == []
    assert payload["labels"]["en"] == "no known relationship"


def test_relate_requires_two_ids(staff_client, family_a):
    assert staff_client.get(RELATE_URL).status_code == 400
    assert staff_client.get(RELATE_URL, {"a": str(family_a.jose.pk)}).status_code == 400
    assert staff_client.get(RELATE_URL, {"a": "not-a-uuid", "b": "also-not"}).status_code == 400


def test_relate_leaks_nothing_private(staff_client, family_a):
    from apps.genealogy.models import Person

    Person.objects.filter(pk=family_a.jose.pk).update(notes="private working note")
    body = staff_client.get(
        RELATE_URL, {"a": str(family_a.jose.pk), "b": str(family_a.rosy.pk)}
    ).content.decode()

    assert "private working note" not in body
    for field in FORBIDDEN_FIELDS:
        assert f'"{field}"' not in body
