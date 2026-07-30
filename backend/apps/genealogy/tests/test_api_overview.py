"""The whole-database overview, quick-add, and the CSRF handshake.

Same discipline as the other API tests: literal URLs, exact key sets, and an explicit
query-count budget — the overview is the one endpoint where an N+1 would be invisible in
development and fatal on a real archive.
"""

import pytest
from django.contrib.auth import get_user_model

from apps.genealogy.factories import make_person, make_union
from apps.genealogy.models import Gender, Person, Role, Union, UnionMembership

pytestmark = pytest.mark.django_db

OVERVIEW_URL = "/api/v1/overview/"
QUICK_ADD_URL = "/api/v1/quick-add/"
CSRF_URL = "/api/v1/csrf/"

OVERVIEW_PERSON_FIELDS = {
    "id",
    "name_en",
    "name_ml",
    "display_name",
    "house_name",
    "gender",
    "is_living",
    "lifespan_compact",
    "band",
}
OVERVIEW_UNION_FIELDS = {"id", "band"}
OVERVIEW_MEMBERSHIP_FIELDS = {"union", "person", "role", "sibling_order"}
FORBIDDEN_FIELDS = {"notes", "created_by", "created_at", "updated_at", "place_origin", "claims"}


@pytest.fixture
def staff_client(client):
    staff = get_user_model().objects.create_user(
        email="owner@example.invalid", password="secret-x", is_staff=True
    )
    client.force_login(staff)
    return client


def bands_by_name(payload):
    return {row["display_name"]: row["band"] for row in payload["persons"]}


# ------------------------------------------------------------------ authentication


@pytest.mark.parametrize("url", [OVERVIEW_URL, CSRF_URL])
def test_anonymous_callers_are_refused(client, url, family_a):
    assert client.get(url).status_code == 403


def test_anonymous_quick_add_is_refused(client):
    assert client.post(QUICK_ADD_URL, {}, content_type="application/json").status_code == 403
    assert Person.objects.count() == 0


def test_non_staff_users_are_refused(client, family_a):
    get_user_model().objects.create_user(email="member@example.invalid", password="secret-x")
    client.login(email="member@example.invalid", password="secret-x")
    assert client.get(OVERVIEW_URL).status_code == 403


def test_csrf_endpoint_sets_the_cookie(staff_client):
    response = staff_client.get(CSRF_URL)
    assert response.status_code == 200
    assert "csrftoken" in response.cookies


# ----------------------------------------------------------------------- payload


def test_overview_payload_shape(staff_client, family_a):
    payload = staff_client.get(OVERVIEW_URL).json()

    assert set(payload) == {"persons", "unions", "memberships", "stats"}
    assert set(payload["persons"][0]) == OVERVIEW_PERSON_FIELDS
    assert set(payload["unions"][0]) == OVERVIEW_UNION_FIELDS
    assert set(payload["memberships"][0]) == OVERVIEW_MEMBERSHIP_FIELDS
    assert set(payload["stats"]) == {"persons", "unions", "components"}


def test_overview_leaks_nothing_private(staff_client, family_a):
    Person.objects.filter(pk=family_a.thomas.pk).update(notes="private working note")
    body = staff_client.get(OVERVIEW_URL).content.decode()

    assert "private working note" not in body
    for field in FORBIDDEN_FIELDS:
        assert f'"{field}"' not in body


def test_overview_covers_every_canonical_person(staff_client, family_a, family_b):
    payload = staff_client.get(OVERVIEW_URL).json()
    assert payload["stats"]["persons"] == Person.objects.canonical().count()
    assert len(payload["persons"]) == payload["stats"]["persons"]


def test_overview_excludes_merged_and_tombstoned(staff_client, family_a):
    from apps.genealogy.models import PersonStatus

    Person.objects.filter(pk=family_a.rosy.pk).update(
        status=PersonStatus.MERGED_INTO, merged_into=family_a.thomas
    )
    names = {row["display_name"] for row in staff_client.get(OVERVIEW_URL).json()["persons"]}
    assert "Rosy" not in names
    assert "Thomas" in names


def test_overview_counts_disconnected_families(staff_client, two_families):
    assert staff_client.get(OVERVIEW_URL).json()["stats"]["components"] == 2


def test_overview_of_an_empty_database(staff_client):
    """What the owner sees straight after `make reset-db`."""
    payload = staff_client.get(OVERVIEW_URL).json()
    assert payload["persons"] == []
    assert payload["unions"] == []
    assert payload["memberships"] == []
    assert payload["stats"] == {"persons": 0, "unions": 0, "components": 0}


