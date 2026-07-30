"""Creating a whole household in one operation.

This is the seed-entry path, and it has two callers: the Django admin quick-add screen and
the `/api/v1/quick-add/` endpoint the explorer posts to. The logic lives here so there is
one implementation of "what does adding a family unit mean" rather than two that drift.
"""

from django.db import transaction

from apps.genealogy.models import Gender, Person, RelationType, Role, Union, UnionMembership
from apps.genealogy.year_parsing import parse_year_input


class AmbiguousUnion(Exception):
    """The person is a partner in more than one union, so "add a child" has no answer.

    Carries the candidates so the caller can ask which one rather than picking. This is
    the whole reason the exception exists: guessing here silently attaches a child to the
    wrong marriage, and nothing downstream would ever reveal it.
    """

    def __init__(self, union_ids):
        self.union_ids = list(union_ids)
        super().__init__("This person has more than one union; choose which one.")


class AlreadyHasParents(Exception):
    """A person can only hang from one union of birth in this UI."""


class OpenPartnerSlot(Exception):
    """The target already has a union with an empty partner seat.

    Adding a partner could mean two completely different things — "this is the other
    parent of those children" or "this is a second marriage" — and they are not
    recoverable from each other by looking at the result. The wrong choice silently
    records a mother as a stranger who happened to marry the father.

    Carries the candidate unions, with their children, so the caller can ask.
    """

    def __init__(self, unions):
        #: [{"union": id, "children": [names], "year": str}]
        self.unions = list(unions)
        super().__init__("This person has a union with an open partner seat; choose which.")


class NotJoinable(Exception):
    """The union already has both partners, or the person is already in it."""


def open_partner_unions(person: Person) -> list[dict]:
    """Unions where `person` is the only recorded partner — an open seat beside them.

    These are exactly the unions created by "+ parents" and by "+ child on someone with
    no union": a real parent with an unrecorded spouse. Completing one is the common case;
    a genuine remarriage is the other.
    """
    union_ids = list(
        UnionMembership.objects.filter(person=person, role=Role.PARTNER).values_list(
            "union_id", flat=True
        )
    )
    if not union_ids:
        return []

    partner_counts: dict = {}
    for union_id in UnionMembership.objects.filter(
        union_id__in=union_ids, role=Role.PARTNER
    ).values_list("union_id", flat=True):
        partner_counts[union_id] = partner_counts.get(union_id, 0) + 1

    open_ids = [uid for uid in union_ids if partner_counts.get(uid, 0) < 2]
    if not open_ids:
        return []

    children: dict = {}
    for union_id, name_en, name_ml in UnionMembership.objects.filter(
        union_id__in=open_ids, role=Role.CHILD
    ).values_list("union_id", "person__name_en", "person__name_ml"):
        children.setdefault(union_id, []).append(name_en or name_ml or "?")

    return [
        {
            "union": str(union.id),
            "children": children.get(union.id, []),
            "year": union.year_display,
        }
        for union in Union.objects.filter(id__in=open_ids).order_by("year_min", "created_at")
    ]


