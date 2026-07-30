"""The admin tree view: explorer, relationship finder, and the seed-entry screen."""

import pytest
from django.urls import reverse

from apps.genealogy.admin.views import parse_child_line
from apps.genealogy.graph import traversal
from apps.genealogy.models import Gender, Person, RelationType, Role, Union, UnionMembership

pytestmark = pytest.mark.django_db


def test_explorer_shows_the_ego_network(admin_client, family_a):
    url = reverse("admin:genealogy_explorer")
    response = admin_client.get(url, {"person": str(family_a.thomas.pk), "depth": 4})

    assert response.status_code == 200
    body = response.content.decode()
    assert "Chacko" in body  # parent
    assert "Rosy" in body  # full sibling
    assert "Joseph" in body  # half sibling
    assert "half" in body  # …labelled as such
    assert "Jose" in body  # child
    assert "Ittira" in body  # ancestor two generations up


def test_explorer_without_a_person_still_renders(admin_client, family_a):
    response = admin_client.get(reverse("admin:genealogy_explorer"))
    assert response.status_code == 200
    assert "Pick a person" in response.content.decode()


def test_relate_view_reports_the_relationship_and_paths(admin_client, family_a):
    url = reverse("admin:genealogy_relate")
    response = admin_client.get(url, {"a": str(family_a.jose.pk), "b": str(family_a.rosy.pk)})

    assert response.status_code == 200
    body = response.content.decode()
    assert "aunt" in body
    assert "അമ്മായി" in body
    assert "Common ancestor" in body
    assert "Chacko" in body or "Annamma" in body


def test_relate_view_is_honest_about_unrelated_people(admin_client, two_families):
    family_a, family_b = two_families
    url = reverse("admin:genealogy_relate")
    response = admin_client.get(url, {"a": str(family_a.jose.pk), "b": str(family_b.manoj.pk)})

    assert response.status_code == 200
    assert "no known relationship" in response.content.decode()


def test_person_changelist_links_to_the_graph_tools(admin_client, family_a):
    response = admin_client.get(reverse("admin:genealogy_person_changelist"))
    assert response.status_code == 200
    body = response.content.decode()
    assert reverse("admin:genealogy_quick_add") in body
    assert reverse("admin:genealogy_explorer") in body


def test_person_changelist_search_spans_scripts_and_house_names(admin_client, family_a):
    url = reverse("admin:genealogy_person_changelist")
    assert "Ittira" in admin_client.get(url, {"q": "Ittira"}).content.decode()
    assert "Kavunkal" in admin_client.get(url, {"q": "Kavunkal"}).content.decode()


# ------------------------------------------------------------------- quick add


def quick_add_payload(**overrides):
    payload = {
        "existing_partner_1": "",
        "new_partner_1": "",
        "new_partner_1_gender": Gender.MALE,
        "existing_partner_2": "",
        "new_partner_2": "",
        "new_partner_2_gender": Gender.FEMALE,
        "union_type": "marriage",
        "union_year": "",
        "union_place": "",
        "house_name": "",
        "children": "",
    }
    payload.update(overrides)
    return payload


def test_quick_add_creates_a_whole_household_in_one_submit(admin_client):
    response = admin_client.post(
        reverse("admin:genealogy_quick_add"),
        quick_add_payload(
            new_partner_1="Mathai",
            new_partner_2="Aleyamma",
            union_year=1935,
            union_place="Aalathoor",
            house_name="Kunnathil",
            children="Thomas | m | 1938\nRosy | f | 1941\nJoseph | m",
        ),
    )
    assert response.status_code == 302

    father = Person.objects.get(name_en="Mathai")
    assert father.house_name == "Kunnathil"
    assert father.gender == Gender.MALE
    assert father.created_by is not None  # provenance is recorded from day one

    children = traversal.children(father)
    assert [link.person.display_name for link in children] == ["Thomas", "Rosy", "Joseph"]
    # Line order becomes birth order — that is the whole point of the textarea.
    assert [link.sibling_order for link in children] == [1, 2, 3]

    thomas = Person.objects.get(name_en="Thomas")
    assert thomas.gender == Gender.MALE
    assert thomas.birth_year_min == 1938
    assert thomas.house_name == "Kunnathil"
    assert {link.person.display_name for link in traversal.parents(thomas)} == {
        "Mathai",
        "Aleyamma",
    }


def test_quick_add_accepts_a_single_known_parent(admin_client):
    """ "We know the mother, nobody remembers the father" must be one submit too."""
    response = admin_client.post(
        reverse("admin:genealogy_quick_add"),
        quick_add_payload(
            new_partner_1="",
            new_partner_2="Eliyamma",
            new_partner_2_gender=Gender.FEMALE,
            union_type="unknown",
            children="Varkey | m | 1940",
        ),
    )
    assert response.status_code == 302

    varkey = Person.objects.get(name_en="Varkey")
    parents = traversal.parents(varkey)
    assert {link.person.display_name for link in parents} == {"Eliyamma"}


