"""The bounded subgraph around one person, shaped for drawing.

The explorer never loads the whole database. It asks for a neighbourhood — a centre
person plus a few generations either way — and fetches more only when the user expands a
node. This module decides what "a few generations either way" should contain.

Ancestors and descendants alone would draw a pedigree, not a family: no siblings, no
aunts and uncles, no spouses. So a neighbourhood is:

    ancestors(up) + centre + descendants(down)
    + the children of every ancestor      → siblings, aunts and uncles
    + the partners of everyone included   → so each union can be drawn whole

Cousins are deliberately *not* included. They are one expand-click away from an aunt or
uncle, and pulling them in by default doubles the node count of the first screen for
people the viewer usually is not looking for.

Every person carries a `generation` relative to the centre (0 = centre, negative above,
positive below) and a count of how many parents/children were left out, which is what
the expand affordance on a node is drawn from.
"""

from dataclasses import dataclass, field
from uuid import UUID

from apps.genealogy.models import Person, PersonStatus, Role, Union, UnionMembership

from .traversal import ancestor_depths, descendant_depths, resolve_id


@dataclass
class Neighborhood:
    center_id: UUID
    generations_up: int
    generations_down: int
    persons: list[Person] = field(default_factory=list)
    unions: list[Union] = field(default_factory=list)
    memberships: list[UnionMembership] = field(default_factory=list)
    #: person id -> generation offset from the centre
    generations: dict[UUID, int] = field(default_factory=dict)
    #: person id -> how many parents / children exist but were not included
    hidden_up: dict[UUID, int] = field(default_factory=dict)
    hidden_down: dict[UUID, int] = field(default_factory=dict)
    #: union id -> generation of its partners
    union_generations: dict[UUID, int] = field(default_factory=dict)


def neighborhood(center, generations_up: int = 2, generations_down: int = 2) -> Neighborhood:
    center_id = resolve_id(center)
    if center_id is None:
        raise Person.DoesNotExist("No such person")

    generations: dict[UUID, int] = {center_id: 0}

    # Ancestors, then their children — the second pass is what produces siblings
    # (children of a depth-1 ancestor) and aunts/uncles (children of a depth-2 one).
    ancestors = ancestor_depths(center_id, max_depth=generations_up)
    for pid, depth in ancestors.items():
        generations.setdefault(pid, -depth)

    for pid, depth in descendant_depths(center_id, max_depth=generations_down).items():
        generations.setdefault(pid, depth)

    ancestor_generations = {center_id: 0} | {pid: -depth for pid, depth in ancestors.items()}
    for pid, generation in _children_of(ancestor_generations).items():
        generations.setdefault(pid, generation)

    # Partners last: they inherit the generation of whoever they are partnered with, and
    # never pull anyone new into the picture beyond themselves.
    for pid, generation in _partners_of(set(generations), generations).items():
        generations.setdefault(pid, generation)

    person_ids = set(generations)
    persons = list(Person.objects.filter(id__in=person_ids, status=PersonStatus.CANONICAL))
    person_ids = {person.id for person in persons}
    generations = {pid: gen for pid, gen in generations.items() if pid in person_ids}

    memberships = list(
        UnionMembership.objects.filter(person_id__in=person_ids)
        .select_related("union")
        .order_by("sibling_order", "created_at")
    )
    unions = {membership.union_id: membership.union for membership in memberships}

    union_generations: dict[UUID, int] = {}
    for membership in memberships:
        if membership.role == Role.PARTNER:
            generation = generations[membership.person_id]
            current = union_generations.get(membership.union_id)
            union_generations[membership.union_id] = (
                generation if current is None else max(current, generation)
            )
    for membership in memberships:
        # A union seen only through one of its children still needs a row: put it one
        # above that child, where its (unrecorded or unloaded) partners would sit.
        if membership.union_id not in union_generations and membership.role == Role.CHILD:
            union_generations[membership.union_id] = generations[membership.person_id] - 1

    hidden_up, hidden_down = _hidden_counts(person_ids)

    return Neighborhood(
        center_id=center_id,
        generations_up=generations_up,
        generations_down=generations_down,
        persons=persons,
        unions=list(unions.values()),
        memberships=memberships,
        generations=generations,
        hidden_up=hidden_up,
        hidden_down=hidden_down,
        union_generations=union_generations,
    )


