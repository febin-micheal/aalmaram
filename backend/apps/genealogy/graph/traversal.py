"""One-hop and multi-hop traversal over the family graph."""

import uuid
from dataclasses import dataclass, field

from django.db import connection

from apps.genealogy.models import Person, RelationType, Role, Union, UnionMembership

from . import sql


@dataclass(frozen=True)
class Relative:
    """A person some number of generations above or below the subject."""

    person: Person
    depth: int


@dataclass(frozen=True)
class ParentLink:
    person: Person
    union: Union
    #: How the *child* attaches to this union: biological, adopted, step, unknown.
    relation_type: str


@dataclass(frozen=True)
class ChildLink:
    person: Person
    union: Union
    relation_type: str
    sibling_order: int | None


@dataclass(frozen=True)
class PartnerLink:
    person: Person
    union: Union
    union_type: str
    union_status: str


@dataclass(frozen=True)
class SiblingLink:
    person: Person
    #: full — same union, or both parents shared.
    #: half — exactly one shared parent, through different unions.
    #: step — linked only by a parent's later union, with no shared parent.
    kind: str
    shared_parent_ids: tuple[uuid.UUID, ...]
    sibling_order: int | None

    @property
    def is_half(self) -> bool:
        return self.kind == "half"


@dataclass
class EgoNetwork:
    """Everything the person page shows above the fold."""

    person: Person
    parents: list[ParentLink] = field(default_factory=list)
    siblings: list[SiblingLink] = field(default_factory=list)
    partners: list[PartnerLink] = field(default_factory=list)
    children: list[ChildLink] = field(default_factory=list)


def resolve_id(value) -> uuid.UUID | None:
    """Coerce a Person / UUID / str to the id of the surviving canonical Person.

    A merged-away person keeps all their edges repointed at the canonical row, so
    traversal must never start from the absorbed id.
    """
    if value is None:
        return None
    if isinstance(value, Person):
        return value.canonical_id
    pid = value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))
    row = Person.objects.filter(pk=pid).values_list("id", "merged_into_id").first()
    if row is None:
        return pid
    return row[1] or row[0]


def _fetch_depths(query: str, root: uuid.UUID, depth_cap: int | None) -> dict[uuid.UUID, int]:
    with connection.cursor() as cursor:
        cursor.execute(query, {"root": root, "max_depth": sql.max_depth(depth_cap)})
        return {row[0]: row[1] for row in cursor.fetchall()}


def ancestor_depths(
    person, max_depth: int | None = None, include_self: bool = False
) -> dict[uuid.UUID, int]:
    """Map every ancestor id to its shortest generational distance from `person`."""
    root = resolve_id(person)
    if root is None:
        return {}
    depths = _fetch_depths(sql.ANCESTOR_DEPTHS, root, max_depth)
    if not include_self:
        depths.pop(root, None)
    return depths


def descendant_depths(
    person, max_depth: int | None = None, include_self: bool = False
) -> dict[uuid.UUID, int]:
    """Map every descendant id to its shortest generational distance from `person`."""
    root = resolve_id(person)
    if root is None:
        return {}
    depths = _fetch_depths(sql.DESCENDANT_DEPTHS, root, max_depth)
    if not include_self:
        depths.pop(root, None)
    return depths


def _hydrate(depths: dict[uuid.UUID, int]) -> list[Relative]:
    if not depths:
        return []
    people = Person.objects.filter(id__in=list(depths)).in_bulk()
    relatives = [
        Relative(person=people[pid], depth=depth) for pid, depth in depths.items() if pid in people
    ]
    relatives.sort(key=lambda rel: (rel.depth, rel.person.display_name))
    return relatives


def ancestors(person, max_depth: int | None = None) -> list[Relative]:
    """All ancestors, nearest generation first."""
    return _hydrate(ancestor_depths(person, max_depth=max_depth))


def descendants(person, max_depth: int | None = None) -> list[Relative]:
    """All descendants, nearest generation first."""
    return _hydrate(descendant_depths(person, max_depth=max_depth))


def ancestor_path(descendant, ancestor, distance: int) -> list[uuid.UUID]:
    """Ids from `descendant` up to `ancestor` inclusive, shortest route.

    Returns [] when no route within `distance` exists.
    """
    start = resolve_id(descendant)
    target = resolve_id(ancestor)
    if start is None or target is None:
        return []
    if start == target:
        return [start]
    with connection.cursor() as cursor:
        cursor.execute(
            sql.ANCESTOR_PATH,
            {"start": start, "target": target, "target_depth": sql.max_depth(distance)},
        )
        row = cursor.fetchone()
    return list(row[0]) if row else []


