"""Reversible person merges.

Merging is the one destructive-looking operation in the system, and CLAUDE.md requires
it to be exactly reversible: un-merging must restore the prior state, not an
approximation of it. So the merge does not delete anything. It:

1. serialises the pre-merge state of *both* persons and every edge it is about to touch
   into MergeRecord.snapshot,
2. repoints those edges at the canonical person,
3. marks the absorbed person status=merged_into.

Un-merge replays the snapshot with queryset ``.update()`` calls rather than ``save()``,
so even auto_now / auto_now_add timestamps come back with their original values.

A note on edge conflicts: duplicates are usually duplicated *because* both rows are
children of the same union, and (union, person, role) is unique. Repointing would
collide, so the absorbed row is removed instead — with its full contents in the snapshot
so un-merge can recreate it byte for byte, primary key included.
"""

import datetime
import decimal
import uuid

from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils import timezone

from apps.claims.models import Claim
from apps.genealogy.models import Person, PersonStatus, UnionMembership
from apps.mediastore.models import MediaItem

from .models import CandidateStatus, MergeCandidate, MergeRecord


class MergeError(Exception):
    """Raised when a merge or un-merge would corrupt the graph."""


#: Fields copied from the absorbed person when the canonical one has nothing recorded.
_FILL_IF_BLANK = (
    "name_en",
    "name_ml",
    "house_name",
    "place_origin",
    "religion_community",
    "institution",
    "notes",
)
_FILL_IF_NULL = (
    "birth_year_min",
    "birth_year_max",
    "birth_date_exact",
    "death_year_min",
    "death_year_max",
    "death_date_exact",
    "place_lat",
    "place_lng",
)


def _dump(instances) -> list[dict]:
    """Snapshot rows losslessly.

    Django's JSON serializer renders datetimes in ECMA-262 format, which keeps only
    milliseconds — enough to make a restored created_at differ from the original in the
    microsecond digits. "Exact prior state" has to mean exact, so timestamps go through
    isoformat() and come back through the field's own to_python().
    """
    return [
        {field.attname: _encode(getattr(obj, field.attname)) for field in obj._meta.concrete_fields}
        for obj in instances
    ]


def _encode(value):
    if isinstance(value, datetime.datetime | datetime.date | datetime.time):
        return value.isoformat()
    if isinstance(value, uuid.UUID | decimal.Decimal):
        return str(value)
    return value


def _decode(field, value):
    if value is None:
        return None
    target = field.target_field if field.is_relation else field
    return target.to_python(value)


def _field_values(model, rows):
    """Yield (pk, {attname: value}) for every row in a snapshot."""
    pk_field = model._meta.pk
    for row in rows or []:
        pk = _decode(pk_field, row[pk_field.attname])
        values = {
            field.attname: _decode(field, row[field.attname])
            for field in model._meta.concrete_fields
            if not field.primary_key
        }
        yield pk, values


@transaction.atomic
def merge_persons(
    canonical: Person, absorbed: Person, performed_by=None, candidate=None
) -> MergeRecord:
    """Fold `absorbed` into `canonical`, returning the record that can undo it."""
    canonical = Person.objects.select_for_update().get(pk=canonical.pk)
    absorbed = Person.objects.select_for_update().get(pk=absorbed.pk)
    _validate_merge(canonical, absorbed)

    snapshot = {
        "canonical": _dump([canonical]),
        "absorbed": _dump([absorbed]),
    }

    # --- union memberships -------------------------------------------------
    existing = set(UnionMembership.objects.filter(person=canonical).values_list("union_id", "role"))
    repoint_ids, removed = [], []
    for membership in UnionMembership.objects.filter(person=absorbed):
        if (membership.union_id, membership.role) in existing:
            removed.append(membership)
        else:
            repoint_ids.append(str(membership.pk))
            existing.add((membership.union_id, membership.role))
    snapshot["memberships_repointed"] = repoint_ids
    snapshot["memberships_removed"] = _dump(removed)
    if repoint_ids:
        UnionMembership.objects.filter(pk__in=repoint_ids).update(person=canonical)
    if removed:
        UnionMembership.objects.filter(pk__in=[m.pk for m in removed]).delete()

    # --- claims about the absorbed person ----------------------------------
    person_type = _person_content_type()
    claim_ids = list(
        Claim.objects.filter(subject_type=person_type, subject_id=absorbed.pk).values_list(
            "pk", flat=True
        )
    )
    snapshot["claims_repointed"] = [str(pk) for pk in claim_ids]
    if claim_ids:
        Claim.objects.filter(pk__in=claim_ids).update(subject_id=canonical.pk)

    # --- media tags --------------------------------------------------------
    media_ids = list(MediaItem.objects.filter(persons=absorbed).values_list("pk", flat=True))
    snapshot["media_repointed"] = [str(pk) for pk in media_ids]
    for item in MediaItem.objects.filter(pk__in=media_ids):
        item.persons.remove(absorbed)
        item.persons.add(canonical)

    # --- members anchored to the absorbed node -----------------------------
    user_model = get_user_model()
    user_ids = list(user_model.objects.filter(anchor_person=absorbed).values_list("pk", flat=True))
    snapshot["users_repointed"] = [str(pk) for pk in user_ids]
    if user_ids:
        user_model.objects.filter(pk__in=user_ids).update(anchor_person=canonical)

    # --- earlier merges that pointed at the absorbed node ------------------
    # Keeps the "one hop resolves to canonical" invariant that traversal relies on.
    chained_ids = list(Person.objects.filter(merged_into=absorbed).values_list("pk", flat=True))
    snapshot["merged_from_repointed"] = [str(pk) for pk in chained_ids]
    if chained_ids:
        Person.objects.filter(pk__in=chained_ids).update(merged_into=canonical)

    _fill_blanks(canonical, absorbed)

    Person.objects.filter(pk=absorbed.pk).update(
        status=PersonStatus.MERGED_INTO, merged_into=canonical, updated_at=timezone.now()
    )

    record = MergeRecord.objects.create(
        canonical=canonical,
        absorbed=absorbed,
        snapshot=snapshot,
        candidate=candidate,
        performed_by=performed_by,
    )
    if candidate is not None:
        MergeCandidate.objects.filter(pk=candidate.pk).update(status=CandidateStatus.MERGED)
    return record


