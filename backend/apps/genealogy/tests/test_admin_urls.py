"""View-level tests for every custom admin page and action.

These exist because of a real failure: the custom pages were built and wired under
`/admin/genealogy/person/…` instead of `/admin/genealogy/…`, and the test suite could
not tell, because every test called the underlying graph functions directly. The pages
404'd for the user while the suite stayed green (DECISIONS.md #16).

So the rules for this module:

* address pages by **hard-coded URL string**, not by `reverse()` — a renamed route that
  moves the page must fail here, and reverse() would happily follow it;
* additionally assert `reverse()` resolves to that same string, so the two can never
  drift apart silently;
* go through the test client as a real logged-in admin, and assert on rendered content,
  never on the helper functions behind the view.

The literal URLs below are the ones documented in the README. If you change one, you are
changing a published address, and this file should be the thing that stops you.
"""

import pytest
from django.contrib.auth import get_user_model
from django.contrib.auth.models import Permission
from django.urls import reverse

from apps.claims.models import Claim, ClaimStatus, Predicate
from apps.genealogy.models import Person, Role, UnionMembership
from apps.merging.models import CandidateStatus, MergeCandidate, MergeRecord

pytestmark = pytest.mark.django_db

EXPLORER_URL = "/admin/genealogy/explorer/"
RELATE_URL = "/admin/genealogy/relate/"
QUICK_ADD_URL = "/admin/genealogy/quick-add/"
MERGE_QUEUE_URL = "/admin/merging/mergecandidate/"
MERGE_RECORD_URL = "/admin/merging/mergerecord/"
CLAIM_QUEUE_URL = "/admin/claims/claim/"


# ------------------------------------------------------ the routes actually exist


@pytest.mark.parametrize(
    ("url", "url_name"),
    [
        (EXPLORER_URL, "admin:genealogy_explorer"),
        (RELATE_URL, "admin:genealogy_relate"),
        (QUICK_ADD_URL, "admin:genealogy_quick_add"),
    ],
)
def test_custom_admin_page_is_reachable_at_its_documented_url(admin_client, url, url_name):
    response = admin_client.get(url)
    assert response.status_code == 200, f"{url} should render, got {response.status_code}"
    assert reverse(url_name) == url, "the route name and the documented URL have drifted apart"


@pytest.mark.parametrize(
    "url",
    [EXPLORER_URL, RELATE_URL, QUICK_ADD_URL, MERGE_QUEUE_URL, MERGE_RECORD_URL, CLAIM_QUEUE_URL],
)
def test_admin_pages_are_listed_in_the_urlconf(url):
    """A 404 must come from a missing object, never from a missing route."""
    from django.urls import Resolver404, resolve

    try:
        resolve(url)
    except Resolver404:  # pragma: no cover - the failure we are guarding against
        pytest.fail(f"{url} is not in the URLconf at all")


# ------------------------------------------------------------------ authentication


@pytest.mark.parametrize("url", [EXPLORER_URL, RELATE_URL, QUICK_ADD_URL])
def test_anonymous_visitors_are_sent_to_the_admin_login(client, url):
    response = client.get(url)
    assert response.status_code == 302
    assert "/admin/login/" in response["Location"]


@pytest.mark.parametrize("url", [EXPLORER_URL, RELATE_URL, QUICK_ADD_URL])
def test_non_staff_users_are_sent_to_the_admin_login(client, url):
    get_user_model().objects.create_user(email="member@example.invalid", password="secret-x")
    client.login(email="member@example.invalid", password="secret-x")

    response = client.get(url)
    assert response.status_code == 302
    assert "/admin/login/" in response["Location"]


def test_staff_without_person_permission_cannot_read_the_graph(client):
    staff = get_user_model().objects.create_user(
        email="staff@example.invalid", password="secret-x", is_staff=True
    )
    client.force_login(staff)

    assert client.get(EXPLORER_URL).status_code == 403
    assert client.get(RELATE_URL).status_code == 403


