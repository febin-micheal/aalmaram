"""Read-only endpoints backing the Phase 1.5 explorer.

Three of them, all GET, all staff-only:

    /api/v1/persons/?search=            find someone to start from
    /api/v1/persons/{id}/neighborhood/  the subgraph to draw
    /api/v1/relate/?a=&b=               how two people are related

The graph work itself is not done here — it is delegated to apps.genealogy.graph, which
is the tested library. These views exist to bound the request, serialize, and refuse
anyone who is not staff.
"""

import uuid

from django.contrib.postgres.search import TrigramSimilarity
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db.models import Count, Q
from django.db.models.functions import Greatest
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import ensure_csrf_cookie
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.genealogy.graph import build_neighborhood, build_overview, describe_relationship
from apps.genealogy.households import (
    AlreadyHasParents,
    AmbiguousUnion,
    NotProvisional,
    create_family_unit,
    create_person_in_context,
    delete_provisional_person,
)
from apps.genealogy.models import Person, Role, Union
from apps.genealogy.year_parsing import YearParseError

from .permissions import IsStaff
from .serializers import (
    CommonAncestorSerializer,
    CreatePersonSerializer,
    MembershipEdgeSerializer,
    OverviewPersonSerializer,
    OverviewUnionSerializer,
    PersonNodeSerializer,
    PersonSerializer,
    QuickAddSerializer,
    UnionNodeSerializer,
    UpdatePersonSerializer,
)


def _created_payload(result) -> dict:
    """What the canvas needs to draw a newly created node without refetching.

    Deliberately the same node/edge vocabulary as /neighborhood/ and /overview/, so the
    client has exactly one merge path for new data however it arrived.
    """
    person = result["person"]
    person.generation = 0
    person.hidden_up = 0
    person.hidden_down = 0
    for union in result["created_unions"]:
        union.generation = 0
    return {
        "person": PersonNodeSerializer(person).data,
        "union": str(result["union"].id) if result["union"] else None,
        "created_unions": UnionNodeSerializer(result["created_unions"], many=True).data,
        "memberships": MembershipEdgeSerializer(result["memberships"], many=True).data,
    }


#: Ceiling on how much of the graph one request may pull. The explorer expands
#: incrementally, so a request never needs more than a few generations either way.
MAX_GENERATIONS = 4
#: Below this trigram score a match is noise rather than a spelling variant.
SIMILARITY_FLOOR = 0.15


