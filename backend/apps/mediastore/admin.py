from django.contrib import admin

from .models import MediaItem


@admin.register(MediaItem)
class MediaItemAdmin(admin.ModelAdmin):
    """Storage only in Phase 1 — upload UX and tagging arrive in Phase 3."""

    list_display = ("__str__", "media_type", "owner", "created_at")
    list_filter = ("media_type",)
    search_fields = ("caption", "transcript")
    autocomplete_fields = ("persons",)
    readonly_fields = ("created_at", "updated_at")