def test_staff_with_only_view_permission_can_read_but_not_quick_add(client, family_a):
    staff = get_user_model().objects.create_user(
        email="viewer@example.invalid", password="secret-x", is_staff=True
    )
    staff.user_permissions.add(Permission.objects.get(codename="view_person"))
    client.force_login(staff)

    assert (
        client.get(EXPLORER_URL, {"person": str(family_a.thomas.pk), "depth": 3}).status_code == 200
    )
    assert client.get(QUICK_ADD_URL).status_code == 403


# --------------------------------------------------------------------- explorer


def test_explorer_renders_the_ego_network_for_a_person(admin_client, family_a):
    response = admin_client.get(EXPLORER_URL, {"person": str(family_a.thomas.pk), "depth": 4})
    assert response.status_code == 200
    body = response.content.decode()

    assert "Ego network" in body
    for section in ["Parents", "Siblings", "Partners", "Children"]:
        assert section in body
    assert "Chacko" in body  # parent
    assert "Annamma" in body  # parent
    assert "Rosy" in body  # full sibling
    assert "Joseph" in body  # half sibling…
    assert "half" in body  # …labelled as such
    assert "Gracy" in body  # partner
    assert "Jose" in body  # child


def test_explorer_renders_ancestors_and_descendants_by_generation(admin_client, family_a):
    response = admin_client.get(EXPLORER_URL, {"person": str(family_a.kiran.pk), "depth": 5})
    body = response.content.decode()

    assert "Ancestors" in body
    assert "Descendants" in body
    assert "Ittira" in body  # five generations up
    assert "generation(s) up" in body


def test_explorer_depth_limits_what_is_shown(admin_client, family_a):
    shallow = admin_client.get(EXPLORER_URL, {"person": str(family_a.kiran.pk), "depth": 2})
    deep = admin_client.get(EXPLORER_URL, {"person": str(family_a.kiran.pk), "depth": 5})

    assert "Ittira" not in shallow.content.decode()
    assert "Ittira" in deep.content.decode()


def test_explorer_renders_without_a_person_selected(admin_client, family_a):
    response = admin_client.get(EXPLORER_URL)
    assert response.status_code == 200
    assert "Pick a person" in response.content.decode()


def test_explorer_rejects_an_unknown_person_id_without_crashing(admin_client, family_a):
    response = admin_client.get(EXPLORER_URL, {"person": "11111111-1111-4111-8111-111111111111"})
    assert response.status_code == 200
    assert "Pick a person" in response.content.decode()


# ----------------------------------------------------------------------- relate


def test_relate_reports_the_relationship_in_both_languages(admin_client, family_a):
    response = admin_client.get(
        RELATE_URL, {"a": str(family_a.jose.pk), "b": str(family_a.rosy.pk)}
    )
    assert response.status_code == 200
    body = response.content.decode()

    assert "aunt" in body
    assert "അമ്മായി" in body


def test_relate_shows_the_common_ancestor_and_both_descent_paths(admin_client, family_a):
    response = admin_client.get(
        RELATE_URL, {"a": str(family_a.kiran.pk), "b": str(family_a.bibin.pk)}
    )
    body = response.content.decode()

    assert "Common ancestor" in body
    assert "Chacko" in body
    # Kiran's line down from Chacko, and Bibin's, both rendered.
    for step in ["Thomas", "Jose", "Arun", "Kiran"]:
        assert step in body
    for step in ["Joseph", "Bibin"]:
        assert step in body


def test_relate_says_so_when_there_is_no_relation(admin_client, two_families):
    family_a, family_b = two_families
    response = admin_client.get(
        RELATE_URL, {"a": str(family_a.jose.pk), "b": str(family_b.manoj.pk)}
    )
    assert response.status_code == 200
    body = response.content.decode()

    assert "no known relationship" in body
    assert "No shared ancestor was found" in body
    assert "Common ancestor" not in body


def test_relate_renders_without_a_pair_selected(admin_client, family_a):
    response = admin_client.get(RELATE_URL)
    assert response.status_code == 200
    assert "Pick two people" in response.content.decode()


# -------------------------------------------------------------------- quick add


def quick_add_payload(**overrides):
    payload = {
        "existing_partner_1": "",
        "new_partner_1": "",
        "new_partner_1_gender": "male",
        "existing_partner_2": "",
        "new_partner_2": "",
        "new_partner_2_gender": "female",
        "union_type": "marriage",
        "union_year": "",
        "union_place": "",
        "house_name": "",
        "children": "",
    }
    payload.update(overrides)
    return payload


