"""The Person node.

Two things about this model are load-bearing for the whole system:

1. It stores no kinship. There is no `father` or `mother` column and there never will
   be — every parent/child link travels through Union + UnionMembership. See CLAUDE.md.
2. Dates are uncertainty-native. Almost nobody remembers an exact birth date for a
   great-grandparent, so the model stores a year *range* and treats the exact date as
   the rare bonus case.
"""

import uuid

from django.contrib.postgres.indexes import GinIndex
from django.db import models
from django.utils.translation import gettext_lazy as _


class PersonStatus(models.TextChoices):
    CANONICAL = "canonical", _("Canonical")
    MERGED_INTO = "merged_into", _("Merged into another person")
    TOMBSTONE = "tombstone", _("Tombstone (created in error)")


class Gender(models.TextChoices):
    FEMALE = "female", _("Female")
    MALE = "male", _("Male")
    OTHER = "other", _("Other")
    UNKNOWN = "unknown", _("Unknown")


class PersonQuerySet(models.QuerySet):
    def canonical(self):
        """Only live, un-merged nodes. This is what traversal and the UI operate on."""
        return self.filter(status=PersonStatus.CANONICAL)

    def deceased(self):
        return self.filter(is_living=False)

    def living(self):
        return self.filter(is_living=True)

    def visible_to(self, anchor, degrees=None):
        """Apply the privacy rule at the queryset level (CLAUDE.md, Phase 1 check #5).

        Deceased persons are visible to every authenticated member. Living persons are
        visible only within `degrees` hops of the viewer's anchor Person, or when they
        have explicitly consented to be public.

        `anchor` may be a Person, a Person id, or a User carrying `anchor_person`.
        Passing None yields deceased + consenting persons only.
        """
        from apps.genealogy.graph.privacy import visible_person_filter

        return self.filter(visible_person_filter(anchor, degrees=degrees))

    def search(self, term):
        """Loose name search across both scripts, nicknames and house name."""
        if not term:
            return self
        return self.filter(
            models.Q(name_en__icontains=term)
            | models.Q(name_ml__icontains=term)
            | models.Q(house_name__icontains=term)
            | models.Q(nicknames__icontains=term)
        )


