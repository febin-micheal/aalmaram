from django.urls import include, path
from rest_framework.routers import DefaultRouter

from .views import CsrfView, OverviewView, PersonViewSet, QuickAddView, RelateView

router = DefaultRouter()
router.register("persons", PersonViewSet, basename="person")

urlpatterns = [
    path("overview/", OverviewView.as_view(), name="overview"),
    path("relate/", RelateView.as_view(), name="relate"),
    path("quick-add/", QuickAddView.as_view(), name="quick-add"),
    path("csrf/", CsrfView.as_view(), name="csrf"),
    path("", include(router.urls)),
]
