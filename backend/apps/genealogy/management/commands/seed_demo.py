"""Generate a demo family large enough to exercise the admin.

    python manage.py seed_demo --generations 5 --seed 20260101

Everything produced is fictional: given names are drawn from a small public pool and
house names are invented, then combined by a seeded RNG. This is a public repository, so
no seed data may resemble a real family — and because the RNG is seeded, two runs of the
same command produce the same people, which makes the output safe to compare in tests.

The dataset is deliberately imperfect. Roughly one household in eight loses a parent to
an early death and the widow or widower remarries, some children have no recorded father,
a few are adopted, and a handful of people are entered twice so the merge queue has
something in it. A clean synthetic tree would prove nothing about the traversal code.
"""

import random

from django.core.management.base import BaseCommand
from django.db import transaction

from apps.genealogy.models import (
    Gender,
    Person,
    RelationType,
    Role,
    Union,
    UnionMembership,
    UnionStatus,
    UnionType,
)
from apps.merging.models import MergeCandidate

MALE_NAMES = [
    "Ittira",
    "Chacko",
    "Devassy",
    "Varkey",
    "Ouseph",
    "Thomas",
    "Joseph",
    "Kuruvilla",
    "Mathai",
    "Lonappan",
    "Chandy",
    "Poulose",
    "Antony",
    "Jacob",
    "Philipose",
    "Kesavan",
    "Raghavan",
    "Balan",
    "Sudhakaran",
    "Mohanan",
    "Sunil",
    "Biju",
    "Jose",
    "Bibin",
    "Arun",
    "Nithin",
    "Vishnu",
    "Adithyan",
    "Kiran",
    "Rahul",
]
FEMALE_NAMES = [
    "Mariam",
    "Annamma",
    "Eliyamma",
    "Saramma",
    "Thresia",
    "Kunjamma",
    "Aleyamma",
    "Rosy",
    "Lucy",
    "Gracy",
    "Molly",
    "Leelamma",
    "Sosamma",
    "Bhargavi",
    "Padmini",
    "Sarasu",
    "Kamalam",
    "Beena",
    "Suja",
    "Mini",
    "Deepa",
    "Sheeba",
    "Neethu",
    "Smitha",
    "Anju",
    "Athira",
    "Riya",
    "Ancy",
    "Jincy",
    "Sini",
]
HOUSE_NAMES = [
    "Kavunkal",
    "Palathinkal",
    "Vazhakkunnathil",
    "Chalil",
    "Manalel",
    "Edathil",
    "Karottu",
    "Nedumparambil",
    "Thundathil",
    "Panayil",
    "Kizhakkethil",
    "Puthenveedu",
    "Ambalathil",
    "Chirayil",
    "Kollamparambil",
    "Ottaplackal",
    "Vadakkel",
    "Kalathil",
]
PLACES = [
    "Aalathoor",
    "Perumbally",
    "Kottamala",
    "Vadakkanchery",
    "Mankuzhy",
    "Elanthoor",
    "Pathanad",
    "Cherukara",
    "Vellikkulam",
    "Muthalamada",
]
NICKNAMES = ["Kunju", "Appachan", "Ammini", "Baby", "Kochu", "Unni", "Thanku", "Chinnu"]

MALAYALAM_FORMS = {
    "Ittira": "ഇട്ടിര",
    "Chacko": "ചാക്കോ",
    "Ouseph": "ഔസേഫ്",
    "Thomas": "തോമ്മാ",
    "Mariam": "മറിയം",
    "Annamma": "അന്നമ്മ",
    "Kesavan": "കേശവൻ",
    "Raghavan": "രാഘവൻ",
    "Rosy": "റോസി",
    "Gracy": "ഗ്രേസി",
}


