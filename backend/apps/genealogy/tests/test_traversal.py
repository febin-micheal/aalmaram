"""Traversal against the fixture families.

The cases that matter are the awkward ones: a remarriage that produces half-siblings, a
union with a single recorded partner standing in for an unknown father, and an adopted
child who is fully a member of the family graph while staying labelled as adopted.
"""

import pytest

from apps.genealogy.factories import make_person, make_union
from apps.genealogy.graph import traversal
from apps.genealogy.models import Person, PersonStatus, RelationType

pytestmark = pytest.mark.django_db


def names(links):
    return {link.person.display_name for link in links}


def depth_map(relatives):
    return {rel.person.display_name: rel.depth for rel in relatives}


# --------------------------------------------------------------------- one hop


def test_parents_of_a_child_of_a_two_partner_union(family_a):
    assert names(traversal.parents(family_a.thomas)) == {"Chacko", "Annamma"}


def test_unknown_father_yields_a_single_parent(family_a):
    """Varkey's union of birth has only his mother recorded — that must not break."""
    links = traversal.parents(family_a.varkey)
    assert names(links) == {"Eliyamma"}
    assert traversal.parents(family_a.eliyamma) != []  # her own parents are known


def test_person_with_no_recorded_parents(family_a):
    assert traversal.parents(family_a.ittira) == []


def test_children_span_every_union_a_person_is_a_partner_in(family_a):
    """Chacko married twice; both sets of children are his."""
    assert names(traversal.children(family_a.chacko)) == {"Thomas", "Rosy", "Joseph", "Lucy"}


def test_children_are_ordered_by_sibling_order(family_a):
    ordered = [link.person.display_name for link in traversal.children(family_a.ittira)]
    assert ordered == ["Chacko", "Eliyamma", "Devassy"]


def test_adopted_child_is_a_child_with_the_relation_preserved(family_a):
    links = {link.person.display_name: link for link in traversal.children(family_a.devassy)}
    assert set(links) == {"Baby", "Ouseph"}
    assert links["Ouseph"].relation_type == RelationType.ADOPTED
    assert links["Baby"].relation_type == RelationType.BIOLOGICAL


def test_remarriage_gives_two_partners(family_a):
    links = traversal.partners(family_a.chacko)
    assert names(links) == {"Annamma", "Saramma"}
    # One link per union, ordered oldest union first.
    assert [link.person.display_name for link in links] == ["Annamma", "Saramma"]


def test_partner_of_a_single_partner_union_is_empty(family_a):
    assert traversal.partners(family_a.eliyamma) == []


# -------------------------------------------------------------------- siblings


def test_remarriage_produces_half_siblings(family_a):
    by_name = {link.person.display_name: link for link in traversal.siblings(family_a.thomas)}
    assert set(by_name) == {"Rosy", "Joseph", "Lucy"}
    assert by_name["Rosy"].kind == "full"
    assert by_name["Joseph"].kind == "half"
    assert by_name["Lucy"].kind == "half"


def test_half_sibling_relation_is_symmetric(family_a):
    by_name = {link.person.display_name: link for link in traversal.siblings(family_a.joseph)}
    assert by_name["Lucy"].kind == "full"
    assert by_name["Thomas"].kind == "half"
    assert by_name["Rosy"].kind == "half"


def test_half_siblings_share_exactly_one_parent(family_a):
    link = next(
        link for link in traversal.siblings(family_a.thomas) if link.person == family_a.joseph
    )
    assert link.shared_parent_ids == (family_a.chacko.id,)
    assert link.is_half


def test_full_siblings_share_both_parents(family_a):
    link = next(
        link for link in traversal.siblings(family_a.thomas) if link.person == family_a.rosy
    )
    assert set(link.shared_parent_ids) == {family_a.chacko.id, family_a.annamma.id}


def test_only_child_has_no_siblings(family_a):
    assert traversal.siblings(family_a.varkey) == []


def test_co_children_of_one_union_are_full_siblings_even_when_adopted(family_a):
    link = next(
        link for link in traversal.siblings(family_a.baby) if link.person == family_a.ouseph
    )
    assert link.kind == "full"


def test_step_siblings_are_classified_as_step():
    """A parent's new spouse brings children of their own — no shared parent at all."""
    father = make_person("Chandy", birth=1930)
    first_wife = make_person("Thresia", birth=1934)
    ego = make_person("Jacob", birth=1958)
    make_union(father, first_wife, children=[ego], year=1955)

    second_wife = make_person("Sosamma", birth=1940)
    her_earlier_husband = make_person("Varghese", birth=1936)
    step_child = make_person("Mercy", birth=1962)
    make_union(her_earlier_husband, second_wife, children=[step_child], year=1960)
    make_union(father, second_wife, year=1970)

    by_name = {link.person.display_name: link for link in traversal.siblings(ego)}
    assert by_name["Mercy"].kind == "step"
    assert by_name["Mercy"].shared_parent_ids == ()

    assert "Mercy" not in {
        link.person.display_name for link in traversal.siblings(ego, include_step=False)
    }


def test_children_recorded_as_step_in_a_shared_union_are_not_half_siblings():
    """relation_type=step overrides the shared-parent arithmetic."""
    father = make_person("Kuruvilla", birth=1930)
    mother = make_person("Aleyamma", birth=1935)
    own = make_person("Biju", birth=1960)
    brought_along = make_person("Sini", birth=1957)
    make_union(
        father,
        mother,
        children=[own, (brought_along, RelationType.STEP)],
        year=1958,
    )
    link = next(link for link in traversal.siblings(own) if link.person == brought_along)
    assert link.kind == "step"


