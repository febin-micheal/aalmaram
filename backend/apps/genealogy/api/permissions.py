from rest_framework.permissions import BasePermission


class IsStaff(BasePermission):
    """Phase 1.5 gate: the explorer is for the project owner only.

    Magic-link invites replace this in Phase 2, when members get anchors and the
    living/deceased visibility rules start doing the real filtering. Until then the API
    serves the whole graph, so it must not be reachable by anyone but staff.
    """

    message = "This API is limited to staff accounts during Phase 1.5."

    def has_permission(self, request, view):
        user = getattr(request, "user", None)
        return bool(user and user.is_authenticated and user.is_staff)
