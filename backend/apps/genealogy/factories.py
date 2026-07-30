"""factory_boy factories for tests and seed data.

Everything produced here is fictional. This is a public repository: no real person,
family, house name or place from anyone's actual ancestry belongs in it. The name pools
below are ordinary given names and invented house names, combined at random.
"""

import factory

from apps.genealogy.models import (
    Gender,
    Person,
    RelationType,
    Role,
    Union,
    UnionMembership,
    UnionType,
)


class PersonFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = Person

    name_en = factory.Sequence(lambda n: f"Person {n}")
    name_ml = ""
    house_name = ""
    gender = Gender.UNKNOWN
    is_living = False

    class Params:
        # Convenience traits so tests read as intent, not as field soup.
        living = factory.Trait(is_living=True)
        male = factory.Trait(gender=Gender.MALE)
        female = factory.Trait(gender=Gender.FEMALE)


class UnionFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = Union

    union_type = UnionType.MARRIAGE


class UnionMembershipFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = UnionMembership

    union = factory.SubFactory(UnionFactory)
    person = factory.SubFactory(PersonFactory)
    role = Role.PARTNER
    relation_type = RelationType.BIOLOGICAL


def make_person(
    name_en, *, gender=Gender.UNKNOWN, birth=None, house=None, living=False, **kwargs
) -> Person:
    """Terse Person constructor for fixture building.

    `birth` is a single year that becomes a ±2 year range — real contributors almost
    never know an exact date, and fixtures should not pretend otherwise.
    """
    if birth is not None:
        kwargs.setdefault("birth_year_min", birth - 2)
        kwargs.setdefault("birth_year_max", birth + 2)
    if house is not None:
        kwargs.setdefault("house_name", house)
    return PersonFactory(name_en=name_en, gender=gender, is_living=living, **kwargs)


def make_union(*partners, children=(), year=None, union_type=UnionType.MARRIAGE, **kwargs) -> Union:
    """Create a union with its partners and children in one call.

    `children` accepts a Person, or a (Person, relation_type) pair, or a
    (Person, relation_type, sibling_order) triple.
    """
    if year is not None:
        kwargs.setdefault("year_min", year - 2)
        kwargs.setdefault("year_max", year + 2)
    union = UnionFactory(union_type=union_type, **kwargs)
    for partner in partners:
        if partner is not None:
            UnionMembershipFactory(union=union, person=partner, role=Role.PARTNER)
    for entry in children:
        person, relation_type, order = _unpack_child(entry)
        UnionMembershipFactory(
            union=union,
            person=person,
            role=Role.CHILD,
            relation_type=relation_type,
            sibling_order=order,
        )
    return union


def _unpack_child(entry):
    if isinstance(entry, tuple):
        if len(entry) == 3:
            return entry
        person, relation_type = entry
        return person, relation_type, None
    return entry, RelationType.BIOLOGICAL, None
