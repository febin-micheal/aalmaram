"""Creating a whole household in one operation.

This is the seed-entry path, and it has two callers: the Django admin quick-add screen and
the `/api/v1/quick-add/` endpoint the explorer posts to. The logic lives here so there is
one implementation of "what does adding a family unit mean" rather than two that drift.
"""

from django.db import transaction

from apps.genealogy.models import Gender, Person, RelationType, Role, Union, UnionMembership


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
