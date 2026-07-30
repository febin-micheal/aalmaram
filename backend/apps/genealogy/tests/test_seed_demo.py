"""The seed command backs the "200+ persons across 5 generations" acceptance check."""

import pytest
from django.core.management import call_command

from apps.genealogy.graph import traversal
from apps.genealogy.models import Person, RelationType, Role, Union, UnionMembership

pytestmark = pytest.mark.django_db


@pytest.fixture
def seeded():
    call_command("seed_demo", verbosity=0)


def test_seed_creates_enough_people_to_stress_the_admin(seeded):
    assert Person.objects.canonical().count() >= 200


def test_seed_spans_at_least_five_generations(seeded):
    deepest = max(
        len(traversal.ancestor_depths(person))
        and max(traversal.ancestor_depths(person).values(), default=0)
        for person in Person.objects.order_by("-birth_year_min")[:40]
    )
    # Five generations of people means four generational hops from youngest to oldest.
    assert deepest >= 4


def test_seed_includes_the_awkward_cases(seeded):
    """A clean synthetic tree would not exercise the traversal code."""
    single_partner_unions = [
        union
        for union in Union.objects.prefetch_related("memberships")
        if sum(1 for m in union.memberships.all() if m.role == Role.PARTNER) == 1
        and any(m.role == Role.CHILD for m in union.memberships.all())
    ]
    assert single_partner_unions, "expected at least one union with an unknown parent"
    assert UnionMembership.objects.filter(relation_type=RelationType.ADOPTED).exists()

    remarried = [
        person
        for person in Person.objects.all()
        if UnionMembership.objects.filter(person=person, role=Role.PARTNER).count() > 1
    ]
    assert remarried, "expected at least one remarriage"


def test_seed_queues_duplicates_for_the_merge_screen(seeded):
    from apps.merging.models import MergeCandidate

    assert MergeCandidate.objects.exists()
    candidate = MergeCandidate.objects.first()
    assert candidate.person_a.name_en == candidate.person_b.name_en
    assert 0 < candidate.score <= 1


def test_seed_is_deterministic():
    call_command("seed_demo", verbosity=0)
    first = list(
        Person.objects.order_by("created_at", "id").values_list("name_en", "birth_year_min")
    )

    call_command("seed_demo", "--reset", verbosity=0)
    second = list(
        Person.objects.order_by("created_at", "id").values_list("name_en", "birth_year_min")
    )

    assert first == second


def test_seeded_graph_traverses(seeded):
    """Whatever the RNG produced, the graph library has to cope with it."""
    youngest = Person.objects.order_by("-birth_year_min").first()
    ancestors = traversal.ancestors(youngest)
    assert ancestors
    for relative in ancestors:
        assert relative.depth >= 1
    ego = traversal.ego_network(youngest)
    assert ego.person == youngest