def test_quick_add_form_renders_its_fields(admin_client):
    response = admin_client.get(QUICK_ADD_URL)
    assert response.status_code == 200
    body = response.content.decode()

    assert 'name="new_partner_1"' in body
    assert 'name="new_partner_2"' in body
    assert 'name="children"' in body
    assert 'name="house_name"' in body
    assert "Save and add another household" in body


def test_quick_add_creates_a_household_through_the_url(admin_client):
    response = admin_client.post(
        QUICK_ADD_URL,
        quick_add_payload(
            new_partner_1="Mathai",
            new_partner_2="Aleyamma",
            house_name="Kunnathil",
            children="Thomas | m | 1938\nRosy | f | 1941\nJoseph | m",
        ),
        follow=True,
    )
    assert response.status_code == 200
    # It redirects onto the explorer for the household it just created.
    assert response.redirect_chain
    assert EXPLORER_URL in response.redirect_chain[-1][0]

    father = Person.objects.get(name_en="Mathai")
    children = UnionMembership.objects.filter(
        union__memberships__person=father, role=Role.CHILD
    ).order_by("sibling_order")
    assert [m.person.name_en for m in children] == ["Thomas", "Rosy", "Joseph"]
    # Line order is sibling order — the whole point of the textarea.
    assert [m.sibling_order for m in children] == [1, 2, 3]


def test_quick_add_reports_errors_on_the_page(admin_client):
    response = admin_client.post(QUICK_ADD_URL, quick_add_payload(children="Orphan | m"))
    assert response.status_code == 200
    assert "Name at least one partner" in response.content.decode()
    assert not Person.objects.filter(name_en="Orphan").exists()


def test_quick_add_and_add_another_returns_to_the_form(admin_client):
    payload = quick_add_payload(new_partner_1="Chandy", house_name="Vazhakkunnathil")
    payload["_addanother"] = "1"
    response = admin_client.post(QUICK_ADD_URL, payload, follow=True)

    assert response.status_code == 200
    assert QUICK_ADD_URL in response.redirect_chain[-1][0]
    # The house name carries over, so a run of households is quick to enter.
    assert "Vazhakkunnathil" in response.content.decode()


# ----------------------------------------------------------- person changelist


def test_person_changelist_links_to_all_three_tools(admin_client, family_a):
    response = admin_client.get("/admin/genealogy/person/")
    assert response.status_code == 200
    body = response.content.decode()

    for url in [EXPLORER_URL, RELATE_URL, QUICK_ADD_URL]:
        assert f'href="{url}"' in body, f"changelist should link to {url}"


# ------------------------------------------------------------------ merge queue


def test_merge_queue_changelist_renders_candidates(admin_client, duplicate_pair):
    MergeCandidate.objects.create(
        person_a=duplicate_pair.primary, person_b=duplicate_pair.duplicate, score=0.91
    )
    response = admin_client.get(MERGE_QUEUE_URL)
    assert response.status_code == 200
    body = response.content.decode()

    assert "Ouseph" in body
    assert "Yousef" in body
    assert "0.91" in body
    # And the compare link points at the relationship finder's real URL.
    assert f"{RELATE_URL}?a=" in body


def test_merge_action_runs_from_the_changelist(admin_client, duplicate_pair):
    candidate = MergeCandidate.objects.create(
        person_a=duplicate_pair.primary, person_b=duplicate_pair.duplicate, score=0.9
    )
    response = admin_client.post(
        MERGE_QUEUE_URL,
        {"action": "merge_keeping_a", "_selected_action": [str(candidate.pk)]},
        follow=True,
    )
    assert response.status_code == 200
    assert "1 pair merged." in response.content.decode()

    candidate.refresh_from_db()
    assert candidate.status == CandidateStatus.MERGED
    duplicate_pair.duplicate.refresh_from_db()
    assert duplicate_pair.duplicate.merged_into_id == duplicate_pair.primary.pk


