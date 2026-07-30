"""Read-only serializers for the explorer.

Every serializer here lists its fields explicitly. None of them is a ModelSerializer with
`fields = "__all__"`, and that is deliberate: `notes`, `created_by`, `source_invite` and
the claim trail are contributor-private, and a wildcard serializer would start leaking
them the moment somebody adds a column. Adding a field to the API has to be a decision
someone makes on purpose.
"""

from rest_framework import serializers

from apps.genealogy.models import Gender, Person, RelationType, Union, UnionType
from apps.genealogy.year_parsing import YearParseError, parse_year_input


class PersonSerializer(serializers.Serializer):
    """A person as a chart node. No notes, no provenance, no claims."""

    id = serializers.UUIDField(read_only=True)
    name_en = serializers.CharField(read_only=True)
    name_ml = serializers.CharField(read_only=True)
    display_name = serializers.CharField(read_only=True)
    house_name = serializers.CharField(read_only=True)
    gender = serializers.CharField(read_only=True)
    is_living = serializers.BooleanField(read_only=True)
    birth_display = serializers.CharField(read_only=True)
    death_display = serializers.CharField(read_only=True)
    lifespan_compact = serializers.CharField(read_only=True)
    place_origin = serializers.CharField(read_only=True)


class PersonNodeSerializer(PersonSerializer):
    """A person inside a neighbourhood: same fields plus where to draw them."""

    generation = serializers.IntegerField(read_only=True)
    hidden_up = serializers.IntegerField(read_only=True)
    hidden_down = serializers.IntegerField(read_only=True)


class UnionNodeSerializer(serializers.Serializer):
    id = serializers.UUIDField(read_only=True)
    union_type = serializers.CharField(read_only=True)
    status = serializers.CharField(read_only=True)
    year_display = serializers.CharField(read_only=True)
    place = serializers.CharField(read_only=True)
    generation = serializers.IntegerField(read_only=True)


class MembershipEdgeSerializer(serializers.Serializer):
    union = serializers.UUIDField(read_only=True, source="union_id")
    person = serializers.UUIDField(read_only=True, source="person_id")
    role = serializers.CharField(read_only=True)
    relation_type = serializers.CharField(read_only=True)
    sibling_order = serializers.IntegerField(read_only=True, allow_null=True)


class OverviewPersonSerializer(serializers.Serializer):
    """A person in the whole-database overview.

    Deliberately carries what a *card* needs, not just what a dot needs: semantic zoom
    swaps dots for the real person cards without a second round trip, so the fields have
    to be here already. What is not here: place, notes, provenance, relation types.
    """

    id = serializers.UUIDField(read_only=True)
    name_en = serializers.CharField(read_only=True)
    name_ml = serializers.CharField(read_only=True)
    display_name = serializers.CharField(read_only=True)
    house_name = serializers.CharField(read_only=True)
    gender = serializers.CharField(read_only=True)
    is_living = serializers.BooleanField(read_only=True)
    lifespan_compact = serializers.CharField(read_only=True)
    band = serializers.IntegerField(read_only=True)


class OverviewUnionSerializer(serializers.Serializer):
    id = serializers.UUIDField(read_only=True)
    band = serializers.IntegerField(read_only=True)


class CreatePersonSerializer(serializers.Serializer):
    """Create one person wired into the graph, as the canvas affordances do.

    `context` names the relationship rather than leaving the client to assemble unions and
    memberships itself — the server owns "what does + child mean", so the canvas, the admin
    and any future caller cannot drift apart on it.
    """

    CONTEXTS = ("partner_of", "child_of_union", "child_of_person", "parent_of")

    context = serializers.ChoiceField(choices=CONTEXTS)
    #: The person the affordance was clicked on (all contexts except child_of_union).
    target = serializers.UUIDField(required=False, allow_null=True)
    #: The chosen union (child_of_union only — used when a person has several).
    union = serializers.UUIDField(required=False, allow_null=True)

    name_en = serializers.CharField(required=False, allow_blank=True, max_length=200)
    name_ml = serializers.CharField(required=False, allow_blank=True, max_length=200)
    gender = serializers.ChoiceField(choices=Gender.choices, required=False, default=Gender.UNKNOWN)
    #: Free text: "1938", "1930s", "c. 1940", "?" — parsed server-side.
    birth = serializers.CharField(required=False, allow_blank=True, allow_null=True)
    house_name = serializers.CharField(required=False, allow_blank=True, max_length=200)
    relation_type = serializers.ChoiceField(
        choices=RelationType.choices, required=False, default=RelationType.BIOLOGICAL
    )

    def validate(self, attrs):
        context = attrs["context"]
        if context == "child_of_union":
            if not attrs.get("union"):
                raise serializers.ValidationError({"union": "child_of_union needs a union id."})
            if not Union.objects.filter(pk=attrs["union"]).exists():
                raise serializers.ValidationError({"union": "No such union."})
        else:
            if not attrs.get("target"):
                raise serializers.ValidationError({"target": f"{context} needs a target person."})
            if not Person.objects.canonical().filter(pk=attrs["target"]).exists():
                raise serializers.ValidationError({"target": "No such canonical person."})

        if attrs.get("birth"):
            # Reject an unreadable year here rather than storing a blank and pretending.
            try:
                parse_year_input(attrs["birth"])
            except YearParseError as error:
                raise serializers.ValidationError({"birth": str(error)}) from error
        return attrs


