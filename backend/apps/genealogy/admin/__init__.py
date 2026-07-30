"""Admin registrations for the family graph.

The admin is Febin's desktop tool: seed data entry, a graph explorer, the merge queue and
the contested-claim queue. Function over beauty — it is server-rendered and has no build
step.

The model admins live here. The three pages that belong to no single model — explorer,
relate, quick-add — are views in `views.py`, registered on the admin site itself in
`config/admin.py` so they get their own top-level URLs under /admin/genealogy/.
"""

from .person import PersonAdmin
from .union import UnionAdmin, UnionMembershipAdmin
from .views import explorer_view, parse_child_line, quick_add_view, relate_view

__all__ = [
    "PersonAdmin",
    "UnionAdmin",
    "UnionMembershipAdmin",
    "explorer_view",
    "parse_child_line",
    "quick_add_view",
    "relate_view",
]
