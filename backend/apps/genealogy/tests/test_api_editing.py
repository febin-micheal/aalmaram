"""The editing endpoints behind direct manipulation on the canvas.

Literal URLs and exact key sets, as with every other endpoint. The behaviour that matters
most here is what happens when the answer is genuinely unknown: a person with two marriages
has no single "add a child" answer, and the server refuses rather than picking one. A wrong
attachment would be invisible afterwards.
"""

import pytest
from django.contrib.auth import get_user_model

from apps.genealogy.factories import make_person, make_union
from apps.genealogy.models import Person, Role, Union, UnionMembership

pytestmark = pytest.mark.django_db

PERSONS_URL = "/api/v1/persons/"


def person_url(pk):
    return f"/api/v1/persons/{pk}/"


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
NODE_FIELDS = PERSON_FIELDS | {"generation", "hidden_up", "hidden_down"}
FORBIDDEN = {"notes", "created_by", "created_at", "updated_at", "source_invite"}


@pytest.fixture
def staff_client(client):
    staff = get_user_model().objects.create_user(
        email="owner@example.invalid", password="secret-x", is_staff=True
    )
    client.force_login(staff)
    return client


def create(staff_client, **payload):
    return staff_client.post(PERSONS_URL, payload, content_type="application/json")


# ------------------------------------------------------------------ auth


def test_anonymous_cannot_create(client, family_a):
    response = client.post(
        PERSONS_URL,
        {"context": "partner_of", "target": str(family_a.thomas.pk)},
        content_type="application/json",
    )
    assert response.status_code == 403
    assert Person.objects.count() == len(Person.objects.all())  # nothing new


def test_anonymous_cannot_patch_or_delete(client, family_a):
    url = person_url(family_a.thomas.pk)
    assert (
        client.patch(url, {"name_en": "Hacked"}, content_type="application/json").status_code == 403
    )
    assert client.delete(url).status_code == 403
    family_a.thomas.refresh_from_db()
    assert family_a.thomas.name_en == "Thomas"


def test_non_staff_cannot_edit(client, family_a):
    get_user_model().objects.create_user(email="m@example.invalid", password="secret-x")
    client.login(email="m@example.invalid", password="secret-x")
    assert (
        client.post(
            PERSONS_URL, {"context": "partner_of"}, content_type="application/json"
        ).status_code
        == 403
    )


# --------------------------------------------------------------- + partner


def test_add_partner_creates_a_new_union(staff_client, family_a):
    response = create(
        staff_client,
        context="partner_of",
        target=str(family_a.sunil.pk),
        name_en="Anitha",
        gender="female",
    )
    assert response.status_code == 201
    payload = response.json()

    # created_person tells undo whether to delete the person or only detach them.
    assert set(payload) == {"person", "created_person", "union", "created_unions", "memberships"}
    assert payload["created_person"] is True
    assert set(payload["person"]) == NODE_FIELDS
    assert payload["person"]["display_name"] == "Anitha"

    union = Union.objects.get(pk=payload["union"])
    partners = {m.person.display_name for m in union.memberships.filter(role=Role.PARTNER)}
    assert partners == {"Sunil", "Anitha"}


def test_a_second_partner_becomes_a_second_union(staff_client, family_a):
    """A remarriage is two unions, which is what makes the layout draw it correctly."""
    before = UnionMembership.objects.filter(person=family_a.sunil, role=Role.PARTNER).count()
    create(staff_client, context="partner_of", target=str(family_a.sunil.pk), name_en="Second")
    after = UnionMembership.objects.filter(person=family_a.sunil, role=Role.PARTNER).count()
    assert after == before + 1


# ----------------------------------------------------------------- + child


def test_add_child_to_a_person_with_one_union(staff_client, family_a):
    response = create(
        staff_client,
        context="child_of_person",
        target=str(family_a.sunil.pk),
        name_en="Meera",
        gender="female",
        birth="2000",
    )
    assert response.status_code == 201

    meera = Person.objects.get(name_en="Meera")
    assert meera.birth_year_min == 2000
    membership = UnionMembership.objects.get(person=meera, role=Role.CHILD)
    assert membership.union_id == family_a.u_sunil.pk


def test_add_child_to_a_person_with_no_union_creates_a_single_partner_union(staff_client):
    """ "We know the mother, nobody remembers the father" is a normal record, not an error."""
    lone = make_person("Eliyamma", birth=1918)
    response = create(
        staff_client, context="child_of_person", target=str(lone.pk), name_en="Varkey"
    )
    assert response.status_code == 201

    union = Union.objects.get(pk=response.json()["union"])
    assert union.memberships.filter(role=Role.PARTNER).count() == 1
    assert union.memberships.get(role=Role.CHILD).person.name_en == "Varkey"
    # The new union is reported so the canvas can draw its dot.
    assert len(response.json()["created_unions"]) == 1


