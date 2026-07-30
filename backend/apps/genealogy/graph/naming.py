"""Turning a structural relationship into a human label, in English and Malayalam.

The graph produces a *structure* — how many generations up from each person to their
common ancestor, which side the route runs through, whether the link is whole or half.
This module is the only place that turns that structure into words.

Coverage (see DECISIONS.md #10):

* English is complete for blood relations: ancestors and descendants to any depth,
  siblings, uncles/aunts and nephews/nieces at any remove, and cousins of any degree
  and removal, each with half-/step- qualifiers.
* Malayalam covers the terms an elderly Malayali speaker would actually use — അച്ഛൻ,
  അമ്മ, ചേട്ടൻ/അനിയൻ, ചേച്ചി/അനിയത്തി, മുത്തച്ഛൻ/മുത്തശ്ശി, അമ്മാവൻ, വലിയച്ഛൻ/ചെറിയച്ഛൻ,
  അമ്മായി, അനന്തരവൻ/അനന്തരവൾ — including the side-of-family and elder/younger
  distinctions those terms encode, whenever the graph knows enough to pick correctly.
  Where it does not, the label degrades to an explicit descriptive form rather than
  guessing: an unknown-side uncle is "അമ്മയുടെ/അച്ഛന്റെ സഹോദരൻ", not a coin flip between
  അമ്മാവൻ and ചിറ്റപ്പൻ. Far-out relations (beyond great-grand, cousins) use a
  descriptive construction; Malayalam has no everyday word for "second cousin".
"""

from dataclasses import dataclass

MALE = "male"
FEMALE = "female"

#: Structural categories produced by describe_relationship().
SELF = "self"
ANCESTOR = "ancestor"
DESCENDANT = "descendant"
SIBLING = "sibling"
PIBLING = "pibling"  # parent's sibling — uncle / aunt
NIBLING = "nibling"  # sibling's child — nephew / niece
COUSIN = "cousin"
PARTNER = "partner"
UNRELATED = "unrelated"


@dataclass(frozen=True)
class Descriptor:
    """A relationship reduced to the facts a label depends on.

    Reads as "`other` is `subject`'s ___".
    """

    kind: str
    #: Generations from the subject up to the common ancestor.
    up_subject: int = 0
    #: Generations from the other person up to the common ancestor.
    up_other: int = 0
    other_gender: str = "unknown"
    #: True when only one parent is shared at the linking generation.
    half: bool = False
    step: bool = False
    #: "paternal" / "maternal" / None — which of the subject's parents the route runs
    #: through. Malayalam needs this; English mostly does not.
    side: str | None = None
    #: True when the other person is older than the reference person (the subject for
    #: siblings; the linking parent for uncles/aunts). None when birth order is unknown.
    other_is_elder: bool | None = None
    #: Gender of the subject's ancestor that the other person is a sibling of.
    linking_ancestor_gender: str = "unknown"
    union_type: str | None = None


_EN_ORDINALS = {
    1: "first",
    2: "second",
    3: "third",
    4: "fourth",
    5: "fifth",
    6: "sixth",
    7: "seventh",
    8: "eighth",
    9: "ninth",
    10: "tenth",
}
_ML_ORDINALS = {1: "ഒന്നാം", 2: "രണ്ടാം", 3: "മൂന്നാം", 4: "നാലാം", 5: "അഞ്ചാം"}
_EN_REMOVED = {1: "once removed", 2: "twice removed", 3: "thrice removed"}

#: Malayalam ancestor terms by generation and gender, with the genitive form used to
#: build "X's brother" style descriptions.
_ML_ANCESTORS = {
    1: {MALE: ("അച്ഛൻ", "അച്ഛന്റെ"), FEMALE: ("അമ്മ", "അമ്മയുടെ"), "unknown": ("മാതാപിതാവ്", "മാതാപിതാവിന്റെ")},
    2: {
        MALE: ("മുത്തച്ഛൻ", "മുത്തച്ഛന്റെ"),
        FEMALE: ("മുത്തശ്ശി", "മുത്തശ്ശിയുടെ"),
        "unknown": ("മുത്തച്ഛൻ/മുത്തശ്ശി", "മുത്തച്ഛന്റെ/മുത്തശ്ശിയുടെ"),
    },
    3: {
        MALE: ("മുതുമുത്തച്ഛൻ", "മുതുമുത്തച്ഛന്റെ"),
        FEMALE: ("മുതുമുത്തശ്ശി", "മുതുമുത്തശ്ശിയുടെ"),
        "unknown": ("മുതുമുത്തച്ഛൻ/മുതുമുത്തശ്ശി", "മുതുമുത്തച്ഛന്റെ/മുതുമുത്തശ്ശിയുടെ"),
    },
}


