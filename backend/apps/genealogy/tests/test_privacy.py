"""The living/deceased visibility rule.

CLAUDE.md requires this to be enforced at the queryset level rather than in views, so
these tests exercise ``Person.objects.visible_to()`` directly and check that the work
actually happens in SQL.
"""

import pytest
from django.contrib.auth import get_user_model

from apps.genealogy.factories import make_person
from apps.genealogy.graph.privacy import relatives_within
from apps.genealogy.models import Person

pytestmark = pytest.mark.django_db


def visible_names(anchor, **kwargs):
    return set(Person.objects.visible_to(anchor, **kwargs).values_list("name_en", flat=True))


def test_degrees_count_parent_child_sibling_and_partner_as_one_hop(family_a):
    degrees = relatives_within(family_a.arun, degrees=3)
    named = {Person.objects.get(pk=pid).display_name: degree for pid, degree in degrees.items()}

    assert named["Arun"] == 0
    assert named["Riya"] == 1  # partner
    assert named["Kiran"] == 1  # child
    assert named["Jose"] == 1  # parent
    assert named["Anju"] == 1  # sibling
    assert named["Thomas"] == 2  # grandparent
    assert named["Mini"] == 2  # parent's sibling, reached through their shared union
    assert named["Rosy"] == 3  # grandparent's sibling
    assert "Joseph" not in named  # grandparent's half-sibling sits at 4
    assert "Ittira" not in named


def test_first_cousins_are_inside_the_radius(family_a):
    """Three degrees is chosen so first cousins are family; see DECISIONS.md #2."""
    degrees = relatives_within(family_a.thomas, degrees=3)
    assert degrees[family_a.varkey.id] == 3


def test_half_siblings_cost_two_hops(family_a):
    """An honest consequence of "one degree = one shared union".

    Full siblings are co-members of a single union and so are one hop apart. Half
    siblings share no union — they meet only at the shared parent — so they sit two hops
    apart. Everything on that side of the family is therefore one degree further away,
    which is why Jose's half-first cousin Bibin falls outside the radius while his true
    first cousins do not.
    """
    from_thomas = relatives_within(family_a.thomas, degrees=3)
    assert from_thomas[family_a.rosy.id] == 1  # full sibling
    assert from_thomas[family_a.joseph.id] == 2  # half sibling

    from_jose = relatives_within(family_a.jose, degrees=3)
    assert family_a.bibin.id not in from_jose


def test_deceased_people_are_visible_to_everyone(family_a):
    visible = visible_names(family_a.arun)
    # Long dead, and nowhere near Arun in the graph.
    assert {"Ittira", "Mariam", "Eliyamma", "Varkey", "Joseph"} <= visible


def test_living_people_outside_the_radius_are_hidden(family_a):
    visible = visible_names(family_a.arun)
    # Bibin is alive and five hops away.
    assert "Bibin" not in visible
    assert "Adithyan" not in visible
    assert "Deepa" not in visible


def test_living_people_inside_the_radius_are_visible(family_a):
    visible = visible_names(family_a.arun)
    assert {"Arun", "Riya", "Kiran", "Anju", "Sheeba"} <= visible


def test_explicit_consent_overrides_the_radius(family_a):
    assert "Bibin" not in visible_names(family_a.arun)
    Person.objects.filter(pk=family_a.bibin.pk).update(visibility_consent=True)
    assert "Bibin" in visible_names(family_a.arun)


def test_a_viewer_without_an_anchor_sees_only_the_dead_and_the_consenting(family_a):
    visible = visible_names(None)
    assert "Ittira" in visible
    assert "Arun" not in visible

    Person.objects.filter(pk=family_a.arun.pk).update(visibility_consent=True)
    assert "Arun" in visible_names(None)


def test_the_radius_is_configurable(family_a):
    assert "Riya" in visible_names(family_a.arun, degrees=1)
    assert "Riya" not in visible_names(family_a.arun, degrees=0)


def test_marriage_between_families_opens_the_in_laws(bridged_families):
    """Anju married into family B, so her spouse's close living family is in range."""
    anju = bridged_families.a.anju
    visible = visible_names(anju)
    assert "Vishnu" in visible  # spouse, 1 degree
    assert "Athira" in visible  # spouse's sibling, 2 degrees
    assert "Manoj" in visible  # spouse's parent, 2 degrees
    assert "Suja" in visible  # spouse's parent's sibling, 3 degrees
    # Her own half-cousins remain out of range: marrying in widens the radius on one
    # side only, exactly as far as three hops reach.
    assert "Bibin" not in visible
    assert "Deepa" not in visible


def test_anchor_can_be_a_user(family_a):
    user = get_user_model().objects.create_user(
        email="member@example.invalid", password="x", anchor_person=family_a.arun
    )
    assert visible_names(user) == visible_names(family_a.arun)


def test_a_user_without_an_anchor_gets_the_restricted_view(family_a):
    user = get_user_model().objects.create_user(email="staff@example.invalid", password="x")
    assert "Arun" not in visible_names(user)
    assert "Ittira" in visible_names(user)


def test_visibility_is_a_single_database_query(family_a, django_assert_num_queries):
    """The rule is a filter, not a Python loop — it has to compose with pagination."""
    with django_assert_num_queries(1):
        list(Person.objects.visible_to(family_a.arun).values_list("id", flat=True))


def test_visibility_composes_with_other_filters(family_a):
    queryset = Person.objects.visible_to(family_a.arun).canonical().filter(house_name="Kavunkal")
    names = set(queryset.values_list("name_en", flat=True))
    assert "Kiran" in names
    assert "Bibin" not in names  # living, out of range
    assert "Riya" not in names  # in range, but a different house


def test_a_merged_anchor_resolves_to_its_canonical_person(family_a):
    from apps.genealogy.models import PersonStatus

    stale = make_person("Stale Arun", birth=1998, living=True)
    Person.objects.filter(pk=stale.pk).update(
        status=PersonStatus.MERGED_INTO, merged_into=family_a.arun
    )
    stale.refresh_from_db()
    assert visible_names(stale) == visible_names(family_a.arun)
