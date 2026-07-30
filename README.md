# Aalmaram (ആൽമരം)

An open-source collaborative family ancestry platform. Like a banyan tree, families
spread endlessly and interconnect — Aalmaram models kinship as a graph, lets relatives
contribute through a simple card/swipe interface (no tree navigation required), and
discovers common ancestors across branches.

Built with Django + PostgreSQL + React. Bilingual (Malayalam/English) by design.

Status: **Phase 1.6 complete** — data model, graph traversal library, admin tree view, a
visual graph explorer that lands on the whole archive, household entry from the graph, and
a backup/restore/reset workflow for real data. The swipe deck and magic-link invites are
Phase 2. See [CLAUDE.md](CLAUDE.md) for the full architecture spec and
[DECISIONS.md](DECISIONS.md) for the judgment calls made along the way.

License: AGPL-3.0

> **This repository is public.** No real names, real family data, or secrets belong in it.
> Every fixture and every seeded person is fictional.

---

## Running it

Requires Docker and Docker Compose.

```bash
cp .env.example .env      # development placeholders; edit UID/GID if `id -u` is not 1000
make up                   # postgres 16 + django + vite
make migrate
make superuser            # your admin login
make seed                 # ~340 fictional people across 6 generations
```

| What | Where |
| --- | --- |
| **Explorer** (the main interface) | http://localhost:5173/ |
| Admin (data entry, merges, claims) | http://localhost:8000/admin/ |
| Graph explorer | http://localhost:8000/admin/genealogy/explorer/ |
| "How are they related?" | http://localhost:8000/admin/genealogy/relate/ |
| Quick add a family unit | http://localhost:8000/admin/genealogy/quick-add/ |
| Merge queue | http://localhost:8000/admin/merging/mergecandidate/ |
| Contested claims | http://localhost:8000/admin/claims/claim/?arbitration=yes |
| API health check | http://localhost:8000/api/v1/health/ |

These URLs are pinned as literal strings by
[backend/apps/genealogy/tests/test_admin_urls.py](backend/apps/genealogy/tests/test_admin_urls.py)
and [test_api.py](backend/apps/genealogy/tests/test_api.py), so the table cannot drift out
of date without the test suite failing.

## Screenshots

> Slots are ready; the images are not taken yet. Drop the three PNGs into
> `docs/screenshots/` with these exact filenames and they appear here. Everything shown is
> **fictional seed data** — that is the only thing that may ever be screenshotted into a
> public repo.

### The whole archive

![The big-picture landing: every person in the database as a dot, families packed side by side, house-name labels over each cluster](docs/screenshots/overview.png)

### Semantic zoom into one family

![Zoomed in past the threshold: dots become person cards, with a remarriage drawn as two adjacent unions](docs/screenshots/card-zoom.png)

### How are we related?

![Relate mode: two people picked, the common ancestor and both descent paths highlighted through the graph](docs/screenshots/relate.png)

<details>
<summary>How to take them</summary>

The explorer keeps its state in memory rather than in the URL, so there is one address and
the other two shots are reached by clicking. Log into http://localhost:8000/admin/ first,
then open **http://localhost:5173/** and:

| File | Steps | Frame it on |
| --- | --- | --- |
| `overview.png` | Land on the page; press **⤢** to fit | The whole archive as dots with house-name cluster labels |
| `card-zoom.png` | Search **`Athira`**, click the result, then scroll to zoom in until cards appear | She has two unions and six children — the remarriage draws as two adjacent union nodes with the half-siblings under separate ones |
| `relate.png` | Click **Relate**, click **Joseph**, then **Mathai** | Fourth cousins / നാലാം കസിൻ via Smitha, both five-generation descent paths lit up |

The seeded database these refer to is dumped at
`backups/manual-fictional-seed-for-screenshots.dump` — restore it with
`make restore FILE=…` whenever you want to retake these, without disturbing real data.

</details>

## Using with real data

Everything up to now has run on `make seed` — a fictional family. When you start entering
real relatives, three things change.

**Where real data lives.** Only in your local Postgres volume and in `./backups/`. Nothing
in this repository contains, or may ever contain, a real name, record or dump.
`backups/` is gitignored; fixtures and `seed_demo` stay fictional and remain what the whole
test suite runs against. Check `git status` before any commit.

**Backups.** A `backup` container dumps the database on start and then daily into
`./backups/`, keeping the newest 14 `auto-*.dump` files. You do not have to remember it.

