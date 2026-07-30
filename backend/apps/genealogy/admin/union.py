from django.contrib import admin
from django.forms.models import BaseInlineFormSet
from django.utils.translation import gettext_lazy as _

from apps.genealogy.models import Role, Union, UnionMembership


class RoleFormSet(BaseInlineFormSet):
    """Both inlines edit UnionMembership, so each needs its own prefix and role.

    The role is never a field the user fills in — it is implied by which section of the
    form they typed into, which is what makes the union screen quick to work with.
    """

    role: str = Role.PARTNER

    def save_new(self, form, commit=True):
        instance = super().save_new(form, commit=False)
        instance.role = self.role
        if commit:
            instance.save()
        return instance


class PartnerFormSet(RoleFormSet):
    role = Role.PARTNER

    @classmethod
    def get_default_prefix(cls):
        return "partners"


class ChildFormSet(RoleFormSet):
    role = Role.CHILD

    @classmethod
    def get_default_prefix(cls):
        return "children"


class PartnerInline(admin.TabularInline):
    """Zero, one or two partners — a union with one partner means "father unknown"."""

    model = UnionMembership
    formset = PartnerFormSet
    fk_name = "union"
    extra = 2
    verbose_name = _("partner")
    verbose_name_plural = _("partners")
    autocomplete_fields = ("person",)
    fields = ("person", "notes")

    def get_queryset(self, request):
        return super().get_queryset(request).filter(role=Role.PARTNER)


class ChildInline(admin.TabularInline):
    model = UnionMembership
    formset = ChildFormSet
    fk_name = "union"
    extra = 3
    verbose_name = _("child")
    verbose_name_plural = _("children")
    autocomplete_fields = ("person",)
    fields = ("person", "relation_type", "sibling_order", "notes")

    def get_queryset(self, request):
        return super().get_queryset(request).filter(role=Role.CHILD)


@admin.register(Union)
class UnionAdmin(admin.ModelAdmin):
    list_display = ("__str__", "union_type", "year_display", "place", "status", "child_count")
    list_filter = ("union_type", "status")
    search_fields = ("memberships__person__name_en", "memberships__person__name_ml", "place")
    inlines = (PartnerInline, ChildInline)
    fieldsets = (
        (None, {"fields": ("union_type", "status")}),
        (_("When and where"), {"fields": (("year_min", "year_max"), "date_exact", "place")}),
        (_("Notes"), {"fields": ("notes",)}),
    )

    @admin.display(description=_("children"))
    def child_count(self, obj):
        return obj.memberships.filter(role=Role.CHILD).count()

    def save_model(self, request, obj, form, change):
        if not change and obj.created_by_id is None:
            obj.created_by = request.user
        super().save_model(request, obj, form, change)


@admin.register(UnionMembership)
class UnionMembershipAdmin(admin.ModelAdmin):
    """Rarely edited directly; registered so autocomplete widgets can resolve `person`."""

    list_display = ("person", "role", "union", "relation_type", "sibling_order")
    list_filter = ("role", "relation_type")
    search_fields = ("person__name_en", "person__name_ml")
    autocomplete_fields = ("person", "union")
