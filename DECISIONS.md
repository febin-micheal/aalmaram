# Architecture decisions

Every deviation from CLAUDE.md, and every judgment call it left open, is recorded here
with its reasoning. CLAUDE.md remains the source of truth; this file explains the places
where it needed interpreting.

---

## 1. The admin tree view is server-rendered Django; the Vite app is a placeholder

**Phase 1.** CLAUDE.md fixes the dev stack as postgres + django + vite, but also says
Phase 1 has "no public UI yet" and that the admin tree view is desktop-only, for one
person, function over beauty.

Building the admin in React would mean shipping API endpoints and an auth story in Phase 1
that Phase 2 is supposed to deliver. So the admin tools (graph explorer, relationship
finder, quick-add, merge queue, claim queue) are server-rendered Django templates — no
build step, no API surface, and they inherit admin authentication. They are registered on
a custom `AalmaramAdminSite` rather than on any one ModelAdmin; see #16 for why that
distinction turned out to matter.

`frontend/` still exists and the vite service is in docker-compose so the stack matches the
spec: it is a React + Vite + Tailwind PWA shell with the i18n layer wired and Malayalam as
the default locale. It renders one placeholder screen and calls `/api/v1/health/`. The swipe
deck replaces that screen in Phase 2.

> **Superseded in part by #17.** Phase 1.5 replaced that placeholder with the visual
> explorer. The Django admin tools described above remain the data-entry surface.

## 2. One degree of separation = one shared union membership

**Phase 1.** The privacy rule says living people are visible "within 3 degrees of the
viewer's anchor Person" without defining a degree.

A degree is a parent/child, sibling, or partner hop. In this schema all four of those are
the same thing: two people are one hop apart when they are members of the same Union in
any role. The radius is therefore a single recursive walk over shared union membership,
with no per-edge-type special-casing (`RELATIVES_WITHIN` in `graph/sql.py`).

At radius 3 that reaches siblings (1), parents (1), children (1), partners (1),
grandparents (2), uncles/aunts (2), nieces/nephews (2), first cousins (3) and
great-grandparents (3). Second cousins (5) are outside.

The consequence worth knowing: **half-siblings are two hops apart, not one**, because they
share no union — they meet at the shared parent. Everything on that branch is one degree
further away, so a half-first cousin (4) falls outside the radius while a full first cousin
(3) does not. This is asserted in `test_privacy.py::test_half_siblings_cost_two_hops` rather
than left to be discovered later. Setting is `PRIVACY_VISIBILITY_DEGREES`.

## 3. Merge/un-merge ships in Phase 1; the matching engine does not

**Phase 1 vs Phase 4.** CLAUDE.md puts the "merge engine" in Phase 4, but a Phase 1
acceptance check requires that merging two persons and un-merging restores exact prior
state, test-proven. The operation therefore has to exist now.

Phase 1 ships: `Person.status`/`merged_into`, `MergeCandidate`, `MergeRecord`, a
transactional `merge_persons()`/`unmerge()` pair, and admin actions.

Phase 4 still owns everything that *proposes* merges: relational-context scoring, the
transliteration variant table, and automatic candidate generation. `MergeCandidate.score`
and `.evidence` are populated by hand (or by the seed command) until then.

## 4. `/api/v1/` exposes only a health check in Phase 1

**Phase 1.** The conventions mandate a versioned, paginated API, but magic-link auth is
Phase 2 and the visibility rules need an authenticated anchor Person to mean anything.
Shipping data endpoints before that would mean either exposing living relatives'
information unauthenticated, or building a throwaway auth scheme.

So DRF is installed and configured — `IsAuthenticated` and pagination as project-wide
defaults, `/api/v1/` namespace in place — with exactly one endpoint: `health/`. Data
endpoints arrive in Phase 2 with the auth they require. `config/tests/test_api.py` asserts
that nothing else is reachable.

> **Superseded in part by #17.** Phase 1.5 adds three read-only endpoints for the
> explorer, gated to staff sessions. The member-facing API is still Phase 2.