# -------------------------------------------------------------------- no N+1


def test_overview_is_a_fixed_number_of_queries(staff_client, family_a, django_assert_num_queries):
    """The count must not grow with the number of people.

    Three queries do the work (persons, memberships, unions); the rest is session and
    user lookup from the test client's login. If this number drifts upward, something
    started querying per person.
    """
    with django_assert_num_queries(5):
        staff_client.get(OVERVIEW_URL)


def test_query_count_does_not_grow_with_the_database(
    staff_client, family_a, family_b, bridged_families, django_assert_num_queries
):
    with django_assert_num_queries(5):
        staff_client.get(OVERVIEW_URL)


# ------------------------------------------------------------------------ bands


def test_a_parent_is_always_banded_above_their_child(staff_client, family_a):
    bands = bands_by_name(staff_client.get(OVERVIEW_URL).json())
    for parent, child in [
        ("Ittira", "Chacko"),
        ("Chacko", "Thomas"),
        ("Chacko", "Joseph"),
        ("Thomas", "Jose"),
        ("Jose", "Arun"),
        ("Arun", "Kiran"),
    ]:
        assert bands[parent] < bands[child], f"{parent} should band above {child}"


def test_partners_share_a_band(staff_client, family_a):
    bands = bands_by_name(staff_client.get(OVERVIEW_URL).json())
    assert bands["Ittira"] == bands["Mariam"]
    assert bands["Thomas"] == bands["Gracy"]
    # Both of Chacko's wives sit on his row, despite the second marriage being later.
    assert bands["Chacko"] == bands["Annamma"] == bands["Saramma"]


def test_half_siblings_share_a_band(staff_client, family_a):
    bands = bands_by_name(staff_client.get(OVERVIEW_URL).json())
    assert bands["Thomas"] == bands["Rosy"] == bands["Joseph"] == bands["Lucy"]


def test_depth_uses_the_longest_ancestor_chain(staff_client, family_a):
    """A person reachable at two depths is drawn at the deeper one, never above a parent."""
    bands = bands_by_name(staff_client.get(OVERVIEW_URL).json())
    assert bands["Kiran"] - bands["Ittira"] == 5


def test_unrelated_families_are_offset_by_era(staff_client, two_families):
    """Structural depth alone would draw both families' roots on the same row."""
    payload = staff_client.get(OVERVIEW_URL).json()
    bands = bands_by_name(payload)

    # Ittira b.1890 and Kesavan b.1900 are both the root of their family, and are close
    # enough in era to land on the same row or within one of it.
    assert abs(bands["Ittira"] - bands["Kesavan"]) <= 1


def test_a_much_later_family_bands_lower(staff_client, family_a):
    """A fragment first recorded in the 1980s must not sit level with 1890s ancestors."""
    recent_parent = make_person("Recent Parent", gender=Gender.MALE, birth=1980, living=True)
    recent_child = make_person("Recent Child", gender=Gender.FEMALE, birth=2010, living=True)
    make_union(recent_parent, children=[recent_child], year=2008)

    bands = bands_by_name(staff_client.get(OVERVIEW_URL).json())
    assert bands["Recent Parent"] > bands["Ittira"]
    assert bands["Recent Parent"] < bands["Recent Child"]


def test_a_family_with_no_dates_still_bands(staff_client):
    parent = make_person("Undated Parent")
    child = make_person("Undated Child")
    make_union(parent, children=[child])

    bands = bands_by_name(staff_client.get(OVERVIEW_URL).json())
    assert bands["Undated Parent"] < bands["Undated Child"]


def test_an_isolated_person_still_gets_a_band(staff_client, family_a):
    make_person("Unconnected", birth=1930)
    bands = bands_by_name(staff_client.get(OVERVIEW_URL).json())
    assert "Unconnected" in bands


def test_union_bands_sit_with_their_partners(staff_client, family_a):
    payload = staff_client.get(OVERVIEW_URL).json()
    person_bands = {row["id"]: row["band"] for row in payload["persons"]}
    union_bands = {row["id"]: row["band"] for row in payload["unions"]}

    assert union_bands[str(family_a.u_thomas.pk)] == person_bands[str(family_a.thomas.pk)]
    assert union_bands[str(family_a.u_g1.pk)] == person_bands[str(family_a.ittira.pk)]


