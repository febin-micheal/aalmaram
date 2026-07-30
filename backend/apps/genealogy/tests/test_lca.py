"""Common ancestors and both descent paths — the Phase 4 showpiece's foundation."""

import pytest

from apps.genealogy.factories import make_person, make_union
from apps.genealogy.graph.lca import describe_relationship, lowest_common_ancestors

pytestmark = pytest.mark.django_db


def ancestor_names(results):
    return {result.person.display_name for result in results}


def path_names(people):
    return [person.display_name for person in people]


def test_full_siblings_share_both_parents(family_a):
    results = lowest_common_ancestors(family_a.thomas, family_a.rosy)
    assert ancestor_names(results) == {"Chacko", "Annamma"}
    assert all((r.depth_subject, r.depth_other) == (1, 1) for r in results)


def test_half_siblings_share_exactly_one_ancestor(family_a):
    results = lowest_common_ancestors(family_a.thomas, family_a.joseph)
    assert ancestor_names(results) == {"Chacko"}
    assert (results[0].depth_subject, results[0].depth_other) == (1, 1)


def test_parent_is_their_own_common_ancestor_with_their_child(family_a):
    results = lowest_common_ancestors(family_a.jose, family_a.thomas)
    assert ancestor_names(results) == {"Thomas"}
    assert (results[0].depth_subject, results[0].depth_other) == (1, 0)


def test_first_cousins_meet_at_the_grandparents(family_a):
    results = lowest_common_ancestors(family_a.jose, family_a.bibin)
    # Jose and Bibin descend from Chacko's two different marriages, so only Chacko is
    # shared — the grandmothers differ.
    assert ancestor_names(results) == {"Chacko"}
    assert (results[0].depth_subject, results[0].depth_other) == (2, 2)


def test_second_cousins_meet_at_the_great_grandparents(family_a):
    results = lowest_common_ancestors(family_a.sunil, family_a.jose)
    assert ancestor_names(results) == {"Ittira", "Mariam"}
    assert all((r.depth_subject, r.depth_other) == (3, 3) for r in results)


def test_lca_returns_both_descent_paths(family_a):
    results = lowest_common_ancestors(family_a.kiran, family_a.bibin)
    assert len(results) == 1
    result = results[0]
    assert result.person == family_a.chacko
    assert path_names(result.path_subject) == ["Kiran", "Arun", "Jose", "Thomas", "Chacko"]
    assert path_names(result.path_other) == ["Bibin", "Joseph", "Chacko"]
    assert path_names(result.descent_to_subject()) == ["Chacko", "Thomas", "Jose", "Arun", "Kiran"]
    assert path_names(result.descent_to_other()) == ["Chacko", "Joseph", "Bibin"]
    assert result.total_distance == 6


def test_lca_through_an_unknown_parent(family_a):
    """Varkey's father is unknown, so the route can only run through Eliyamma."""
    results = lowest_common_ancestors(family_a.sunil, family_a.rosy)
    assert ancestor_names(results) == {"Ittira", "Mariam"}
    subject_path = path_names(next(iter(results)).path_subject)
    assert subject_path[:3] == ["Sunil", "Varkey", "Eliyamma"]


def test_disconnected_families_have_no_common_ancestor(two_families):
    family_a, family_b = two_families
    assert lowest_common_ancestors(family_a.thomas, family_b.manoj) == []
    assert lowest_common_ancestors(family_a.kiran, family_b.athira) == []


def test_marriage_between_families_creates_no_blood_relationship(bridged_families):
    """The components are connected, but Anju and Vishnu still share no ancestor."""
    assert lowest_common_ancestors(bridged_families.a.anju, bridged_families.b.vishnu) == []
    assert lowest_common_ancestors(bridged_families.a.arun, bridged_families.b.athira) == []


