from django.urls import include, path
from rest_framework.routers import DefaultRouter

from .views import (
    CsrfView,
    MeView,
    OverviewView,
    PersonViewSet,
    QuickAddView,
    RelateBulkView,
    RelateView,
    SetAnchorView,
    UnionPartnerView,
)

router = DefaultRouter()
router.register("persons", PersonViewSet, basename="person")

urlpatterns = [
    path("overview/", OverviewView.as_view(), name="overview"),
    path("relate/", RelateView.as_view(), name="relate"),
    path("relate-bulk/", RelateBulkView.as_view(), name="relate-bulk"),
    path(
        "unions/<uuid:union_id>/partners/<uuid:person_id>/",
        UnionPartnerView.as_view(),
        name="union-partner",
    ),
    path("me/", MeView.as_view(), name="me"),
    path("me/anchor/", SetAnchorView.as_view(), name="set-anchor"),
    path("quick-add/", QuickAddView.as_view(), name="quick-add"),
    path("csrf/", CsrfView.as_view(), name="csrf"),
    path("", include(router.urls)),
]