def test_bad_data_with_a_cycle_does_not_hang(staff_client):
    """Someone recorded as their own ancestor must degrade, not spin."""
    a = make_person("A", birth=1900)
    b = make_person("B", birth=1930)
    make_union(a, children=[b])
    make_union(b, children=[a])

    payload = staff_client.get(OVERVIEW_URL).json()
    assert {row["display_name"] for row in payload["persons"]} == {"A", "B"}


# --------------------------------------------------------------------- quick add


def quick_add(staff_client, **payload):
    return staff_client.post(QUICK_ADD_URL, payload, content_type="application/json")


def test_quick_add_creates_a_household(staff_client):
    response = quick_add(
        staff_client,
        partner_1_name="Mathai",
        partner_1_gender="male",
        partner_2_name="Aleyamma",
        partner_2_gender="female",
        house_name="Kunnathil",
        union_year=1935,
        children="Thomas | m | 1938\nRosy | f | 1941\nJoseph | m",
    )
    assert response.status_code == 201

    father = Person.objects.get(name_en="Mathai")
    assert father.house_name == "Kunnathil"
    assert father.created_by is not None

    children = UnionMembership.objects.filter(
        union__memberships__person=father, role=Role.CHILD
    ).order_by("sibling_order")
    assert [m.person.name_en for m in children] == ["Thomas", "Rosy", "Joseph"]
    assert [m.sibling_order for m in children] == [1, 2, 3]


def test_quick_add_returns_a_mergeable_subgraph(staff_client):
    """The response is neighborhood-shaped so the canvas merges it without a reload."""
    payload = quick_add(
        staff_client, partner_1_name="Chandy", partner_2_name="Thresia", children="Jacob | m"
    ).json()

    assert set(payload) >= {
        "created_person_ids",
        "union",
        "center",
        "persons",
        "unions",
        "memberships",
    }
    assert len(payload["created_person_ids"]) == 3
    names = {row["display_name"] for row in payload["persons"]}
    assert {"Chandy", "Thresia", "Jacob"} <= names
    # Same node shape as /neighborhood/, generations included.
    assert {"generation", "hidden_up", "hidden_down"} <= set(payload["persons"][0])
    assert payload["center"] in {str(p.id) for p in Person.objects.all()}


def test_quick_add_attaches_to_an_existing_person(staff_client, family_a):
    response = quick_add(
        staff_client,
        partner_1_id=str(family_a.sunil.pk),
        partner_2_name="Anitha",
        children="Meera | f | 2000",
    )
    assert response.status_code == 201

    from apps.genealogy.graph import traversal

    names = {link.person.display_name for link in traversal.children(family_a.sunil)}
    assert names == {"Nithin", "Meera"}


def test_quick_add_accepts_a_single_known_parent(staff_client):
    response = quick_add(
        staff_client, partner_2_name="Eliyamma", union_type="unknown", children="Varkey | m | 1940"
    )
    assert response.status_code == 201
    assert Union.objects.get().memberships.filter(role=Role.PARTNER).count() == 1


def test_quick_add_requires_a_partner(staff_client):
    response = quick_add(staff_client, children="Orphan | m")
    assert response.status_code == 400
    assert not Person.objects.filter(name_en="Orphan").exists()


def test_quick_add_rejects_an_unknown_partner_id(staff_client):
    response = quick_add(
        staff_client, partner_1_id="11111111-1111-4111-8111-111111111111", children="Nobody | m"
    )
    assert response.status_code == 400
    assert not Person.objects.filter(name_en="Nobody").exists()


def test_quick_add_rejects_an_id_and_a_name_together(staff_client, family_a):
    response = quick_add(
        staff_client, partner_1_id=str(family_a.sunil.pk), partner_1_name="Someone Else"
    )
    assert response.status_code == 400


def test_quick_add_marks_adopted_children(staff_client):
    quick_add(
        staff_client,
        partner_1_name="Devassy",
        partner_2_name="Kunjamma",
        children="Baby | f\nOuseph | m | adopted",
    )
    membership = UnionMembership.objects.get(person__name_en="Ouseph", role=Role.CHILD)
    assert membership.relation_type == "adopted"


def test_quick_add_appears_in_the_overview(staff_client):
    """The point of the whole feature: add a household, see it in the graph."""
    assert staff_client.get(OVERVIEW_URL).json()["stats"]["persons"] == 0

    quick_add(staff_client, partner_1_name="First", partner_2_name="Second", children="Third | m")

    payload = staff_client.get(OVERVIEW_URL).json()
    assert payload["stats"]["persons"] == 3
    bands = bands_by_name(payload)
    assert bands["First"] == bands["Second"] < bands["Third"]
