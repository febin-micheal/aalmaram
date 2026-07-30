"""Year parsing, and its round trip with what the chart displays.

The round-trip property is the important one: whatever a person sees on a card, they must
be able to type back in and get the same stored range. Without it, opening a year chip and
pressing Enter without changing anything would silently alter the record.
"""

import datetime

import pytest

from apps.genealogy.models import Person
from apps.genealogy.year_parsing import YearParseError, YearRange, parse_year_input


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("1938", YearRange(1938, 1938)),
        ("  1938  ", YearRange(1938, 1938)),
        ("1930s", YearRange(1930, 1939)),
        ("1930S", YearRange(1930, 1939)),
        ("1900s", YearRange(1900, 1909)),
        ("c. 1940", YearRange(1935, 1945)),
        ("c.1940", YearRange(1935, 1945)),
        ("ca 1940", YearRange(1935, 1945)),
        ("circa 1940", YearRange(1935, 1945)),
        ("around 1940", YearRange(1935, 1945)),
        ("about 1940", YearRange(1935, 1945)),
        ("1930-1945", YearRange(1930, 1945)),
        ("1930 to 1945", YearRange(1930, 1945)),
        ("1930–1945", YearRange(1930, 1945)),
        ("before 1930", YearRange(None, 1930)),
        ("<1930", YearRange(None, 1930)),
        ("≤1930", YearRange(None, 1930)),
        ("after 1930", YearRange(1930, None)),
        (">1930", YearRange(1930, None)),
        ("≥1930", YearRange(1930, None)),
    ],
)
def test_understood_forms(raw, expected):
    assert parse_year_input(raw) == expected


@pytest.mark.parametrize("raw", ["", "  ", "?", "??", "unknown", "n/a", "-", "അറിയില്ല", None])
def test_unknown_stays_unknown(raw):
    """ "I don't know" must record as nothing, never as a guessed year."""
    parsed = parse_year_input(raw)
    assert parsed.is_unknown
    assert parsed == YearRange()


def test_exact_dates_are_kept_exact():
    assert parse_year_input("1938-04-12") == YearRange(1938, 1938, datetime.date(1938, 4, 12))
    assert parse_year_input("12/04/1938") == YearRange(1938, 1938, datetime.date(1938, 4, 12))


@pytest.mark.parametrize(
    "raw",
    [
        "sometime in the war",
        "19387",
        "38",
        "nineteen thirty eight",
        "1945-1930",  # backwards
        "0500",  # implausibly early
        "3000",  # in the future
        "1930ss",
    ],
)
def test_nonsense_is_rejected_not_guessed(raw):
    """A wrong year that looks confident is worse than an empty field."""
    with pytest.raises(YearParseError):
        parse_year_input(raw)


def test_the_error_says_what_to_type():
    with pytest.raises(YearParseError, match="1938, 1930s, c. 1940"):
        parse_year_input("no idea really")


# ------------------------------------------------------------------ round trip


@pytest.mark.parametrize(
    ("year_min", "year_max"),
    [(1938, 1938), (1930, 1939), (1935, 1945), (None, None), (1900, 1909), (2000, 2009)],
)
def test_display_round_trips_back_to_the_same_range(year_min, year_max):
    """Type back what the card shows and nothing changes."""
    person = Person(birth_year_min=year_min, birth_year_max=year_max)
    shown = person.birth_display

    reparsed = parse_year_input(shown)
    assert reparsed.year_min == year_min, f"{shown!r} did not round-trip"
    assert reparsed.year_max == year_max, f"{shown!r} did not round-trip"


def test_open_ended_displays_round_trip():
    after = Person(birth_year_min=1930, birth_year_max=None)
    assert parse_year_input(after.birth_display) == YearRange(1930, None)

    before = Person(birth_year_min=None, birth_year_max=1930)
    assert parse_year_input(before.birth_display) == YearRange(None, 1930)


def test_a_wide_range_round_trips_as_a_range():
    # Wider than "circa" territory, so the display keeps both ends.
    person = Person(birth_year_min=1900, birth_year_max=1940)
    assert person.birth_display == "1900–1940"
    assert parse_year_input(person.birth_display) == YearRange(1900, 1940)


# ----------------------------------------------------------------- model glue


def test_as_fields_maps_onto_the_model():
    assert parse_year_input("1930s").as_fields("birth") == {
        "birth_year_min": 1930,
        "birth_year_max": 1939,
        "birth_date_exact": None,
    }
    assert parse_year_input("?").as_fields("death") == {
        "death_year_min": None,
        "death_year_max": None,
        "death_date_exact": None,
    }


@pytest.mark.django_db
def test_a_parsed_range_satisfies_the_model_constraint():
    """min <= max is a database CHECK; the parser must never produce a violation."""
    for raw in ["1938", "1930s", "c. 1940", "1930-1945", "before 1930", "after 1930", "?"]:
        person = Person.objects.create(name_en="T", **parse_year_input(raw).as_fields("birth"))
        person.refresh_from_db()
        if person.birth_year_min and person.birth_year_max:
            assert person.birth_year_min <= person.birth_year_max


@pytest.mark.django_db
def test_quick_add_and_the_canvas_agree_on_years():
    """The same string must mean the same thing typed into either entry point."""
    from apps.genealogy.households import parse_child_line

    details = parse_child_line("Thomas | m | 1938")
    assert details["birth_year"] == 1938
    assert parse_year_input("1938").year_min == details["birth_year"]
