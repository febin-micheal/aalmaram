"""Relationship labels, driven straight from a Descriptor.

test_lca.py covers naming end to end on the fixture families. This file exercises the
label table itself, including the distant relations that would need a ten-generation
fixture to reach naturally, and the fallbacks Malayalam uses when the graph does not know
enough to pick a specific term.

No database needed: label_for() is a pure function of the descriptor.
"""

import pytest

from apps.genealogy.graph.naming import (
    ANCESTOR,
    COUSIN,
    DESCENDANT,
    NIBLING,
    PARTNER,
    PIBLING,
    SELF,
    SIBLING,
    UNRELATED,
    Descriptor,
    label_for,
    labels_for,
)

FEMALE = "female"
MALE = "male"
UNKNOWN = "unknown"


# --------------------------------------------------------------------------- English


@pytest.mark.parametrize(
    ("descriptor", "expected"),
    [
        (Descriptor(kind=ANCESTOR, up_subject=1, other_gender=MALE), "father"),
        (Descriptor(kind=ANCESTOR, up_subject=1, other_gender=UNKNOWN), "parent"),
        (Descriptor(kind=ANCESTOR, up_subject=3, other_gender=FEMALE), "great-grandmother"),
        (
            Descriptor(kind=ANCESTOR, up_subject=5, other_gender=MALE),
            "great-great-great-grandfather",
        ),
        (Descriptor(kind=ANCESTOR, up_subject=1, other_gender=FEMALE, step=True), "step-mother"),
        (Descriptor(kind=DESCENDANT, up_other=1, other_gender=UNKNOWN), "child"),
        (Descriptor(kind=DESCENDANT, up_other=3, other_gender=MALE), "great-grandson"),
        (
            Descriptor(kind=DESCENDANT, up_other=5, other_gender=FEMALE),
            "great-great-great-granddaughter",
        ),
        (Descriptor(kind=DESCENDANT, up_other=1, other_gender=MALE, step=True), "step-son"),
        (Descriptor(kind=SIBLING, up_subject=1, up_other=1, other_gender=UNKNOWN), "sibling"),
        (
            Descriptor(kind=SIBLING, up_subject=1, up_other=1, other_gender=MALE, half=True),
            "half-brother",
        ),
        (
            Descriptor(kind=SIBLING, up_subject=1, up_other=1, other_gender=FEMALE, step=True),
            "step-sister",
        ),
        (Descriptor(kind=PIBLING, up_subject=2, up_other=1, other_gender=FEMALE), "aunt"),
        (Descriptor(kind=PIBLING, up_subject=3, up_other=1, other_gender=MALE), "great-uncle"),
        (
            Descriptor(kind=PIBLING, up_subject=4, up_other=1, other_gender=FEMALE),
            "great-great-aunt",
        ),
        (Descriptor(kind=PIBLING, up_subject=2, up_other=1, other_gender=UNKNOWN), "uncle/aunt"),
        (Descriptor(kind=NIBLING, up_subject=1, up_other=2, other_gender=MALE), "nephew"),
        (Descriptor(kind=NIBLING, up_subject=1, up_other=3, other_gender=FEMALE), "great-niece"),
        (
            Descriptor(kind=NIBLING, up_subject=1, up_other=4, other_gender=UNKNOWN),
            "great-great-nephew/niece",
        ),
        (Descriptor(kind=COUSIN, up_subject=2, up_other=2), "first cousin"),
        (Descriptor(kind=COUSIN, up_subject=3, up_other=2), "first cousin once removed"),
        (Descriptor(kind=COUSIN, up_subject=4, up_other=2), "first cousin twice removed"),
        (Descriptor(kind=COUSIN, up_subject=5, up_other=2), "first cousin thrice removed"),
        (Descriptor(kind=COUSIN, up_subject=6, up_other=2), "first cousin 4 times removed"),
        (Descriptor(kind=COUSIN, up_subject=4, up_other=4), "third cousin"),
        (Descriptor(kind=COUSIN, up_subject=11, up_other=11), "tenth cousin"),
        (Descriptor(kind=COUSIN, up_subject=13, up_other=13), "12th cousin"),
        (Descriptor(kind=COUSIN, up_subject=3, up_other=3, half=True), "half-second cousin"),
        (Descriptor(kind=PARTNER, other_gender=MALE, union_type="marriage"), "husband"),
        (Descriptor(kind=PARTNER, other_gender=UNKNOWN, union_type="marriage"), "spouse"),
        (Descriptor(kind=PARTNER, other_gender=FEMALE, union_type="partnership"), "partner"),
        (Descriptor(kind=SELF), "the same person"),
        (Descriptor(kind=UNRELATED), "no known relationship"),
    ],
)
def test_english_labels(descriptor, expected):
    assert label_for(descriptor, "en") == expected