def parents(person) -> list[ParentLink]:
    """Partners of every union in which `person` is recorded as a child.

    A union with a single partner means one parent is simply unknown — that is the
    normal way to record "we know her mother, nobody remembers her father".
    """
    pid = resolve_id(person)
    if pid is None:
        return []
    child_links = UnionMembership.objects.filter(person_id=pid, role=Role.CHILD).select_related(
        "union"
    )
    relation_by_union = {link.union_id: link.relation_type for link in child_links}
    if not relation_by_union:
        return []
    rows = (
        UnionMembership.objects.filter(union_id__in=list(relation_by_union), role=Role.PARTNER)
        .exclude(person_id=pid)
        .select_related("person", "union")
        .order_by("person__name_en")
    )
    return [
        ParentLink(
            person=row.person, union=row.union, relation_type=relation_by_union[row.union_id]
        )
        for row in rows
        if row.person.status == "canonical"
    ]


def children(person) -> list[ChildLink]:
    """Children of every union in which `person` is a partner."""
    pid = resolve_id(person)
    if pid is None:
        return []
    union_ids = list(
        UnionMembership.objects.filter(person_id=pid, role=Role.PARTNER).values_list(
            "union_id", flat=True
        )
    )
    if not union_ids:
        return []
    rows = (
        UnionMembership.objects.filter(union_id__in=union_ids, role=Role.CHILD)
        .exclude(person_id=pid)
        .select_related("person", "union")
        .order_by("sibling_order", "person__birth_year_min", "person__name_en")
    )
    return [
        ChildLink(
            person=row.person,
            union=row.union,
            relation_type=row.relation_type,
            sibling_order=row.sibling_order,
        )
        for row in rows
        if row.person.status == "canonical"
    ]


def partners(person) -> list[PartnerLink]:
    """Spouses and partners, one entry per union (remarriage yields several)."""
    pid = resolve_id(person)
    if pid is None:
        return []
    union_ids = list(
        UnionMembership.objects.filter(person_id=pid, role=Role.PARTNER).values_list(
            "union_id", flat=True
        )
    )
    if not union_ids:
        return []
    rows = (
        UnionMembership.objects.filter(union_id__in=union_ids, role=Role.PARTNER)
        .exclude(person_id=pid)
        .select_related("person", "union")
        .order_by("union__year_min", "union__created_at")
    )
    return [
        PartnerLink(
            person=row.person,
            union=row.union,
            union_type=row.union.union_type,
            union_status=row.union.status,
        )
        for row in rows
        if row.person.status == "canonical"
    ]


def siblings(person, include_step: bool = True) -> list[SiblingLink]:
    """Siblings classified as full, half or step.

    The classification rules, in order:

    1. Recorded as a child of the *same* union → **full**. Co-children of one union
       assert the same parent pair even when only one partner (or none) is known.
    2. Either side is attached to the linking union with relation_type=step → **step**.
    3. Otherwise count parents in common: two or more → **full**, exactly one → **half**.
    4. Reachable only through a parent's other union with no parent in common
       → **step** (a step-parent's children by someone else).

    This is deliberately ORM + Python rather than a CTE: it is a two-hop neighbourhood,
    and the classification needs per-membership detail that flattening into SQL would
    only obscure.
    """
    pid = resolve_id(person)
    if pid is None:
        return []

    own_child_links = list(UnionMembership.objects.filter(person_id=pid, role=Role.CHILD))
    own_union_ids = {link.union_id for link in own_child_links}
    stepwise_own = {
        link.union_id for link in own_child_links if link.relation_type == RelationType.STEP
    }
    if not own_union_ids:
        return []

    own_parent_ids = set(
        UnionMembership.objects.filter(union_id__in=own_union_ids, role=Role.PARTNER)
        .exclude(person_id=pid)
        .values_list("person_id", flat=True)
    )

    # Every union any of my parents belongs to — this is where half-siblings live —
    # plus the unions I am a child of, which hold my full siblings.
    candidate_union_ids = set(own_union_ids)
    if own_parent_ids:
        candidate_union_ids |= set(
            UnionMembership.objects.filter(
                person_id__in=own_parent_ids, role=Role.PARTNER
            ).values_list("union_id", flat=True)
        )
        if include_step:
            # A parent's spouse may bring children from an earlier union of their own.
            step_parent_ids = set(
                UnionMembership.objects.filter(union_id__in=candidate_union_ids, role=Role.PARTNER)
                .exclude(person_id__in=own_parent_ids | {pid})
                .values_list("person_id", flat=True)
            )
            if step_parent_ids:
                candidate_union_ids |= set(
                    UnionMembership.objects.filter(
                        person_id__in=step_parent_ids, role=Role.PARTNER
                    ).values_list("union_id", flat=True)
                )

    candidate_links = list(
        UnionMembership.objects.filter(union_id__in=candidate_union_ids, role=Role.CHILD)
        .exclude(person_id=pid)
        .select_related("person")
        .order_by("sibling_order", "person__birth_year_min", "person__name_en")
    )
    if not candidate_links:
        return []

    parents_by_candidate = _parents_by_person({link.person_id for link in candidate_links})

    seen: set[uuid.UUID] = set()
    results: list[SiblingLink] = []
    for link in candidate_links:
        if link.person_id in seen or link.person.status != "canonical":
            continue
        shared = own_parent_ids & parents_by_candidate.get(link.person_id, set())
        same_union = link.union_id in own_union_ids
        is_step = link.relation_type == RelationType.STEP or link.union_id in stepwise_own

        if is_step:
            kind = "step"
        elif same_union or len(shared) >= 2:
            kind = "full"
        elif len(shared) == 1:
            kind = "half"
        else:
            kind = "step"

        if kind == "step" and not include_step:
            continue

        seen.add(link.person_id)
        results.append(
            SiblingLink(
                person=link.person,
                kind=kind,
                shared_parent_ids=tuple(sorted(shared, key=str)),
                sibling_order=link.sibling_order,
            )
        )
    return results


