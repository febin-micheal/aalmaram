"""Versioned API surface.

Phase 1 shipped only a health check, because there was no way to authenticate anyone.
Phase 1.5 adds three read-only endpoints for the explorer, gated to staff sessions —
still not the member-facing API, which arrives with magic-link auth in Phase 2. See
DECISIONS.md #4 and #17.
"""

from django.urls import include, path
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response


@api_view(["GET"])
@permission_classes([AllowAny])
def health(_request):
    return Response({"status": "ok", "phase": 1.5})


urlpatterns = [
    path("health/", health, name="health"),
    path("", include("apps.genealogy.api.urls")),
]