def label_for(descriptor: Descriptor, language: str = "en") -> str:
    """Render `descriptor` as a phrase: "other is subject's <label>"."""
    if language == "ml":
        return _label_ml(descriptor)
    return _label_en(descriptor)


def labels_for(descriptor: Descriptor) -> dict[str, str]:
    return {"en": _label_en(descriptor), "ml": _label_ml(descriptor)}


# --------------------------------------------------------------------------- English


def _en_gendered(male: str, female: str, neutral: str, gender: str) -> str:
    if gender == MALE:
        return male
    if gender == FEMALE:
        return female
    return neutral


def _en_greats(count: int) -> str:
    """`count` = how many "great"s to stack in front of grand-."""
    return "great-" * count


def _en_qualifier(descriptor: Descriptor) -> str:
    if descriptor.step:
        return "step-"
    if descriptor.half:
        return "half-"
    return ""


def _label_en(d: Descriptor) -> str:
    if d.kind == SELF:
        return "the same person"

    if d.kind == PARTNER:
        if d.union_type == "marriage":
            return _en_gendered("husband", "wife", "spouse", d.other_gender)
        return "partner"

    if d.kind == ANCESTOR:
        n = d.up_subject
        if n == 1:
            return _en_qualifier(d) + _en_gendered("father", "mother", "parent", d.other_gender)
        base = _en_gendered("grandfather", "grandmother", "grandparent", d.other_gender)
        return _en_qualifier(d) + _en_greats(n - 2) + base

    if d.kind == DESCENDANT:
        n = d.up_other
        if n == 1:
            return _en_qualifier(d) + _en_gendered("son", "daughter", "child", d.other_gender)
        base = _en_gendered("grandson", "granddaughter", "grandchild", d.other_gender)
        return _en_qualifier(d) + _en_greats(n - 2) + base

    if d.kind == SIBLING:
        return _en_qualifier(d) + _en_gendered("brother", "sister", "sibling", d.other_gender)

    if d.kind == PIBLING:
        level = d.up_subject - 1  # 1 = uncle/aunt, 2 = great-uncle, ...
        base = _en_gendered("uncle", "aunt", "uncle/aunt", d.other_gender)
        return _en_qualifier(d) + _en_greats(level - 1) + base

    if d.kind == NIBLING:
        level = d.up_other - 1  # 1 = nephew/niece, 2 = great-nephew, ...
        base = _en_gendered("nephew", "niece", "nephew/niece", d.other_gender)
        return _en_qualifier(d) + _en_greats(level - 1) + base

    if d.kind == COUSIN:
        degree = min(d.up_subject, d.up_other) - 1
        removed = abs(d.up_subject - d.up_other)
        ordinal = _EN_ORDINALS.get(degree, f"{degree}th")
        label = f"{_en_qualifier(d)}{ordinal} cousin"
        if removed:
            label += " " + _EN_REMOVED.get(removed, f"{removed} times removed")
        return label

    return "no known relationship"


# ------------------------------------------------------------------------- Malayalam


def _ml_gendered(male: str, female: str, neutral: str, gender: str) -> str:
    if gender == MALE:
        return male
    if gender == FEMALE:
        return female
    return neutral


def _ml_ancestor_term(generation: int, gender: str) -> tuple[str, str]:
    table = _ML_ANCESTORS.get(generation)
    if table:
        return table.get(gender, table["unknown"])
    noun = _ml_gendered("പൂർവികൻ", "പൂർവിക", "പൂർവികൻ/പൂർവിക", gender)
    return (f"{generation} തലമുറ മുകളിലുള്ള {noun}", f"{generation} തലമുറ മുകളിലുള്ള {noun}യുടെ")


