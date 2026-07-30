"""Common ancestors and the "how are we related?" answer.

Two people are related through their lowest common ancestor(s). "Lowest" here means the
pair of upward distances with the smallest total — the standard criterion, and the one
that behaves correctly on a graph rather than a tree:

* full siblings share **two** lowest common ancestors (both parents) at (1, 1)
* half-siblings share exactly **one**
* a parent and child have the parent themselves as the common ancestor, at (0, 1)
* remarriage produces several routes; the shortest wins

Half-ness is deliberately *not* inferred from "only one common ancestor was found",
because a union with a single recorded partner (unknown father) would then make ordinary
full siblings look like half-siblings. It is read from the sibling classification at the
linking generation instead.
"""

import uuid
from dataclasses import dataclass, field

from apps.genealogy.models import Person

from . import naming
from .naming import Descriptor
from .traversal import ancestor_depths, ancestor_path, is_elder, partners, resolve_id, siblings


@dataclass(frozen=True)
class CommonAncestor:
    person: Person
    #: Generations from the subject / the other person up to this ancestor.
    depth_subject: int
    depth_other: int
    #: Full routes, subject-first and other-first, each ending at the ancestor.
    path_subject: list[Person] = field(default_factory=list)
    path_other: list[Person] = field(default_factory=list)

    @property
    def total_distance(self) -> int:
        return self.depth_subject + self.depth_other

    def descent_to_subject(self) -> list[Person]:
        """The ancestor's line down to the subject — how the admin UI displays it."""
        return list(reversed(self.path_subject))

    def descent_to_other(self) -> list[Person]:
        return list(reversed(self.path_other))


@dataclass(frozen=True)
class RelationshipResult:
    subject: Person
    other: Person
    descriptor: Descriptor
    common_ancestors: list[CommonAncestor] = field(default_factory=list)

    @property
    def is_related(self) -> bool:
        return self.descriptor.kind != naming.UNRELATED

    @property
    def label_en(self) -> str:
        return naming.label_for(self.descriptor, "en")

    @property
    def label_ml(self) -> str:
        return naming.label_for(self.descriptor, "ml")

    def labels(self) -> dict[str, str]:
        return naming.labels_for(self.descriptor)

    def describe(self, language: str = "en") -> str:
        label = naming.label_for(self.descriptor, language)
        if language == "ml":
            return f"{self.other.display_name} — {self.subject.display_name}യുടെ {label}"
        return f"{self.other.display_name} is {self.subject.display_name}'s {label}"


def lowest_common_ancestors(subject, other, max_depth: int | None = None) -> list[CommonAncestor]:
    """Every ancestor shared at the minimum total distance, with both descent paths."""
    subject_id = resolve_id(subject)
    other_id = resolve_id(other)
    if subject_id is None or other_id is None:
        return []

    up_subject = ancestor_depths(subject_id, max_depth=max_depth, include_self=True)
    up_other = ancestor_depths(other_id, max_depth=max_depth, include_self=True)
    shared = set(up_subject) & set(up_other)
    if not shared:
        return []

    best = min(up_subject[pid] + up_other[pid] for pid in shared)
    winners = [pid for pid in shared if up_subject[pid] + up_other[pid] == best]

    paths: dict[uuid.UUID, tuple[list[uuid.UUID], list[uuid.UUID]]] = {}
    needed: set[uuid.UUID] = set()
    for pid in winners:
        path_s = ancestor_path(subject_id, pid, up_subject[pid])
        path_o = ancestor_path(other_id, pid, up_other[pid])
        paths[pid] = (path_s, path_o)
        needed.update(path_s)
        needed.update(path_o)
        needed.add(pid)

    people = Person.objects.filter(id__in=list(needed)).in_bulk()
    results = [
        CommonAncestor(
            person=people[pid],
            depth_subject=up_subject[pid],
            depth_other=up_other[pid],
            path_subject=[people[step] for step in paths[pid][0] if step in people],
            path_other=[people[step] for step in paths[pid][1] if step in people],
        )
        for pid in winners
        if pid in people
    ]
    results.sort(key=lambda item: (item.total_distance, item.person.display_name))
    return results


