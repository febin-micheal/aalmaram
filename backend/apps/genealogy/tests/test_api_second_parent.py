"""Adding the second parent to a single-partner union.

The gap this covers was found in real use, doing the most ordinary thing there is: me →
+ parents → father → + partner → mother. That recorded the mother as a *separate marriage*
of the father's rather than as the other parent, and nothing on screen showed the
difference. The graph looked right and was wrong.

The rule now mirrors the child case: where the answer is genuinely ambiguous, the server
refuses and asks instead of picking.
"""

import pytest
from django.contrib.auth import get_user_model

from apps.genealogy.factories import make_person, make_union
from apps.genealogy.graph import describe_relationship
from apps.genealogy.models import Person, Role, Union, UnionMembership

pytestmark = pytest.mark.django_db

PERSONS_URL = "/api/v1/persons/"


@pytest.fixture
def staff_client(client):
    staff = get_user_model().objects.create_user(
        email="owner@example.invalid", password="secret-x", is_staff=True
    )
    client.force_login(staff)
    return client


def create(staff_client, **payload):
    return staff_client.post(PERSONS_URL, payload, content_type="application/json")


@pytest.fixture
def me_and_father(staff_client):
    """The exact repro: a child, and a father in a single-partner union."""
    me = create(staff_client, context="standalone", name_en="Febin", gender="male").json()
    father = create(
        staff_client,
        context="parent_of",
        target=me["person"]["id"],
        name_en="Micheal",
        gender="male",
    ).json()
    return me, father


# --------------------------------------------------------- the ambiguity


def test_adding_a_partner_to_a_single_partner_union_is_refused(staff_client, me_and_father):
    """The bug. Silently creating a second union recorded a mother as a stranger."""
    _, father = me_and_father

    response = create(
        staff_client,
        context="partner_of",
        target=father["person"]["id"],
        name_en="Anitha",
        gender="female",
    )

    assert response.status_code == 409
    body = response.json()
    assert body["code"] == "open_partner_slot"
    assert len(body["unions"]) == 1
    assert body["unions"][0]["union"] == father["union"]
    # The candidate is described by its children, so the question is answerable.
    assert body["unions"][0]["children"] == ["Febin"]
    assert not Person.objects.filter(name_en="Anitha").exists(), "nothing may be created"


def test_completing_the_pair_puts_both_parents_on_one_union(staff_client, me_and_father):
    me, father = me_and_father

    response = create(
        staff_client,
        context="partner_in_union",
        union=father["union"],
        name_en="Bincy",
        gender="female",
    )
    assert response.status_code == 201

    union = Union.objects.get(pk=father["union"])
    partners = {m.person.name_en for m in union.memberships.filter(role=Role.PARTNER)}
    assert partners == {"Micheal", "Bincy"}
    assert Union.objects.count() == 1, "completing a pair must not create a second union"


def test_after_completing_the_pair_the_child_has_both_parents(staff_client, me_and_father):
    me, father = me_and_father
    create(
        staff_client,
        context="partner_in_union",
        union=father["union"],
        name_en="Bincy",
        gender="female",
    )

    from apps.genealogy.graph import traversal

    child = Person.objects.get(pk=me["person"]["id"])
    assert {p.person.name_en for p in traversal.parents(child)} == {"Micheal", "Bincy"}


def test_the_joined_partner_is_labelled_mother_not_a_strangers_wife(staff_client, me_and_father):
    """The check that would have caught the original bug from the outside."""
    me, father = me_and_father
    create(
        staff_client,
        context="partner_in_union",
        union=father["union"],
        name_en="Bincy",
        gender="female",
    )

    child = Person.objects.get(pk=me["person"]["id"])
    mother = Person.objects.get(name_en="Bincy")

    result = describe_relationship(child, mother)
    assert result.label_en == "mother"
    assert result.label_ml == "അമ്മ"


def test_the_old_behaviour_would_have_failed_this(staff_client, me_and_father):
    """Belt and braces: a *separate* union really does give the wrong label."""
    me, father = me_and_father
    create(
        staff_client,
        context="partner_of",
        target=father["person"]["id"],
        name_en="Stranger",
        gender="female",
        force_new_union=True,
    )

    child = Person.objects.get(pk=me["person"]["id"])
    stranger = Person.objects.get(name_en="Stranger")
    assert describe_relationship(child, stranger).label_en != "mother"


# ------------------------------------------------------- the remarriage path


def test_forcing_a_new_union_is_still_available(staff_client, me_and_father):
    """A real second marriage must remain expressible."""
    _, father = me_and_father

    response = create(
        staff_client,
        context="partner_of",
        target=father["person"]["id"],
        name_en="Saramma",
        gender="female",
        force_new_union=True,
    )
    assert response.status_code == 201
    assert response.json()["union"] != father["union"]
    assert Union.objects.count() == 2


def test_a_person_with_a_complete_union_gets_no_question(staff_client):
    """Both seats already filled means adding a partner can only be a remarriage."""
    husband = make_person("Chacko", birth=1915)
    wife = make_person("Annamma", birth=1920)
    make_union(husband, wife, children=[make_person("Thomas", birth=1942)], year=1940)

    response = create(staff_client, context="partner_of", target=str(husband.pk), name_en="Saramma")
    assert response.status_code == 201, "no open seat, so no ambiguity"
    assert Union.objects.count() == 2