class Command(BaseCommand):
    help = "Create a fictional multi-generation family for admin and demo use."

    def add_arguments(self, parser):
        parser.add_argument("--generations", type=int, default=5, help="How many generations deep.")
        parser.add_argument(
            "--founders", type=int, default=3, help="Founding couples in generation 1."
        )
        parser.add_argument(
            "--seed", type=int, default=20260101, help="RNG seed; same seed, same people."
        )
        parser.add_argument(
            "--min-persons", type=int, default=220, help="Keep going until at least this many."
        )
        parser.add_argument(
            "--max-persons",
            type=int,
            default=340,
            help="Soft cap; households stop branching past this so the tree cannot explode.",
        )
        parser.add_argument(
            "--reset",
            action="store_true",
            help="Delete all existing graph data first (never use in production).",
        )

    @transaction.atomic
    def handle(self, *args, **options):
        rng = random.Random(options["seed"])
        if options["reset"]:
            self.stdout.write(
                self.style.WARNING("Deleting all persons, unions and merge candidates…")
            )
            MergeCandidate.objects.all().delete()
            UnionMembership.objects.all().delete()
            Union.objects.all().delete()
            Person.objects.all().delete()

        builder = _Builder(
            rng,
            generations=options["generations"],
            min_persons=options["min_persons"],
            max_persons=options["max_persons"],
        )
        builder.build(founders=options["founders"])

        self.stdout.write(
            self.style.SUCCESS(
                f"Seeded {builder.person_count} fictional persons across {options['generations']} "
                f"generations in {builder.union_count} unions "
                f"({builder.duplicates} duplicate records queued for merging)."
            )
        )