def describe_relationship(subject, other, max_depth: int | None = None) -> RelationshipResult:
    """Answer "how are we related?" — reads as "other is subject's <label>"."""
    subject_person = _as_person(subject)
    other_person = _as_person(other)

    if subject_person.id == other_person.id:
        return RelationshipResult(
            subject=subject_person, other=other_person, descriptor=Descriptor(kind=naming.SELF)
        )

    # Spouses usually share no ancestor at all, so check the partner edge first.
    for link in partners(subject_person):
        if link.person.id == other_person.id:
            return RelationshipResult(
                subject=subject_person,
                other=other_person,
                descriptor=Descriptor(
                    kind=naming.PARTNER,
                    other_gender=other_person.gender,
                    union_type=link.union_type,
                ),
            )

    ancestors_shared = lowest_common_ancestors(subject_person, other_person, max_depth=max_depth)
    if not ancestors_shared:
        # No blood link. A step-sibling relationship lives entirely in the union graph
        # and never produces a common ancestor, so it has to be checked separately.
        for link in siblings(subject_person):
            if link.person.id == other_person.id:
                return RelationshipResult(
                    subject=subject_person,
                    other=other_person,
                    descriptor=Descriptor(
                        kind=naming.SIBLING,
                        up_subject=1,
                        up_other=1,
                        other_gender=other_person.gender,
                        step=link.kind == "step",
                        half=link.kind == "half",
                        other_is_elder=is_elder(other_person, subject_person),
                    ),
                )
        return RelationshipResult(
            subject=subject_person, other=other_person, descriptor=Descriptor(kind=naming.UNRELATED)
        )

    primary = ancestors_shared[0]
    up_s, up_o = primary.depth_subject, primary.depth_other
    descriptor = _build_descriptor(subject_person, other_person, primary, up_s, up_o)
    return RelationshipResult(
        subject=subject_person,
        other=other_person,
        descriptor=descriptor,
        common_ancestors=ancestors_shared,
    )


def _build_descriptor(subject_person, other_person, primary, up_s, up_o) -> Descriptor:
    if up_o == 0:
        return Descriptor(kind=naming.ANCESTOR, up_subject=up_s, other_gender=other_person.gender)
    if up_s == 0:
        return Descriptor(kind=naming.DESCENDANT, up_other=up_o, other_gender=other_person.gender)

    # Both sides go up, so the link is between two siblings one step below the common
    # ancestor. Classify *that* pair to learn whether the relation is whole or half.
    linking_subject = _step(primary.path_subject, up_s - 1, subject_person)
    linking_other = _step(primary.path_other, up_o - 1, other_person)
    link_kind = _sibling_kind(linking_subject, linking_other)

    side = _side_of_family(primary.path_subject)
    linking_ancestor_gender = linking_subject.gender if linking_subject else "unknown"

    if up_s == 1 and up_o == 1:
        return Descriptor(
            kind=naming.SIBLING,
            up_subject=1,
            up_other=1,
            other_gender=other_person.gender,
            half=link_kind == "half",
            step=link_kind == "step",
            other_is_elder=is_elder(other_person, subject_person),
        )

    if up_o == 1:
        return Descriptor(
            kind=naming.PIBLING,
            up_subject=up_s,
            up_other=1,
            other_gender=other_person.gender,
            half=link_kind == "half",
            step=link_kind == "step",
            side=side,
            # Uncle-vs-elder-uncle is judged against the parent he is a sibling of.
            other_is_elder=is_elder(other_person, linking_subject) if linking_subject else None,
            linking_ancestor_gender=linking_ancestor_gender,
        )

    if up_s == 1:
        return Descriptor(
            kind=naming.NIBLING,
            up_subject=1,
            up_other=up_o,
            other_gender=other_person.gender,
            half=link_kind == "half",
            step=link_kind == "step",
            side=side,
        )

    return Descriptor(
        kind=naming.COUSIN,
        up_subject=up_s,
        up_other=up_o,
        other_gender=other_person.gender,
        half=link_kind == "half",
        step=link_kind == "step",
        side=side,
    )


def _sibling_kind(person_a: Person | None, person_b: Person | None) -> str:
    if person_a is None or person_b is None or person_a.id == person_b.id:
        return "full"
    for link in siblings(person_a):
        if link.person.id == person_b.id:
            return link.kind
    return "full"


def _step(path: list[Person], index: int, fallback: Person) -> Person | None:
    if index <= 0:
        return fallback
    if index < len(path):
        return path[index]
    return None


def _side_of_family(path_subject: list[Person]) -> str | None:
    """Whether the route leaves the subject through their father or their mother."""
    if len(path_subject) < 2:
        return None
    parent = path_subject[1]
    if parent.gender == naming.MALE:
        return "paternal"
    if parent.gender == naming.FEMALE:
        return "maternal"
    return None


def _as_person(value) -> Person:
    if isinstance(value, Person):
        return value.resolve_canonical()
    return Person.objects.get(pk=resolve_id(value))