@transaction.atomic
def create_person_in_context(
    *,
    context: str,
    target=None,
    union=None,
    name_en: str = "",
    name_ml: str = "",
    gender: str = Gender.UNKNOWN,
    birth: str | None = None,
    house_name: str | None = None,
    relation_type: str = RelationType.BIOLOGICAL,
    force_new_union: bool = False,
    existing_person=None,
    user=None,
) -> dict:
    """Create one person and wire them into the graph in a named relationship.

    This is what the canvas calls when someone clicks "+ partner" / "+ child" / "+ parents".
    It exists as a service rather than in the view so the admin quick-add screen, the
    bulk form and the canvas all create people the same way.

    `context` is one of:

    * ``standalone``      — no relationships at all. The first person in an empty
      archive has nobody to be related to, and every other context needs an anchor;
      without this the canvas editor cannot start from nothing.
    * ``partner_of``      — a partner for `target`. Raises OpenPartnerSlot when `target`
      already has a union with an empty seat, because "the other parent of those
      children" and "a second marriage" are different facts and cannot be told apart
      afterwards. Pass ``force_new_union=True`` for the remarriage path.
    * ``partner_in_union`` — the second partner of a *specific* union: the answer to the
      question above, and what completes a pair of parents
    * ``child_of_union``  — a child of the given `union`
    * ``child_of_person`` — a child of `target`; creates a single-partner union when they
      have none (an unknown other parent is a normal record), attaches to the only one if
      there is exactly one, and raises AmbiguousUnion if there are several
    * ``parent_of``       — a parent for `target`, creating the union they hang from

    Returns the created objects so the caller can hand them straight back to the client.
    """
    # Refuse before creating anything: a person left behind by a rejected call is worse
    # than the rejection.
    if context == "partner_of" and target is not None and not force_new_union:
        candidates = open_partner_unions(target)
        if candidates:
            raise OpenPartnerSlot(candidates)

    house = (house_name or "").strip()
    fields = {
        "name_en": (name_en or "").strip(),
        "name_ml": (name_ml or "").strip(),
        "gender": gender or Gender.UNKNOWN,
        "house_name": house,
        "created_by": user,
    }
    # An unparseable year raises rather than silently storing nothing.
    fields |= parse_year_input(birth).as_fields("birth")

    if existing_person is not None:
        person = existing_person
        created_person = False
    else:
        person = Person.objects.create(**fields)
        created_person = True

    created_unions: list[Union] = []
    memberships: list[UnionMembership] = []

    def join(union_obj, who, role, **extra):
        membership = UnionMembership.objects.create(
            union=union_obj, person=who, role=role, created_by=user, **extra
        )
        memberships.append(membership)
        return membership

    if context == "standalone":
        # Nothing to wire. The affordances on the resulting card are how the graph grows
        # from here.
        union = None

    elif context == "partner_of":
        _require(target, "partner_of needs a person to partner with")
        union = Union.objects.create(created_by=user)
        created_unions.append(union)
        join(union, target, Role.PARTNER)
        join(union, person, Role.PARTNER)

    elif context == "partner_in_union":
        _require(union, "partner_in_union needs a union")
        seats = UnionMembership.objects.filter(union=union, role=Role.PARTNER)
        if seats.count() >= 2:
            raise NotJoinable("That union already has both partners recorded.")
        if seats.filter(person=person).exists():
            raise NotJoinable("That person is already a partner in this union.")
        join(union, person, Role.PARTNER)

    elif context == "child_of_union":
        _require(union, "child_of_union needs a union")
        join(
            union,
            person,
            Role.CHILD,
            relation_type=relation_type,
            sibling_order=_next_sibling_order(union),
        )

    elif context == "child_of_person":
        _require(target, "child_of_person needs a parent")
        union, union_was_created = _union_for_new_child(target, user)
        if union_was_created:
            created_unions.append(union)
        join(
            union,
            person,
            Role.CHILD,
            relation_type=relation_type,
            sibling_order=_next_sibling_order(union),
        )

    elif context == "parent_of":
        _require(target, "parent_of needs a child")
        existing = UnionMembership.objects.filter(person=target, role=Role.CHILD).first()
        if existing:
            raise AlreadyHasParents("This person already hangs from a union of birth.")
        union = Union.objects.create(created_by=user)
        created_unions.append(union)
        join(union, person, Role.PARTNER)
        join(union, target, Role.CHILD)

    else:
        raise ValueError(f"unknown context {context!r}")

    return {
        "person": person,
        "union": union,
        "created_unions": created_unions,
        "memberships": memberships,
        # Undo has to know whether to delete the person or only detach them: joining an
        # existing relative to a union must never delete that relative.
        "created_person": created_person,
    }


def _union_for_new_child(parent: Person, user) -> tuple[Union, bool]:
    """Which union does a new child of `parent` belong to? Returns (union, was_created).

    Zero unions is not an error — "we know the mother, nobody remembers the father" is a
    normal record, and it becomes a union with a single partner. More than one union is
    genuinely ambiguous and is refused rather than guessed.
    """
    union_ids = list(
        UnionMembership.objects.filter(person=parent, role=Role.PARTNER).values_list(
            "union_id", flat=True
        )
    )
    if len(union_ids) == 1:
        return Union.objects.get(pk=union_ids[0]), False
    if len(union_ids) > 1:
        raise AmbiguousUnion(union_ids)

    union = Union.objects.create(created_by=user)
    UnionMembership.objects.create(union=union, person=parent, role=Role.PARTNER, created_by=user)
    return union, True