def _label_ml(d: Descriptor) -> str:
    if d.kind == SELF:
        return "ഇതേ വ്യക്തി"

    if d.kind == PARTNER:
        if d.union_type == "marriage":
            return _ml_gendered("ഭർത്താവ്", "ഭാര്യ", "ജീവിതപങ്കാളി", d.other_gender)
        return "പങ്കാളി"

    if d.kind == ANCESTOR:
        term, _ = _ml_ancestor_term(d.up_subject, d.other_gender)
        if d.step and d.up_subject == 1:
            return _ml_gendered("രണ്ടാനച്ഛൻ", "രണ്ടാനമ്മ", "രണ്ടാൻ മാതാപിതാവ്", d.other_gender)
        return term

    if d.kind == DESCENDANT:
        n = d.up_other
        if n == 1:
            if d.step:
                return _ml_gendered("രണ്ടാൻ മകൻ", "രണ്ടാൻ മകൾ", "രണ്ടാൻ കുട്ടി", d.other_gender)
            return _ml_gendered("മകൻ", "മകൾ", "കുട്ടി", d.other_gender)
        if n == 2:
            return _ml_gendered("കൊച്ചുമകൻ", "കൊച്ചുമകൾ", "കൊച്ചുമകൻ/കൊച്ചുമകൾ", d.other_gender)
        noun = _ml_gendered("സന്തതി", "സന്തതി", "സന്തതി", d.other_gender)
        return f"{n} തലമുറ താഴെയുള്ള {noun}"

    if d.kind == SIBLING:
        return _ml_sibling(d)

    if d.kind == PIBLING:
        level = d.up_subject - 1
        if level == 1:
            return _ml_pibling(d)
        term, genitive = _ml_ancestor_term(d.up_subject - 1, d.linking_ancestor_gender)
        sibling_word = _ml_gendered("സഹോദരൻ", "സഹോദരി", "സഹോദരൻ/സഹോദരി", d.other_gender)
        return f"{genitive} {sibling_word}"

    if d.kind == NIBLING:
        level = d.up_other - 1
        if level == 1:
            base = _ml_gendered("അനന്തരവൻ", "അനന്തരവൾ", "അനന്തരവൻ/അനന്തരവൾ", d.other_gender)
            return f"രണ്ടാൻ {base}" if d.step else base
        base = _ml_gendered("അനന്തരവൻ", "അനന്തരവൾ", "അനന്തരവൻ/അനന്തരവൾ", d.other_gender)
        return f"{level} തലമുറ താഴെയുള്ള {base}"

    if d.kind == COUSIN:
        degree = min(d.up_subject, d.up_other) - 1
        removed = abs(d.up_subject - d.up_other)
        label = "കസിൻ" if degree == 1 else f"{_ML_ORDINALS.get(degree, str(degree))} കസിൻ"
        if d.half:
            label = f"അർദ്ധ{label}"
        if removed:
            label += f" ({removed} തലമുറ അകലെ)"
        return label

    return "ബന്ധം കണ്ടെത്താനായില്ല"


def _ml_sibling(d: Descriptor) -> str:
    """ചേട്ടൻ vs അനിയൻ needs birth order; without it Malayalam has a neutral term."""
    if d.step:
        return _ml_gendered("രണ്ടാൻ സഹോദരൻ", "രണ്ടാൻ സഹോദരി", "രണ്ടാൻ സഹോദരൻ/സഹോദരി", d.other_gender)
    if d.half:
        return _ml_gendered("അർദ്ധസഹോദരൻ", "അർദ്ധസഹോദരി", "അർദ്ധസഹോദരൻ/സഹോദരി", d.other_gender)
    if d.other_is_elder is True:
        return _ml_gendered("ചേട്ടൻ", "ചേച്ചി", "ചേട്ടൻ/ചേച്ചി", d.other_gender)
    if d.other_is_elder is False:
        return _ml_gendered("അനിയൻ", "അനിയത്തി", "അനിയൻ/അനിയത്തി", d.other_gender)
    return _ml_gendered("സഹോദരൻ", "സഹോദരി", "സഹോദരൻ/സഹോദരി", d.other_gender)


def _ml_pibling(d: Descriptor) -> str:
    """Uncles and aunts: Malayalam encodes side of family, and on one side, seniority."""
    if d.other_gender == MALE:
        if d.side == "maternal":
            return "അമ്മാവൻ"
        if d.side == "paternal":
            if d.other_is_elder is True:
                return "വലിയച്ഛൻ"
            if d.other_is_elder is False:
                return "ചെറിയച്ഛൻ"
            return "അച്ഛന്റെ സഹോദരൻ"
        return "അമ്മയുടെ/അച്ഛന്റെ സഹോദരൻ"
    if d.other_gender == FEMALE:
        if d.side == "paternal":
            return "അമ്മായി"
        if d.side == "maternal":
            if d.other_is_elder is True:
                return "വലിയമ്മ"
            if d.other_is_elder is False:
                return "ചെറിയമ്മ"
            return "അമ്മയുടെ സഹോദരി"
        return "അമ്മയുടെ/അച്ഛന്റെ സഹോദരി"
    return "അമ്മയുടെ/അച്ഛന്റെ സഹോദരൻ/സഹോദരി"