## 5. A custom User model exists now, even though auth is Phase 2

**Phase 1.** Swapping `AUTH_USER_MODEL` after other tables reference it is destructive and
effectively requires a rebuild. `accounts.User` is therefore created in the first migration:
UUID primary key, email as the username field, and a nullable `anchor_person` FK.

`anchor_person` is not speculative — the privacy queryset keys off it today
(`Person.objects.visible_to(user)`). Login itself remains Phase 2.

## 6. `Person.source_invite` is deferred to Phase 2

**Deviation from the CLAUDE.md field list.** The Person spec includes `source_invite` for
provenance, but the Invite model does not exist until Phase 2. Adding an unconstrained UUID
column now would be a foreign key in everything but enforcement.

Provenance in Phase 1 is carried by `created_by` + `created_at`, which the admin sets on
every path including quick-add. Phase 2 adds `source_invite` as a real FK in its own
migration; no backfill is needed because no invite-created rows can exist before then.

## 7. Geocoding is two nullable decimal columns, not PostGIS

**Phase 1.** `place_origin` is specified as "free text + optional geocode". PostGIS would
add a heavyweight extension, a spatial index and a container image change to store what is
currently a pair of numbers nobody queries spatially.

`place_lat` / `place_lng` are nullable decimals. If proximity search is ever needed, moving
to PostGIS is one migration.

## 8. pg_trgm is enabled in Phase 1

**Phase 1.** Fuzzy name search is needed as soon as the admin holds 200+ people spelled
several ways across two scripts. Migration `genealogy.0002_trigram_search` enables the
extension and adds GIN trigram indexes on `name_en`, `name_ml` and `house_name`, plus a GIN
index on the `nicknames` JSONB. The Phase 4 duplicate matcher will reuse them.

## 9. Set-building walks deduplicate; only path reconstruction enumerates routes

**Phase 1.** A naive recursive CTE that carries a path array enumerates every distinct
route, which multiplies badly under pedigree collapse (cousin marriage — common in the
communities this serves).

So the walks are split. `ANCESTOR_DEPTHS` / `DESCENDANT_DEPTHS` / `RELATIVES_WITHIN` use
`UNION` rather than `UNION ALL`, bounding the working set at (persons × depth) regardless of
how many routes exist. `ANCESTOR_PATH` does carry a path array, but it is only ever run
against a target whose distance is already known and it stops on arrival.

Every walk is additionally capped by `GRAPH_MAX_DEPTH` (25), so a cycle created by bad data
terminates instead of spinning. `test_traversal.py::test_walk_survives_a_cycle_in_the_data`
pins that.

## 10. Relationship naming: English is complete, Malayalam is honest

**Phase 1.** English covers blood relations exhaustively — ancestors and descendants to any
depth, siblings, uncles/aunts and nephews/nieces at any remove, cousins of any degree and
removal, each with half-/step- qualifiers.