def _next_sibling_order(union: Union) -> int | None:
    """Where does a newly typed child sit in the birth order?

    Rapid entry into a fresh union numbers children 1, 2, 3… as they are typed, which is
    exactly the order someone recites siblings in — birth order recorded for free.

    But if the union already holds children whose order nobody recorded, numbering only
    the new ones would invent an ordering over an unordered set, and the chart would then
    draw the undated existing children *after* the new ones as though that were known.
    In that case the order is left unrecorded and the layout falls back to birth year.
    """
    existing = list(
        UnionMembership.objects.filter(union=union, role=Role.CHILD).values_list(
            "sibling_order", flat=True
        )
    )
    if not existing:
        return 1
    if any(order is None for order in existing):
        return None
    return max(existing) + 1


def _require(value, message):
    if value is None:
        raise ValueError(message)


class NotProvisional(Exception):
    """The person has grown edges since they were created, so undo is no longer safe."""


@transaction.atomic
def delete_provisional_person(person: Person) -> dict:
    """Undo the creation of a just-added node.

    This is the inverse of `create_person_in_context`, and it is deliberately narrow. Undo
    is for taking back the node you typed a second ago — not a delete feature. The moment a
    person has acquired anything of their own (a child, a second union, a claim, a photo,
    a member anchored to them), removing them would destroy work that undo never created,
    so it refuses and says why.
    """
    from django.contrib.auth import get_user_model
    from django.contrib.contenttypes.models import ContentType

    from apps.claims.models import Claim
    from apps.mediastore.models import MediaItem

    reasons = []

    memberships = list(UnionMembership.objects.filter(person=person).select_related("union"))
    if len(memberships) > 1:
        reasons.append(f"is in {len(memberships)} unions")

    # Anything that attached *after* this person did is somebody else's work; anything
    # that was already there is not evidence against undoing them.
    #
    # The distinction matters for the second-parent flow: joining a mother to a union that
    # already holds a child must stay undoable, because that child predates her and was
    # not created by the step being undone. Counting children outright would refuse it.
    partner_unions = [m.union_id for m in memberships if m.role == Role.PARTNER]
    if partner_unions and memberships:
        joined_at = min(m.created_at for m in memberships)
        newer = (
            UnionMembership.objects.filter(union_id__in=partner_unions, created_at__gt=joined_at)
            .exclude(person=person)
            .count()
        )
        if newer:
            reasons.append(f"has {newer} relative(s) recorded since")

    if Claim.objects.filter(
        subject_type=ContentType.objects.get_for_model(Person), subject_id=person.pk
    ).exists():
        reasons.append("has claims recorded about them")
    if MediaItem.objects.filter(persons=person).exists():
        reasons.append("is tagged in media")
    if get_user_model().objects.filter(anchor_person=person).exists():
        reasons.append("is a member's anchor person")
    if person.merged_from.exists():
        reasons.append("has other records merged into them")

    if reasons:
        raise NotProvisional(f"Cannot undo: {person.display_name} " + ", and ".join(reasons) + ".")

    removed_unions = []
    for membership in memberships:
        union = membership.union
        membership.delete()

        # A union that only existed to hold this person should go with them rather than
        # leaving a node on the canvas that represents nothing. "Represents nothing" means
        # no children and fewer than two partners — a marriage with two partners and no
        # recorded children is a real record and stays.
        remaining = UnionMembership.objects.filter(union=union)
        if (
            not remaining.filter(role=Role.CHILD).exists()
            and remaining.filter(role=Role.PARTNER).count() < 2
        ):
            removed_unions.append(str(union.pk))
            union.delete()

    person_id = str(person.pk)
    person.delete()
    return {"person": person_id, "unions": removed_unions}