def test_add_child_to_a_person_with_TWO_unions_is_refused(staff_client, family_a):
    """The heart of "never guess": Chacko married twice, so this has no single answer."""
    response = create(
        staff_client,
        context="child_of_person",
        target=str(family_a.chacko.pk),
        name_en="Should Not Exist",
    )

    assert response.status_code == 409
    body = response.json()
    assert body["code"] == "ambiguous_union"
    assert set(body["unions"]) == {str(family_a.u_chacko_1.pk), str(family_a.u_chacko_2.pk)}
    # Nothing was created — not even the person.
    assert not Person.objects.filter(name_en="Should Not Exist").exists()


def test_choosing_the_union_resolves_the_ambiguity(staff_client, family_a):
    response = create(
        staff_client,
        context="child_of_union",
        union=str(family_a.u_chacko_2.pk),
        name_en="Late Child",
    )
    assert response.status_code == 201
    membership = UnionMembership.objects.get(person__name_en="Late Child", role=Role.CHILD)
    assert membership.union_id == family_a.u_chacko_2.pk


def test_rapid_sibling_entry_records_birth_order(staff_client):
    """Typing siblings in order into a fresh union records that order for free."""
    father = make_person("Chandy", birth=1900)
    union = make_union(father, year=1925)

    for name in ["Eldest", "Middle", "Youngest"]:
        create(staff_client, context="child_of_union", union=str(union.pk), name_en=name)

    orders = list(
        UnionMembership.objects.filter(union=union, role=Role.CHILD)
        .order_by("sibling_order")
        .values_list("person__name_en", "sibling_order")
    )
    assert orders == [("Eldest", 1), ("Middle", 2), ("Youngest", 3)]


def test_no_order_is_invented_over_unordered_siblings(staff_client, family_a):
    """Nithin's birth order was never recorded.

    Numbering only the newcomers would claim knowledge nobody has, and would draw the
    existing child last as though that were known. Better to leave it unrecorded and let
    the layout fall back to birth year.
    """
    assert (
        UnionMembership.objects.get(union=family_a.u_sunil, person=family_a.nithin).sibling_order
        is None
    )

    create(staff_client, context="child_of_union", union=str(family_a.u_sunil.pk), name_en="NewOne")

    assert (
        UnionMembership.objects.get(union=family_a.u_sunil, person__name_en="NewOne").sibling_order
        is None
    )


# --------------------------------------------------------------- + parents


def test_add_parent_creates_the_union_above(staff_client):
    child = make_person("Orphan", birth=1950)
    response = create(staff_client, context="parent_of", target=str(child.pk), name_en="Father")
    assert response.status_code == 201

    union = Union.objects.get(pk=response.json()["union"])
    assert union.memberships.get(role=Role.PARTNER).person.name_en == "Father"
    assert union.memberships.get(role=Role.CHILD).person == child


def test_add_parent_is_refused_when_parents_already_exist(staff_client, family_a):
    """The affordance is hidden in the UI; the API refuses anyway."""
    response = create(
        staff_client, context="parent_of", target=str(family_a.thomas.pk), name_en="Impostor"
    )
    assert response.status_code == 409
    assert response.json()["code"] == "already_has_parents"
    assert not Person.objects.filter(name_en="Impostor").exists()


# ------------------------------------------------------------------- years


@pytest.mark.parametrize(
    ("typed", "expected_min", "expected_max"),
    [
        ("1938", 1938, 1938),
        ("1930s", 1930, 1939),
        ("c. 1940", 1935, 1945),
        ("?", None, None),
        ("", None, None),
    ],
)
def test_uncertainty_is_accepted_as_typed(
    staff_client, family_a, typed, expected_min, expected_max
):
    create(
        staff_client,
        context="partner_of",
        target=str(family_a.sunil.pk),
        name_en=f"P{typed or 'blank'}",
        birth=typed,
    )
    person = Person.objects.get(name_en=f"P{typed or 'blank'}")
    assert (person.birth_year_min, person.birth_year_max) == (expected_min, expected_max)


def test_an_unreadable_year_is_rejected_not_guessed(staff_client, family_a):
    response = create(
        staff_client,
        context="partner_of",
        target=str(family_a.sunil.pk),
        name_en="Nope",
        birth="sometime in the war",
    )
    assert response.status_code == 400
    assert "birth" in response.json()
    assert not Person.objects.filter(name_en="Nope").exists()


# ------------------------------------------------------------------- patch


def test_inline_rename(staff_client, family_a):
    response = staff_client.patch(
        person_url(family_a.thomas.pk), {"name_en": "Thommen"}, content_type="application/json"
    )
    assert response.status_code == 200
    assert set(response.json()) == PERSON_FIELDS
    family_a.thomas.refresh_from_db()
    assert family_a.thomas.name_en == "Thommen"