Malayalam cannot be produced by the same mechanical composition, because its kinship terms
encode facts English leaves out: which side of the family (അമ്മാവൻ is specifically a
*mother's* brother), and seniority (ചേട്ടൻ vs അനിയൻ, വലിയച്ഛൻ vs ചെറിയച്ഛൻ). The graph
often knows these — side comes from the gender of the parent the route runs through, birth
order from `sibling_order` or estimated years — and `Descriptor` carries them.

When the graph does *not* know, the label degrades to an explicit descriptive form rather
than guessing: an unknown-side uncle renders as "അമ്മയുടെ/അച്ഛന്റെ സഹോദരൻ", not a coin flip.
Relations with no everyday Malayalam word (second cousins, great-great-grandparents) use a
descriptive construction. Getting an elder's kinship term wrong is a real social error, so
the module admits ignorance instead of inventing a term.

## 11. Half-ness is read from the sibling link, not from counting common ancestors

**Phase 1.** The obvious implementation of "are these half-siblings?" is "did the LCA search
return one ancestor instead of two?". That is wrong here: a union with a single recorded
partner (unknown father) also yields one common ancestor, which would label ordinary full
siblings as half-siblings — and unknown parents are a first-class case in this data, not an
edge case.

So `describe_relationship()` identifies the two siblings at the linking generation and asks
`siblings()` to classify that pair. Sibling classification rules, in order:

1. children of the *same* union → **full** (co-children assert one parent pair, even when
   only one partner is known)
2. either membership marked `relation_type=step` → **step**
3. otherwise, parents in common: 2+ → **full**, exactly 1 → **half**
4. reachable only through a parent's other union with no shared parent → **step**

## 12. Adopted children are full members of the graph

**Phase 1.** `relation_type` distinguishes biological, adopted and step, but traversal does
not filter on it: an adopted child has ancestors, appears among their parents' children, and
is a full sibling of their siblings. The distinction is preserved and displayed, never used
to exclude someone from their family. Reversing this later would be a one-line filter; the
default matters more.

## 13. Merges never delete, and un-merge restores to the microsecond

**Phase 1.** `merge_persons()` snapshots the pre-merge state of both persons and every edge
it touches into `MergeRecord.snapshot`, then repoints edges and marks the absorbed person
`status=merged_into`. Nothing is deleted; `Person.objects.canonical()` is what hides merged
rows from the UI.

Two details worth recording:

- **Edge conflicts.** Duplicates are usually duplicated *because* both rows are children of
  the same union, and `(union, person, role)` is unique. Repointing would collide, so the
  absorbed membership is deleted instead — with its full contents in the snapshot, so
  un-merge recreates it byte for byte, primary key and `created_at` included.
- **Snapshot encoding.** The first implementation used Django's JSON serializer, which
  renders datetimes in ECMA-262 format and keeps only milliseconds. Restored timestamps
  differed from the originals in the microsecond digits, and the test could not see it
  because it compared through the same lossy encoder. The snapshot now encodes timestamps
  with `isoformat()` and decodes them through each field's `to_python()`, and the tests
  compare raw column values. "Exact prior state" means exact.

Merging a person with their own ancestor or descendant is refused outright — it would make
someone their own grandparent and put a cycle in the graph.

## 14. Fixture and seed data is fictional, and structurally awkward on purpose

**Phase 1.** This is a public repository, so no real person, family, house name or place
appears anywhere. Fixtures use ordinary given names combined with invented house names.

The fixture families and `seed_demo` both deliberately include remarriages, half-siblings,
unions with a single recorded partner, adopted children and duplicate records. A clean
synthetic tree would pass every test while proving nothing about the cases this system
exists to handle. `seed_demo` is seeded from a fixed RNG value, so the same command produces
the same people — which is why it samples from its own creation-ordered list rather than
querying by a random UUID primary key.

## 15. Containers run as the host user

**Phase 1, operational.** The backend and frontend services set
`user: "${UID:-1000}:${GID:-1000}"` so that files they write into the bind mounts — new
migrations, `package-lock.json` — are owned by the developer rather than by root. Anyone
whose `id -u` is not 1000 sets `UID`/`GID` in `.env` (see `.env.example`). The database
publishes host port 55432 rather than 5432/5433, which are usually already taken by a
locally installed Postgres.

## 16. Custom admin pages live on the admin site, not on PersonAdmin

**Phase 1 — incident and fix.**

**What happened.** The Phase 1 completion report stated that the custom admin views
(quick-add, graph explorer, relationship finder, merge queue, claim queue) were built and
"verified in the live admin". Every one of the URLs in the approved plan returned 404.

**What was actually true.** The view code existed and was wired — but through
`PersonAdmin.get_urls()`, which nests custom routes inside the Person model's URL block:

| Plan said | Was actually built at |
| --- | --- |
| `/admin/genealogy/quick-add/` | `/admin/genealogy/person/quick-add/` |
| `/admin/genealogy/explorer/?person=` | `/admin/genealogy/person/explorer/?person=` |
| `/admin/genealogy/relate/?a=&b=` | `/admin/genealogy/person/relate/?person_a=&person_b=` |

The verification did run, against a live server, and did return 200 — but at the paths that
had been built rather than the paths the plan promised. The two were never compared. The
README then documented the `person/` paths without anyone noting they contradicted an
approved plan. On a 404 debug page the real routes are easy to miss, buried among the
default model routes for `genealogy/person/`.

**Why the test suite did not catch it.** Every admin test went through `reverse()`. A route
name resolves to wherever the route happens to be, so the tests followed the views to the
wrong URL and passed. They asserted that the *views worked*, never that they were *reachable
at the addresses users were given*.

**The fix.** `AalmaramAdminSite` (config/admin.py) registers the three pages on the admin
site itself, so they appear in the URLconf at their own top-level paths. It is installed as
the default admin site via `config.apps.AalmaramAdminConfig` in INSTALLED_APPS, which means
`django.contrib.admin.site` *is* this site and every existing `@admin.register(...)` keeps
working unchanged. Each view is wrapped in `AdminSite.admin_view()` (staff-only, redirects
to the admin login) and additionally checks the model permission it needs: `view_person` to
read the graph, `add_person` + `add_union` to use quick-add.

**The guard.** `apps/genealogy/tests/test_admin_urls.py` hits every custom page and every
queue action through the test client as a logged-in admin, and it addresses them by
**hard-coded URL string**, not by `reverse()` — plus an assertion that `reverse()` still
resolves to that same literal, so the name and the published address cannot drift apart. It
also covers the anonymous, non-staff and insufficient-permission cases. The guard was
verified by unregistering the routes and confirming the suite goes red.

**The general lesson, recorded because it generalises past this bug.** "Verified" must name
what was verified. A report that says a feature works has to state the exact URL, command or
input that was exercised — otherwise a real check of the wrong thing reads identically to no
check at all. And a deviation from an approved plan, however small it looks while making it,
gets surfaced rather than silently absorbed into the implementation.

## 17. Phase 1.5: a visual explorer, inserted before Phase 2

**Amendment to the build phases in CLAUDE.md.** The phase list runs 1 → 2 (magic-link
invites + swipe deck). Phase 1.5 is inserted before it: a read-only, interactive family
graph explorer in the React frontend, for the project owner only. No swipe deck, no
invites, no contribution — those remain Phase 2 and 3.

The reason it earns its place ahead of Phase 2: Phase 1 produced 344 seeded people and a
traversal library, and the only way to look at any of it was a Django changelist. Before
inviting elderly relatives to answer questions about this graph, the person answering for
its correctness needs to be able to *see* it.

### API: real endpoints, staff-gated

Decision #4 said `/api/v1/` would carry nothing but a health check until magic-link auth
arrived. That still holds for the *member-facing* API. Phase 1.5 adds three read-only
endpoints gated behind `IsStaff` + DRF `SessionAuthentication`:

    GET /api/v1/persons/?search=            trigram + substring search, paginated
    GET /api/v1/persons/{id}/neighborhood/  the subgraph to draw
    GET /api/v1/relate/?a=&b=               LCA, labels, both descent paths

They serve the entire graph with no visibility filtering, which is exactly why they are
staff-only: the living/deceased radius from decision #2 needs an authenticated member
with an anchor Person to mean anything, and that is Phase 2. `config/tests/test_api.py`
now asserts anonymous callers get 403 rather than 404, and that the member-facing paths
(`/cards/`, `/claims/`, `/invites/`) still do not exist.

**Serializers are hand-written, never `fields = "__all__"`.** `notes`, `created_by`,
timestamps and the claim trail are contributor-private. The tests assert an exact key set
per payload, so adding a model field can never silently start publishing it.

**Session, not tokens.** The Vite dev server proxies `/api`, `/admin` and `/static` to
Django with `changeOrigin: false`. The session cookie is scoped to `localhost` and cookies
ignore ports, so logging into `/admin` in the same browser authenticates the explorer with
no second login and no token plumbing to throw away in Phase 2.

### What a "neighbourhood" contains

Ancestors and descendants alone draw a pedigree, not a family. So a neighbourhood is
ancestors(up) + centre + descendants(down), **plus the children of every ancestor** (which
is what yields siblings, aunts and uncles) **plus the partners of everyone included** (so
each union can be drawn whole). Cousins are deliberately excluded — they are one expand
click away from an aunt or uncle, and including them by default roughly doubles the first
screen for people the viewer usually is not looking for.

Every person carries `hidden_up` / `hidden_down`: how many parents and children exist but
were not sent. That is what the `↑2` / `↓4` chips on a node are drawn from, and it is what
makes "never load the whole DB into one render" visible rather than merely true.

### Rendering: custom SVG, not a graph library

**Considered and rejected:**

- **react-flow / @xyflow** — excellent viewport and interaction, but it has no genealogy
  layout, so the generational placement would still have to be written by hand. It would
  have contributed pan/zoom and ~50 kB, for a node model that fights this one.
- **family-chart** and similar genealogy libraries — they carry their own data model,
  built around a person having *a* father and *a* mother. This schema deliberately does
  not work that way (CLAUDE.md: kinship flows through Union), and remarriage and
  half-siblings are the cases that model gets wrong. Adapting the data to fit the library
  would mean flattening exactly the structure the project exists to preserve.
- **d3-hierarchy** — assumes a tree. This is a graph: pedigree collapse from cousin
  marriage means a node can be reached by two paths.

**Chosen: a hand-written generational layout rendered as SVG,** with pan/zoom implemented
over a single transform group (~80 lines, `usePanZoom.js`). Zero rendering dependencies.
The layout is in `src/graph/layout.js` and works like a tidy-tree relaxation:

1. seed an order by walking out from the centre, so relatives start near each other;
2. place each generation row left to right in that order;
3. relax for a few passes — pull children under their union, pull partners over their
   children, and after each pull push apart anything that now overlaps, preserving row
   order;
4. Union is a **node**, not an edge: partners connect down into it, children hang from it
   via a sibling bus. This is what makes a remarriage draw as one person between two
   adjacent union nodes, and what puts half-siblings under the union they belong to
   instead of merging them into one sibling row.

It is not an optimal layout and does not try to be. It is deterministic, and it lays out
481 nodes in ~10 ms — measured, in `scripts/check-layout.mjs`.

### Guards

- `npm run build` must pass in the container.
- `npm run check` runs headless assertions on the layout: no overlapping cards, ancestors
  above descendants, remarriage producing two union nodes, half-siblings under different
  unions, unions between their partners and their children, determinism, and the 300+ node
  performance budget. `npm run build` proves the app compiles and nothing about whether
  the chart is *correct*; this covers the part most likely to break silently.
- API tests address every endpoint by literal URL string, per #16.
- No Playwright this phase, by agreement — the click-script in the README is the manual
  acceptance path instead.

### Deviations worth noting

- **`phase` in the health payload is now `1.5`**, so `/api/v1/health/` identifies which
  build is running.
- **Compact year display** (`birth_display`, `death_display`) was added alongside the
  existing admin `birth_year_display`, rather than replacing it. A chart node has room for
  "1930s"; the admin's fuller "1888–1892" is still the right thing on a detail page.
- **Landing suggestions** come from a new `/persons/suggested/` action ordered by number of
  union memberships. "Search for someone" is useless advice when you do not yet know a
  single name in the tree, so the first screen offers the most-connected people.

## 18. Phase 1.6: real-data mode

**Amendment to the build phases.** Phase 1.6 sits between 1.5 and 2. It does not add
member-facing features; it makes the system safe and usable for the owner's *actual*
family records, which until now had nowhere to live but a demo seed.

**The repo stays public.** `backups/` is gitignored (the directory itself is tracked via a
`.gitkeep`, so Docker cannot create it root-owned on first `make up`). Fixtures and
`seed_demo` remain entirely fictional and are still what every test runs against.

### Safety

`reset_graph` deletes graph rows only: persons, unions, memberships, claims, merges, media
rows. It refuses without `--confirm`, and `make reset-db` requires typing `YES` **and takes
a dump before calling it**, so an accidental reset is always recoverable.

Two things it deliberately does not do:

- **It never touches `accounts.User`.** Wiping the family must not lock the owner out of
  their own admin. `User.anchor_person` is `SET_NULL`, so anchors clear themselves.
- **It never deletes files from `MEDIA_ROOT`.** A reset can drop a media row; it must not
  be able to destroy a photograph or a voice recording somebody uploaded. Orphaned files
  are cleaned by hand.

A bug worth recording, caught by its own test: deleting persons fires `SET_NULL` on
`merged_into`, which leaves a row with `status=merged_into` and a null target — violating
the CHECK constraint from #13. The command now normalises merged persons back to canonical
before deleting anything.

Backups are a compose sidecar (`ops/auto-backup.sh`) rather than a host cron entry, so the
safety net needs no setup beyond `make up`: it dumps on start and then daily, keeping the
newest 14 `auto-*` files. `make backup` writes `manual-*` dumps, which are never pruned.
`make restore FILE=` stops the backend first so Django holds no locks.

### The overview

`GET /api/v1/overview/` returns the whole archive in **one request** — three queries and
then pure Python, with a `django_assert_num_queries` test pinning it, because an N+1 here
would be invisible on a 30-person demo and fatal on a real archive.

Every person needs a row, and an overview has no centre person to measure from. Rows are
**structural depth per connected family, offset by era**:

1. Within a family, depth is the *longest* ancestor chain, so a parent is always above
   their child even when one branch is recorded more deeply than another. Partners are
   levelled to the same row.
2. Each family is then shifted so its estimated depth-0 birth year lines up with a shared
   timeline (~28 years per generation). Without this, a fragment first recorded in the
   1980s would draw level with someone's 1890s great-grandparents. Families with no dates
   anywhere get offset 0.

Depth uses relaxation with a pass cap rather than a topological sort: bad data can contain
a cycle, and a capped relaxation degrades into a slightly wrong drawing instead of hanging.

**Payload contents.** The overview carries what a *card* needs, not just what a dot needs,
so semantic zoom does not trigger a second fetch on every zoom-in. Measured at 1214 people
across 40 families: 457 KB of JSON, **97 KB on the wire**, ~110 ms. `GZipMiddleware` was
added for this — the response is highly repetitive JSON and carries no CSRF token, so the
BREACH caveat in Django's docs does not apply.

### Semantic zoom and packing

`layoutOverview` lays out each connected family with the ordinary generational layout and
then packs the families left to right with a gutter, largest first. Two unrelated branches
never interleave, and the gaps between packed families are themselves informative — they
are the joins still waiting to be found.

Detail follows zoom rather than a mode toggle: below `CARD_ZOOM_THRESHOLD` (0.45, chosen
where a 14px name stops being legible) a person is a dot with house-name cluster labels;
above it, the full cards appear **culled to the viewport**. Culling is what makes this
work at scale: measured on a synthetic 1200-person archive, layout takes ~21 ms and card
zoom draws **18 of 1200** cards.

### Data entry from the graph

Quick-add is a **React form posting to `POST /api/v1/quick-add/`**, not an iframe and not
a restyled Django view. The deciding reason is the "appears without a reload" requirement:
an API endpoint can return the created subgraph in the same shape as `/neighborhood/`, so
the canvas merges it directly. An embedded Django view could only redirect.

`create_family_unit()` and `parse_child_line()` moved out of the admin view into
`apps/genealogy/households.py`. Both entry points now call one implementation, so the
children-text syntax cannot drift between them.

`GET /api/v1/csrf/` exists because DRF's `SessionAuthentication` enforces CSRF on unsafe
methods and a client that has only ever done GETs may hold no cookie. Asking for one is
cleaner than scraping a token out of an admin page.

Editing a person's own fields still links out to the Django admin change page. In-graph
editing is a later phase, and an honest handoff beats a half-built form.