def parse_child_line(line: str) -> dict | None:
    """Parse "Thomas | m | 1942 | adopted" into person kwargs.

    Every part after the name is optional, and unrecognised parts are ignored rather
    than rejected — a contributor typing quickly should never be stopped by syntax.
    """
    parts = [part.strip() for part in line.split("|")]
    name = parts[0]
    if not name:
        return None

    details = {"name_en": name, "gender": Gender.UNKNOWN, "relation_type": RelationType.BIOLOGICAL}
    for part in parts[1:]:
        lowered = part.lower()
        if lowered in {"m", "male"}:
            details["gender"] = Gender.MALE
        elif lowered in {"f", "female"}:
            details["gender"] = Gender.FEMALE
        elif lowered in {"adopted", "step", "unknown"}:
            details["relation_type"] = lowered
        elif part.isdigit() and len(part) == 4:
            details["birth_year"] = int(part)
    return details


@transaction.atomic
def create_family_unit(data, user) -> tuple[Union, list[Person]]:
    """Create one union, its partners and all its children.

    `data` uses the admin form's field names so both callers speak the same language:
    existing_partner_1/2 (Person or None), new_partner_1/2 (name), new_partner_*_gender,
    house_name, union_type, union_year, union_place, children (one per line).

    A union with a single partner is valid and normal — it is how "we know the mother,
    nobody remembers the father" is recorded.
    """
    created: list[Person] = []
    house_name = data.get("house_name") or ""

    def resolve_partner(existing_key, name_key, gender_key):
        person = data.get(existing_key)
        if person:
            return person
        name = (data.get(name_key) or "").strip()
        if not name:
            return None
        person = Person.objects.create(
            name_en=name,
            gender=data.get(gender_key) or Gender.UNKNOWN,
            house_name=house_name,
            created_by=user,
        )
        created.append(person)
        return person

    partner_1 = resolve_partner("existing_partner_1", "new_partner_1", "new_partner_1_gender")
    partner_2 = resolve_partner("existing_partner_2", "new_partner_2", "new_partner_2_gender")

    year = data.get("union_year")
    union = Union.objects.create(
        union_type=data.get("union_type") or "marriage",
        year_min=year,
        year_max=year,
        place=data.get("union_place") or "",
        created_by=user,
    )
    for partner in (partner_1, partner_2):
        if partner is not None:
            UnionMembership.objects.create(
                union=union, person=partner, role=Role.PARTNER, created_by=user
            )

    order = 0
    for line in (data.get("children") or "").splitlines():
        details = parse_child_line(line)
        if details is None:
            continue
        order += 1
        birth_year = details.pop("birth_year", None)
        relation_type = details.pop("relation_type")
        child = Person.objects.create(
            house_name=house_name,
            created_by=user,
            birth_year_min=birth_year,
            birth_year_max=birth_year,
            **details,
        )
        created.append(child)
        UnionMembership.objects.create(
            union=union,
            person=child,
            role=Role.CHILD,
            relation_type=relation_type,
            sibling_order=order,
            created_by=user,
        )
    return union, created


@transaction.atomic
def leave_union(person: Person, union: Union) -> dict:
    """Undo a "joined an existing union" — detach, do not delete.

    The inverse of `partner_in_union` when the person was already in the graph. Refuses
    once anything has attached to the union since they joined: undo takes back the step
    you just took, and a child recorded afterwards is somebody else's work.
    """
    membership = UnionMembership.objects.filter(
        union=union, person=person, role=Role.PARTNER
    ).first()
    if membership is None:
        raise NotProvisional("That person is not a partner in this union.")

    newer = UnionMembership.objects.filter(
        union=union, created_at__gt=membership.created_at
    ).count()
    if newer:
        raise NotProvisional(
            f"Cannot undo: {newer} more member(s) were added to this union afterwards."
        )

    membership.delete()
    removed_unions = []
    remaining = UnionMembership.objects.filter(union=union)
    if (
        not remaining.filter(role=Role.CHILD).exists()
        and remaining.filter(role=Role.PARTNER).count() < 1
    ):
        removed_unions.append(str(union.pk))
        union.delete()
    return {"person": str(person.pk), "unions": removed_unions, "detached_only": True}
