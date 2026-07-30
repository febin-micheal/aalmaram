"""The reset that takes the owner from demo data to an empty database.

This command is the most destructive thing in the project, so the tests are about what it
must *not* touch as much as what it clears.
"""

import pytest
from django.contrib.auth import get_user_model
from django.core.management import CommandError, call_command

from apps.claims.models import Claim, Predicate
from apps.genealogy.models import Person, Union, UnionMembership
from apps.mediastore.models import MediaItem, MediaType
from apps.merging.models import MergeCandidate, MergeRecord
from apps.merging.services import merge_persons

pytestmark = pytest.mark.django_db


def graph_row_counts():
    return {
        "persons": Person.objects.count(),
        "unions": Union.objects.count(),
        "memberships": UnionMembership.objects.count(),
        "claims": Claim.objects.count(),
        "candidates": MergeCandidate.objects.count(),
        "records": MergeRecord.objects.count(),
        "media": MediaItem.objects.count(),
    }


def test_refuses_without_confirm(family_a):
    with pytest.raises(CommandError, match="--confirm"):
        call_command("reset_graph")
    assert Person.objects.count() > 0, "a refused reset must change nothing"


def test_clears_every_graph_table(family_a, duplicate_pair):
    Claim.objects.create(
        subject=family_a.thomas, predicate=Predicate.BIRTH_YEAR, value={"year": 1942}
    )
    MediaItem.objects.create(media_type=MediaType.PHOTO, caption="Family group")
    candidate = MergeCandidate.objects.create(
        person_a=duplicate_pair.primary, person_b=duplicate_pair.duplicate, score=0.9
    )
    merge_persons(duplicate_pair.primary, duplicate_pair.duplicate, candidate=candidate)

    before = graph_row_counts()
    assert all(count > 0 for count in before.values()), f"fixture is incomplete: {before}"

    call_command("reset_graph", confirm=True, verbosity=0)

    assert graph_row_counts() == dict.fromkeys(before, 0)


def test_keeps_admin_accounts(family_a):
    """Wiping the family must never lock the owner out of their own admin."""
    user_model = get_user_model()
    owner = user_model.objects.create_superuser(email="owner@example.invalid", password="x")
    member = user_model.objects.create_user(
        email="member@example.invalid", password="x", anchor_person=family_a.thomas
    )

    call_command("reset_graph", confirm=True, verbosity=0)

    assert user_model.objects.filter(pk=owner.pk).exists()
    assert user_model.objects.filter(pk=member.pk).exists()
    member.refresh_from_db()
    # The anchor pointed at a deleted person, so it nulls rather than cascading.
    assert member.anchor_person_id is None


def test_leaves_uploaded_files_alone(family_a, tmp_path, settings):
    """A reset may drop a media row; it may not destroy the file behind it."""
    settings.MEDIA_ROOT = tmp_path
    upload = tmp_path / "uploads" / "voice-note.m4a"
    upload.parent.mkdir(parents=True)
    upload.write_bytes(b"not really audio")

    MediaItem.objects.create(media_type=MediaType.AUDIO, file="uploads/voice-note.m4a")

    call_command("reset_graph", confirm=True, verbosity=0)

    assert MediaItem.objects.count() == 0
    assert upload.exists(), "the uploaded file must survive a database reset"


def test_is_safe_to_run_on_an_empty_database():
    call_command("reset_graph", confirm=True, verbosity=0)
    assert graph_row_counts() == dict.fromkeys(graph_row_counts(), 0)


def test_seeding_still_works_afterwards(family_a):
    """reset_graph clears the way for real data; seed_demo stays available for dev."""
    call_command("reset_graph", confirm=True, verbosity=0)
    assert Person.objects.count() == 0

    call_command("seed_demo", verbosity=0)
    assert Person.objects.canonical().count() >= 200