def test_several_open_unions_are_all_offered(staff_client):
    parent = make_person("Eliyamma", birth=1918)
    first = make_union(parent, children=[make_person("Varkey", birth=1940)], year=1939)
    second = make_union(parent, children=[make_person("Baby", birth=1950)], year=1948)

    response = create(staff_client, context="partner_of", target=str(parent.pk), name_en="Someone")
    assert response.status_code == 409

    offered = {u["union"]: u["children"] for u in response.json()["unions"]}
    assert set(offered) == {str(first.pk), str(second.pk)}
    assert offered[str(first.pk)] == ["Varkey"]
    assert offered[str(second.pk)] == ["Baby"]


# ------------------------------------------------- joining someone who exists


def test_an_existing_person_can_be_joined_as_the_second_parent(staff_client, me_and_father):
    """The mother may already be in the graph from another branch."""
    _, father = me_and_father
    mother = make_person("Bincy", gender="female", birth=1968)

    response = create(
        staff_client,
        context="partner_in_union",
        union=father["union"],
        existing_person_id=str(mother.pk),
    )
    assert response.status_code == 201
    assert response.json()["created_person"] is False, "undo must know not to delete her"
    assert Person.objects.filter(name_en="Bincy").count() == 1, "no duplicate person"

    union = Union.objects.get(pk=father["union"])
    assert {m.person.name_en for m in union.memberships.filter(role=Role.PARTNER)} == {
        "Micheal",
        "Bincy",
    }


def test_a_full_union_refuses_a_third_partner(staff_client, me_and_father):
    _, father = me_and_father
    create(staff_client, context="partner_in_union", union=father["union"], name_en="Bincy")

    response = create(
        staff_client, context="partner_in_union", union=father["union"], name_en="Third"
    )
    assert response.status_code == 409
    assert response.json()["code"] == "not_joinable"


def test_joining_the_same_person_twice_is_refused(staff_client, me_and_father):
    _, father = me_and_father
    response = create(
        staff_client,
        context="partner_in_union",
        union=father["union"],
        existing_person_id=father["person"]["id"],
    )
    assert response.status_code == 409


# --------------------------------------------------------------------- undo


def test_undoing_a_join_detaches_rather_than_deletes(staff_client, me_and_father):
    """She existed before the join; undo must not delete somebody else's relative."""
    _, father = me_and_father
    mother = make_person("Bincy", gender="female", birth=1968)
    create(
        staff_client,
        context="partner_in_union",
        union=father["union"],
        existing_person_id=str(mother.pk),
    )

    response = staff_client.delete(f"/api/v1/unions/{father['union']}/partners/{mother.pk}/")
    assert response.status_code == 200
    assert response.json()["detached_only"] is True

    assert Person.objects.filter(pk=mother.pk).exists(), "the person must survive"
    assert not UnionMembership.objects.filter(union_id=father["union"], person=mother).exists()
    assert Union.objects.filter(pk=father["union"]).exists(), "the union still holds the father"


def test_undoing_a_join_refuses_once_something_attached_afterwards(staff_client, me_and_father):
    _, father = me_and_father
    mother = make_person("Bincy", gender="female", birth=1968)
    create(
        staff_client,
        context="partner_in_union",
        union=father["union"],
        existing_person_id=str(mother.pk),
    )
    # A sibling recorded after the join is somebody else's work.
    create(staff_client, context="child_of_union", union=father["union"], name_en="Later Sibling")

    response = staff_client.delete(f"/api/v1/unions/{father['union']}/partners/{mother.pk}/")
    assert response.status_code == 409
    assert response.json()["code"] == "not_provisional"
    assert UnionMembership.objects.filter(union_id=father["union"], person=mother).exists()


def test_undoing_a_newly_created_second_parent_deletes_them(staff_client, me_and_father):
    """When the join created the person, undo may take the whole person back."""
    _, father = me_and_father
    created = create(
        staff_client, context="partner_in_union", union=father["union"], name_en="Bincy"
    ).json()
    assert created["created_person"] is True

    assert staff_client.delete(f"/api/v1/persons/{created['person']['id']}/").status_code == 200
    assert not Person.objects.filter(name_en="Bincy").exists()


def test_detaching_needs_the_person_to_actually_be_a_partner(staff_client, me_and_father):
    me, father = me_and_father
    response = staff_client.delete(
        f"/api/v1/unions/{father['union']}/partners/{me['person']['id']}/"
    )
    assert response.status_code == 409, "the child is not a partner in that union"


def test_detach_is_staff_only(me_and_father):
    """A fresh client — the shared `client` fixture is already logged in by staff_client."""
    from django.test import Client

    _, father = me_and_father
    anonymous = Client()
    response = anonymous.delete(
        f"/api/v1/unions/{father['union']}/partners/{father['person']['id']}/"
    )
    assert response.status_code == 403


# ------------------------------------------------ the full first-run sequence


def test_the_most_common_real_entry_sequence(staff_client):
    """me -> + parents -> complete the pair. This is what everyone does first."""
    me = create(staff_client, context="standalone", name_en="Febin", gender="male").json()
    father = create(
        staff_client,
        context="parent_of",
        target=me["person"]["id"],
        name_en="Micheal",
        gender="male",
    ).json()
    create(
        staff_client,
        context="partner_in_union",
        union=father["union"],
        name_en="Bincy",
        gender="female",
    )

    assert Person.objects.count() == 3
    assert Union.objects.count() == 1, "one union, two parents, one child"

    child = Person.objects.get(name_en="Febin")
    assert describe_relationship(child, Person.objects.get(name_en="Micheal")).label_en == "father"
    assert describe_relationship(child, Person.objects.get(name_en="Bincy")).label_en == "mother"
