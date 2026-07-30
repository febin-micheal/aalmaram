"""Wipe the family graph without touching accounts.

This is what takes the owner from the fictional demo dataset to an empty database ready
for real relatives. It is deliberately narrow:

* it deletes graph data only — persons, unions, memberships, claims, merges, media rows;
* it never touches `accounts.User`, so the admin login survives (anchors null themselves
  through `on_delete=SET_NULL`);
* it never deletes files from MEDIA_ROOT. A reset can wipe a table, but it must not be
  able to destroy a photograph somebody uploaded. Orphaned files are cleaned by hand.

It refuses to run without `--confirm`, and `make reset-db` takes a dump before calling it.
"""

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from apps.claims.models import Claim
from apps.genealogy.models import Person, PersonStatus, Union, UnionMembership
from apps.mediastore.models import MediaItem
from apps.merging.models import MergeCandidate, MergeRecord

#: Deletion order matters: rows that reference persons go before the persons themselves.
DELETION_ORDER = (
    ("merge records", MergeRecord),
    ("merge candidates", MergeCandidate),
    ("claims", Claim),
    ("media items", MediaItem),
    ("union memberships", UnionMembership),
    ("unions", Union),
    ("persons", Person),
)


class Command(BaseCommand):
    help = "Delete all family graph data. Keeps admin accounts and uploaded files."

    def add_arguments(self, parser):
        parser.add_argument(
            "--confirm",
            action="store_true",
            help="Required. Without it the command refuses and changes nothing.",
        )

    @transaction.atomic
    def handle(self, *args, **options):
        if not options["confirm"]:
            raise CommandError(
                "Refusing to delete anything without --confirm. Use `make reset-db`, "
                "which takes a backup first."
            )

        # Merged persons point at their canonical row through a SET_NULL foreign key, and
        # a CHECK constraint ties that pointer to status=merged_into. Deleting the
        # canonical person first nulls the pointer while the status still says otherwise,
        # which the database rejects. Normalise the pair before deleting anything.
        Person.objects.filter(status=PersonStatus.MERGED_INTO).update(
            status=PersonStatus.CANONICAL, merged_into=None
        )

        deleted = []
        for label, model in DELETION_ORDER:
            count = model.objects.count()
            if count:
                model.objects.all().delete()
            deleted.append((label, count))

        width = max(len(label) for label, _ in deleted)
        for label, count in deleted:
            self.stdout.write(f"  {label:<{width}}  {count:>7,}")

        total = sum(count for _, count in deleted)
        self.stdout.write(
            self.style.SUCCESS(f"\nDeleted {total:,} rows. Admin accounts and uploaded files kept.")
        )
        if total == 0:
            self.stdout.write("The graph was already empty.")
