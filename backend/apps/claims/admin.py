"""The contested-claim queue.

Febin is the sole arbiter in v1, so this is a filtered changelist with confirm/reject
actions rather than a workflow. The default view opens on the claims that need a
decision.
"""

from django.contrib import admin, messages
from django.utils import timezone
from django.utils.translation import gettext_lazy as _

from .models import Claim, ClaimStatus


class NeedsArbitrationFilter(admin.SimpleListFilter):
    title = _("needs arbitration")
    parameter_name = "arbitration"

    def lookups(self, request, model_admin):
        return (("yes", _("Waiting on a decision")), ("no", _("Settled")))

    def queryset(self, request, queryset):
        if self.value() == "yes":
            return queryset.needs_arbitration()
        if self.value() == "no":
            return queryset.exclude(pk__in=queryset.needs_arbitration().values("pk"))
        return queryset


@admin.register(Claim)
class ClaimAdmin(admin.ModelAdmin):
    list_display = (
        "predicate",
        "subject",
        "value",
        "status",
        "confirmations_count",
        "disputes_count",
        "created_by",
        "created_at",
    )
    list_filter = (NeedsArbitrationFilter, "status", "predicate")
    search_fields = ("predicate", "resolution_note")
    readonly_fields = ("subject", "created_at", "updated_at")
    actions = ("confirm_claims", "reject_claims")

    @admin.action(description=_("Confirm: this claim is correct"))
    def confirm_claims(self, request, queryset):
        updated = queryset.update(
            status=ClaimStatus.CONFIRMED, resolved_by=request.user, resolved_at=timezone.now()
        )
        self.message_user(request, _("%d claim(s) confirmed.") % updated, messages.SUCCESS)

    @admin.action(description=_("Reject: this claim is wrong"))
    def reject_claims(self, request, queryset):
        updated = queryset.update(
            status=ClaimStatus.REJECTED, resolved_by=request.user, resolved_at=timezone.now()
        )
        self.message_user(request, _("%d claim(s) rejected.") % updated, messages.WARNING)