# ------------------------------------------------------------------------- Malayalam


@pytest.mark.parametrize(
    ("descriptor", "expected"),
    [
        (Descriptor(kind=ANCESTOR, up_subject=1, other_gender=MALE), "അച്ഛൻ"),
        (Descriptor(kind=ANCESTOR, up_subject=1, other_gender=UNKNOWN), "മാതാപിതാവ്"),
        (Descriptor(kind=ANCESTOR, up_subject=3, other_gender=FEMALE), "മുതുമുത്തശ്ശി"),
        (Descriptor(kind=ANCESTOR, up_subject=1, other_gender=MALE, step=True), "രണ്ടാനച്ഛൻ"),
        (Descriptor(kind=DESCENDANT, up_other=1, other_gender=UNKNOWN), "കുട്ടി"),
        (Descriptor(kind=DESCENDANT, up_other=2, other_gender=FEMALE), "കൊച്ചുമകൾ"),
        (Descriptor(kind=DESCENDANT, up_other=1, other_gender=FEMALE, step=True), "രണ്ടാൻ മകൾ"),
        (Descriptor(kind=SIBLING, up_subject=1, up_other=1, other_gender=UNKNOWN), "സഹോദരൻ/സഹോദരി"),
        (
            Descriptor(kind=SIBLING, up_subject=1, up_other=1, other_gender=FEMALE, half=True),
            "അർദ്ധസഹോദരി",
        ),
        (
            Descriptor(kind=SIBLING, up_subject=1, up_other=1, other_gender=MALE, step=True),
            "രണ്ടാൻ സഹോദരൻ",
        ),
        (Descriptor(kind=NIBLING, up_subject=1, up_other=2, other_gender=FEMALE), "അനന്തരവൾ"),
        (
            Descriptor(kind=NIBLING, up_subject=1, up_other=2, other_gender=MALE, step=True),
            "രണ്ടാൻ അനന്തരവൻ",
        ),
        (Descriptor(kind=COUSIN, up_subject=2, up_other=2), "കസിൻ"),
        (Descriptor(kind=COUSIN, up_subject=3, up_other=3), "രണ്ടാം കസിൻ"),
        (Descriptor(kind=COUSIN, up_subject=3, up_other=2), "കസിൻ (1 തലമുറ അകലെ)"),
        (Descriptor(kind=COUSIN, up_subject=2, up_other=2, half=True), "അർദ്ധകസിൻ"),
        (Descriptor(kind=PARTNER, other_gender=FEMALE, union_type="marriage"), "ഭാര്യ"),
        (Descriptor(kind=PARTNER, other_gender=UNKNOWN, union_type="marriage"), "ജീവിതപങ്കാളി"),
        (Descriptor(kind=PARTNER, other_gender=MALE, union_type="partnership"), "പങ്കാളി"),
        (Descriptor(kind=SELF), "ഇതേ വ്യക്തി"),
        (Descriptor(kind=UNRELATED), "ബന്ധം കണ്ടെത്താനായില്ല"),
    ],
)
def test_malayalam_labels(descriptor, expected):
    assert label_for(descriptor, "ml") == expected


@pytest.mark.parametrize(
    ("descriptor", "expected"),
    [
        # Malayalam distinguishes the mother's brother from the father's, and among the
        # father's brothers, the ones older and younger than him.
        (
            Descriptor(kind=PIBLING, up_subject=2, up_other=1, other_gender=MALE, side="maternal"),
            "അമ്മാവൻ",
        ),
        (
            Descriptor(
                kind=PIBLING,
                up_subject=2,
                up_other=1,
                other_gender=MALE,
                side="paternal",
                other_is_elder=True,
            ),
            "വലിയച്ഛൻ",
        ),
        (
            Descriptor(
                kind=PIBLING,
                up_subject=2,
                up_other=1,
                other_gender=MALE,
                side="paternal",
                other_is_elder=False,
            ),
            "ചെറിയച്ഛൻ",
        ),
        (
            Descriptor(
                kind=PIBLING, up_subject=2, up_other=1, other_gender=FEMALE, side="paternal"
            ),
            "അമ്മായി",
        ),
        (
            Descriptor(
                kind=PIBLING,
                up_subject=2,
                up_other=1,
                other_gender=FEMALE,
                side="maternal",
                other_is_elder=True,
            ),
            "വലിയമ്മ",
        ),
        (
            Descriptor(
                kind=PIBLING,
                up_subject=2,
                up_other=1,
                other_gender=FEMALE,
                side="maternal",
                other_is_elder=False,
            ),
            "ചെറിയമ്മ",
        ),
    ],
)
def test_malayalam_uncles_and_aunts_encode_side_and_seniority(descriptor, expected):
    assert label_for(descriptor, "ml") == expected


