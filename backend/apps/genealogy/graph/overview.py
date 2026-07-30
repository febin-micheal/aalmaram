"""The whole graph, banded for a zoomed-out drawing.

The detailed explorer positions people relative to a centre person. An overview has no
centre: it has to give every person in the database a row, including people in families
that share no ancestor at all.

Two things decide a row, and they are combined (DECISIONS.md #18):

1. **Structural depth**, within each connected family. Depth is the *longest* chain of
   ancestors, so a parent is always drawn above their child even when one branch of the
   family is recorded more deeply than another.
2. **An era offset**, per family. Depth alone would draw a fragment first recorded in the
   1960s level with someone's 1890s great-grandparents. So each family is shifted
   vertically so its estimated depth-0 birth year lines up with a shared timeline.

The whole thing is three queries and then pure Python. Nothing here runs per person, and
`test_api.py` pins the query count so it stays that way.
"""

from dataclasses import dataclass, field
from statistics import median
from uuid import UUID

from apps.genealogy.models import Person, PersonStatus, Role, Union, UnionMembership

#: Years between generations, used to convert an era difference into a row offset.
GENERATION_YEARS = 28
#: Guard against pathological data: no walk may relax more times than this.
MAX_RELAX_PASSES = 200


@dataclass
class Overview:
    persons: list[Person] = field(default_factory=list)
    unions: list[Union] = field(default_factory=list)
    memberships: list[dict] = field(default_factory=list)
    #: person id -> band (row). Lower numbers are older generations.
    bands: dict[UUID, int] = field(default_factory=dict)
    #: union id -> band of its partners.
    union_bands: dict[UUID, int] = field(default_factory=dict)
    component_count: int = 0


def build_overview() -> Overview:
    """Every canonical person, union and membership, with a row for each."""
    persons = list(
        Person.objects.filter(status=PersonStatus.CANONICAL).only(
            "id",
            "name_en",
            "name_ml",
            "house_name",
            "gender",
            "is_living",
            "birth_year_min",
            "birth_year_max",
            "birth_date_exact",
            "death_year_min",
            "death_year_max",
            "death_date_exact",
        )
    )
    person_ids = {person.id for person in persons}
    if not persons:
        return Overview()

    memberships = [
        {"union": union_id, "person": person_id, "role": role, "sibling_order": sibling_order}
        for union_id, person_id, role, sibling_order in UnionMembership.objects.filter(
            person_id__in=person_ids
        ).values_list("union_id", "person_id", "role", "sibling_order")
    ]
    union_ids = {row["union"] for row in memberships}
    unions = list(Union.objects.filter(id__in=union_ids).only("id"))

    partners_of, children_of = _adjacency(memberships)
    components = _components(persons, partners_of, children_of)

    bands: dict[UUID, int] = {}
    birth_years = {person.id: person.birth_year_estimate for person in persons}

    reference_offsets = []
    per_component = []
    for members in components:
        depths = _structural_depths(members, partners_of, children_of)
        era0 = _estimated_root_year(members, depths, birth_years)
        per_component.append((members, depths, era0))
        if era0 is not None:
            reference_offsets.append(era0)

    # The timeline everything is measured against: the median depth-0 year across
    # families. With no dates anywhere, every family simply starts at row 0.
    reference = median(reference_offsets) if reference_offsets else None

    for members, depths, era0 in per_component:
        offset = 0
        if reference is not None and era0 is not None:
            offset = round((era0 - reference) / GENERATION_YEARS)
        for person_id in members:
            bands[person_id] = depths.get(person_id, 0) + offset

    union_bands = _union_bands(memberships, bands)

    return Overview(
        persons=persons,
        unions=unions,
        memberships=memberships,
        bands=bands,
        union_bands=union_bands,
        component_count=len(components),
    )


def _adjacency(memberships):
    partners_of: dict[UUID, list[UUID]] = {}
    children_of: dict[UUID, list[UUID]] = {}
    for row in memberships:
        target = partners_of if row["role"] == Role.PARTNER else children_of
        target.setdefault(row["union"], []).append(row["person"])
    return partners_of, children_of


def _components(persons, partners_of, children_of) -> list[list[UUID]]:
    """Connected families, over "shares a union with" in any role."""
    neighbours: dict[UUID, set[UUID]] = {person.id: set() for person in persons}
    for union_id in set(partners_of) | set(children_of):
        members = partners_of.get(union_id, []) + children_of.get(union_id, [])
        for person_id in members:
            if person_id not in neighbours:
                continue
            neighbours[person_id].update(other for other in members if other != person_id)

    seen: set[UUID] = set()
    components = []
    for person in persons:
        if person.id in seen:
            continue
        stack = [person.id]
        seen.add(person.id)
        group = []
        while stack:
            current = stack.pop()
            group.append(current)
            for other in neighbours.get(current, ()):
                if other not in seen:
                    seen.add(other)
                    stack.append(other)
        components.append(group)
    return components


def _structural_depths(members, partners_of, children_of) -> dict[UUID, int]:
    """Longest ancestor chain per person, with partners levelled to the same row.

    Relaxation rather than a topological sort: bad data can contain a cycle (someone
    recorded as their own ancestor), and a relaxation with a pass cap degrades into a
    slightly wrong drawing instead of hanging.
    """
    member_set = set(members)
    depths = dict.fromkeys(members, 0)

    # Parent → child edges, restricted to this component.
    edges = []
    for union_id, kids in children_of.items():
        parents = [p for p in partners_of.get(union_id, []) if p in member_set]
        for child in kids:
            if child not in member_set:
                continue
            for parent in parents:
                edges.append((parent, child))

    partner_groups = [
        [p for p in group if p in member_set] for group in partners_of.values() if len(group) > 1
    ]

    for _ in range(min(MAX_RELAX_PASSES, len(members) + 2)):
        changed = False
        for parent, child in edges:
            if depths[child] < depths[parent] + 1:
                depths[child] = depths[parent] + 1
                changed = True
        # A couple belongs on one row; the deeper partner wins so nobody is pulled above
        # their own parents.
        for group in partner_groups:
            if len(group) < 2:
                continue
            deepest = max(depths[p] for p in group)
            for person_id in group:
                if depths[person_id] != deepest:
                    depths[person_id] = deepest
                    changed = True
        if not changed:
            break

    return depths


def _estimated_root_year(members, depths, birth_years) -> float | None:
    """Estimated birth year of this family's depth-0 row.

    Taken from whoever in the family has a usable birth year, walked back up by
    GENERATION_YEARS per row. Using every dated member rather than only the deepest
    ancestors means a family whose oldest records are undated still lands sensibly.
    """
    samples = [
        birth_years[person_id] - depths.get(person_id, 0) * GENERATION_YEARS
        for person_id in members
        if birth_years.get(person_id) is not None
    ]
    return median(samples) if samples else None


def _union_bands(memberships, bands) -> dict[UUID, int]:
    union_bands: dict[UUID, int] = {}
    for row in memberships:
        band = bands.get(row["person"])
        if band is None:
            continue
        if row["role"] == Role.PARTNER:
            current = union_bands.get(row["union"])
            union_bands[row["union"]] = band if current is None else max(current, band)

    # A union reached only through a child (both partners unknown) still needs a row:
    # put it where its partners would have been.
    for row in memberships:
        if row["union"] in union_bands or row["role"] != Role.CHILD:
            continue
        band = bands.get(row["person"])
        if band is not None:
            union_bands[row["union"]] = band - 1
    return union_bands