def test_a_person_is_their_own_common_ancestor(family_a):
    results = lowest_common_ancestors(family_a.thomas, family_a.thomas)
    assert ancestor_names(results) == {"Thomas"}
    assert (results[0].depth_subject, results[0].depth_other) == (0, 0)


def test_cousin_marriage_prefers_the_nearest_shared_ancestor():
    """Pedigree collapse: two routes to the same couple, plus a nearer link."""
    ancestor_m = make_person("Ancestor M", birth=1880)
    ancestor_f = make_person("Ancestor F", birth=1884)
    child_one = make_person("Branch One", birth=1910)
    child_two = make_person("Branch Two", birth=1913)
    make_union(ancestor_m, ancestor_f, children=[child_one, child_two], year=1905)

    cousin_a = make_person("Cousin A", birth=1940)
    cousin_b = make_person("Cousin B", birth=1942)
    make_union(child_one, make_person("Spouse One", birth=1915), children=[cousin_a], year=1938)
    make_union(child_two, make_person("Spouse Two", birth=1918), children=[cousin_b], year=1939)

    # The cousins marry, and their child descends from the same couple twice over.
    shared_child = make_person("Descendant", birth=1970)
    make_union(cousin_a, cousin_b, children=[shared_child], year=1965)

    results = lowest_common_ancestors(shared_child, cousin_a)
    assert ancestor_names(results) == {"Cousin A"}
    assert (results[0].depth_subject, results[0].depth_other) == (1, 0)

    # And from the child's own perspective the ancestral couple is reachable at depth 3
    # by two different routes without the walk multiplying out of control.
    results = lowest_common_ancestors(shared_child, ancestor_m)
    assert ancestor_names(results) == {"Ancestor M"}
    assert results[0].depth_subject == 3


# --------------------------------------------------------- relationship naming


@pytest.mark.parametrize(
    ("subject", "other", "expected_en"),
    [
        ("thomas", "rosy", "sister"),
        ("rosy", "thomas", "brother"),
        ("thomas", "joseph", "half-brother"),
        ("joseph", "thomas", "half-brother"),
        ("jose", "thomas", "father"),
        ("jose", "gracy", "mother"),
        ("thomas", "jose", "son"),
        ("thomas", "mini", "daughter"),
        ("kiran", "chacko", "great-great-grandfather"),
        ("chacko", "kiran", "great-great-grandson"),
        ("kiran", "ittira", "great-great-great-grandfather"),
        ("jose", "rosy", "aunt"),
        ("jose", "joseph", "half-uncle"),
        ("rosy", "jose", "nephew"),
        ("rosy", "mini", "niece"),
        ("jose", "bibin", "half-first cousin"),
        ("sunil", "jose", "second cousin"),
        ("thomas", "gracy", "wife"),
        ("gracy", "thomas", "husband"),
        # Their grandfathers are Chacko's sons by different wives, so the shared line
        # narrows to one person and the cousinhood is a half one.
        ("arun", "adithyan", "half-second cousin"),
        ("kiran", "anju", "aunt"),
        ("deepa", "ouseph", "uncle"),
        ("ouseph", "deepa", "niece"),
        ("arun", "kiran", "son"),
        ("kiran", "mini", "great-aunt"),
    ],
)
def test_english_relationship_labels(family_a, subject, other, expected_en):
    result = describe_relationship(getattr(family_a, subject), getattr(family_a, other))
    assert result.label_en == expected_en