def _parents_by_person(person_ids: set[uuid.UUID]) -> dict[uuid.UUID, set[uuid.UUID]]:
    """Parent id sets for many people in two queries."""
    if not person_ids:
        return {}
    child_links = UnionMembership.objects.filter(
        person_id__in=person_ids, role=Role.CHILD
    ).values_list("person_id", "union_id")
    unions_by_person: dict[uuid.UUID, set[uuid.UUID]] = {}
    all_union_ids: set[uuid.UUID] = set()
    for person_id, union_id in child_links:
        unions_by_person.setdefault(person_id, set()).add(union_id)
        all_union_ids.add(union_id)

    partners_by_union: dict[uuid.UUID, set[uuid.UUID]] = {}
    for union_id, partner_id in UnionMembership.objects.filter(
        union_id__in=all_union_ids, role=Role.PARTNER
    ).values_list("union_id", "person_id"):
        partners_by_union.setdefault(union_id, set()).add(partner_id)

    result: dict[uuid.UUID, set[uuid.UUID]] = {}
    for person_id, union_ids in unions_by_person.items():
        found: set[uuid.UUID] = set()
        for union_id in union_ids:
            found |= partners_by_union.get(union_id, set())
        found.discard(person_id)
        result[person_id] = found
    return result


def is_elder(candidate: Person, reference: Person) -> bool | None:
    """Is `candidate` older than `reference`? None when the graph cannot tell.

    Birth order is answered two ways, in order of reliability: an explicit sibling_order
    recorded on both children of one union (the "was X older or younger?" swipe fills
    these in), then estimated birth years. Malayalam sibling terms depend on the answer,
    so guessing is worse than admitting ignorance.
    """
    if candidate is None or reference is None:
        return None

    orders = {}
    rows = UnionMembership.objects.filter(
        person_id__in=[candidate.id, reference.id], role=Role.CHILD, sibling_order__isnull=False
    ).values_list("union_id", "person_id", "sibling_order")
    for union_id, person_id, order in rows:
        orders.setdefault(union_id, {})[person_id] = order
    for by_person in orders.values():
        if candidate.id in by_person and reference.id in by_person:
            if by_person[candidate.id] == by_person[reference.id]:
                break
            return by_person[candidate.id] < by_person[reference.id]

    candidate_year = candidate.birth_year_estimate
    reference_year = reference.birth_year_estimate
    if candidate_year is None or reference_year is None or candidate_year == reference_year:
        return None
    return candidate_year < reference_year


def ego_network(person) -> EgoNetwork:
    """Parents, siblings, partners and children — the person page payload."""
    subject = person if isinstance(person, Person) else Person.objects.get(pk=resolve_id(person))
    subject = subject.resolve_canonical()
    return EgoNetwork(
        person=subject,
        parents=parents(subject),
        siblings=siblings(subject),
        partners=partners(subject),
        children=children(subject),
    )