```bash
make backup                        # manual-<timestamp>.dump — never auto-pruned
make backups                       # list dumps, newest first
make restore FILE=backups/....dump # asks for YES; stops the backend while restoring
```

**Starting fresh.** `make reset-db` clears every person, union, claim, merge and media row.
It asks you to type `YES`, and **takes a dump before deleting anything**. It deliberately
does not touch your admin account, and it never deletes uploaded files from
`backend/media/` — a reset can drop a media row, but it will not destroy a photograph.

```bash
make reset-db     # type YES; a pre-reset dump is written automatically
```

### Rehearse the cycle with fictional data first

Run this end to end before you type a single real name, so the restore path is one you have
already used rather than one you are reading about during an emergency:

| # | Command / action | You should see |
|---|---|---|
| 1 | `make seed` | ~344 fictional people |
| 2 | Open http://localhost:5173/ | The whole archive as dots, house-name labels over the clusters |
| 3 | `make backup` | `wrote backups/manual-<timestamp>.dump (…)` |
| 4 | `make reset-db`, type `YES` | A safety dump path, then a table of deleted counts ending "Admin accounts and uploaded files kept" |
| 5 | Reload the explorer | The **"No family recorded yet"** screen with **Add the first household** |
| 6 | Click it, fill in two partners and a few children, save | The dialog closes and the graph opens on the household you just typed |
| 7 | Click **Whole archive** | Your new household is the entire overview |
| 8 | `make restore FILE=backups/manual-<step-3>.dump`, type `YES` | `restored from …` |
| 9 | Reload the explorer | The 344 fictional people are back; your test household is gone (it postdated the dump) |
| 10 | Log into `/admin/` | Still works — the reset never touched your account |

Verified on this machine at step 9: 1214 people restored from a dump taken before a reset,
with the admin login intact.

## Data entry log

When you hit something the quick-add form cannot express — a father known only by his
house name, a person everyone calls by a pet name, "born some time in the 40s", a second
marriage whose children you cannot attribute — **write it down instead of forcing the data
to fit**.

That list is what Phase 2's swipe cards get designed from. The card that asks "was X older
or younger than Y?" only exists because someone first wrote down "I know the birth order
but not the years."

```bash
cp NOTES.example.md NOTES.md   # already done if you followed the setup
```

`NOTES.md` is **gitignored** — it will name real relatives by its nature.
[NOTES.example.md](NOTES.example.md) is the committed template, so the format survives even
though the content never leaves your machine. Same pattern as `.env` / `.env.example`.

## The explorer

