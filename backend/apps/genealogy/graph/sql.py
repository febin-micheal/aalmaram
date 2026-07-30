"""Raw SQL used by the traversal layer.

CLAUDE.md fixes Postgres recursive CTEs as the traversal mechanism (no graph DB), so the
depth walks live here as parameterised SQL rather than in the ORM. Table names come from
``_meta.db_table`` so a rename can never silently break these strings.

Two safety properties every walk in this module holds:

* **Bounded** — each recursion carries a depth counter compared against a caller-supplied
  cap (``settings.GRAPH_MAX_DEPTH`` by default). A cycle created by bad data therefore
  terminates instead of spinning.
* **Deduplicated** — the set-building walks use ``UNION`` rather than ``UNION ALL``, so
  the working set is bounded by (persons × depth) instead of by the number of distinct
  routes. Path reconstruction, which does need per-route rows, is only ever run against
  a target already known to be a few generations away.
"""

from django.conf import settings

from apps.genealogy.models import Person, Union, UnionMembership

PERSON = Person._meta.db_table
UNION = Union._meta.db_table
MEMBERSHIP = UnionMembership._meta.db_table


def max_depth(value: int | None = None) -> int:
    return settings.GRAPH_MAX_DEPTH if value is None else value


# Walk upward: I am a child in some union → the partners of that union are my parents.
ANCESTOR_DEPTHS = f"""
WITH RECURSIVE ancestry(person_id, depth) AS (
        SELECT %(root)s::uuid, 0
    UNION
        SELECT parent.person_id, ancestry.depth + 1
          FROM ancestry
          JOIN {MEMBERSHIP} AS kid
            ON kid.person_id = ancestry.person_id AND kid.role = 'child'
          JOIN {MEMBERSHIP} AS parent
            ON parent.union_id = kid.union_id AND parent.role = 'partner'
          JOIN {PERSON} AS p
            ON p.id = parent.person_id AND p.status = 'canonical'
         WHERE ancestry.depth < %(max_depth)s
)
SELECT person_id, MIN(depth) AS depth
  FROM ancestry
 GROUP BY person_id
"""

# Walk downward: I am a partner in some union → the children of that union are mine.
DESCENDANT_DEPTHS = f"""
WITH RECURSIVE progeny(person_id, depth) AS (
        SELECT %(root)s::uuid, 0
    UNION
        SELECT kid.person_id, progeny.depth + 1
          FROM progeny
          JOIN {MEMBERSHIP} AS parent
            ON parent.person_id = progeny.person_id AND parent.role = 'partner'
          JOIN {MEMBERSHIP} AS kid
            ON kid.union_id = parent.union_id AND kid.role = 'child'
          JOIN {PERSON} AS p
            ON p.id = kid.person_id AND p.status = 'canonical'
         WHERE progeny.depth < %(max_depth)s
)
SELECT person_id, MIN(depth) AS depth
  FROM progeny
 GROUP BY person_id
"""

# Ancestors of *many* people at once, each row tagged with the seed it belongs to.
#
# This is what makes labelling a screenful of cards affordable. Asking "how is each of
# these 40 people related to me?" one pair at a time costs ~8 queries per pair; seeding one
# recursive walk with every person involved costs exactly one, whatever the count.
ANCESTOR_DEPTHS_MULTI = f"""
WITH RECURSIVE ancestry(seed, person_id, depth) AS (
        SELECT seed.id, seed.id, 0
          FROM unnest(%(seeds)s::uuid[]) AS seed(id)
    UNION
        SELECT ancestry.seed, parent.person_id, ancestry.depth + 1
          FROM ancestry
          JOIN {MEMBERSHIP} AS kid
            ON kid.person_id = ancestry.person_id AND kid.role = 'child'
          JOIN {MEMBERSHIP} AS parent
            ON parent.union_id = kid.union_id AND parent.role = 'partner'
          JOIN {PERSON} AS p
            ON p.id = parent.person_id AND p.status = 'canonical'
         WHERE ancestry.depth < %(max_depth)s
)
SELECT seed, person_id, MIN(depth) AS depth
  FROM ancestry
 GROUP BY seed, person_id
"""

# Shortest upward route from a descendant to one specific ancestor. Only ever called
# with a target whose distance is already known, and the walk stops as soon as it
# reaches the target, so the per-route rows stay tiny.
ANCESTOR_PATH = f"""
WITH RECURSIVE walk(person_id, depth, path) AS (
        SELECT %(start)s::uuid, 0, ARRAY[%(start)s::uuid]
    UNION ALL
        SELECT parent.person_id, walk.depth + 1, walk.path || parent.person_id
          FROM walk
          JOIN {MEMBERSHIP} AS kid
            ON kid.person_id = walk.person_id AND kid.role = 'child'
          JOIN {MEMBERSHIP} AS parent
            ON parent.union_id = kid.union_id AND parent.role = 'partner'
          JOIN {PERSON} AS p
            ON p.id = parent.person_id AND p.status = 'canonical'
         WHERE walk.depth < %(target_depth)s
           AND walk.person_id <> %(target)s::uuid
           AND NOT (parent.person_id = ANY(walk.path))
)
SELECT path
  FROM walk
 WHERE person_id = %(target)s::uuid
 ORDER BY depth
 LIMIT 1
"""

# Undirected kinship radius. Two people are one degree apart when they share a union
# membership in any role — which is exactly parent/child, sibling, and partner at once
# (see DECISIONS.md #2).
RELATIVES_WITHIN = f"""
WITH RECURSIVE reach(person_id, degree) AS (
        SELECT %(anchor)s::uuid, 0
    UNION
        SELECT other.person_id, reach.degree + 1
          FROM reach
          JOIN {MEMBERSHIP} AS mine
            ON mine.person_id = reach.person_id
          JOIN {MEMBERSHIP} AS other
            ON other.union_id = mine.union_id AND other.person_id <> reach.person_id
         WHERE reach.degree < %(degrees)s
)
SELECT person_id, MIN(degree) AS degree
  FROM reach
 GROUP BY person_id
"""

# Same walk, reduced to the id column, for embedding as a subquery in a queryset filter.
RELATIVES_WITHIN_IDS = f"""
WITH RECURSIVE reach(person_id, degree) AS (
        SELECT %s::uuid, 0
    UNION
        SELECT other.person_id, reach.degree + 1
          FROM reach
          JOIN {MEMBERSHIP} AS mine
            ON mine.person_id = reach.person_id
          JOIN {MEMBERSHIP} AS other
            ON other.union_id = mine.union_id AND other.person_id <> reach.person_id
         WHERE reach.degree < %s
)
SELECT DISTINCT person_id FROM reach
"""
