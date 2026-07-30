"""How is each of these people related to me?

The single-pair `describe_relationship` costs roughly eight queries: two ancestor walks,
two path reconstructions, a sibling classification, a birth-order check, a partner lookup.
That is fine for one question and ruinous for a screenful — labelling forty visible cards
would be three hundred round trips, and the labels have to be refreshed every time the
focus changes or the graph grows.

So this does the same work with a **constant number of queries**, whatever the number of
targets — one recursive walk seeded with *every* person involved, one query for the
memberships among the people that walk touched, and one for those people's fields. The
view adds one more to validate the subject, which is what the pinned count of four in
test_api_ego.py counts.

Everything after that — common ancestors, paths, half vs full, side of the family, birth
order — is computed against those in-memory structures. The labels themselves come from
`naming.py` unchanged: there is one place in this codebase that turns a relationship into
words, and this is not a second one.
"""

from dataclasses import dataclass
from uuid import UUID

from django.db import connection

from apps.genealogy.models import Person, PersonStatus, Role, UnionMembership

from . import naming, sql
from .naming import Descriptor

#: A cap on how many people one call may ask about. The client batches beyond this.
MAX_TARGETS = 200


@dataclass(frozen=True)
class BulkRelation:
    target_id: UUID
    descriptor: Descriptor | None
    #: Generational distance: steps up from the subject plus steps up from the target.
    degree: int | None
    common_ancestor_ids: tuple[UUID, ...] = ()

    @property
    def is_related(self) -> bool:
        return self.descriptor is not None and self.descriptor.kind != naming.UNRELATED


def relate_bulk(subject_id, target_ids, max_depth: int | None = None) -> dict[UUID, BulkRelation]:
    """Relationship of each target to `subject_id`, in three queries however many there are."""
    subject_id = _as_uuid(subject_id)
    targets = [_as_uuid(t) for t in target_ids if t]
    targets = [t for t in dict.fromkeys(targets) if t]  # de-duplicate, keep order
    if not subject_id or not targets:
        return {}

    seeds = list(dict.fromkeys([subject_id, *targets]))

    # --- query 1: ancestors of everyone involved, in one walk ----------------
    ancestry = _ancestor_depths_multi(seeds, max_depth)
    subject_anc = ancestry.get(subject_id, {subject_id: 0})

    # --- queries 2 and 3: the neighbourhood those walks touched --------------
    involved: set[UUID] = set(seeds)
    for depths in ancestry.values():
        involved.update(depths)
    graph = _InMemoryGraph(involved)

    results: dict[UUID, BulkRelation] = {}
    for target_id in targets:
        results[target_id] = _relate_one(
            subject_id, target_id, subject_anc, ancestry.get(target_id, {target_id: 0}), graph
        )
    return results


def _relate_one(subject_id, target_id, subject_anc, target_anc, graph) -> BulkRelation:
    if subject_id == target_id:
        return BulkRelation(target_id, Descriptor(kind=naming.SELF), 0)

    # A spouse usually shares no ancestor at all, so the partner edge is checked first.
    if graph.are_partners(subject_id, target_id):
        return BulkRelation(
            target_id,
            Descriptor(
                kind=naming.PARTNER,
                other_gender=graph.gender(target_id),
                union_type=graph.union_type_between(subject_id, target_id),
            ),
            1,
        )

    shared = set(subject_anc) & set(target_anc)
    if not shared:
        # No blood link. Step-siblings live entirely in the union graph and never produce
        # a common ancestor, so they have to be looked for separately.
        kind = graph.sibling_kind(subject_id, target_id)
        if kind:
            return BulkRelation(
                target_id,
                Descriptor(
                    kind=naming.SIBLING,
                    up_subject=1,
                    up_other=1,
                    other_gender=graph.gender(target_id),
                    step=kind == "step",
                    half=kind == "half",
                    other_is_elder=graph.is_elder(target_id, subject_id),
                ),
                2,
            )
        return BulkRelation(target_id, Descriptor(kind=naming.UNRELATED), None)

    best = min(subject_anc[pid] + target_anc[pid] for pid in shared)
    winners = tuple(
        sorted((pid for pid in shared if subject_anc[pid] + target_anc[pid] == best), key=str)
    )
    lca = winners[0]
    up_subject, up_target = subject_anc[lca], target_anc[lca]

    descriptor = _build_descriptor(subject_id, target_id, lca, up_subject, up_target, graph)
    return BulkRelation(target_id, descriptor, best, winners)