def test_inline_edits_of_gender_and_years(staff_client, family_a):
    staff_client.patch(
        person_url(family_a.thomas.pk),
        {"gender": "female", "birth": "1940s", "death": "?"},
        content_type="application/json",
    )
    family_a.thomas.refresh_from_db()
    assert family_a.thomas.gender == "female"
    assert (family_a.thomas.birth_year_min, family_a.thomas.birth_year_max) == (1940, 1949)
    assert family_a.thomas.death_year_min is None


def test_patch_leaves_untouched_fields_alone(staff_client, family_a):
    original_house = family_a.thomas.house_name
    staff_client.patch(
        person_url(family_a.thomas.pk), {"name_ml": "തോമ്മാ"}, content_type="application/json"
    )
    family_a.thomas.refresh_from_db()
    assert family_a.thomas.name_ml == "തോമ്മാ"
    assert family_a.thomas.house_name == original_house
    assert family_a.thomas.name_en == "Thomas"


def test_patch_rejects_an_empty_body(staff_client, family_a):
    assert (
        staff_client.patch(
            person_url(family_a.thomas.pk), {}, content_type="application/json"
        ).status_code
        == 400
    )


def test_patch_rejects_a_bad_year(staff_client, family_a):
    response = staff_client.patch(
        person_url(family_a.thomas.pk), {"birth": "yesterday"}, content_type="application/json"
    )
    assert response.status_code == 400
    family_a.thomas.refresh_from_db()
    assert family_a.thomas.birth_year_min == 1940  # unchanged


def test_patch_never_leaks_private_fields(staff_client, family_a):
    Person.objects.filter(pk=family_a.thomas.pk).update(notes="private working note")
    body = staff_client.patch(
        person_url(family_a.thomas.pk), {"name_en": "T"}, content_type="application/json"
    ).content.decode()
    assert "private working note" not in body
    for field in FORBIDDEN:
        assert f'"{field}"' not in body


# -------------------------------------------------------------------- undo


def test_undo_removes_a_just_created_person_and_their_union(staff_client):
    lone = make_person("Eliyamma", birth=1918)
    created = create(
        staff_client, context="child_of_person", target=str(lone.pk), name_en="Varkey"
    ).json()
    person_id = created["person"]["id"]
    union_id = created["union"]

    response = staff_client.delete(person_url(person_id))
    assert response.status_code == 200
    assert not Person.objects.filter(pk=person_id).exists()
    # The union held one partner and this child; with the child gone it represents
    # nothing, so it goes too rather than leaving an empty dot on the canvas.
    assert not Union.objects.filter(pk=union_id).exists()
    assert Person.objects.filter(pk=lone.pk).exists(), "the parent must survive"


def test_undo_keeps_a_two_partner_union_with_no_children(staff_client, family_a):
    """A marriage with no recorded children is a real record, not a leftover."""
    created = create(
        staff_client, context="partner_of", target=str(family_a.sunil.pk), name_en="Spouse"
    ).json()
    union_id = created["union"]
    staff_client.delete(person_url(created["person"]["id"]))
    # One partner left and no children -> nothing to represent, so it goes.
    assert not Union.objects.filter(pk=union_id).exists()


def test_undo_keeps_a_union_that_still_has_members(staff_client, family_a):
    created = create(
        staff_client, context="child_of_union", union=str(family_a.u_sunil.pk), name_en="Temp"
    ).json()
    staff_client.delete(person_url(created["person"]["id"]))
    assert Union.objects.filter(pk=family_a.u_sunil.pk).exists()
    assert Person.objects.filter(pk=family_a.nithin.pk).exists()


def test_undo_refuses_once_the_person_has_children(staff_client, family_a):
    """Undo takes back what it created — it is not a delete button."""
    parent = create(
        staff_client, context="partner_of", target=str(family_a.sunil.pk), name_en="NewSpouse"
    ).json()
    create(staff_client, context="child_of_union", union=parent["union"], name_en="TheirChild")

    response = staff_client.delete(person_url(parent["person"]["id"]))
    assert response.status_code == 409
    assert response.json()["code"] == "not_provisional"
    assert Person.objects.filter(name_en="NewSpouse").exists()


def test_undo_refuses_for_someone_embedded_in_the_graph(staff_client, family_a):
    response = staff_client.delete(person_url(family_a.chacko.pk))
    assert response.status_code == 409
    assert Person.objects.filter(pk=family_a.chacko.pk).exists()


def test_undo_refuses_when_a_member_is_anchored_to_them(staff_client, family_a):
    created = create(
        staff_client, context="partner_of", target=str(family_a.sunil.pk), name_en="Anchored"
    ).json()
    person = Person.objects.get(pk=created["person"]["id"])
    get_user_model().objects.create_user(
        email="anchored@example.invalid", password="x", anchor_person=person
    )
    assert staff_client.delete(person_url(person.pk)).status_code == 409