class PersonViewSet(viewsets.ModelViewSet):
    permission_classes = [IsStaff]
    serializer_class = PersonSerializer
    queryset = Person.objects.canonical()

    def get_queryset(self):
        queryset = Person.objects.canonical()
        term = self.request.query_params.get("search", "").strip()
        if not term:
            return queryset.order_by("name_en", "name_ml")

        # Trigram similarity handles the spelling drift this data is full of
        # (Ouseph / Yousef, Thoma / Thomas); icontains catches the short prefixes a
        # trigram score would rate too low to return at all.
        return (
            queryset.annotate(
                similarity=Greatest(
                    TrigramSimilarity("name_en", term),
                    TrigramSimilarity("name_ml", term),
                    TrigramSimilarity("house_name", term),
                )
            )
            .filter(
                Q(similarity__gt=SIMILARITY_FLOOR)
                | Q(name_en__icontains=term)
                | Q(name_ml__icontains=term)
                | Q(house_name__icontains=term)
                | Q(nicknames__icontains=term)
            )
            .order_by("-similarity", "name_en", "name_ml")
        )

    # --- editing ---------------------------------------------------------
    # The canvas is the primary editor, so these three exist to serve direct manipulation:
    # create a person already wired into a relationship, edit a field inline, and undo a
    # creation. Anything broader belongs in the admin.

    def create(self, request):
        """Create a person in a named relationship — what a "+ partner/child/parents" click does."""
        serializer = CreatePersonSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        target = Person.objects.filter(pk=data["target"]).first() if data.get("target") else None
        union = Union.objects.filter(pk=data["union"]).first() if data.get("union") else None

        try:
            result = create_person_in_context(
                context=data["context"],
                target=target,
                union=union,
                name_en=data.get("name_en", ""),
                name_ml=data.get("name_ml", ""),
                gender=data.get("gender", "unknown"),
                birth=data.get("birth"),
                house_name=data.get("house_name", ""),
                relation_type=data.get("relation_type", "biological"),
                user=request.user,
            )
        except AmbiguousUnion as error:
            # Not an error the user made — a question only they can answer. 409 with the
            # candidates so the canvas can highlight those union dots and ask.
            return Response(
                {
                    "detail": str(error),
                    "code": "ambiguous_union",
                    "unions": [str(uid) for uid in error.union_ids],
                },
                status=status.HTTP_409_CONFLICT,
            )
        except AlreadyHasParents as error:
            return Response(
                {"detail": str(error), "code": "already_has_parents"},
                status=status.HTTP_409_CONFLICT,
            )
        except (YearParseError, ValueError) as error:
            return Response({"detail": str(error)}, status=status.HTTP_400_BAD_REQUEST)

        return Response(_created_payload(result), status=status.HTTP_201_CREATED)

    def partial_update(self, request, pk=None):
        """Inline field edit from a card or the side panel."""
        person = self.get_object()
        serializer = UpdatePersonSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)

        fields = serializer.to_model_fields()
        for key, value in fields.items():
            setattr(person, key, value)
        try:
            person.full_clean(exclude=[f.name for f in Person._meta.fields if f.name not in fields])
        except DjangoValidationError as error:
            return Response({"detail": error.message_dict}, status=status.HTTP_400_BAD_REQUEST)
        person.save(update_fields=[*fields.keys(), "updated_at"])

        return Response(PersonSerializer(person).data)

    def destroy(self, request, pk=None):
        """Undo a just-created node. Refuses once it has acquired edges of its own."""
        person = self.get_object()
        try:
            removed = delete_provisional_person(person)
        except NotProvisional as error:
            return Response(
                {"detail": str(error), "code": "not_provisional"},
                status=status.HTTP_409_CONFLICT,
            )
        return Response(removed, status=status.HTTP_200_OK)

    @action(detail=False, methods=["get"])
    def suggested(self, request):
        """A handful of well-connected people, so the landing screen is never blank."""
        people = (
            Person.objects.canonical()
            .annotate(connections=Count("union_memberships"))
            .order_by("-connections", "birth_year_min")[:8]
        )
        return Response({"results": PersonSerializer(people, many=True).data})

    @action(detail=True, methods=["get"])
    def neighborhood(self, request, pk=None):
        """Persons + unions + memberships around one person, bounded by generations."""
        person = self.get_object()
        up = _bounded_int(request.query_params.get("generations_up"), default=2)
        down = _bounded_int(request.query_params.get("generations_down"), default=2)

        result = build_neighborhood(person, generations_up=up, generations_down=down)

        for node in result.persons:
            node.generation = result.generations.get(node.id, 0)
            node.hidden_up = result.hidden_up.get(node.id, 0)
            node.hidden_down = result.hidden_down.get(node.id, 0)
        for union in result.unions:
            union.generation = result.union_generations.get(union.id, 0)

        return Response(
            {
                "center": str(result.center_id),
                "generations_up": up,
                "generations_down": down,
                "persons": PersonNodeSerializer(result.persons, many=True).data,
                "unions": UnionNodeSerializer(result.unions, many=True).data,
                "memberships": MembershipEdgeSerializer(result.memberships, many=True).data,
            }
        )


