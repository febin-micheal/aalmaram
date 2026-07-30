"""Turning what someone types about a year into the uncertainty trio.

People do not know exact dates. They know "1938", or "the thirties", or "around the war",
or nothing at all. The model stores a min/max range precisely so that vagueness can be
recorded as vagueness rather than rounded into a false precision — and this is the function
that reads it.

The one hard rule: **never invent precision**. "1930s" is a decade, not 1935. "?" is not
1900. If the input cannot be understood, it is rejected rather than guessed at, because a
wrong year that looks confident is worse than an empty field.

Designed to round-trip with `Person.birth_display` — whatever the chart shows, you can type
back in and get the same trio. `test_year_parsing.py` asserts that.
"""

import datetime
import re
from dataclasses import dataclass

#: How wide "circa" is taken to be, either side. Matches what birth_display renders as
#: "c. YYYY" (a span of 15 years or less), so the two stay round-trippable.
CIRCA_SPREAD = 5

_DECADE = re.compile(r"^(?P<decade>\d{3}0)\s*s$", re.IGNORECASE)
_CIRCA = re.compile(
    r"^(?:c\.?|ca\.?|circa|about|around|approx\.?)\s*(?P<year>\d{4})$", re.IGNORECASE
)
_RANGE = re.compile(r"^(?P<from>\d{4})\s*(?:-|–|—|to)\s*(?P<to>\d{4})$")
_BEFORE = re.compile(r"^(?:before|by|pre|<=?|≤)\s*(?P<year>\d{4})$", re.IGNORECASE)
_AFTER = re.compile(r"^(?:after|post|since|>=?|≥)\s*(?P<year>\d{4})$", re.IGNORECASE)
_YEAR = re.compile(r"^(?P<year>\d{4})$")

_UNKNOWN = {"", "?", "??", "unknown", "n/a", "na", "-", "—", "അറിയില്ല"}

#: Nothing before this is a plausible family record; nothing after it has happened.
MIN_YEAR = 1000
MAX_YEAR = datetime.date.today().year + 1


class YearParseError(ValueError):
    """The input could not be understood. Deliberately not a silent fallback."""


@dataclass(frozen=True)
class YearRange:
    """The uncertainty trio for one event."""

    year_min: int | None = None
    year_max: int | None = None
    date_exact: datetime.date | None = None

    @property
    def is_unknown(self) -> bool:
        return self.year_min is None and self.year_max is None and self.date_exact is None

    def as_fields(self, prefix: str) -> dict:
        """Model kwargs, e.g. as_fields("birth") -> birth_year_min/max/date_exact."""
        return {
            f"{prefix}_year_min": self.year_min,
            f"{prefix}_year_max": self.year_max,
            f"{prefix}_date_exact": self.date_exact,
        }


def parse_year_input(raw: str | None) -> YearRange:
    """Parse a typed year into a range. Raises YearParseError on anything unrecognised.

    Understood forms::

        ""  "?"  "unknown"     nothing is known
        "1938"                 that year exactly
        "1930s"               that decade, 1930–1939
        "1900s"               ambiguous by convention; read as the decade, not the century
        "c. 1940"  "circa 1940"  "around 1940"    1935–1945
        "1930-1945"  "1930 to 1945"               that span
        "before 1930"  "<1930"                    open-ended below
        "after 1930"   ">1930"                    open-ended above
        "1938-04-12"  "12/04/1938"                an exact date, when someone truly has one
    """
    if raw is None:
        return YearRange()
    text = str(raw).strip()
    if text.lower() in _UNKNOWN:
        return YearRange()

    if match := _YEAR.match(text):
        year = _checked(int(match["year"]))
        return YearRange(year_min=year, year_max=year)

    if match := _DECADE.match(text):
        start = _checked(int(match["decade"]))
        return YearRange(year_min=start, year_max=_checked(start + 9))

    if match := _CIRCA.match(text):
        year = _checked(int(match["year"]))
        return YearRange(year_min=_clamp(year - CIRCA_SPREAD), year_max=_clamp(year + CIRCA_SPREAD))

    if match := _RANGE.match(text):
        low, high = _checked(int(match["from"])), _checked(int(match["to"]))
        if low > high:
            raise YearParseError(f"{low} is after {high}")
        return YearRange(year_min=low, year_max=high)

    if match := _BEFORE.match(text):
        return YearRange(year_max=_checked(int(match["year"])))

    if match := _AFTER.match(text):
        return YearRange(year_min=_checked(int(match["year"])))

    if exact := _parse_date(text):
        return YearRange(year_min=exact.year, year_max=exact.year, date_exact=exact)

    raise YearParseError(
        f"Could not read {text!r} as a year. Try 1938, 1930s, c. 1940, before 1950, or ?"
    )


def _parse_date(text: str) -> datetime.date | None:
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%d.%m.%Y"):
        try:
            parsed = datetime.datetime.strptime(text, fmt).date()
        except ValueError:
            continue
        _checked(parsed.year)
        return parsed
    return None


def _checked(year: int) -> int:
    if not MIN_YEAR <= year <= MAX_YEAR:
        raise YearParseError(f"{year} is outside {MIN_YEAR}–{MAX_YEAR}")
    return year


def _clamp(year: int) -> int:
    return max(MIN_YEAR, min(MAX_YEAR, year))
