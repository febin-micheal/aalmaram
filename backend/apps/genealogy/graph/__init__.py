"""Graph traversal over the family.

Everything here treats Person + Union + UnionMembership as a graph and never assumes a
tree: a person can have two sets of parents recorded, two spouses, children in several
unions, and the same ancestor reachable by more than one route.

Public API:

    parents(p) / children(p) / partners(p) / siblings(p)   — one hop
    ancestors(p) / descendants(p)                          — bounded recursive walks
    ego_network(p)                                         — the person page's core
    lowest_common_ancestors(a, b)                          — with both descent paths
    describe_relationship(a, b)                            — "how are we related?"
    relatives_within(p, degrees)                           — privacy radius
"""

from .lca import CommonAncestor, RelationshipResult, describe_relationship, lowest_common_ancestors
from .naming import label_for
from .neighborhood import Neighborhood
from .neighborhood import neighborhood as build_neighborhood
from .overview import Overview, build_overview
from .privacy import relatives_within, visible_person_filter
from .traversal import (
    ChildLink,
    EgoNetwork,
    ParentLink,
    PartnerLink,
    Relative,
    SiblingLink,
    ancestor_depths,
    ancestors,
    children,
    descendant_depths,
    descendants,
    ego_network,
    parents,
    partners,
    siblings,
)

__all__ = [
    "ChildLink",
    "CommonAncestor",
    "EgoNetwork",
    "Neighborhood",
    "Overview",
    "ParentLink",
    "PartnerLink",
    "Relative",
    "RelationshipResult",
    "SiblingLink",
    "ancestor_depths",
    "ancestors",
    "children",
    "descendant_depths",
    "descendants",
    "describe_relationship",
    "ego_network",
    "label_for",
    "build_neighborhood",
    "build_overview",
    "lowest_common_ancestors",
    "parents",
    "partners",
    "relatives_within",
    "siblings",
    "visible_person_filter",
]
