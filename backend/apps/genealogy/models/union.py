"""Union and UnionMembership — the only place kinship is stored.

A Union is a partnership node. Partners attach to it with role=partner; their children
attach with role=child. Parenthood is therefore always derived: X is a parent of Y when
X is a partner in a union where Y is a child.

That indirection is what makes the awkward cases representable:

* remarriage — one person is a partner in two unions
* half-siblings — two children in different unions that share exactly one partner
* unknown parent — a union with a single partner (or none) that still has children
* single mothers, adoptions, informal partnerships — union_type and relation_type
"""

import uuid

from django.db import models
from django.utils.translation import gettext_lazy as _


class UnionType(models.TextChoices):
    MARRIAGE = "marriage", _("Marriage")
    PARTNERSHIP = "partnership", _("Partnership")
    UNKNOWN = "unknown", _("Unknown")


class UnionStatus(models.TextChoices):
    ACTIVE = "active", _("Active")
    ENDED = "ended", _("Ended")
    UNKNOWN = "unknown", _("Unknown")


class Role(models.TextChoices):
    PARTNER = "partner", _("Partner")
    CHILD = "child", _("Child")


class RelationType(models.TextChoices):
    BIOLOGICAL = "biological", _("Biological")
    ADOPTED = "adopted", _("Adopted")
    STEP = "step", _("Step")
    UNKNOWN = "unknown", _("Unknown")


class Union(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    union_type = models.CharField(
        _("union type"), max_length=16, choices=UnionType.choices, default=UnionType.MARRIAGE
    )
    year_min = models.IntegerField(_("year (earliest)"), null=True, blank=True)
    year_max = models.IntegerField(_("year (latest)"), null=True, blank=True)
    date_exact = models.DateField(_("date (exact)"), null=True, blank=True)
    place = models.CharField(_("place"), max_length=200, blank=True)
    status = models.CharField(
        _("status"), max_length=16, choices=UnionStatus.choices, default=UnionStatus.UNKNOWN
    )
    notes = models.TextField(_("notes"), blank=True)

    created_by = models.ForeignKey(
        "accounts.User",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="created_unions",
    )
    created_at = models.DateTimeField(_("created at"), auto_now_add=True)
    updated_at = models.DateTimeField(_("updated at"), auto_now=True)

    class Meta:
        verbose_name = _("union")
        verbose_name_plural = _("unions")
        ordering = ("year_min", "created_at")
        constraints = [
            models.CheckConstraint(
                condition=(
                    models.Q(year_min__isnull=True)
                    | models.Q(year_max__isnull=True)
                    | models.Q(year_min__lte=models.F("year_max"))
                ),
                name="union_year_range_ordered",
            ),
        ]

    def __str__(self) -> str:
        partners = [
            m.person.display_name
            for m in self.memberships.filter(role=Role.PARTNER).select_related("person")
        ]
        label = " & ".join(partners) if partners else "unknown partners"
        year = self.year_display
        return f"{label} ({year})" if year else label

    @property
    def year_display(self) -> str:
        if self.date_exact:
            return str(self.date_exact.year)
        if self.year_min and self.year_max:
            return (
                str(self.year_min)
                if self.year_min == self.year_max
                else f"{self.year_min}–{self.year_max}"
            )
        return str(self.year_min or self.year_max or "")

    def partners(self):
        return [
            m.person for m in self.memberships.filter(role=Role.PARTNER).select_related("person")
        ]

    def children(self):
        return [m.person for m in self.memberships.filter(role=Role.CHILD).select_related("person")]


class UnionMembership(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    union = models.ForeignKey(Union, on_delete=models.CASCADE, related_name="memberships")
    person = models.ForeignKey(
        "genealogy.Person", on_delete=models.CASCADE, related_name="union_memberships"
    )
    role = models.CharField(_("role"), max_length=16, choices=Role.choices)
    #: Only meaningful for role=child; partners keep the UNKNOWN default.
    relation_type = models.CharField(
        _("relation type"),
        max_length=16,
        choices=RelationType.choices,
        default=RelationType.BIOLOGICAL,
    )
    #: 1-based birth order among the children of this union. Usually not known at entry
    #: time — it gets filled in indirectly by "was X older or younger than Y?" swipes.
    sibling_order = models.PositiveIntegerField(_("sibling order"), null=True, blank=True)
    notes = models.TextField(_("notes"), blank=True)

    created_by = models.ForeignKey(
        "accounts.User",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="created_memberships",
    )
    created_at = models.DateTimeField(_("created at"), auto_now_add=True)

    class Meta:
        verbose_name = _("union membership")
        verbose_name_plural = _("union memberships")
        ordering = ("role", "sibling_order", "created_at")
        constraints = [
            models.UniqueConstraint(
                fields=["union", "person", "role"], name="unique_union_person_role"
            ),
        ]
        indexes = [
            models.Index(fields=["person", "role"]),
            models.Index(fields=["union", "role"]),
        ]

    def __str__(self) -> str:
        return f"{self.person.display_name} — {self.get_role_display()}"