An interactive view of the family graph, for the project owner.
It reads through your **Django admin session**: log into http://localhost:8000/admin/ once
in the same browser, then open http://localhost:5173/. There is no second login, and no
token to manage. (The Vite dev server proxies `/api` to Django so the session cookie is
carried; see DECISIONS.md #17.)

### Click-script

From a fresh `make up` + `make seed`, with one admin login:

| # | Do this | You should see |
|---|---|---|
| 1 | Open http://localhost:5173/ | **The whole archive at once**, zoomed to fit: every person a dot, coloured by gender and faded if deceased, families packed side by side with house-name labels over each cluster. The toolbar reads e.g. "1214 people · 40 families · overview". |
| 2 | Scroll to zoom in | Past a threshold the dots **become full person cards** (semantic zoom); only what is on screen is drawn. Zoom back out and they collapse to dots again. |
| 3 | Type `Ittira` in the toolbar search | Matching dots **highlight in place** in the overview, so you can see where they fall in the whole tree. Clicking a result dives into their detailed neighbourhood: ancestors above, descendants below, spouses side by side with a small circle (the union) between and below them, children hanging off that circle — not off either parent. |
| 4 | Click any card | A side panel opens on the right: house, born, died, place, and clickable Parents / Siblings / Partners / Children lists. Half-siblings are badged `half`, adopted children `adopted`. |
| 5 | Find a card with a **`↑2`** or **`↓4`** chip and click the chip | That many more relatives load and merge into the chart in place. The viewport does not jump. Repeat once more to reach two extra generations. |
| 6 | Drag the background; scroll to zoom | The whole chart pans and zooms smoothly, zoom anchored on the cursor. **⤢** in the toolbar re-fits. |
| 7 | Click **മലയാളം** in the toolbar | Every interface label switches to Malayalam. Names switch to their Malayalam spelling **where one exists**; people entered only in English keep their English name rather than going blank. |
| 8 | Click **ബന്ധം കണ്ടെത്തുക** (Relate) | A bar appears: *"Relate mode: click the first person"*. |
| 9 | Click one person, then a distant one | Both get an **A** / **B** badge. The bar shows the relationship in both languages, the common ancestor, and both descent paths as clickable name chips. Everything on those paths is highlighted in the chart; everything else dims. If part of the path is not loaded, the bar says so and offers **“Centre on the common ancestor.”** |
| 10 | Click **Whole archive** | Back to the zoomed-out overview of everything. |
| 11 | Click **+ Household** | The quick-add dialog: two partners, house name, year, and a children textarea (`Thomas \| m \| 1938`, one per line, line order becomes birth order). Saving drops you onto the new household in the graph — no page reload. |
| 12 | Open a person's side panel, click **Edit** | The Django admin change page for that person, in a new tab. In-graph editing is a later phase. |

Two pairs from the current seeded database, if you want a known-good answer:

- **third cousins** (common ancestor Ittira, 4 generations each way) —
  `001dd83d-bf76-4c16-be23-f8aaf4181159` and `03938379-f53a-4c17-bc85-519da8ecefb3`
- **no relation at all** — `001dd83d-bf76-4c16-be23-f8aaf4181159` and
  `01299db1-8ae6-495a-8c7f-43137390ecd7`

(Ids are from the deterministic seed; `make seed` regenerates the same people.)

### API

Three read-only endpoints, staff-session only. Anonymous callers get 403, never data.

```
GET  /api/v1/overview/                     the whole archive, banded — one request
GET  /api/v1/persons/?search=<term>
GET  /api/v1/persons/<id>/neighborhood/?generations_up=2&generations_down=2
GET  /api/v1/relate/?a=<id>&b=<id>
POST /api/v1/quick-add/                    create a household; returns it for merging
GET  /api/v1/csrf/                         cookie for the POST above
```

Measured on a 1214-person, 40-family archive: the overview is **97 KB on the wire**
(457 KB uncompressed, gzipped by middleware) in ~110 ms, three database queries regardless
of size. Laying it out takes ~21 ms, and at card zoom the canvas draws 18 cards, not 1200.

`make help` lists the rest (`test`, `test-cov`, `lint`, `fmt`, `shell`, `dbshell`, `clean`).

## Tests

```bash
make test          # backend suite
make test-cov      # with coverage
make check-frontend # frontend build + headless layout checks
```

The graph library is tested against fixture families that deliberately include a
remarriage, half-siblings, an unknown parent, an adopted child, a disconnected second
family, and duplicate records — see
[backend/apps/genealogy/fixtures/families.py](backend/apps/genealogy/fixtures/families.py).

## Layout

```
backend/
  config/            settings (base/dev/test), urls, /api/v1/
  apps/accounts/     custom User, anchored to a Person
  apps/genealogy/    Person, Union, UnionMembership
    graph/           traversal, LCA, relationship naming, privacy — the core library
    admin/           explorer, relationship finder, quick-add
    fixtures/        fictional families used by tests and the seed command
  apps/claims/       fact provenance + the contested-claim queue
  apps/merging/      reversible merges + the merge queue
  apps/mediastore/   photos, voice notes, documents (tables only until Phase 3)
frontend/            React + Vite + Tailwind PWA shell (Malayalam default)
```

## The data model in one paragraph

The family is a **graph**, not a tree. No Person row ever points at another Person as a
parent. Instead a `Union` is a partnership node: partners attach to it with
`role=partner`, children with `role=child`, and parenthood is derived from that. This is
what makes the difficult cases representable rather than exceptional — remarriage is one
person in two unions, half-siblings are children of two unions sharing one partner, and
"we know her mother but nobody remembers her father" is simply a union with one partner.

## Using the graph library

```python
from apps.genealogy.graph import (
    ancestors, descendants, ego_network, siblings,
    describe_relationship, lowest_common_ancestors,
)

siblings(person)                        # each link classified full / half / step
ancestors(person, max_depth=6)          # Relative(person, depth), nearest first
lowest_common_ancestors(a, b)           # with both descent paths
describe_relationship(a, b).label_ml    # 'അമ്മാവൻ'

Person.objects.visible_to(request.user) # the privacy rule, at the queryset level
```