class Person(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    status = models.CharField(
        _("status"),
        max_length=16,
        choices=PersonStatus.choices,
        default=PersonStatus.CANONICAL,
        db_index=True,
    )
    #: Set only when status=merged_into. Points at the surviving canonical Person.
    merged_into = models.ForeignKey(
        "self",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="merged_from",
        verbose_name=_("merged into"),
    )

    name_en = models.CharField(_("name (English)"), max_length=200, blank=True)
    name_ml = models.CharField(_("name (Malayalam)"), max_length=200, blank=True)
    nicknames = models.JSONField(_("nicknames"), default=list, blank=True)
    #: veedu / tharavadu. For pre-1950 births this identifies a person more reliably
    #: than the given name does, so it is a first-class column, not a note.
    house_name = models.CharField(_("house name"), max_length=200, blank=True, db_index=True)
    gender = models.CharField(
        _("gender"), max_length=16, choices=Gender.choices, default=Gender.UNKNOWN
    )
    is_living = models.BooleanField(_("is living"), default=True)

    birth_year_min = models.IntegerField(_("birth year (earliest)"), null=True, blank=True)
    birth_year_max = models.IntegerField(_("birth year (latest)"), null=True, blank=True)
    birth_date_exact = models.DateField(_("birth date (exact)"), null=True, blank=True)

    death_year_min = models.IntegerField(_("death year (earliest)"), null=True, blank=True)
    death_year_max = models.IntegerField(_("death year (latest)"), null=True, blank=True)
    death_date_exact = models.DateField(_("death date (exact)"), null=True, blank=True)

    place_origin = models.CharField(_("place of origin"), max_length=200, blank=True)
    place_lat = models.DecimalField(
        _("latitude"), max_digits=9, decimal_places=6, null=True, blank=True
    )
    place_lng = models.DecimalField(
        _("longitude"), max_digits=9, decimal_places=6, null=True, blank=True
    )

    religion_community = models.CharField(_("religion / community"), max_length=120, blank=True)
    #: parish / mahallu / temple — disambiguates same-named people in old records.
    institution = models.CharField(_("institution"), max_length=200, blank=True)

    notes = models.TextField(_("notes"), blank=True)
    #: Explicit opt-in that makes a living person visible outside the privacy radius.
    visibility_consent = models.BooleanField(_("consents to be publicly visible"), default=False)

    created_by = models.ForeignKey(
        "accounts.User",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="created_persons",
        verbose_name=_("created by"),
    )
    # `source_invite` (CLAUDE.md) lands in Phase 2 together with the Invite model;
    # until invites exist, created_by + created_at carry provenance. See DECISIONS.md #6.
    created_at = models.DateTimeField(_("created at"), auto_now_add=True)
    updated_at = models.DateTimeField(_("updated at"), auto_now=True)

    objects = PersonQuerySet.as_manager()

    class Meta:
        verbose_name = _("person")
        verbose_name_plural = _("persons")
        ordering = ("name_en", "name_ml", "created_at")
        indexes = [
            models.Index(fields=["status", "is_living"]),
            models.Index(fields=["birth_year_min", "birth_year_max"]),
            # Seeding runs to hundreds of people whose names are spelled several ways
            # across two scripts, so admin search is fuzzy by default and needs trigram
            # support. The Phase 4 duplicate matcher reuses these.
            GinIndex(fields=["name_en"], name="person_name_en_trgm", opclasses=["gin_trgm_ops"]),
            GinIndex(fields=["name_ml"], name="person_name_ml_trgm", opclasses=["gin_trgm_ops"]),
            GinIndex(fields=["house_name"], name="person_house_trgm", opclasses=["gin_trgm_ops"]),
            GinIndex(fields=["nicknames"], name="person_nicknames_gin"),
        ]
        constraints = [
            models.CheckConstraint(
                condition=(
                    models.Q(status=PersonStatus.MERGED_INTO, merged_into__isnull=False)
                    | (
                        ~models.Q(status=PersonStatus.MERGED_INTO)
                        & models.Q(merged_into__isnull=True)
                    )
                ),
                name="person_merged_into_requires_status",
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(birth_year_min__isnull=True)
                    | models.Q(birth_year_max__isnull=True)
                    | models.Q(birth_year_min__lte=models.F("birth_year_max"))
                ),
                name="person_birth_year_range_ordered",
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(death_year_min__isnull=True)
                    | models.Q(death_year_max__isnull=True)
                    | models.Q(death_year_min__lte=models.F("death_year_max"))
                ),
                name="person_death_year_range_ordered",
            ),
            models.CheckConstraint(
                condition=~models.Q(merged_into=models.F("id")),
                name="person_not_merged_into_self",
            ),
        ]

    def __str__(self) -> str:
        name = self.display_name
        if self.house_name:
            return f"{name} ({self.house_name})"
        return name

    @property
    def display_name(self) -> str:
        return self.name_en or self.name_ml or f"Unnamed {str(self.id)[:8]}"

    @property
    def birth_year_display(self) -> str:
        return _year_range_display(self.birth_year_min, self.birth_year_max, self.birth_date_exact)

    @property
    def death_year_display(self) -> str:
        return _year_range_display(self.death_year_min, self.death_year_max, self.death_date_exact)

    @property
    def lifespan_display(self) -> str:
        birth = self.birth_year_display or "?"
        if self.is_living and not self.death_year_display:
            return f"{birth}–"
        return f"{birth}–{self.death_year_display or '?'}"

    @property
    def birth_display(self) -> str:
        """Short form for a node on a chart: "1938", "1930s", "c. 1890", "?"."""
        return _compact_year_display(
            self.birth_year_min, self.birth_year_max, self.birth_date_exact
        )

    @property
    def death_display(self) -> str:
        return _compact_year_display(
            self.death_year_min, self.death_year_max, self.death_date_exact
        )

    @property
    def lifespan_compact(self) -> str:
        if self.is_living and self.death_display == "?":
            return f"b. {self.birth_display}" if self.birth_display != "?" else ""
        return f"{self.birth_display} – {self.death_display}"

    @property
    def canonical_id(self):
        """Id of the surviving Person, following one merge hop.

        Merges always point at a canonical target, so a single hop is enough; the
        traversal SQL relies on that invariant too.
        """
        if self.status == PersonStatus.MERGED_INTO and self.merged_into_id:
            return self.merged_into_id
        return self.id

    def resolve_canonical(self) -> "Person":
        if self.status == PersonStatus.MERGED_INTO and self.merged_into_id:
            return self.merged_into
        return self

    @property
    def birth_year_estimate(self) -> int | None:
        """Single best-guess birth year, for era comparison and sibling ordering."""
        if self.birth_date_exact:
            return self.birth_date_exact.year
        if self.birth_year_min and self.birth_year_max:
            return (self.birth_year_min + self.birth_year_max) // 2
        return self.birth_year_min or self.birth_year_max


def _compact_year_display(year_min, year_max, exact) -> str:
    """Collapse an uncertainty trio into something that fits on a chart node.

    A range is never widened into a false precision and never hidden: a decade-wide
    guess reads as "1930s", a tight one as "c. 1890", and no information at all as "?"
    rather than as a blank that could be mistaken for a missing field.
    """
    if exact:
        return str(exact.year)
    if year_min and year_max:
        if year_min == year_max:
            return str(year_min)
        if year_min // 10 == year_max // 10:
            return f"{(year_min // 10) * 10}s"
        if year_max - year_min <= 15:
            return f"c. {(year_min + year_max) // 2}"
        return f"{year_min}–{year_max}"
    if year_min:
        return f"after {year_min}"
    if year_max:
        return f"before {year_max}"
    return "?"


def _year_range_display(year_min, year_max, exact) -> str:
    if exact:
        return str(exact.year)
    if year_min and year_max:
        return str(year_min) if year_min == year_max else f"{year_min}–{year_max}"
    if year_min:
        return f"≥{year_min}"
    if year_max:
        return f"≤{year_max}"
    return ""
