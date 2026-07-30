"""Fact provenance.

Every assertable statement about a person or a union can be recorded here with who said
it and how many people have since agreed or disagreed. From Phase 2 the swipe deck
writes into this table; in Phase 1 it exists so the schema and the arbiter queue are in
place, and so seed data entered by the admin can carry provenance.

The subject is a generic FK because claims are made about both Person and Union rows.
"""

import uuid

from django.contrib.contenttypes.fields import GenericForeignKey
from django.contrib.contenttypes.models import ContentType
from django.db import models
from django.utils.translation import gettext_lazy as _


class ClaimStatus(models.TextChoices):
    PROPOSED = "proposed", _("Proposed")
    CONFIRMED = "confirmed", _("Confirmed")
    CONTESTED = "contested", _("Contested")
    REJECTED = "rejected", _("Rejected")


class Predicate(models.TextChoices):
    """Open-ended by design; these are the predicates Phase 1–3 need."""

    NAME = "name", _("Name")
    HOUSE_NAME = "house_name", _("House name")
    BIRTH_YEAR = "birth_year", _("Birth year")
    DEATH_YEAR = "death_year", _("Death year")
    IS_LIVING = "is_living", _("Is living")
    PARENT_OF = "parent_of", _("Parent of")
    SIBLING_OF = "sibling_of", _("Sibling of")
    PARTNER_OF = "partner_of", _("Partner of")
    SIBLING_ORDER = "sibling_order", _("Sibling order")
    PHOTO_TAG = "photo_tag", _("Person in photo")
    OTHER = "other", _("Other")


class ClaimQuerySet(models.QuerySet):
    def contested(self):
        return self.filter(status=ClaimStatus.CONTESTED)

    def needs_arbitration(self):
        """The arbiter queue: contested, or disputed more than it is confirmed."""
        return self.filter(
            models.Q(status=ClaimStatus.CONTESTED)
            | models.Q(
                status=ClaimStatus.PROPOSED, disputes_count__gt=models.F("confirmations_count")
            )
        )


class Claim(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    subject_type = models.ForeignKey(ContentType, on_delete=models.CASCADE)
    subject_id = models.UUIDField()
    subject = GenericForeignKey("subject_type", "subject_id")

    predicate = models.CharField(_("predicate"), max_length=40, choices=Predicate.choices)
    value = models.JSONField(_("value"), default=dict, blank=True)

    created_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="claims"
    )
    #: Contributor's own certainty, 0.0–1.0. A "don't know" swipe never writes a claim.
    confidence = models.FloatField(_("confidence"), default=1.0)
    confirmations_count = models.PositiveIntegerField(_("confirmations"), default=0)
    disputes_count = models.PositiveIntegerField(_("disputes"), default=0)
    status = models.CharField(
        _("status"),
        max_length=16,
        choices=ClaimStatus.choices,
        default=ClaimStatus.PROPOSED,
        db_index=True,
    )
    resolution_note = models.TextField(_("arbiter note"), blank=True)
    resolved_by = models.ForeignKey(
        "accounts.User",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="resolved_claims",
    )
    resolved_at = models.DateTimeField(_("resolved at"), null=True, blank=True)

    created_at = models.DateTimeField(_("created at"), auto_now_add=True)
    updated_at = models.DateTimeField(_("updated at"), auto_now=True)

    objects = ClaimQuerySet.as_manager()

    class Meta:
        verbose_name = _("claim")
        verbose_name_plural = _("claims")
        ordering = ("-created_at",)
        indexes = [
            models.Index(fields=["subject_type", "subject_id"]),
            models.Index(fields=["predicate", "status"]),
        ]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(confidence__gte=0.0) & models.Q(confidence__lte=1.0),
                name="claim_confidence_in_range",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.predicate} on {self.subject_id} [{self.status}]"
