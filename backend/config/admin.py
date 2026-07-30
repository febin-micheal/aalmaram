"""The Aalmaram admin site.

The Phase 1 interface is the admin, and it needs three pages that belong to no single
model: a graph explorer, a relationship finder, and a quick-add screen that creates a
whole household at once. They are registered here, on the site, so they appear in the
URLconf at their own paths:

    /admin/genealogy/explorer/
    /admin/genealogy/relate/
    /admin/genealogy/quick-add/

An earlier revision hung these off ``PersonAdmin.get_urls()``, which buried them under
``/admin/genealogy/person/…`` — a URL nobody would guess and not the one the plan
specified. See DECISIONS.md #16.

Django wires this class in as the default admin site through
``config.apps.AalmaramAdminConfig``, so ``django.contrib.admin.site`` *is* this site and
every existing ``@admin.register(...)`` keeps working untouched.
"""

from functools import partial

from django.contrib.admin import AdminSite
from django.urls import path
from django.utils.translation import gettext_lazy as _


class AalmaramAdminSite(AdminSite):
    site_header = _("Aalmaram")
    site_title = _("Aalmaram admin")
    index_title = _("Family graph")

    def get_urls(self):
        # Imported here rather than at module level: this module is loaded while the
        # admin site itself is being constructed, and the views pull in forms whose
        # autocomplete widgets need the finished site object.
        from apps.genealogy.admin import views

        custom = [
            path(
                "genealogy/explorer/",
                self.admin_view(partial(views.explorer_view, admin_site=self)),
                name="genealogy_explorer",
            ),
            path(
                "genealogy/relate/",
                self.admin_view(partial(views.relate_view, admin_site=self)),
                name="genealogy_relate",
            ),
            path(
                "genealogy/quick-add/",
                self.admin_view(partial(views.quick_add_view, admin_site=self)),
                name="genealogy_quick_add",
            ),
        ]
        # Prepended so they resolve ahead of the app_index catch-all.
        return custom + super().get_urls()