def _build_descriptor(subject_id, target_id, lca, up_subject, up_target, graph) -> Descriptor:
    gender = graph.gender(target_id)

    if up_target == 0:
        return Descriptor(kind=naming.ANCESTOR, up_subject=up_subject, other_gender=gender)
    if up_subject == 0:
        return Descriptor(kind=naming.DESCENDANT, up_other=up_target, other_gender=gender)

    # Both go up, so the link is between two siblings one step below the shared ancestor.
    subject_path = graph.path_up(subject_id, lca, up_subject)
    target_path = graph.path_up(target_id, lca, up_target)
    linking_subject = (
        subject_path[up_subject - 1] if len(subject_path) > up_subject - 1 else subject_id
    )
    linking_target = target_path[up_target - 1] if len(target_path) > up_target - 1 else target_id

    # Half-ness comes from classifying that sibling pair, never from "only one common
    # ancestor was found" — an unknown parent would make full siblings look half.
    link_kind = graph.sibling_kind(linking_subject, linking_target) or "full"
    side = graph.side_of_family(subject_path)
    linking_gender = graph.gender(linking_subject)

    if up_subject == 1 and up_target == 1:
        return Descriptor(
            kind=naming.SIBLING,
            up_subject=1,
            up_other=1,
            other_gender=gender,
            half=link_kind == "half",
            step=link_kind == "step",
            other_is_elder=graph.is_elder(target_id, subject_id),
        )
    if up_target == 1:
        return Descriptor(
            kind=naming.PIBLING,
            up_subject=up_subject,
            up_other=1,
            other_gender=gender,
            half=link_kind == "half",
            step=link_kind == "step",
            side=side,
            other_is_elder=graph.is_elder(target_id, linking_subject),
            linking_ancestor_gender=linking_gender,
        )
    if up_subject == 1:
        return Descriptor(
            kind=naming.NIBLING,
            up_subject=1,
            up_other=up_target,
            other_gender=gender,
            half=link_kind == "half",
            step=link_kind == "step",
            side=side,
        )
    return Descriptor(
        kind=naming.COUSIN,
        up_subject=up_subject,
        up_other=up_target,
        other_gender=gender,
        half=link_kind == "half",
        step=link_kind == "step",
        side=side,
    )


def _ancestor_depths_multi(seeds, max_depth) -> dict[UUID, dict[UUID, int]]:
    with connection.cursor() as cursor:
        cursor.execute(
            sql.ANCESTOR_DEPTHS_MULTI,
            {"seeds": [str(s) for s in seeds], "max_depth": sql.max_depth(max_depth)},
        )
        rows = cursor.fetchall()

    ancestry: dict[UUID, dict[UUID, int]] = {seed: {} for seed in seeds}
    for seed, person_id, depth in rows:
        ancestry.setdefault(seed, {})[person_id] = depth
    return ancestry