def test_dismiss_action_runs_from_the_changelist(admin_client, duplicate_pair):
    candidate = MergeCandidate.objects.create(
        person_a=duplicate_pair.primary, person_b=duplicate_pair.duplicate, score=0.4
    )
    admin_client.post(
        MERGE_QUEUE_URL,
        {"action": "dismiss_as_distinct", "_selected_action": [str(candidate.pk)]},
        follow=True,
    )
    candidate.refresh_from_db()
    assert candidate.status == CandidateStatus.REJECTED
    duplicate_pair.duplicate.refresh_from_db()
    assert duplicate_pair.duplicate.merged_into_id is None


def test_unmerge_action_runs_from_the_merge_record_changelist(admin_client, duplicate_pair):
    candidate = MergeCandidate.objects.create(
        person_a=duplicate_pair.primary, person_b=duplicate_pair.duplicate, score=0.9
    )
    admin_client.post(
        MERGE_QUEUE_URL,
        {"action": "merge_keeping_a", "_selected_action": [str(candidate.pk)]},
        follow=True,
    )
    record = MergeRecord.objects.get()

    listing = admin_client.get(MERGE_RECORD_URL)
    assert listing.status_code == 200
    assert "Yousef" in listing.content.decode()

    response = admin_client.post(
        MERGE_RECORD_URL,
        {"action": "revert_merges", "_selected_action": [str(record.pk)]},
        follow=True,
    )
    assert "1 merge reverted." in response.content.decode()

    record.refresh_from_db()
    assert record.is_reverted
    duplicate_pair.duplicate.refresh_from_db()
    assert duplicate_pair.duplicate.merged_into_id is None
    assert duplicate_pair.duplicate.status == "canonical"


# --------------------------------------------------------- contested claim queue


@pytest.fixture
def contested_claim(family_a):
    return Claim.objects.create(
        subject=family_a.thomas,
        predicate=Predicate.BIRTH_YEAR,
        value={"year": 1942},
        status=ClaimStatus.CONTESTED,
        disputes_count=2,
        confirmations_count=1,
    )


def test_claim_queue_changelist_renders(admin_client, contested_claim):
    response = admin_client.get(CLAIM_QUEUE_URL)
    assert response.status_code == 200
    body = response.content.decode()

    assert "birth_year" in body
    assert "Confirm: this claim is correct" in body
    assert "Reject: this claim is wrong" in body


def test_claim_queue_filters_to_what_needs_arbitration(admin_client, contested_claim, family_a):
    settled = Claim.objects.create(
        subject=family_a.rosy,
        predicate=Predicate.NAME,
        value={"text": "Rosy"},
        status=ClaimStatus.CONFIRMED,
    )
    response = admin_client.get(CLAIM_QUEUE_URL, {"arbitration": "yes"})
    assert response.status_code == 200
    body = response.content.decode()

    assert str(contested_claim.pk) in body
    assert str(settled.pk) not in body


def test_confirm_action_runs_from_the_changelist(admin_client, contested_claim):
    response = admin_client.post(
        CLAIM_QUEUE_URL,
        {"action": "confirm_claims", "_selected_action": [str(contested_claim.pk)]},
        follow=True,
    )
    assert response.status_code == 200
    assert "1 claim(s) confirmed." in response.content.decode()

    contested_claim.refresh_from_db()
    assert contested_claim.status == ClaimStatus.CONFIRMED
    assert contested_claim.resolved_by is not None
    assert contested_claim.resolved_at is not None


def test_reject_action_runs_from_the_changelist(admin_client, contested_claim):
    response = admin_client.post(
        CLAIM_QUEUE_URL,
        {"action": "reject_claims", "_selected_action": [str(contested_claim.pk)]},
        follow=True,
    )
    assert "1 claim(s) rejected." in response.content.decode()

    contested_claim.refresh_from_db()
    assert contested_claim.status == ClaimStatus.REJECTED


# ------------------------------------------------------------------- admin index


def test_admin_index_renders_with_every_app(admin_client):
    response = admin_client.get("/admin/")
    assert response.status_code == 200
    body = response.content.decode()

    assert "Aalmaram" in body
    for label in ["Persons", "Unions", "Merge candidates", "Claims"]:
        assert label in body
