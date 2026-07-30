"""The merge queue.

Candidates are worked as a list with two actions: merge (person_a survives) or dismiss.
Every merge produces a MergeRecord that can be reverted from its own changelist, so a
mistaken merge is a two-click fix rather than a data-recovery exercise.
"""

from django.contrib import admin, messages
from django.urls import reverse
from django.utils.html import format_html
from django.utils.translation import gettext_lazy as _
from django.utils.translation import ngettext

from .models import CandidateStatus, MergeCandidate, MergeRecord
from .services import MergeError, merge_persons, unmerge


@admin.register(MergeCandidate)
class MergeCandidateAdmin(admin.ModelAdmin):
    list_display = ("person_a", "person_b", "score", "status", "evidence_summary", "compare_link")
    list_filter = ("status",)
    search_fields = (
        "person_a__name_en",
        "person_a__name_ml",
        "person_b__name_en",
        "person_b__name_ml",
    )
    autocomplete_fields = ("person_a", "person_b")
    actions = ("merge_keeping_a", "dismiss_as_distinct")
    readonly_fields = ("created_at", "updated_at")

    @admin.display(description=_("evidence"))
    def evidence_summary(self, obj):
        if not obj.evidence:
            return "—"
        return ", ".join(f"{key}={value}" for key, value in list(obj.evidence.items())[:4])

    @admin.display(description=_("compare"))
    def compare_link(self, obj):
        return format_html(
            '<a href="{}?a={}&b={}">{}</a>',
            reverse("admin:genealogy_relate"),
            obj.person_a_id,
            obj.person_b_id,
            _("how are they related?"),
        )

    @admin.action(description=_("Merge: keep person A, absorb person B"))
    def merge_keeping_a(self, request, queryset):
        merged = 0
        for candidate in queryset.filter(status=CandidateStatus.OPEN).select_related(
            "person_a", "person_b"
        ):
            try:
                merge_persons(
                    candidate.person_a,
                    candidate.person_b,
                    performed_by=request.user,
                    candidate=candidate,
                )
            except MergeError as error:
                self.message_user(request, f"{candidate}: {error}", messages.ERROR)
            else:
                merged += 1
        if merged:
            self.message_user(
                request,
                ngettext("%d pair merged.", "%d pairs merged.", merged) % merged,
                messages.SUCCESS,
            )

    @admin.action(description=_("Dismiss: these are different people"))
    def dismiss_as_distinct(self, request, queryset):
        updated = queryset.filter(status=CandidateStatus.OPEN).update(
            status=CandidateStatus.REJECTED
        )
        self.message_user(request, _("%d candidate(s) dismissed.") % updated, messages.INFO)


@admin.register(MergeRecord)
class MergeRecordAdmin(admin.ModelAdmin):
    list_display = ("absorbed", "canonical", "performed_by", "performed_at", "reverted_at")
    list_filter = ("reverted_at",)
    search_fields = ("canonical__name_en", "absorbed__name_en")
    readonly_fields = (
        "canonical",
        "absorbed",
        "candidate",
        "snapshot",
        "performed_by",
        "performed_at",
        "reverted_by",
        "reverted_at",
    )
    actions = ("revert_merges",)

    def has_add_permission(self, request):
        # Records are written by the merge service, never typed in by hand.
        return False

    @admin.action(description=_("Un-merge: restore the absorbed person exactly"))
    def revert_merges(self, request, queryset):
        reverted = 0
        for record in queryset.filter(reverted_at__isnull=True):
            try:
                unmerge(record, performed_by=request.user)
            except MergeError as error:
                self.message_user(request, f"{record}: {error}", messages.ERROR)
            else:
                reverted += 1
        if reverted:
            self.message_user(
                request,
                ngettext("%d merge reverted.", "%d merges reverted.", reverted) % reverted,
                messages.SUCCESS,
            )
