"""The shape of the versioned API surface.

Phase 1 exposed nothing but a health check. Phase 1.5 adds the explorer's three read-only
endpoints, gated to staff sessions — so the assertion here is no longer "nothing exists"
but "nothing is reachable without a staff session, and nothing beyond those three exists
at all". Per-endpoint behaviour lives in apps/genealogy/tests/test_api.py.
"""

import pytest
from django.urls import reverse

pytestmark = pytest.mark.django_db


def test_health_endpoint_answers(client):
    response = client.get(reverse("v1:health"))
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "phase": 1.5}


def test_the_versioned_namespace_is_in_place():
    assert reverse("v1:health") == "/api/v1/health/"


def test_family_data_is_never_served_to_anonymous_callers(client, family_a):
    """Magic-link auth is Phase 2; until then only staff sessions see the graph."""
    for path in [
        "/api/v1/persons/",
        "/api/v1/persons/suggested/",
        f"/api/v1/persons/{family_a.thomas.pk}/neighborhood/",
        "/api/v1/relate/",
    ]:
        assert client.get(path).status_code == 403, f"{path} must refuse anonymous callers"


def test_member_facing_endpoints_do_not_exist_yet(client):
    """The swipe deck's API is Phase 2 and must not be half-present."""
    for path in ["/api/v1/cards/", "/api/v1/claims/", "/api/v1/invites/", "/api/v1/media/"]:
        assert client.get(path).status_code == 404


def test_drf_defaults_are_closed_and_paginated():
    from django.conf import settings

    rest = settings.REST_FRAMEWORK
    assert rest["DEFAULT_PERMISSION_CLASSES"] == ["rest_framework.permissions.IsAuthenticated"]
    assert rest["DEFAULT_PAGINATION_CLASS"] == "rest_framework.pagination.PageNumberPagination"
    assert rest["PAGE_SIZE"] > 0
