"""The visibility rule, expressed as a queryset filter.

CLAUDE.md: deceased persons and their facts are visible to every authenticated member;
living persons only within 3 degrees of the viewer's anchor Person, or with an explicit
consent flag. A Phase 1 acceptance check requires this at the *queryset* level, not in
views — so it lives here as a ``Q`` object that ``Person.objects.visible_to()`` applies,
and nothing above it has to remember to filter.

One degree is a parent/child, sibling, or partner hop (DECISIONS.md #2). Those four
edges have one thing in common in this schema: both people are members of the same
Union. So the radius is a single recursive walk over shared union membership — no
special-casing per edge type, and step-relations come along for free.
"""

import uuid

from django.conf import settings
from django.db import connection
from django.db.models import Q
from django.db.models.expressions import RawSQL

from apps.genealogy.models import Person

from . import sql


def _anchor_id(anchor) -> uuid.UUID | None:
    """Accept a Person, a User carrying `anchor_person`, a UUID/str, or None."""
    if anchor is None:
        return None
    if isinstance(anchor, Person):
        return anchor.canonical_id
    if isinstance(anchor, uuid.UUID):
        return anchor
    if isinstance(anchor, str):
        return uuid.UUID(anchor)
    anchor_person = getattr(anchor, "anchor_person", None)
    return anchor_person.canonical_id if anchor_person is not None else None


def visible_person_filter(anchor, degrees: int | None = None) -> Q:
    """The Q object behind ``Person.objects.visible_to(anchor)``.

    An anchorless viewer (a staff account not yet pinned to a Person, say) sees the
    deceased and anyone who has consented — never the living family of strangers.
    """
    radius = settings.PRIVACY_VISIBILITY_DEGREES if degrees is None else degrees
    condition = Q(is_living=False) | Q(visibility_consent=True)

    anchor_id = _anchor_id(anchor)
    if anchor_id is not None:
        condition |= Q(id__in=RawSQL(sql.RELATIVES_WITHIN_IDS, (anchor_id, radius)))
    return condition


def relatives_within(person, degrees: int | None = None) -> dict[uuid.UUID, int]:
    """Map every person within `degrees` hops to their distance from `person`.

    Used by the admin explorer and, from Phase 2, by the question engine's proximity
    ranking. The anchor itself is included at degree 0.
    """
    from .traversal import resolve_id

    radius = settings.PRIVACY_VISIBILITY_DEGREES if degrees is None else degrees
    anchor_id = resolve_id(person)
    if anchor_id is None:
        return {}
    with connection.cursor() as cursor:
        cursor.execute(sql.RELATIVES_WITHIN, {"anchor": anchor_id, "degrees": radius})
        return {row[0]: row[1] for row in cursor.fetchall()}