class _Builder:
    #: Approximate years between generations, used to keep birth ranges plausible.
    GENERATION_SPAN = 28

    def __init__(self, rng: random.Random, generations: int, min_persons: int, max_persons: int):
        self.rng = rng
        self.generations = generations
        self.min_persons = min_persons
        self.max_persons = max_persons
        self.union_count = 0
        self.duplicates = 0
        #: Creation order, which is RNG order. Anything that samples people later reads
        #: this rather than querying — a query ordered by a random UUID primary key
        #: would make the "same seed, same people" guarantee quietly false.
        self.created: list[Person] = []

    @property
    def person_count(self) -> int:
        return len(self.created)

    # -- people -----------------------------------------------------------

    def person(self, gender, birth_year, house=None, living=False) -> Person:
        names = MALE_NAMES if gender == Gender.MALE else FEMALE_NAMES
        name = self.rng.choice(names)
        person = Person.objects.create(
            name_en=name,
            name_ml=MALAYALAM_FORMS.get(name, "") if self.rng.random() < 0.5 else "",
            nicknames=[self.rng.choice(NICKNAMES)] if self.rng.random() < 0.25 else [],
            house_name=house or self.rng.choice(HOUSE_NAMES),
            gender=gender,
            is_living=living,
            # Nobody remembers exact birth dates this far back, so record a window.
            birth_year_min=birth_year - self.rng.randint(0, 3),
            birth_year_max=birth_year + self.rng.randint(0, 3),
            place_origin=self.rng.choice(PLACES),
            institution=f"St. Mary's, {self.rng.choice(PLACES)}" if self.rng.random() < 0.3 else "",
        )
        self.created.append(person)
        return person

    def union(
        self, partners, children, year, status=UnionStatus.UNKNOWN, union_type=UnionType.MARRIAGE
    ) -> Union:
        union = Union.objects.create(
            union_type=union_type,
            year_min=year - 2,
            year_max=year + 2,
            place=self.rng.choice(PLACES),
            status=status,
        )
        self.union_count += 1
        for partner in partners:
            UnionMembership.objects.create(union=union, person=partner, role=Role.PARTNER)
        for order, (child, relation) in enumerate(children, start=1):
            UnionMembership.objects.create(
                union=union,
                person=child,
                role=Role.CHILD,
                relation_type=relation,
                # Birth order is often unknown until someone answers an ordering card.
                sibling_order=order if self.rng.random() < 0.6 else None,
            )
        return union

    # -- the tree ---------------------------------------------------------

    def build(self, founders: int) -> None:
        base_year = 1890
        current: list[Person] = []
        for _ in range(founders):
            house = self.rng.choice(HOUSE_NAMES)
            husband = self.person(Gender.MALE, base_year, house=house)
            wife = self.person(Gender.FEMALE, base_year + 3)
            children = self.make_children(
                base_year + self.GENERATION_SPAN, count=self.rng.randint(3, 5), house=house
            )
            self.union([husband, wife], children, year=base_year + 22, status=UnionStatus.ENDED)
            current.extend(child for child, _ in children)

        for generation in range(2, self.generations + 1):
            birth_year = base_year + (generation - 1) * self.GENERATION_SPAN
            living = generation >= self.generations - 1
            current = self.next_generation(current, birth_year, living=living)

        self.top_up(base_year)
        self.plant_duplicates()

    def next_generation(self, parents: list[Person], birth_year: int, living: bool) -> list[Person]:
        offspring: list[Person] = []
        for parent in parents:
            if self.rng.random() < 0.15:
                continue  # not everyone marries or has children
            if self.person_count >= self.max_persons:
                break  # a demo dataset, not a population simulation

            house = parent.house_name
            child_birth = birth_year + self.GENERATION_SPAN
            spouse_gender = Gender.FEMALE if parent.gender == Gender.MALE else Gender.MALE

            if self.rng.random() < 0.08:
                # One parent is simply not remembered: a union with a single partner.
                children = self.make_children(
                    child_birth, self.rng.randint(1, 2), house, living=living
                )
                self.union([parent], children, year=birth_year + 24, union_type=UnionType.UNKNOWN)
                offspring.extend(child for child, _ in children)
                continue

            spouse = self.person(
                spouse_gender, birth_year + 2, living=living and self.rng.random() < 0.8
            )
            children = self.make_children(child_birth, self.rng.randint(1, 4), house, living=living)
            first = self.union([parent, spouse], children, year=birth_year + 24)
            offspring.extend(child for child, _ in children)

            if self.rng.random() < 0.12:
                # The spouse dies young and the survivor remarries: half-siblings.
                Union.objects.filter(pk=first.pk).update(status=UnionStatus.ENDED)
                Person.objects.filter(pk=spouse.pk).update(
                    is_living=False, death_year_min=birth_year + 30, death_year_max=birth_year + 34
                )
                second_spouse = self.person(spouse_gender, birth_year + 10, living=living)
                half_siblings = self.make_children(
                    child_birth + 12, self.rng.randint(1, 3), house, living=living
                )
                self.union([parent, second_spouse], half_siblings, year=birth_year + 36)
                offspring.extend(child for child, _ in half_siblings)
        return offspring

    def make_children(self, birth_year, count, house=None, living=False):
        children = []
        for index in range(count):
            gender = Gender.MALE if self.rng.random() < 0.52 else Gender.FEMALE
            child = self.person(gender, birth_year + index * 3, house=house, living=living)
            relation = RelationType.ADOPTED if self.rng.random() < 0.04 else RelationType.BIOLOGICAL
            children.append((child, relation))
        return children

    def top_up(self, base_year: int) -> None:
        """Add extra founding branches until the dataset is big enough to be realistic."""
        guard = 0
        while self.person_count < self.min_persons and guard < 40:
            guard += 1
            house = self.rng.choice(HOUSE_NAMES)
            husband = self.person(Gender.MALE, base_year + self.GENERATION_SPAN)
            wife = self.person(Gender.FEMALE, base_year + self.GENERATION_SPAN + 3)
            children = self.make_children(
                base_year + 2 * self.GENERATION_SPAN, self.rng.randint(2, 4), house
            )
            self.union([husband, wife], children, year=base_year + self.GENERATION_SPAN + 22)

            grandchildren_parents = [child for child, _ in children]
            self.next_generation(
                grandchildren_parents, base_year + 2 * self.GENERATION_SPAN, living=True
            )

    def plant_duplicates(self) -> None:
        """Re-enter a few people as separate records, the way two contributors would."""
        candidates = [person for person in self.created if not person.is_living][:60]
        if not candidates:
            return
        for original in self.rng.sample(candidates, k=min(4, len(candidates))):
            copy = Person.objects.create(
                name_en=original.name_en,
                name_ml=original.name_ml or MALAYALAM_FORMS.get(original.name_en, ""),
                house_name=original.house_name,
                gender=original.gender,
                is_living=False,
                birth_year_min=(original.birth_year_min or 1900) - 2,
                birth_year_max=(original.birth_year_max or 1900) + 2,
                place_origin=original.place_origin,
                notes="Entered separately by another contributor — likely the same person.",
            )
            self.created.append(copy)
            self.duplicates += 1
            MergeCandidate.objects.get_or_create(
                person_a=original,
                person_b=copy,
                defaults={
                    "score": round(self.rng.uniform(0.6, 0.95), 2),
                    "evidence": {
                        "same_name": True,
                        "same_house_name": True,
                        "era_overlap": True,
                        "note": "Seeded duplicate; Phase 4 will compute this properly.",
                    },
                },
            )