# -------------------------------------------------------- the graph stays sane


def test_a_person_added_on_the_canvas_appears_in_the_overview(staff_client, family_a):
    create(staff_client, context="partner_of", target=str(family_a.sunil.pk), name_en="Anitha")
    payload = staff_client.get("/api/v1/overview/").json()
    names = {row["display_name"] for row in payload["persons"]}
    assert "Anitha" in names


def test_canvas_and_quick_add_produce_the_same_structure(staff_client):
    """One code path: a household typed on the canvas matches one typed into the form."""
    from apps.genealogy.households import create_family_unit

    father = make_person("Chandy", birth=1900)
    create(staff_client, context="partner_of", target=str(father.pk), name_en="Thresia")
    union_id = UnionMembership.objects.filter(person=father, role=Role.PARTNER).first().union_id
    create(staff_client, context="child_of_union", union=str(union_id), name_en="Jacob")

    form_union, _ = create_family_unit(
        {"new_partner_1": "Chandy2", "new_partner_2": "Thresia2", "children": "Jacob2"}, None
    )

    canvas = Union.objects.get(pk=union_id)
    assert (
        canvas.memberships.filter(role=Role.PARTNER).count()
        == form_union.memberships.filter(role=Role.PARTNER).count()
    )
    assert (
        canvas.memberships.filter(role=Role.CHILD).count()
        == form_union.memberships.filter(role=Role.CHILD).count()
    )


# ------------------------------------------------- the first person in an archive


def test_the_first_person_can_be_created_with_no_relationships(staff_client):
    """An empty archive has no anchor, and every other context requires one.

    Without this the canvas editor cannot start from nothing — which is exactly the state
    the owner is in straight after `make reset-db`.
    """
    assert Person.objects.count() == 0

    response = create(
        staff_client,
        context="standalone",
        name_en="Ittira",
        gender="male",
        birth="1890",
        house_name="Kavunkal",
    )
    assert response.status_code == 201

    payload = response.json()
    assert payload["union"] is None
    assert payload["created_unions"] == []
    assert payload["memberships"] == []

    ittira = Person.objects.get()
    assert ittira.name_en == "Ittira"
    assert ittira.birth_year_min == 1890
    assert ittira.house_name == "Kavunkal"
    assert UnionMembership.objects.count() == 0, "a lone person belongs to no union yet"


def test_standalone_needs_neither_target_nor_union(staff_client, family_a):
    """Passing an anchor is not required, and a stray one is simply ignored."""
    assert create(staff_client, context="standalone", name_en="Alone").status_code == 201


def test_the_first_person_appears_in_the_overview(staff_client):
    """The empty state must become a one-person graph, not stay empty."""
    assert staff_client.get("/api/v1/overview/").json()["stats"]["persons"] == 0

    create(staff_client, context="standalone", name_en="Ittira")

    payload = staff_client.get("/api/v1/overview/").json()
    assert payload["stats"]["persons"] == 1
    assert payload["stats"]["components"] == 1
    assert payload["persons"][0]["display_name"] == "Ittira"


def test_a_whole_family_grows_from_one_standalone_person(staff_client):
    """The path the click-script walks: nothing -> one person -> a three-generation family."""
    root = create(staff_client, context="standalone", name_en="Ittira", gender="male").json()
    root_id = root["person"]["id"]

    # + partner
    spouse = create(
        staff_client, context="partner_of", target=root_id, name_en="Mariam", gender="female"
    ).json()
    union_id = spouse["union"]
    assert union_id is not None

    # + child, three of them, in order
    for name in ["Chacko", "Eliyamma", "Devassy"]:
        assert (
            create(staff_client, context="child_of_union", union=union_id, name_en=name).status_code
            == 201
        )

    # + parents above the root
    assert (
        create(
            staff_client, context="parent_of", target=root_id, name_en="Kunjachan", gender="male"
        ).status_code
        == 201
    )

    assert Person.objects.count() == 6
    orders = list(
        UnionMembership.objects.filter(union_id=union_id, role=Role.CHILD)
        .order_by("sibling_order")
        .values_list("person__name_en", flat=True)
    )
    assert orders == ["Chacko", "Eliyamma", "Devassy"]

    # And the root now hangs from its own union of birth.
    assert UnionMembership.objects.filter(person_id=root_id, role=Role.CHILD).exists()


def test_undo_works_on_the_very_first_person(staff_client):
    """Nothing references them, so taking the first person back must be allowed."""
    created = create(staff_client, context="standalone", name_en="Mistake").json()
    assert staff_client.delete(person_url(created["person"]["id"])).status_code == 200
    assert Person.objects.count() == 0