@pytest.mark.parametrize(
    ("descriptor", "expected"),
    [
        # Unknown side: describe the relation rather than gamble on അമ്മാവൻ vs ചിറ്റപ്പൻ.
        (
            Descriptor(kind=PIBLING, up_subject=2, up_other=1, other_gender=MALE),
            "അമ്മയുടെ/അച്ഛന്റെ സഹോദരൻ",
        ),
        (
            Descriptor(kind=PIBLING, up_subject=2, up_other=1, other_gender=FEMALE),
            "അമ്മയുടെ/അച്ഛന്റെ സഹോദരി",
        ),
        (
            Descriptor(kind=PIBLING, up_subject=2, up_other=1, other_gender=UNKNOWN),
            "അമ്മയുടെ/അച്ഛന്റെ സഹോദരൻ/സഹോദരി",
        ),
        # Known side, unknown seniority: still no coin flip.
        (
            Descriptor(kind=PIBLING, up_subject=2, up_other=1, other_gender=MALE, side="paternal"),
            "അച്ഛന്റെ സഹോദരൻ",
        ),
        (
            Descriptor(
                kind=PIBLING, up_subject=2, up_other=1, other_gender=FEMALE, side="maternal"
            ),
            "അമ്മയുടെ സഹോദരി",
        ),
    ],
)
def test_malayalam_falls_back_to_description_when_the_graph_is_unsure(descriptor, expected):
    assert label_for(descriptor, "ml") == expected


@pytest.mark.parametrize(
    ("descriptor", "expected"),
    [
        # No everyday Malayalam word exists this far out, so the label says plainly how
        # many generations are involved instead of inventing one.
        (Descriptor(kind=ANCESTOR, up_subject=4, other_gender=MALE), "4 തലമുറ മുകളിലുള്ള പൂർവികൻ"),
        (Descriptor(kind=ANCESTOR, up_subject=6, other_gender=FEMALE), "6 തലമുറ മുകളിലുള്ള പൂർവിക"),
        (
            Descriptor(kind=ANCESTOR, up_subject=4, other_gender=UNKNOWN),
            "4 തലമുറ മുകളിലുള്ള പൂർവികൻ/പൂർവിക",
        ),
        (Descriptor(kind=DESCENDANT, up_other=3, other_gender=MALE), "3 തലമുറ താഴെയുള്ള സന്തതി"),
        (
            Descriptor(kind=NIBLING, up_subject=1, up_other=3, other_gender=MALE),
            "2 തലമുറ താഴെയുള്ള അനന്തരവൻ",
        ),
        (Descriptor(kind=COUSIN, up_subject=7, up_other=7), "6 കസിൻ"),
    ],
)
def test_malayalam_describes_distant_relations(descriptor, expected):
    assert label_for(descriptor, "ml") == expected


def test_malayalam_builds_grand_uncles_from_the_linking_ancestor():
    """ "Grandfather's brother" is natural Malayalam; "great-uncle" has no single word."""
    grand_uncle = Descriptor(
        kind=PIBLING, up_subject=3, up_other=1, other_gender=MALE, linking_ancestor_gender=MALE
    )
    assert label_for(grand_uncle, "ml") == "മുത്തച്ഛന്റെ സഹോദരൻ"

    grand_aunt = Descriptor(
        kind=PIBLING, up_subject=3, up_other=1, other_gender=FEMALE, linking_ancestor_gender=FEMALE
    )
    assert label_for(grand_aunt, "ml") == "മുത്തശ്ശിയുടെ സഹോദരി"

    great_grand_uncle = Descriptor(
        kind=PIBLING, up_subject=4, up_other=1, other_gender=MALE, linking_ancestor_gender=MALE
    )
    assert label_for(great_grand_uncle, "ml") == "മുതുമുത്തച്ഛന്റെ സഹോദരൻ"


def test_unknown_language_falls_back_to_english():
    descriptor = Descriptor(kind=ANCESTOR, up_subject=1, other_gender=MALE)
    assert label_for(descriptor, "fr") == "father"


def test_labels_for_returns_both_languages():
    descriptor = Descriptor(kind=ANCESTOR, up_subject=2, other_gender=FEMALE)
    assert labels_for(descriptor) == {"en": "grandmother", "ml": "മുത്തശ്ശി"}