class OverviewView(APIView):
    """The whole graph in one request, banded for a zoomed-out drawing.

    One request by design: the explorer lands on this, and a per-person or per-family
    fetch would turn opening the app into hundreds of round trips. The heavy lifting is
    in graph/overview.py, which is three queries and then pure Python — a query-count
    test pins that.
    """

    permission_classes = [IsStaff]

    def get(self, request):
        overview = build_overview()

        for person in overview.persons:
            person.band = overview.bands.get(person.id, 0)
        for union in overview.unions:
            union.band = overview.union_bands.get(union.id, 0)

        return Response(
            {
                "persons": OverviewPersonSerializer(overview.persons, many=True).data,
                "unions": OverviewUnionSerializer(overview.unions, many=True).data,
                "memberships": overview.memberships,
                "stats": {
                    "persons": len(overview.persons),
                    "unions": len(overview.unions),
                    "components": overview.component_count,
                },
            }
        )


class QuickAddView(APIView):
    """Create a household from the explorer, without leaving the graph.

    Returns the created subgraph in the same shape as the neighborhood endpoint, so the
    client merges it straight into the canvas instead of reloading everything.
    """

    permission_classes = [IsStaff]

    def post(self, request):
        serializer = QuickAddSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        union, created = create_family_unit(serializer.to_form_data(), request.user)

        anchor = union.memberships.filter(role=Role.PARTNER).first()
        anchor_id = anchor.person_id if anchor else (created[0].id if created else None)

        payload = {
            "created_person_ids": [str(person.id) for person in created],
            "union": str(union.id),
            "center": str(anchor_id) if anchor_id else None,
        }
        if anchor_id:
            # Shaped exactly like /neighborhood/ so the frontend has one merge path.
            result = build_neighborhood(anchor_id, generations_up=1, generations_down=1)
            for node in result.persons:
                node.generation = result.generations.get(node.id, 0)
                node.hidden_up = result.hidden_up.get(node.id, 0)
                node.hidden_down = result.hidden_down.get(node.id, 0)
            for node in result.unions:
                node.generation = result.union_generations.get(node.id, 0)
            payload |= {
                "persons": PersonNodeSerializer(result.persons, many=True).data,
                "unions": UnionNodeSerializer(result.unions, many=True).data,
                "memberships": MembershipEdgeSerializer(result.memberships, many=True).data,
            }
        else:  # pragma: no cover - the serializer requires at least one partner
            payload |= {"persons": [], "unions": [], "memberships": []}

        return Response(payload, status=status.HTTP_201_CREATED)


@method_decorator(ensure_csrf_cookie, name="get")
class CsrfView(APIView):
    """Hand out a CSRF cookie.

    DRF's SessionAuthentication enforces CSRF on unsafe methods, and a client that only
    ever did GETs may not have the cookie yet. The explorer calls this once before its
    first POST rather than scraping a token out of an admin page.
    """

    permission_classes = [IsStaff]

    def get(self, request):
        return Response({"detail": "CSRF cookie set"})


class RelateView(APIView):
    """How two people are related: labels in both languages, and both descent paths."""

    permission_classes = [IsStaff]

    def get(self, request):
        person_a = _person_or_none(request.query_params.get("a"))
        person_b = _person_or_none(request.query_params.get("b"))
        if person_a is None or person_b is None:
            return Response(
                {"detail": "Pass two person ids as ?a=<uuid>&b=<uuid>."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        result = describe_relationship(person_a, person_b)
        return Response(
            {
                "a": PersonSerializer(result.subject).data,
                "b": PersonSerializer(result.other).data,
                "is_related": result.is_related,
                "kind": result.descriptor.kind,
                "labels": result.labels(),
                "common_ancestors": CommonAncestorSerializer(
                    result.common_ancestors, many=True
                ).data,
            }
        )


def _bounded_int(raw, default: int) -> int:
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    return max(0, min(value, MAX_GENERATIONS))


def _person_or_none(raw):
    """Resolve a query-string id to a canonical Person, or None if it is not one."""
    if not raw:
        return None
    try:
        uuid.UUID(str(raw))
    except (ValueError, AttributeError, TypeError):
        return None
    return Person.objects.canonical().filter(pk=raw).first()