def _children_of(parent_generations: dict[UUID, int]) -> dict[UUID, int]:
    """Children of the given people, each one generation below their parent.

    Fed the centre plus its ancestors, this yields siblings (children of a parent),
    aunts and uncles (children of a grandparent), and so on up the tree.
    """
    if not parent_generations:
        return {}

    union_generation: dict[UUID, int] = {}
    for union_id, person_id in UnionMembership.objects.filter(
        person_id__in=list(parent_generations), role=Role.PARTNER
    ).values_list("union_id", "person_id"):
        generation = parent_generations[person_id]
        current = union_generation.get(union_id)
        # If two known parents disagree, trust the one nearer the centre.
        union_generation[union_id] = generation if current is None else max(current, generation)

    if not union_generation:
        return {}

    children: dict[UUID, int] = {}
    for union_id, person_id in UnionMembership.objects.filter(
        union_id__in=list(union_generation), role=Role.CHILD
    ).values_list("union_id", "person_id"):
        children.setdefault(person_id, union_generation[union_id] + 1)
    return children


def _partners_of(person_ids: set[UUID], generations: dict[UUID, int]) -> dict[UUID, int]:
    """Partners of the given people, at the same generation as the person they married."""
    if not person_ids:
        return {}
    union_ids = set(
        UnionMembership.objects.filter(person_id__in=person_ids, role=Role.PARTNER).values_list(
            "union_id", flat=True
        )
    )
    if not union_ids:
        return {}

    by_union: dict[UUID, list[UUID]] = {}
    for union_id, person_id in UnionMembership.objects.filter(
        union_id__in=union_ids, role=Role.PARTNER
    ).values_list("union_id", "person_id"):
        by_union.setdefault(union_id, []).append(person_id)

    found: dict[UUID, int] = {}
    for members in by_union.values():
        known = [pid for pid in members if pid in generations]
        if not known:
            continue
        generation = generations[known[0]]
        for pid in members:
            if pid not in generations:
                found[pid] = generation
    return found


def _hidden_counts(person_ids: set[UUID]) -> tuple[dict[UUID, int], dict[UUID, int]]:
    """How many parents / children of each person were left outside the neighbourhood.

    This is what the "+2 ↑" chip on a node is drawn from: the user can see that there is
    more to load without the server having loaded it.
    """
    hidden_up: dict[UUID, int] = {}
    hidden_down: dict[UUID, int] = {}
    if not person_ids:
        return hidden_up, hidden_down

    child_links = list(
        UnionMembership.objects.filter(person_id__in=person_ids, role=Role.CHILD).values_list(
            "person_id", "union_id"
        )
    )
    partner_links = list(
        UnionMembership.objects.filter(person_id__in=person_ids, role=Role.PARTNER).values_list(
            "person_id", "union_id"
        )
    )

    parents_by_union: dict[UUID, set[UUID]] = {}
    for union_id, person_id in UnionMembership.objects.filter(
        union_id__in={union_id for _, union_id in child_links}, role=Role.PARTNER
    ).values_list("union_id", "person_id"):
        parents_by_union.setdefault(union_id, set()).add(person_id)

    children_by_union: dict[UUID, set[UUID]] = {}
    for union_id, person_id in UnionMembership.objects.filter(
        union_id__in={union_id for _, union_id in partner_links}, role=Role.CHILD
    ).values_list("union_id", "person_id"):
        children_by_union.setdefault(union_id, set()).add(person_id)

    for person_id, union_id in child_links:
        missing = parents_by_union.get(union_id, set()) - person_ids
        if missing:
            hidden_up[person_id] = hidden_up.get(person_id, 0) + len(missing)
    for person_id, union_id in partner_links:
        missing = children_by_union.get(union_id, set()) - person_ids
        if missing:
            hidden_down[person_id] = hidden_down.get(person_id, 0) + len(missing)

    return hidden_up, hidden_down