@transaction.atomic
def unmerge(record: MergeRecord, performed_by=None) -> MergeRecord:
    """Undo `record`, restoring both persons and every edge exactly as they were."""
    record = MergeRecord.objects.select_for_update().get(pk=record.pk)
    if record.reverted_at is not None:
        raise MergeError("This merge has already been reverted.")

    absorbed = Person.objects.get(pk=record.absorbed_id)
    if (
        absorbed.status != PersonStatus.MERGED_INTO
        or absorbed.merged_into_id != record.canonical_id
    ):
        raise MergeError(
            "The absorbed person is no longer merged into this canonical person; "
            "revert the later merge first."
        )

    snapshot = record.snapshot

    # Un-set the merge pointer before restoring rows, so the CHECK constraint that ties
    # status to merged_into is satisfied at every step.
    for pk, values in _field_values(Person, snapshot["absorbed"]):
        Person.objects.filter(pk=pk).update(**values)
    for pk, values in _field_values(Person, snapshot["canonical"]):
        Person.objects.filter(pk=pk).update(**values)

    if snapshot.get("memberships_repointed"):
        UnionMembership.objects.filter(pk__in=snapshot["memberships_repointed"]).update(
            person=absorbed
        )

    for pk, values in _field_values(UnionMembership, snapshot.get("memberships_removed")):
        UnionMembership.objects.filter(pk=pk).delete()
        created_at = values.pop("created_at")
        UnionMembership.objects.create(pk=pk, **values)
        # created_at is auto_now_add, so it has to be written back separately.
        UnionMembership.objects.filter(pk=pk).update(created_at=created_at)

    if snapshot.get("claims_repointed"):
        Claim.objects.filter(pk__in=snapshot["claims_repointed"]).update(subject_id=absorbed.pk)

    canonical = Person.objects.get(pk=record.canonical_id)
    for item in MediaItem.objects.filter(pk__in=snapshot.get("media_repointed") or []):
        item.persons.remove(canonical)
        item.persons.add(absorbed)

    user_model = get_user_model()
    if snapshot.get("users_repointed"):
        user_model.objects.filter(pk__in=snapshot["users_repointed"]).update(anchor_person=absorbed)

    if snapshot.get("merged_from_repointed"):
        Person.objects.filter(pk__in=snapshot["merged_from_repointed"]).update(merged_into=absorbed)

    MergeRecord.objects.filter(pk=record.pk).update(
        reverted_at=timezone.now(), reverted_by=performed_by
    )
    if record.candidate_id:
        MergeCandidate.objects.filter(pk=record.candidate_id).update(status=CandidateStatus.OPEN)
    record.refresh_from_db()
    return record


def _validate_merge(canonical: Person, absorbed: Person) -> None:
    from apps.genealogy.graph.traversal import ancestor_depths

    if canonical.pk == absorbed.pk:
        raise MergeError("A person cannot be merged into themselves.")
    if canonical.status != PersonStatus.CANONICAL:
        raise MergeError("The surviving person must be canonical.")
    if absorbed.status != PersonStatus.CANONICAL:
        raise MergeError("The absorbed person has already been merged or tombstoned.")
    if absorbed.pk in ancestor_depths(canonical) or canonical.pk in ancestor_depths(absorbed):
        raise MergeError(
            "These two are recorded as ancestor and descendant of each other; merging "
            "them would create a cycle. Fix the parentage first."
        )


def _fill_blanks(canonical: Person, absorbed: Person) -> None:
    """Carry over anything the absorbed record knew and the canonical one did not."""
    updates = {}
    for field in _FILL_IF_BLANK:
        if not getattr(canonical, field) and getattr(absorbed, field):
            updates[field] = getattr(absorbed, field)
    for field in _FILL_IF_NULL:
        if getattr(canonical, field) is None and getattr(absorbed, field) is not None:
            updates[field] = getattr(absorbed, field)
    if canonical.gender == "unknown" and absorbed.gender != "unknown":
        updates["gender"] = absorbed.gender
    # A death recorded on either record settles it.
    if canonical.is_living and not absorbed.is_living:
        updates["is_living"] = False
    if absorbed.visibility_consent and not canonical.visibility_consent:
        updates["visibility_consent"] = True

    merged_nicknames = list(canonical.nicknames or [])
    for nickname in absorbed.nicknames or []:
        if nickname not in merged_nicknames:
            merged_nicknames.append(nickname)
    if merged_nicknames != (canonical.nicknames or []):
        updates["nicknames"] = merged_nicknames

    if updates:
        updates["updated_at"] = timezone.now()
        Person.objects.filter(pk=canonical.pk).update(**updates)
        canonical.refresh_from_db()


def _person_content_type():
    from django.contrib.contenttypes.models import ContentType

    return ContentType.objects.get_for_model(Person)