class UpdatePersonSerializer(serializers.Serializer):
    """Inline edits from the card or the side panel. Every field optional."""

    name_en = serializers.CharField(required=False, allow_blank=True, max_length=200)
    name_ml = serializers.CharField(required=False, allow_blank=True, max_length=200)
    gender = serializers.ChoiceField(choices=Gender.choices, required=False)
    house_name = serializers.CharField(required=False, allow_blank=True, max_length=200)
    is_living = serializers.BooleanField(required=False)
    birth = serializers.CharField(required=False, allow_blank=True, allow_null=True)
    death = serializers.CharField(required=False, allow_blank=True, allow_null=True)

    def validate(self, attrs):
        if not attrs:
            raise serializers.ValidationError("No fields to update.")
        for field in ("birth", "death"):
            if field in attrs and attrs[field]:
                try:
                    parse_year_input(attrs[field])
                except YearParseError as error:
                    raise serializers.ValidationError({field: str(error)}) from error
        return attrs

    def to_model_fields(self) -> dict:
        """Translate into model kwargs, expanding the year strings into their trios."""
        data = dict(self.validated_data)
        fields = {}
        for key in ("name_en", "name_ml", "gender", "house_name", "is_living"):
            if key in data:
                fields[key] = data[key]
        for key, prefix in (("birth", "birth"), ("death", "death")):
            if key in data:
                fields |= parse_year_input(data[key]).as_fields(prefix)
        return fields


class QuickAddSerializer(serializers.Serializer):
    """Validates one household from the explorer's add form.

    Mirrors the admin quick-add form's fields, including the same children text block, so
    the two entry points stay interchangeable and `create_family_unit` sees one shape.
    """

    partner_1_id = serializers.UUIDField(required=False, allow_null=True)
    partner_1_name = serializers.CharField(required=False, allow_blank=True, max_length=200)
    partner_1_gender = serializers.ChoiceField(
        choices=Gender.choices, required=False, default=Gender.UNKNOWN
    )
    partner_2_id = serializers.UUIDField(required=False, allow_null=True)
    partner_2_name = serializers.CharField(required=False, allow_blank=True, max_length=200)
    partner_2_gender = serializers.ChoiceField(
        choices=Gender.choices, required=False, default=Gender.UNKNOWN
    )

    house_name = serializers.CharField(required=False, allow_blank=True, max_length=200)
    union_type = serializers.ChoiceField(
        choices=UnionType.choices, required=False, default=UnionType.MARRIAGE
    )
    union_year = serializers.IntegerField(required=False, allow_null=True)
    union_place = serializers.CharField(required=False, allow_blank=True, max_length=200)
    children = serializers.CharField(required=False, allow_blank=True)

    def validate(self, attrs):
        for index in (1, 2):
            person_id = attrs.get(f"partner_{index}_id")
            if person_id and not Person.objects.canonical().filter(pk=person_id).exists():
                raise serializers.ValidationError(
                    {f"partner_{index}_id": "No canonical person with that id."}
                )
            if person_id and attrs.get(f"partner_{index}_name"):
                raise serializers.ValidationError(
                    {f"partner_{index}_name": "Give an existing id or a new name, not both."}
                )

        has_partner = any(
            attrs.get(f"partner_{index}_id") or (attrs.get(f"partner_{index}_name") or "").strip()
            for index in (1, 2)
        )
        if not has_partner:
            # A union with one partner is fine — "father unknown" is a real record. A
            # union with none is not: there would be nothing to hang the children off.
            raise serializers.ValidationError(
                "Name at least one partner — a union with a single known partner is fine."
            )
        return attrs

    def to_form_data(self) -> dict:
        """Translate into the keys `create_family_unit` expects."""
        data = self.validated_data
        resolved = {}
        for index in (1, 2):
            person_id = data.get(f"partner_{index}_id")
            resolved[f"existing_partner_{index}"] = (
                Person.objects.filter(pk=person_id).first() if person_id else None
            )
            resolved[f"new_partner_{index}"] = data.get(f"partner_{index}_name") or ""
            resolved[f"new_partner_{index}_gender"] = data.get(f"partner_{index}_gender")
        return resolved | {
            "house_name": data.get("house_name") or "",
            "union_type": data.get("union_type"),
            "union_year": data.get("union_year"),
            "union_place": data.get("union_place") or "",
            "children": data.get("children") or "",
        }


class CommonAncestorSerializer(serializers.Serializer):
    person = PersonSerializer(read_only=True)
    depth_subject = serializers.IntegerField(read_only=True)
    depth_other = serializers.IntegerField(read_only=True)
    #: Both descent paths, ancestor-first, as the UI draws them.
    path_subject = serializers.SerializerMethodField()
    path_other = serializers.SerializerMethodField()

    def get_path_subject(self, obj):
        return PersonSerializer(obj.descent_to_subject(), many=True).data

    def get_path_other(self, obj):
        return PersonSerializer(obj.descent_to_other(), many=True).data