def test_quick_add_attaches_children_to_an_existing_person(admin_client, family_a):
    admin_client.post(
        reverse("admin:genealogy_quick_add"),
        quick_add_payload(
            existing_partner_1=str(family_a.sunil.pk),
            new_partner_2="Anitha",
            children="Meera | f | 2000",
        ),
    )
    assert {link.person.display_name for link in traversal.children(family_a.sunil)} == {
        "Nithin",
        "Meera",
    }


def test_quick_add_requires_at_least_one_partner(admin_client):
    response = admin_client.post(
        reverse("admin:genealogy_quick_add"), quick_add_payload(children="Orphan | m")
    )
    assert response.status_code == 200
    assert "Name at least one partner" in response.content.decode()
    assert not Person.objects.filter(name_en="Orphan").exists()


def test_quick_add_marks_adopted_children(admin_client):
    admin_client.post(
        reverse("admin:genealogy_quick_add"),
        quick_add_payload(
            new_partner_1="Devassy",
            new_partner_2="Kunjamma",
            children="Baby | f\nOuseph | m | adopted",
        ),
    )
    membership = UnionMembership.objects.get(person__name_en="Ouseph", role=Role.CHILD)
    assert membership.relation_type == RelationType.ADOPTED


@pytest.mark.parametrize(
    ("line", "expected"),
    [
        (
            "Thomas",
            {
                "name_en": "Thomas",
                "gender": Gender.UNKNOWN,
                "relation_type": RelationType.BIOLOGICAL,
            },
        ),
        (
            "Thomas | m",
            {"name_en": "Thomas", "gender": Gender.MALE, "relation_type": RelationType.BIOLOGICAL},
        ),
        (
            "Rosy | f | 1945",
            {
                "name_en": "Rosy",
                "gender": Gender.FEMALE,
                "relation_type": RelationType.BIOLOGICAL,
                "birth_year": 1945,
            },
        ),
        (
            "Ouseph | male | 1952 | adopted",
            {
                "name_en": "Ouseph",
                "gender": Gender.MALE,
                "relation_type": "adopted",
                "birth_year": 1952,
            },
        ),
        ("  ", None),
        (
            "തോമ്മാ",
            {"name_en": "തോമ്മാ", "gender": Gender.UNKNOWN, "relation_type": RelationType.BIOLOGICAL},
        ),
    ],
)
def test_child_line_parsing(line, expected):
    assert parse_child_line(line) == expected


def test_child_line_ignores_noise_instead_of_refusing_it():
    """Contributors type fast; unknown extras are dropped, not rejected."""
    assert parse_child_line("Thomas | ??? | m") == {
        "name_en": "Thomas",
        "gender": Gender.MALE,
        "relation_type": RelationType.BIOLOGICAL,
    }


# ---------------------------------------------------------------- union screen


def test_union_admin_saves_partners_and_children_from_one_form(admin_client):
    father = Person.objects.create(name_en="Chandy", gender=Gender.MALE)
    mother = Person.objects.create(name_en="Thresia", gender=Gender.FEMALE)
    child = Person.objects.create(name_en="Jacob", gender=Gender.MALE)

    response = admin_client.post(
        reverse("admin:genealogy_union_add"),
        {
            "union_type": "marriage",
            "status": "unknown",
            "year_min": "1926",
            "year_max": "1926",
            "date_exact": "",
            "place": "Perumbally",
            "notes": "",
            "partners-TOTAL_FORMS": "2",
            "partners-INITIAL_FORMS": "0",
            "partners-MIN_NUM_FORMS": "0",
            "partners-MAX_NUM_FORMS": "1000",
            "partners-0-person": str(father.pk),
            "partners-0-notes": "",
            "partners-1-person": str(mother.pk),
            "partners-1-notes": "",
            "children-TOTAL_FORMS": "1",
            "children-INITIAL_FORMS": "0",
            "children-MIN_NUM_FORMS": "0",
            "children-MAX_NUM_FORMS": "1000",
            "children-0-person": str(child.pk),
            "children-0-relation_type": RelationType.BIOLOGICAL,
            "children-0-sibling_order": "1",
            "children-0-notes": "",
        },
    )
    assert response.status_code == 302

    union = Union.objects.get()
    assert {m.person.display_name for m in union.memberships.filter(role=Role.PARTNER)} == {
        "Chandy",
        "Thresia",
    }
    assert {m.person.display_name for m in union.memberships.filter(role=Role.CHILD)} == {"Jacob"}
    assert {link.person.display_name for link in traversal.parents(child)} == {"Chandy", "Thresia"}