# ------------------------------------------------------------------ deep walks


def test_ancestors_across_six_generations(family_a):
    assert depth_map(traversal.ancestors(family_a.kiran)) == {
        "Arun": 1,
        "Riya": 1,
        "Jose": 2,
        "Sheeba": 2,
        "Thomas": 3,
        "Gracy": 3,
        "Chacko": 4,
        "Annamma": 4,
        "Ittira": 5,
        "Mariam": 5,
    }


def test_ancestors_through_an_unknown_parent(family_a):
    """The missing father simply contributes no ancestors; the mother's line still walks."""
    assert depth_map(traversal.ancestors(family_a.varkey)) == {
        "Eliyamma": 1,
        "Ittira": 2,
        "Mariam": 2,
    }


def test_adoption_creates_real_ancestry(family_a):
    assert depth_map(traversal.ancestors(family_a.ouseph)) == {
        "Devassy": 1,
        "Kunjamma": 1,
        "Ittira": 2,
        "Mariam": 2,
    }


def test_descendants_include_both_marriages(family_a):
    assert depth_map(traversal.descendants(family_a.chacko)) == {
        "Thomas": 1,
        "Rosy": 1,
        "Joseph": 1,
        "Lucy": 1,
        "Jose": 2,
        "Mini": 2,
        "Bibin": 2,
        "Arun": 3,
        "Anju": 3,
        "Adithyan": 3,
        "Kiran": 4,
    }


def test_descendant_depth_is_the_shortest_route(family_a):
    depths = traversal.descendant_depths(family_a.ittira)
    assert depths[family_a.chacko.id] == 1
    assert depths[family_a.kiran.id] == 5


def test_max_depth_bounds_the_walk(family_a):
    assert depth_map(traversal.ancestors(family_a.kiran, max_depth=2)) == {
        "Arun": 1,
        "Riya": 1,
        "Jose": 2,
        "Sheeba": 2,
    }


def test_leaf_person_has_no_descendants(family_a):
    assert traversal.descendants(family_a.kiran) == []


def test_ancestor_path_returns_the_chain(family_a):
    path = traversal.ancestor_path(family_a.kiran, family_a.chacko, 4)
    assert path == [
        family_a.kiran.id,
        family_a.arun.id,
        family_a.jose.id,
        family_a.thomas.id,
        family_a.chacko.id,
    ]


def test_ancestor_path_is_empty_when_unrelated(two_families):
    family_a, family_b = two_families
    assert traversal.ancestor_path(family_a.kiran, family_b.kesavan, 6) == []


def test_walk_survives_a_cycle_in_the_data():
    """Bad data must terminate the walk, not hang it."""
    a = make_person("A", birth=1900)
    b = make_person("B", birth=1930)
    make_union(a, children=[b])
    make_union(b, children=[a])  # B is now recorded as A's parent too

    # The depth cap stops the loop; A is reachable from itself but is excluded as the
    # root, so only B comes back — and the query returns rather than spinning.
    assert depth_map(traversal.ancestors(a, max_depth=6)) == {"B": 1}
    assert depth_map(traversal.descendants(a, max_depth=6)) == {"B": 1}


# ------------------------------------------------------- merged persons resolve


def test_traversal_from_a_merged_person_resolves_to_the_canonical_one(family_a):
    stale = make_person("Duplicate Thomas", birth=1942)
    Person.objects.filter(pk=stale.pk).update(
        status=PersonStatus.MERGED_INTO, merged_into=family_a.thomas
    )
    stale.refresh_from_db()

    # Both entry styles have to land on Thomas: a bare id (resolved with a lookup) and
    # a loaded Person (resolved from its own merge pointer).
    assert traversal.resolve_id(stale.id) == family_a.thomas.id
    assert traversal.resolve_id(stale) == family_a.thomas.id
    assert names(traversal.parents(stale)) == {"Chacko", "Annamma"}
    assert names(traversal.parents(stale.id)) == {"Chacko", "Annamma"}


def test_merged_people_are_not_returned_as_relatives(family_a):
    Person.objects.filter(pk=family_a.rosy.pk).update(
        status=PersonStatus.MERGED_INTO, merged_into=family_a.thomas
    )
    assert "Rosy" not in names(traversal.children(family_a.chacko))
    assert family_a.rosy.id not in traversal.descendant_depths(family_a.ittira)


# ----------------------------------------------------------------- ego network


def test_ego_network_gathers_the_person_page(family_a):
    ego = traversal.ego_network(family_a.thomas)
    assert ego.person == family_a.thomas
    assert names(ego.parents) == {"Chacko", "Annamma"}
    assert names(ego.siblings) == {"Rosy", "Joseph", "Lucy"}
    assert names(ego.partners) == {"Gracy"}
    assert names(ego.children) == {"Jose", "Mini"}


def test_ego_network_of_an_isolated_person():
    lonely = make_person("Unconnected", birth=1900)
    ego = traversal.ego_network(lonely)
    assert (ego.parents, ego.siblings, ego.partners, ego.children) == ([], [], [], [])


# ------------------------------------------------------------------ birth order


def test_is_elder_prefers_recorded_sibling_order(family_a):
    assert traversal.is_elder(family_a.thomas, family_a.rosy) is True
    assert traversal.is_elder(family_a.rosy, family_a.thomas) is False


def test_is_elder_falls_back_to_estimated_years(family_a):
    # Different unions, so sibling_order cannot be compared directly.
    assert traversal.is_elder(family_a.thomas, family_a.joseph) is True


def test_is_elder_admits_ignorance():
    one = make_person("One")
    other = make_person("Other")
    assert traversal.is_elder(one, other) is None
