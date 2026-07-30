"""Duplicate detection and reversible merges.

Phase 1 ships the tables and the merge/unmerge operation itself (a Phase 1 acceptance
check requires un-merge to restore exact prior state). What it does *not* ship is the
scoring engine that proposes candidates automatically — relational-context matching and
the transliteration variant table are Phase 4. Until then MergeCandidate rows come from
a human noticing a duplicate in the admin.
"""

import uuid

from django.db import models
from django.utils.translation import gettext_lazy as _


class CandidateStatus(models.TextChoices):
    OPEN = "open", _("Open")
    MERGED = "merged", _("Merged")
    REJECTED = "rejected", _("Not a duplicate")


class MergeCandidate(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    person_a = models.ForeignKey(
        "genealogy.Person", on_delete=models.CASCADE, related_name="merge_candidates_as_a"
    )
    person_b = models.ForeignKey(
        "genealogy.Person", on_delete=models.CASCADE, related_name="merge_candidates_as_b"
    )
    #: 0.0–1.0. Hand-entered in Phase 1; computed by the Phase 4 matcher.
    score = models.FloatField(_("score"), default=0.0)
    #: Per-signal breakdown, e.g. {"shared_parent_names": 2, "era_overlap": true}.
    evidence = models.JSONField(_("evidence"), default=dict, blank=True)
    status = models.CharField(
        _("status"),
        max_length=16,
        choices=CandidateStatus.choices,
        default=CandidateStatus.OPEN,
        db_index=True,
    )
    note = models.TextField(_("note"), blank=True)

    created_at = models.DateTimeField(_("created at"), auto_now_add=True)
    updated_at = models.DateTimeField(_("updated at"), auto_now=True)

    class Meta:
        verbose_name = _("merge candidate")
        verbose_name_plural = _("merge candidates")
        ordering = ("-score", "-created_at")
        constraints = [
            models.UniqueConstraint(
                fields=["person_a", "person_b"], name="unique_merge_candidate_pair"
            ),
            models.CheckConstraint(
                condition=~models.Q(person_a=models.F("person_b")),
                name="merge_candidate_distinct_persons",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.person_a} ≟ {self.person_b} ({self.score:.2f})"


class MergeRecord(models.Model):
    """One performed merge, carrying everything needed to undo it exactly.

    `snapshot` holds the pre-merge field values of the absorbed person plus every edge
    that was repointed (union memberships, claims, media tags). Un-merge replays it.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    canonical = models.ForeignKey(
        "genealogy.Person",
        on_delete=models.CASCADE,
        related_name="merges_absorbed",
        verbose_name=_("canonical"),
    )
    absorbed = models.ForeignKey(
        "genealogy.Person",
        on_delete=models.CASCADE,
        related_name="merges_as_absorbed",
        verbose_name=_("absorbed"),
    )
    snapshot = models.JSONField(_("pre-merge snapshot"), default=dict)
    candidate = models.ForeignKey(
        MergeCandidate,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="merge_records",
    )

    performed_by = models.ForeignKey(
        "accounts.User",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="performed_merges",
    )
    performed_at = models.DateTimeField(_("performed at"), auto_now_add=True)
    reverted_by = models.ForeignKey(
        "accounts.User",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="reverted_merges",
    )
    reverted_at = models.DateTimeField(_("reverted at"), null=True, blank=True)

    class Meta:
        verbose_name = _("merge record")
        verbose_name_plural = _("merge records")
        ordering = ("-performed_at",)
        indexes = [models.Index(fields=["absorbed", "reverted_at"])]

    def __str__(self) -> str:
        state = "reverted" if self.reverted_at else "active"
        return f"{self.absorbed_id} → {self.canonical_id} ({state})"

    @property
    def is_reverted(self) -> bool:
        return self.reverted_at is not None