class _InMemoryGraph:
    """The two queries' worth of graph everything else is answered from."""

    def __init__(self, person_ids: set[UUID]):
        self.persons = {
            person.id: person
            for person in Person.objects.filter(
                id__in=person_ids, status=PersonStatus.CANONICAL
            ).only("id", "gender", "birth_year_min", "birth_year_max", "birth_date_exact")
        }

        self.partners_of: dict[UUID, list[UUID]] = {}
        self.children_of: dict[UUID, list[UUID]] = {}
        self.unions_as_partner: dict[UUID, list[UUID]] = {}
        self.unions_as_child: dict[UUID, list[UUID]] = {}
        self.union_type: dict[UUID, str] = {}
        self.sibling_order: dict[tuple[UUID, UUID], int | None] = {}
        self.relation_type: dict[tuple[UUID, UUID], str] = {}

        rows = UnionMembership.objects.filter(person_id__in=person_ids).values_list(
            "union_id", "person_id", "role", "sibling_order", "relation_type", "union__union_type"
        )
        for union_id, person_id, role, order, relation, union_type in rows:
            self.union_type[union_id] = union_type
            if role == Role.PARTNER:
                self.partners_of.setdefault(union_id, []).append(person_id)
                self.unions_as_partner.setdefault(person_id, []).append(union_id)
            else:
                self.children_of.setdefault(union_id, []).append(person_id)
                self.unions_as_child.setdefault(person_id, []).append(union_id)
                self.sibling_order[(union_id, person_id)] = order
                self.relation_type[(union_id, person_id)] = relation

    # --- lookups -----------------------------------------------------------

    def gender(self, person_id) -> str:
        person = self.persons.get(person_id)
        return person.gender if person else "unknown"

    def parents(self, person_id) -> set[UUID]:
        found: set[UUID] = set()
        for union_id in self.unions_as_child.get(person_id, ()):
            found.update(p for p in self.partners_of.get(union_id, ()) if p != person_id)
        return found

    def are_partners(self, a, b) -> bool:
        for union_id in self.unions_as_partner.get(a, ()):
            if b in self.partners_of.get(union_id, ()):
                return True
        return False

    def union_type_between(self, a, b) -> str | None:
        for union_id in self.unions_as_partner.get(a, ()):
            if b in self.partners_of.get(union_id, ()):
                return self.union_type.get(union_id)
        return None

    def sibling_kind(self, a, b) -> str | None:
        """full / half / step, or None if they are not siblings at all.

        Same rules as `traversal.siblings`, applied to the in-memory graph: same union is
        full even when a parent is unknown, an explicit step membership wins, otherwise
        count shared parents.
        """
        if a == b:
            return None

        a_unions = set(self.unions_as_child.get(a, ()))
        b_unions = set(self.unions_as_child.get(b, ()))

        for union_id in a_unions & b_unions:
            if "step" in (
                self.relation_type.get((union_id, a)),
                self.relation_type.get((union_id, b)),
            ):
                return "step"
            return "full"

        shared = self.parents(a) & self.parents(b)
        if len(shared) >= 2:
            return "full"
        if len(shared) == 1:
            return "half"

        # A parent's later spouse may bring children of their own: no shared parent, but
        # still siblings in the household sense.
        for union_id in a_unions:
            for parent in self.partners_of.get(union_id, ()):
                for other_union in self.unions_as_partner.get(parent, ()):
                    for co_partner in self.partners_of.get(other_union, ()):
                        if co_partner == parent:
                            continue
                        for step_union in self.unions_as_partner.get(co_partner, ()):
                            if b in self.children_of.get(step_union, ()):
                                return "step"
        return None

    def path_up(self, person_id, ancestor_id, distance: int) -> list[UUID]:
        """Ids from `person_id` up to `ancestor_id`, shortest route, in memory."""
        if person_id == ancestor_id:
            return [person_id]
        frontier = [[person_id]]
        seen = {person_id}
        for _ in range(max(distance, 1)):
            nxt = []
            for path in frontier:
                for parent in self.parents(path[-1]):
                    if parent == ancestor_id:
                        return [*path, parent]
                    if parent not in seen:
                        seen.add(parent)
                        nxt.append([*path, parent])
            if not nxt:
                break
            frontier = nxt
        return [person_id]

    def side_of_family(self, path: list[UUID]) -> str | None:
        """Whether the route leaves the subject through their father or their mother."""
        if len(path) < 2:
            return None
        gender = self.gender(path[1])
        return "paternal" if gender == "male" else "maternal" if gender == "female" else None

    def is_elder(self, candidate, reference) -> bool | None:
        """Recorded birth order first, then estimated years, then honest ignorance."""
        for union_id in self.unions_as_child.get(candidate, ()):
            if reference in self.children_of.get(union_id, ()):
                a = self.sibling_order.get((union_id, candidate))
                b = self.sibling_order.get((union_id, reference))
                if a is not None and b is not None and a != b:
                    return a < b

        one, two = self.persons.get(candidate), self.persons.get(reference)
        if not one or not two:
            return None
        a, b = one.birth_year_estimate, two.birth_year_estimate
        if a is None or b is None or a == b:
            return None
        return a < b


def _as_uuid(value) -> UUID | None:
    if value is None:
        return None
    if isinstance(value, UUID):
        return value
    try:
        return UUID(str(value))
    except (ValueError, AttributeError, TypeError):
        return None
