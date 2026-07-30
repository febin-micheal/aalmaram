# Data entry log — template

Copy to `NOTES.md`, which is gitignored. **`NOTES.md` will contain real relatives' names
and is never committed.** This file is the committed template so the format survives.

## What this is for

Every time the quick-add form cannot express something true about a real person, write it
down here instead of forcing the data to fit. The point is not to fix it now — it is to
collect the friction, because this list is what Phase 2's card designs get built from.

A card that asks "was X older or younger than Y?" only exists because someone first wrote
down "I know the birth order but not the years."

## What to record

Write the thing you could not say, not the workaround you used.

- **Unknown parents** — "knew the mother, the father is only remembered as a house name"
- **Names that are not names** — someone known only by a pet name, a title, or "the
  Kanjirappally man"; a person with three spellings across two scripts
- **Approximate time** — "born some time in the 40s", "married before the flood",
  "she was about twelve when they moved"
- **Second marriages and half-siblings** — where the form made you guess an order, or
  where the children's parentage could not be attributed correctly
- **Relationships with no field** — adoption within the family, a child raised by an
  aunt, someone counted as a sibling who is not one by blood
- **Anything you typed into a notes field** because there was nowhere else to put it —
  that is the strongest signal of a missing field

## Format

One entry per friction. Keep it short; a sentence is enough.

```
### 2026-08-03 — entering the <house name> branch

- Could not record that <person>'s father is unknown but his house name is known.
  Put it in notes. → wants a "house name only" parent.
- Three children, I know the order but no years. sibling_order is admin-only, and the
  quick-add textarea has no way to say "these are in order but undated".
- <person> married twice; the form makes one union at a time, so I could not say which
  children belong to which marriage without opening the admin.
```

## When to review it

Before designing Phase 2's swipe cards. Each recurring entry is a card type; each one-off
is probably a field. Entries that never recur are worth leaving alone.
