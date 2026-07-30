"""Photos, voice notes and documents.

Phase 1 creates the tables only — upload UX, photo tagging and the transcription
pipeline are Phase 3. The model is here now because it is part of the core data model in
CLAUDE.md and because `transcript` being empty must never be mistaken for "no audio":
voice notes are stored raw today and transcribed later.
"""

import uuid

from django.db import models
from django.utils.translation import gettext_lazy as _


class MediaType(models.TextChoices):
    PHOTO = "photo", _("Photo")
    AUDIO = "audio", _("Audio")
    DOCUMENT = "document", _("Document")


class MediaItem(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    media_type = models.CharField(_("type"), max_length=16, choices=MediaType.choices)
    file = models.FileField(_("file"), upload_to="uploads/%Y/%m/")
    caption = models.TextField(_("caption"), blank=True)
    year_min = models.IntegerField(_("year (earliest)"), null=True, blank=True)
    year_max = models.IntegerField(_("year (latest)"), null=True, blank=True)

    #: Filled by the Phase 3 transcription pipeline; empty until then.
    transcript = models.TextField(_("transcript"), blank=True)
    transcript_language = models.CharField(_("transcript language"), max_length=8, blank=True)

    owner = models.ForeignKey(
        "accounts.User",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="media_items",
    )
    #: Who appears in / is described by this item. Tags are proposed via Claim rows and
    #: land here once accepted, so this stays the settled view.
    persons = models.ManyToManyField(
        "genealogy.Person", blank=True, related_name="media_items", verbose_name=_("tagged persons")
    )

    created_at = models.DateTimeField(_("created at"), auto_now_add=True)
    updated_at = models.DateTimeField(_("updated at"), auto_now=True)

    class Meta:
        verbose_name = _("media item")
        verbose_name_plural = _("media items")
        ordering = ("-created_at",)

    def __str__(self) -> str:
        return self.caption or f"{self.get_media_type_display()} {str(self.id)[:8]}"
