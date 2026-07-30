from django.contrib import admin, messages
from django.urls import reverse
from django.utils.html import format_html
from django.utils.translation import gettext_lazy as _

from apps.genealogy.models import Person, PersonStatus


@admin.register(Person)
class PersonAdmin(admin.ModelAdmin):
    list_display = (
        "display_name",
        "name_ml",
        "house_name",
        "gender",
        "lifespan_display",
        "status",
        "explore_link",
    )
    list_filter = ("status", "is_living", "gender", "visibility_consent", "religion_community")
    # Trigram-indexed; nicknames is JSONB and matches on its text form.
    search_fields = ("name_en", "name_ml", "house_name", "nicknames", "place_origin", "institution")
    readonly_fields = ("status", "merged_into", "created_at", "updated_at")
    list_select_related = False
    actions = ("mark_as_tombstone",)
    change_list_template = "admin/genealogy/person/change_list.html"

    fieldsets = (
        (
            None,
            {"fields": ("name_en", "name_ml", "nicknames", "house_name", "gender", "is_living")},
        ),
        (
            _("Birth"),
            {
                "fields": (("birth_year_min", "birth_year_max"), "birth_date_exact"),
                "description": _("A year range is enough. Never block entry on an exact date."),
            },
        ),
        (_("Death"), {"fields": (("death_year_min", "death_year_max"), "death_date_exact")}),
        (
            _("Place & community"),
            {
                "fields": (
                    "place_origin",
                    ("place_lat", "place_lng"),
                    "religion_community",
                    "institution",
                )
            },
        ),
        (_("Privacy"), {"fields": ("visibility_consent",)}),
        (
            _("Notes & provenance"),
            {
                "fields": (
                    "notes",
                    "created_by",
                    "status",
                    "merged_into",
                    "created_at",
                    "updated_at",
                )
            },
        ),
    )

    @admin.display(description=_("lifespan"))
    def lifespan_display(self, obj):
        return obj.lifespan_display

    @admin.display(description=_("graph"))
    def explore_link(self, obj):
        url = reverse("admin:genealogy_explorer")
        return format_html('<a href="{}?person={}">explore</a>', url, obj.pk)

    @admin.action(description=_("Mark selected as entered in error (tombstone)"))
    def mark_as_tombstone(self, request, queryset):
        updated = queryset.filter(status=PersonStatus.CANONICAL).update(
            status=PersonStatus.TOMBSTONE
        )
        self.message_user(request, _("%d person(s) tombstoned.") % updated, messages.WARNING)

    def save_model(self, request, obj, form, change):
        if not change and obj.created_by_id is None:
            obj.created_by = request.user
        super().save_model(request, obj, form, change)

    # The graph explorer, relationship finder and quick-add screens are registered on
    # the admin site itself (config/admin.py), not here — they are not Person views and
    # nesting them under /admin/genealogy/person/ hid them. See DECISIONS.md #16.
