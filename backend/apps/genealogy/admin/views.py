"""The custom admin pages: graph explorer, relationship finder, quick add.

These are registered on the admin *site* (see config/admin.py), not on PersonAdmin, so
they live at the URLs the Phase 1 plan specifies:

    /admin/genealogy/explorer/?person=<uuid>[&depth=<n>]
    /admin/genealogy/relate/?a=<uuid>&b=<uuid>
    /admin/genealogy/quick-add/

Each is wrapped in ``AdminSite.admin_view()``, so an anonymous or non-staff visitor is
redirected to the admin login, and each additionally checks the model permission it
needs — reading the graph is not the same right as adding to it.
"""

from django.contrib import messages
from django.core.exceptions import PermissionDenied
from django.shortcuts import redirect, render
from django.urls import reverse
from django.utils.translation import gettext_lazy as _

from apps.genealogy.graph import describe_relationship, ego_network, traversal
from apps.genealogy.households import create_family_unit, parse_child_line
from apps.genealogy.models import Role

from .forms import ExplorerForm, QuickAddFamilyForm, RelateForm


def _require(request, *permissions):
    if not all(request.user.has_perm(perm) for perm in permissions):
        raise PermissionDenied


def explorer_view(request, admin_site):
    """Ego network plus ancestors and descendants, both expandable by depth."""
    _require(request, "genealogy.view_person")

    form = ExplorerForm(request.GET or None)
    context = {
        **admin_site.each_context(request),
        "title": _("Graph explorer"),
        "form": form,
    }

    if form.is_valid():
        person = form.cleaned_data["person"]
        depth = form.cleaned_data["depth"]
        context.update(
            person=person,
            ego=ego_network(person),
            ancestors=_group_by_depth(traversal.ancestors(person, max_depth=depth)),
            descendants=_group_by_depth(traversal.descendants(person, max_depth=depth)),
            explorer_url=reverse("admin:genealogy_explorer"),
        )
    return render(request, "admin/genealogy/explorer.html", context)


def relate_view(request, admin_site):
    """ "How are they related?" — common ancestors, both descent paths, both languages."""
    _require(request, "genealogy.view_person")

    form = RelateForm(request.GET or None)
    context = {
        **admin_site.each_context(request),
        "title": _("How are they related?"),
        "form": form,
    }

    if form.is_valid():
        person_a = form.cleaned_data["a"]
        person_b = form.cleaned_data["b"]
        context.update(
            result=describe_relationship(person_a, person_b),
            person_a=person_a,
            person_b=person_b,
            explorer_url=reverse("admin:genealogy_explorer"),
        )
    return render(request, "admin/genealogy/relate.html", context)


def quick_add_view(request, admin_site):
    """Create a union, its partners and all its children in one submit."""
    _require(request, "genealogy.add_person", "genealogy.add_union")

    if request.method == "POST":
        form = QuickAddFamilyForm(request.POST)
        if form.is_valid():
            union, created_people = create_family_unit(form.cleaned_data, request.user)
            messages.success(
                request,
                _("Created %(count)d new person(s) in union %(union)s.")
                % {"count": len(created_people), "union": union},
            )
            if "_addanother" in request.POST:
                quick_add = reverse("admin:genealogy_quick_add")
                return redirect(f"{quick_add}?house_name={form.cleaned_data['house_name']}")
            anchor = union.memberships.filter(role=Role.PARTNER).first()
            explorer = reverse("admin:genealogy_explorer")
            return redirect(f"{explorer}?person={anchor.person_id}&depth=4")
    else:
        form = QuickAddFamilyForm(initial={"house_name": request.GET.get("house_name", "")})

    context = {
        **admin_site.each_context(request),
        "title": _("Quick add: a family unit"),
        "form": form,
    }
    return render(request, "admin/genealogy/quick_add.html", context)


def _group_by_depth(relatives):
    grouped: dict[int, list] = {}
    for relative in relatives:
        grouped.setdefault(relative.depth, []).append(relative.person)
    return sorted(grouped.items())


# Re-exported so callers that already import these from the admin keep working; the one
# implementation lives in apps.genealogy.households and is shared with /api/v1/quick-add/.
__all__ = [
    "create_family_unit",
    "explorer_view",
    "parse_child_line",
    "quick_add_view",
    "relate_view",
]