@pytest.mark.parametrize(
    ("subject", "other", "expected_ml"),
    [
        ("jose", "thomas", "അച്ഛൻ"),
        ("jose", "gracy", "അമ്മ"),
        ("thomas", "jose", "മകൻ"),
        ("thomas", "mini", "മകൾ"),
        ("rosy", "thomas", "ചേട്ടൻ"),
        ("thomas", "rosy", "അനിയത്തി"),
        ("arun", "anju", "അനിയത്തി"),
        ("anju", "arun", "ചേട്ടൻ"),
        ("thomas", "joseph", "അർദ്ധസഹോദരൻ"),
        ("jose", "chacko", "മുത്തച്ഛൻ"),
        ("jose", "annamma", "മുത്തശ്ശി"),
        ("kiran", "arun", "അച്ഛൻ"),
        ("arun", "kiran", "മകൻ"),
        ("jose", "arun", "മകൻ"),
        ("chacko", "jose", "കൊച്ചുമകൻ"),
        # Malayalam encodes which side of the family an uncle is on: Deepa's mother's
        # brother is an അമ്മാവൻ, while Jose's father's younger brother is a ചെറിയച്ഛൻ.
        ("deepa", "ouseph", "അമ്മാവൻ"),
        ("jose", "joseph", "ചെറിയച്ഛൻ"),
        ("jose", "rosy", "അമ്മായി"),
        ("rosy", "jose", "അനന്തരവൻ"),
        ("thomas", "gracy", "ഭാര്യ"),
        ("gracy", "thomas", "ഭർത്താവ്"),
    ],
)
def test_malayalam_relationship_labels(family_a, subject, other, expected_ml):
    result = describe_relationship(getattr(family_a, subject), getattr(family_a, other))
    assert result.label_ml == expected_ml


def test_malayalam_falls_back_when_birth_order_is_unknown():
    """Without birth order there is no honest choice between ചേട്ടൻ and അനിയൻ."""
    father = make_person("Father", birth=1900)
    mother = make_person("Mother", birth=1905)
    from apps.genealogy.models import Gender

    one = make_person("Sibling One", gender=Gender.MALE)
    two = make_person("Sibling Two", gender=Gender.MALE)
    make_union(father, mother, children=[one, two], year=1925)

    result = describe_relationship(one, two)
    assert result.label_ml == "സഹോദരൻ"
    assert result.label_en == "brother"


def test_unrelated_people_are_reported_as_such(two_families):
    family_a, family_b = two_families
    result = describe_relationship(family_a.thomas, family_b.manoj)
    assert not result.is_related
    assert result.label_en == "no known relationship"
    assert result.common_ancestors == []


def test_marriage_across_families_is_still_not_a_blood_relationship(bridged_families):
    result = describe_relationship(bridged_families.a.arun, bridged_families.b.vishnu)
    assert not result.is_related


def test_step_siblings_are_named_without_a_common_ancestor():
    father = make_person("Chandy", birth=1930)
    first_wife = make_person("Thresia", birth=1934)
    from apps.genealogy.models import Gender

    ego = make_person("Jacob", gender=Gender.MALE, birth=1958)
    make_union(father, first_wife, children=[ego], year=1955)

    second_wife = make_person("Sosamma", birth=1940)
    her_first_husband = make_person("Varghese", birth=1936)
    step_sister = make_person("Mercy", gender=Gender.FEMALE, birth=1962)
    make_union(her_first_husband, second_wife, children=[step_sister], year=1960)
    make_union(father, second_wife, year=1970)

    result = describe_relationship(ego, step_sister)
    assert result.label_en == "step-sister"
    assert result.label_ml == "രണ്ടാൻ സഹോദരി"


def test_self_relationship(family_a):
    result = describe_relationship(family_a.thomas, family_a.thomas)
    assert result.label_en == "the same person"


def test_describe_renders_a_sentence(family_a):
    result = describe_relationship(family_a.jose, family_a.thomas)
    assert result.describe("en") == "Thomas is Jose's father"
    assert result.labels() == {"en": "father", "ml": "അച്ഛൻ"}


def test_relationship_result_carries_the_paths(family_a):
    result = describe_relationship(family_a.sunil, family_a.jose)
    assert len(result.common_ancestors) == 2
    for common in result.common_ancestors:
        assert path_names(common.path_subject)[0] == "Sunil"
        assert path_names(common.path_other)[0] == "Jose"
        assert common.path_subject[-1] == common.person
