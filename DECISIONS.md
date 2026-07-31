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

## 19. The data-entry friction log is gitignored, its template is not

**Phase 1.6, housekeeping.** The owner needs somewhere to record every time the quick-add
form cannot express something true about a real relative — an unknown father known only by
a house name, a person with no formal name, "some time in the 40s", a remarriage whose
children cannot be attributed. That list is the input to Phase 2's card design.

By its nature it will contain real names and real family circumstances, so it cannot be a
README section and it cannot be committed. It is `NOTES.md`, gitignored, with
`NOTES.example.md` committed as the template — the same split this repo already uses for
`.env` / `.env.example`, so the format is version-controlled while the content never leaves
the machine.

Screenshots take the opposite rule: `docs/screenshots/` is deliberately **not** ignored,
because the only thing that may ever be screenshotted is fictional seed data. The dump
`backups/manual-fictional-seed-for-screenshots.dump` preserves the seeded archive those
images refer to, so they can be retaken after the database holds real data.

## 20. Phase 1.7: production deployment

**New phase.** The archive moves from a laptop to a small ARM VM at
`https://family.bulkbeing.in`, serving the owner's real family data over the public
internet. Nothing about the application changes; what changes is that "staff-only" now has
to mean something against strangers rather than against localhost.

### Shape of the deployment

Caddy is the only process with a published port. Gunicorn and Postgres are reachable only
on the private compose network, and **Postgres publishes no host port at all** — it cannot
be scanned or brute-forced from the internet regardless of its password. `ops/verify-prod.sh`
asserts that from outside, because "we didn't publish the port" is a claim worth testing.

### Settings that refuse to start

`config/settings/prod.py` has no usable defaults. A missing `DJANGO_SECRET_KEY`,
`DJANGO_ALLOWED_HOSTS` or `DJANGO_CSRF_TRUSTED_ORIGINS` raises `ImproperlyConfigured` at
import. A process that boots with a dev secret key is worse than one that does not boot:
the failure is silent and the consequence is total. All three were verified to fail loudly
before deployment.

TLS is terminated by Caddy, so `SECURE_PROXY_SSL_HEADER` is set. That header is only
trustworthy because nothing but Caddy can reach gunicorn — which is the same fact the
"no published port" decision rests on.

**HSTS is enabled without preload.** `includeSubDomains` covers this host; preload is
submitted for the apex domain and is effectively irreversible for every other
`bulkbeing.in` host, which is not this project's decision to make.

**django-axes** locks out after 5 failures per IP+username. The admin login is the only
door and it faces the open internet. Axes is enabled in production only, and pinned off in
test settings so it can never start silently locking out the test client mid-suite.

### A bug found by smoke-testing the image

The first build served a 500 on every admin page: WhiteNoise's manifest storage raises on
any unhashed static reference, and `collectstatic` had not run. The original design ran it
at deploy time into a named volume — which is fragile twice over, because the volume
shadows whatever the image contains and a failed deploy step leaves a broken site.

Static files are **build artifacts, not runtime state**. `collectstatic` now runs in
`Dockerfile.prod` and the `staticfiles` volume is gone: an image that builds is an image
that can serve. Found only by booting the production image locally and requesting
`/admin/login/` — `docker build` succeeding proved nothing about it.

### Backups: age + rclone to Backblaze B2

**B2 over R2**, because its credential model is a bucket plus an application key with
nothing else attached, and rclone has a native `b2` backend. R2 would work identically —
rclone abstracts the difference — and swapping means editing one config file. B2 also keeps
backups independent of whoever runs DNS for the domain.

**Encryption is a keypair, not a passphrase, and that is a deliberate deviation from the
brief.** `age` reads a passphrase from the terminal, not from an environment variable or
stdin, so passphrase mode cannot run unattended — a nightly job would simply hang. Instead
the VM holds only the age *public* key: it writes backups it cannot itself read, so
whoever steals the machine gets ciphertext. The private identity lives in the owner's
password manager, with a root-only copy at `/opt/aalmaram/secrets/` on the VM so restores
can run there. That copy is a convenience and weakens the property above; the offline copy
is the authority.

The backup script refuses to upload anything that does not begin with the age magic bytes.
An unencrypted dump reaching object storage is the one failure this pipeline must not have.

### Verified before touching a VM

The whole production stack was booted locally: images build, settings fail loudly without
secrets, `check --deploy` is clean apart from the deliberate preload opt-out, gunicorn
serves, `ALLOWED_HOSTS` rejects an unknown Host, the API returns 403 to anonymous callers,
the admin renders. The backup chain was run end to end against a local rclone remote —
dump, encrypt, upload, download, decrypt, restore into a scratch database, compare counts:
**344 = 344**, with no plaintext names anywhere in the ciphertext.

### Mobile

`fitTransform` was extracted from the pan/zoom hook so "does it fit" can be checked
headlessly at 390×844. Two real bugs came out of that: padding could exceed a phone's
width and collapse the fit, and the fit floor was clamped to the *interactive* minimum
zoom, silently leaving part of a large archive off-screen. Fit now has its own lower floor,
and dot radius is compensated for zoom so a far-out fit still shows visible dots rather
than a blank canvas.

A third came from the same tests: a few hundred people entered but not yet connected to
anyone would each become their own component and stretch the canvas by ~400px apiece.
Unattached people are now gathered into a roughly square block whose width grows as √n.
Families keep the shared timeline; someone with no relatives has no generation to be part
of, so little is lost.

## 21. Phase 1.75: the canvas becomes the editor

**New phase.** Adding people moves onto the graph itself. Hovering or tapping a card
reveals three affordances — **+ partner** to the right, **+ child** below, **+ parents**
above — and clicking one opens a name box where the new person will be. The quick-add form
stays as the bulk-entry fallback; this is an editor layer over the existing SVG canvas and
layout engine, not a rewrite.

The position of each affordance *is* its label. Partner to the right, child below, parents
above: you learn the union model by using it rather than by reading about it.

### Never guess which union

The decision this phase turns on. "+ child" on someone with **one** union attaches to it;
with **none** it creates a single-partner union, because "we know the mother, nobody
remembers the father" is a normal record rather than an error. With **two or more** it has
no answer, and both layers refuse to invent one:

* the **server** raises `AmbiguousUnion` and returns 409 with the candidate union ids —
  nothing is created, not even the person;
* the **client** moves into a `choosing-union` state, highlights those union dots, and
  **sends no further request until one is tapped**.

Enforcing it server-side matters more than the UI prompt: a child silently attached to the
wrong marriage is invisible afterwards. There is no downstream check that would ever
surface it.

### Undo is one step and narrow

Ctrl/Cmd+Z, and an Undo button on the toast after each commit. Implemented as the inverse
API call (`DELETE /api/v1/persons/{id}`), not as a client-side history stack, so what is
undone is what the database actually did.

**Scope, deliberately small:** the last creation only. The server refuses with 409
`not_provisional` once that person has acquired anything of their own — a child, a second
union, a claim, a photo, a member anchored to them. Undo takes back the node you typed a
second ago; it is not a delete button, and it must never become one by accident. A union
created solely to hold the undone person goes with them, unless it still has two partners
or a child, in which case it is a real record and stays.

### Optimistic, but honest

A typed name appears instantly so the canvas can keep up with someone reciting a family out
loud. If the server refuses, the node is removed and the reason is shown in a toast. The
graph never silently keeps something the database rejected — including inline field edits,
which roll back to the previous values on failure.

**The viewport does not move.** Adding a node re-runs the layout, which can shift the whole
row sideways. The screen position of the anchor is recorded before the change and the view
is panned by the difference afterwards, so the person you are working on stays under your
cursor. Without that, every addition would yank the canvas and rapid entry would be
unusable.

### Rapid sibling entry

Tab commits and immediately opens the next input on the same union: five siblings is five
names and five Tabs. Birth order is recorded for free — but only into a union whose
children are *all* already ordered. Numbering only the newcomers, where existing children
have no recorded order, would invent an ordering over an unordered set and draw the older
children last as though that were known. In that case the order is left unrecorded and the
layout falls back to birth year. (Found by a test that asserted the wrong thing first.)

### Years stay uncertain

`year_parsing.py` accepts what people actually say: `1938`, `1930s`, `c. 1940`,
`1930-1945`, `before 1930`, `?`. Shared with quick-add so both entry points mean the same
thing by the same string. Unreadable input is **rejected, not guessed** — a wrong year that
looks confident is worse than an empty field.

It round-trips with `birth_display`: whatever a card shows can be typed back in and yields
the same stored range. Without that property, opening a year chip and pressing Enter
without changing anything would silently alter the record. Asserted in the tests.

### Gestures

Wheel, trackpad pinch (`ctrlKey`+wheel, with a much stronger response or it feels stuck),
and two-finger touch pinch all funnel into one `zoomAbout` function — the graph point under
the cursor or between the fingers must not move. Double-tap zooms one step on touch. No
momentum, as agreed. The sheet is unbounded; Fit reframes.

### Guards

45 headless checks now, including: adding a partner/child/parents produces non-overlapping,
correctly-wired geometry; four siblings entered in a row keep their order; a provisional
node lands where the affordance points; both of a remarried person's union dots are
separately addressable (which is what lets the UI ask); affordance hit targets are ≥44px
and fit around a card on a 390px screen; and pinch keeps its anchor fixed to within a
thousandth of a pixel across four zoom ratios. 446 backend tests.

**Verified by construction, not by observation.** The layout maths, the API behaviour and
the state machine are covered by tests; the *feel* of hover, tap, focus and pinch is not,
because there is no browser here. The click-script in the README is the real verification
and has not been run by me.

### Addendum: the empty state was never wired (found after shipping)

Phase 1.75 shipped with the empty-database screen still pointing at the bulk form. The
container was serving current code — the fault was that the empty branch `return`ed before
`<GraphCanvas>` was rendered at all, so there was no canvas for the editor to act on.

Behind that sat a real gap rather than a loose wire: **the API had no way to create a
person with no relationships.** All four contexts required an anchor, because the editor
was designed as "grow from an existing node" and the one case with no existing node — the
first person in an empty archive — was never considered. The feature could not have worked
even if the button had been connected.

Fixed by adding a `standalone` context, making the canvas render with an empty layout (the
first person is placed *on* the sheet, so a null layout cannot mean "no sheet"), and
pointing the empty state at the canvas flow with the bulk form kept as a secondary link.

Five headless checks now cover the empty → first-person → grown-family path, including
that a lone person draws as a card rather than a dot at every viewport and that the first
`+ partner` / `+ child` produce correct geometry. The regression was invisible to 45
existing checks because every one of them started from a populated fixture.

## 22. Phase 1.8: the ego-centric view

**New phase.** Every card gains a relationship label — "അമ്മാവൻ", "half-uncle",
"5 തലമുറ മുകളിലുള്ള പൂർവികൻ" — relative to a chosen point of view, and that point of view
is switchable. The graph stops being a diagram of a family and becomes a diagram of *your*
family.

### Anchor vs pins: one is data, the other is a scratchpad

**The anchor ("me")** lives on the server, on `accounts.User.anchor_person`, one per user.
That is not an arbitrary limit: it is the same field Phase 2's privacy radius measures
from, so a second notion of "me" would mean two different answers to "who is allowed to
see this living relative". `PATCH /api/v1/me/anchor/` moves it rather than adding to it,
and it survives a reload because it is a fact about the user.

**Pins** are the two or three people you are currently reasoning between, and they live in
**localStorage, per device**. They are a working set, closer to which tabs you have open
than to who you are: losing them on another machine costs nothing, and syncing them would
mean a migration plus API surface for something ephemeral. "Me" is always chip #1 and is
not removable from the focus bar — removing yourself is an answer about identity, given in
the side panel, not a bookmark you drag off a shelf.

### Labelling a screenful in three queries, not three hundred

`describe_relationship` costs roughly eight queries per pair: two ancestor walks, two path
reconstructions, a sibling classification, a birth-order check, a partner lookup. Forty
visible cards would be several hundred round trips — and they would all have to be redone
on every focus switch and every time the graph grows. That is the difference between a
feature and a demo.

`graph/relate_bulk.py` does the same work in a **constant four queries** regardless of how
many people are asked about:

1. validate the `from` person;
2. **one** recursive walk seeded with every person involved (`ANCESTOR_DEPTHS_MULTI`),
   giving each seed's ancestor set;
3. every membership among the people that walk touched;
4. those people's fields.

Common ancestors, paths, half-vs-full, side of the family and birth order are then computed
against those in-memory structures. `test_api_ego.py` pins the count at 8 targets and pins
it again against the entire fixture database — if it ever starts growing with the target
count, that is a regression the tests fail on rather than a slow page nobody traces.

**One labelling path.** The bulk endpoint builds a `Descriptor` and hands it to
`naming.py` unchanged. A test asserts every core-kin label matches what the single-pair
`/relate/` view returns, because two labelling implementations would drift and the drift
would be invisible.

### What gets labelled

Only the cards actually drawn. The canvas already culls to the viewport, and that same set
is what gets asked about — labelling the whole archive would be wasted work repeated on
every focus switch. In dot mode nothing is labelled: a dot has no room for a chip.

Three cases render as nothing rather than as something wrong: the focus person shows
**"you"** instead of a relationship; a disconnected person shows **no chip at all** (the
API returns an explicit `null`, so "no relationship" is distinguishable from "not asked
about"); and where Malayalam has no everyday term, the chip falls back to English rather
than blanking.

The chip sits *above* the card, not inside it. The card's three lines are the person's own
facts; the chip is a fact about the viewer's relationship to them, and it changes when the
focus does. A headless check asserts it fits in the gap between rows so labels cannot push
the layout around.

### Verified by construction vs by observation

Backend: 492 tests, including the query pins, en+ml label snapshots for the core kin set,
and correctness against half-siblings, a second marriage, an unknown parent, a
cross-family bridge and a disconnected pair. Frontend: 59 headless checks.

Live-checked through the running API: setting the anchor, and the same six people labelled
from two different focuses — from Jose, Thomas is *father* / അച്ഛൻ; from Kiran the same
man is *great-grandfather* / മുതുമുത്തച്ഛൻ.

Not verified: that the focus bar chips, the ring on the focus person and the chips on the
cards actually look right and switch cleanly under a real pointer. There is no browser
here. The click-script is the verification.

## 23. The second parent, and why "+ parents" now asks for both

**Found in real use, not by a test.** The most ordinary sequence there is — me → + parents
→ father → + partner → mother — recorded the mother as a *separate marriage* of the
father's rather than as the other parent of the child. Nothing on screen showed the
difference. The graph looked right and was wrong, and the relationship label proved it:
the child's `describe_relationship` to their own mother did not say "mother".

That is the worst class of bug this project can have. It is silent, it is in the first
thirty seconds of use, and the resulting record is indistinguishable by eye from the
correct one.

### The rule

`+ partner` on someone who has a union with an **open partner seat** no longer creates a
new union. It raises `OpenPartnerSlot` → 409, listing each candidate union **described by
its children** — "Parent of Febin", not a UUID, because that is a question a person can
actually answer. `force_new_union: true` takes the remarriage path deliberately.

This is the same philosophy as the child case (#21): where two readings record different
facts and cannot be told apart afterwards, the server refuses and asks. Both rules live in
`create_person_in_context`, so the admin, the bulk form and the canvas cannot drift.

New context `partner_in_union` fills a specific seat, and accepts `existing_person_id` for
when the other parent is already in the graph from another branch.

### Undo had to learn the difference

Joining an existing relative to a union must **detach, not delete** — they existed before
the step and are somebody else's relative. The create response now carries
`created_person`, and undo picks its inverse from it: `DELETE /persons/{id}/` when the step
created them, `DELETE /unions/{u}/partners/{p}/` when it only attached them.

The existing undo guard also had to be sharpened. It refused whenever a person's union had
children — which would have blocked undoing a mother joined to a union that already held a
child, since that child *predates* her. The guard now refuses only when something attached
**after** the person did, which is the actual question: is there work here that this step
did not create?

### The real fix is not asking at all

The ambiguity is worth handling, but the common case should never reach it. **"+ parents"
now opens both seats in sequence**: father, Tab, mother, Enter — one continuous motion,
with either left blank if unknown. The union is created once and filled twice, so the
question simply does not arise on the path everybody walks first.

The chooser exists for the cases that genuinely are ambiguous: coming back later to a
parent entered long ago, or a real remarriage.

### Guards

Seventeen backend tests covering the repro exactly, including the one that would have
caught it from the outside — *after joining, the child's label for the joined partner must
be "mother" / "അമ്മ"* — plus a test asserting the old behaviour produces a label that is
**not** "mother", so the difference stays pinned. Five headless checks compare the fixed
geometry (one union, both parents, child below) against the bug's (two unions, mother
parenting nobody).

---

## 24. relate-bulk is total over the graph; only malformed requests fail

**Context.** On a one-person database the explorer showed an error toast:
`400 Bad Request for /api/v1/relate-bulk/`. Reproduced against the running stack, the 400
came from exactly one condition — a `from` id that no longer resolved to a canonical
person. Every other suspected case (`to == from`, empty `to`, `to` omitted, unknown target
ids) already returned 200.

**Cause.** The focus id lives in `localStorage` under `aalmaram.focus` and was never
checked against the server. After `make reset-db` — or an undo that deleted the anchored
person — the id outlived its row. Worse, `useFocus` preferred the stored value over the
server's anchor (`current ?? payload.anchor_person?.id`), so a stale id could not be
displaced by re-anchoring elsewhere. The canvas then asked for labels from a viewpoint that
did not exist, and `loadRelations` turned the failure into a toast.

**Decision — the contract.** relate-bulk is a *labelling* endpoint, and labelling has
exactly one failure mode: there is no label. "That person is gone" and "those two are
unrelated" produce the same nothing. So the endpoint is **total over the state of the
graph**, and only a malformed *request* is refused:

| condition | answer |
| --- | --- |
| `from` missing or blank | **400** `missing_from` |
| more than `MAX_TARGETS` targets | **400** `too_many_targets` |
| `from` well-formed but unresolved | **200**, `from: null`, every target `null` |
| target unknown, or genuinely unrelated | **200**, `null` for that id |
| `target == from` | **200**, `kind: "self"` |
| `to` empty or omitted | **200**, `results: {}` |

**Why 200 and not 404 for an unresolved `from`.** A cached viewpoint going stale is
ordinary, not exceptional — it happens on every reset and every undo of an anchored person.
Any status in the 4xx range forces every caller to write the same defensive branch for a
condition the server can describe perfectly well in the normal payload. `from: null` is
more useful than a status code: it is a *signal to drop the stale id*, which is what the
client now does. The failure is handled, not swallowed.

The rejected alternative was to keep the 400 and make the client avoid it. That fixes this
call site and leaves the trap armed for the next one.

**Client, three separate defects at three layers.**

1. `fetchRelationsBulk` returns early when no target survives filtering — self is dropped
   because the focus wears its own chip, and on a one-person graph that empties the list.
   **A request with nothing to label is now never built.**
2. `from: null` clears the dead focus (and any pin holding it) and re-reads the anchor, so
   the app self-heals instead of failing every subsequent fetch.
3. A label failure is `console.warn`, not a toast. Labels are decoration over a graph that
   renders fine without them; a toast the user can do nothing about is noise.

Stale *target* ids need no client bookkeeping — unknown targets return `null` per id, so a
half-stale batch still labels everyone it can.

**Also: chained input focus no longer depends on remounting.** The second-parent and
Tab-sibling chains focused the box by keying the element on
`targetId + unionId + position.x` and relying on the remount. That holds only while no two
consecutive drafts share those three, which is a property of how the key happens to be
built rather than something the component can promise — "+ parents", cancelled and
reopened, collides on all three. Each opened seat now carries a monotonic `seat` number and
`InlineInput` focuses on that changing, inside a `requestAnimationFrame` so the input is
laid out before it takes focus (focusing a not-yet-positioned input is what opens the iOS
keyboard against the wrong element).

**Tests.** Eight backend tests pin the table above, including the literal repro — one
person, anchored to them, every call the canvas can make returns 200 — and a
delete-the-focus-person test that reproduces it through undo's actual mechanism rather than
a synthetic uuid. Four headless checks drive the real `fetchRelationsBulk` with a stubbed
`fetch` and **count the requests built**, so "no call is made" is verified rather than
described.

**One thing the fix uncovered.** The headless runner called check bodies synchronously
inside `try/catch`, so an async body's rejection was swallowed and printed ✓. Every
fetch-stubbing check is necessarily async, so the runner now collects promises and settles
them before the summary. Verified by breaking an async assertion deliberately: exit code 1
and a ✗ line, where before it would have passed silently.

---

## 25. Editing works in the overview; a handler that does not exist must not draw a button

**Context.** On a real archive of nine people the green `+` circles rendered on every card
and did nothing — no input, no request, no console error. The canvas otherwise worked:
pan, zoom, cards, relationship labels.

**Cause — two independent faults that had to coincide.**

1. `App` passed `onAddRelative={mode === 'detail' && !relate.active ? startAdd : undefined}`,
   and `startAdd` *also* began `if (mode === 'overview') return`. Both said "editing happens
   in the detail view".
2. `GraphCanvas` handed the prop down as
   `onAddRelative={(context) => onAddRelative?.(context, person)}` — an arrow function,
   therefore **always truthy**. `PersonCard` draws the buttons when that prop is set, so it
   drew them even when the thing they call was `undefined`. The optional chaining then
   swallowed the click in perfect silence.

Fault 2 is the one that mattered: without it, fault 1 would have been invisible (no
buttons), which is a legible state. Together they produced a button that looks live and is
not — the worst outcome available.

**Decision — editing works in the overview.** The `detail`-only rule was written when the
overview was a read-only big picture. Phase 1.75 made the canvas the primary editor, and a
small archive *never leaves the overview* — so the rule disabled the add-buttons precisely
when the graph was small enough to need them. It was also already inconsistent: the empty
archive's "add the first person" flow creates on the overview canvas, so the overview could
create a first person but not a second.

The overview reloads from the server after a commit rather than merging optimistically. The
new card therefore arrives a beat later than it does in the detail view. That is the honest
cost of laying out every component at once, and it is preferable to a second merge path
that could disagree with the server.

**Decision — a component may not manufacture a handler.** `GraphCanvas` now passes
`undefined` through when it has nothing to call. The affordance draws **if and only if**
there is something behind it, so "renders but dead" is not a reachable state rather than a
state we happen not to be in. The general rule: never wrap a possibly-absent callback in an
arrow that is unconditionally truthy, because it converts a missing handler from a visible
absence into a silent no-op.

**Tests — a new file, because the existing ones structurally could not catch this.**
`check-layout.mjs` verifies the layout as data in and data out; every assertion in it would
have passed with every button dead. So `scripts/check-interaction.mjs` renders the real
components into jsdom and dispatches real pointer events. It is deliberately narrow: it
asks only "does a click reach what it is supposed to reach". Ten checks, including the
literal repro — three people, the overview, click `+ parents`, **assert an input element
exists**.

Both faults were confirmed catchable by reintroducing them one at a time: restoring the
truthy wrapper fails with *"affordances rendered with no handler to call"*, and restoring
the early return fails with *"clicking + parents in the overview opened nothing"*.

`jsdom` is the one new devDependency; JSX is bundled for Node with the esbuild that already
ships inside Vite. `npm run check` now runs layout then interaction.

**On the "extra" + circles in the screenshot — not misplaced.** Measured against the real
layout: the `+` above a top-generation card is that person's *add-parents* button, correct
and expected, since nobody in the top row has recorded parents. The `+` that appears to sit
on the union dot is the *add-child* button, which genuinely shares a horizontal line with
the dot (both a little below the card row). Nothing is drawn in the wrong place, but the
proximity is real, so it is now pinned: no rendered affordance may come within the union
dot's own hit radius. The near-miss that check protects — a child's add-parents button
landing 42px from the union it already hangs from — never renders, because that button is
suppressed for anyone who already has parents. If that rule ever goes, the geometry check
is what starts failing.

---

## 26. A bus belongs to one union; the render may never assert a kinship the data does not hold

**Context.** On a real ten-person archive: union A (two partners, children Biju and Bindu)
and an unrelated union B (child Pecsy), same generation, joined only one generation *below*
by Bindu × Pecsy. Adding a third child to union A produced two visible faults — the new
child landed beyond the unrelated family, and both unions' sibling buses drew as one
unbroken horizontal rail, so every child in the row appeared to belong to both sets of
parents. The data was correct throughout; this was purely render.

**The rule this establishes.** The render's one job is to never assert a relationship that
is not in the data. A bus, a connector or any continuous stroke that visually links two
unions is a **P0 class of bug** — worse than a crash, because a crash is obvious and a
false ancestry is quietly copied into someone's family history.

### Fault 1 — buses were positioned by generation, not by union

`busY = union.y + CHILD_BUS`, and `union.y` depends only on the generation. Two unions in
one row therefore drew their buses at *the same y*; wherever their spans overlapped, two
separate paths landed on one line and fused.

Fixed with lane assignment in `assignBusLanes()`: unions whose spans come within
`BUS_MIN_GAP` are placed on different lanes, spread around `CHILD_BUS` and squeezed to fit
the band between the union row and the child row. A single unconflicted bus — the common
case — still draws exactly where it always did. Lanes are computed inside `buildEdges`
rather than during placement, because the overview shifts whole families sideways *after*
layout, which changes the spans and so can change which buses collide.

### Fault 2 — sibling groups could interleave, and nothing downstream could recover

Three separate causes, all of which had to be fixed:

1. **The seed walk interleaves.** It is depth-first, so from a child it wanders into that
   child's marriage and numbers a same-generation in-law before returning for the next
   sibling. Rows are now ordered by *block*, not by person: a block is a birth group, and
   two birth groups never interleave.
2. **Relaxation silently undid it.** `separateRows` re-derived the order from the current x
   on every pass, so a relaxed node could drift past its neighbour and swap — despite the
   comment claiming it preserved row order. It now walks the row in its established order,
   which makes the final order exactly the seeded one. It also re-centres each row
   afterwards: separation only pushes right, so without that the layout crept rightward on
   every pass and inflated (the fixture's width went from ~900px to 1676px before this was
   added, which collapsed the phone-fit check — a useful accident).
3. **A couple must not be split.** Ordering strictly by birth group separated spouses. A
   married-in partner now joins their spouse's block, and someone with two marriages sits
   *between* their two spouses, which is what makes a remarriage legible. The rule is
   therefore "two birth groups never interleave", not "nothing may sit among siblings" — a
   spouse between two siblings is fine, since no drop-line goes to them.

### Fault 3, found by the determinism check rather than by eye

Asked to pin incremental-vs-full layout, the check failed immediately: the layout depended
on the **order the graph arrived in**. Adjacency lists were built by appending memberships,
so an incremental add (new person appended last) and a reload (server's order) produced
genuinely different pictures — the graph rearranged itself on refresh. Every adjacency list
is now sorted on stable keys, making the layout a function of the graph alone. This was not
in the report; it is the same bug one refresh later.

**Verified against the live archive, not only fixtures.** The real overview payload and all
ten detail neighbourhoods were laid out with the code at HEAD and with the fix: **4 fused
rails → 0**, and **4 foreign-sibling intrusions → 0**. (Measured structurally; no names left
the machine and nothing was written into the repo.)

**Tests.** Six checks on the exact repro shape: one bus per union spanning only its own
children; no two unions sharing a bus line where their spans meet; the same rule swept
canvas-wide over every fixture; a new child landing among its siblings; layout invariance
under input reordering; and viewport-anchor arithmetic still returning the anchor to its
original screen point. Five of the six fail against the pre-fix layout, each with a precise
message — the sixth is a regression guard, so it passes both ways by design.

---

## 27. Undo is a stack of inverse API calls; Escape is global; names are editable in place

**Context.** Three gaps reported together from real data entry: an already-added node could
not be corrected on the canvas, Escape did nothing, and there was one level of undo with no
redo and no visible control.

### Editing an existing node

The machinery existed — `editPerson` does an optimistic update with rollback — but the only
thing wired to it on the canvas was the year field. The side panel had a full form behind an
Edit button, which is not where someone reciting a family is looking.

The **name is now editable in place**, exactly like the years directly below it: click it, a
box opens holding the current name with the text selected, Enter saves and Escape cancels.
Selecting the text means typing replaces it while the caret is still there for a one-letter
correction, which is the common case — a misheard spelling, a missing initial.

### Escape

It was handled only inside the name input's own `keydown`, so it worked while the caret was
in the box and nowhere else. Pressing it after clicking away, or while the canvas was asking
which marriage a child belongs to, did nothing.

Escape is now a window-level handler that closes **the topmost thing, innermost first**:
quick-add dialog → rename box → year box → any editor mode (placing, choosing-union,
choosing-seat) → relate mode → search highlight → selection. A component that has already
handled the key calls `preventDefault`, and the global handler skips those, so the inline
input still cancels itself without also clearing the selection behind it.

### Undo and redo

Undo was a single slot holding the last creation, exposed as `canUndo: Boolean(ref.current)`
— read from a ref, so a button bound to it would never have re-rendered when it changed.

It is now a proper stack in state, with `past` and `future`. Each entry knows how to invert
itself and how to re-apply itself, so undo and redo are one engine read in two directions.
Toolbar buttons (disabled when there is nothing to do, which is also how you find that out),
Ctrl/Cmd+Z, Ctrl+Y and Ctrl/Cmd+Shift+Z.

**Every step is a real API call, not a local rewind.** The database is the record; an undo
that only changed the canvas would be a lie the next reload exposes. Steps unwind
newest-first, and the server still refuses to delete a node that has acquired relatives of
its own, so a deep undo cannot become a bulk delete.

**Redoing a creation makes a new node, not the old one back.** The row was really deleted,
so the replacement gets a fresh id, and the stack entry is rewritten with the new response —
a later undo must delete the node that now exists. Nothing else can hold a stale reference,
because undo refuses once anything points at the node.

**One case cannot be redone, and says so by disappearing.** Undoing the last partner out of
a marriage deletes the marriage too (`removed_unions`), and a `partner_in_union` step cannot
re-create one. Rather than let redo fail against a union that no longer exists, those
entries are dropped from the redo branch when the undo reports the union gone. Undo edits
restore only the fields that edit touched, so undoing a rename cannot revert an unrelated
concurrent change.

**A bug this turned up in my own work:** `step()` first peeked at the stack through a
`setHistory` updater. React does not run updaters synchronously, so the entry was always
still null and undo silently did nothing — caught by the interaction check asserting that
undo issues a DELETE, not by reading the code.

**Tests.** Six interaction checks driving the real app: clicking a name opens a box holding
that name; Escape closes it when dispatched on the window rather than the input; Escape
cancels a half-finished add; the buttons exist and are inert until there is something to do;
undo issues a DELETE and redo re-POSTs *the same payload*; and the keyboard shortcuts drive
the same history as the buttons. The whole-app mounts are memory-hungry, so
`check:interaction` runs with a raised heap rather than with its coverage trimmed.

---

## 28. Pointer capture belongs to dragging, not to pressing

**Context.** After #27 shipped editable names, the report came back unchanged: *"I still
cannot edit a node."* The source was right and Vite was serving it — `data-edit-name` was in
the module the browser received. The handler simply never ran.

**Cause.** `usePanZoom` called `setPointerCapture` in `onPointerDown`. Once an element
captures a pointer, the browser delivers the rest of that gesture to it — and `click`, which
is synthesised from the down/up pair, is dispatched at the capturing element rather than at
what was actually pressed. Every `onClick` drawn inside the SVG therefore never fired: the
card select, the year field, and now the name.

The add-buttons worked, which is what made this so hard to see. They survive only because
`Affordances` stops `pointerdown` from reaching the canvas — a line written to prevent a
stray pan, which incidentally also prevented the capture. One component had immunity for an
unrelated reason, so the canvas looked half-alive rather than broken.

**Decision.** Capture is for dragging. It is now taken on the first `pointermove` past the
2px threshold — and when a pinch begins, which is unambiguously a gesture — never on
`pointerdown`. A press that does not move is a click and stays one. Panning is unaffected:
by the time the pointer has moved enough to be a pan, the canvas holds it and keeps
receiving moves even if the cursor leaves the element.

This also means new controls drawn on the canvas no longer need to know about panning to be
clickable, which is what let the previous fix look complete when it was not.

**The test was answering an easier question than the browser asks.** The interaction checks
stubbed `setPointerCapture` as a no-op and dispatched `click` directly at the element under
test — so a dead click passed as working, and #27 shipped with the feature non-functional
and a green suite. The harness now *models* capture: `setPointerCapture` records the target,
and `clickElement` dispatches the click at whatever held the pointer during the gesture,
read before `pointerup` releases it.

With that harness and the old source, three checks fail — card select, opening the rename
box, and closing it with Escape — while the affordance checks still pass, which is exactly
the half-alive canvas that was reported. Two further checks pin the rule directly: a press
that does not move must capture nothing, and a press that does move must capture.

**Lesson, recorded because it cost a whole cycle.** A harness that simulates an interaction
has to be faithful about *where events land*, not just that they were dispatched.
Dispatching straight at the element skips the browser's own targeting — which is the very
thing that was broken. When a fix "works in the checks" and not in the browser, suspect the
harness's model of the platform before re-reading the feature code.

---

## 29. Rendering a false kinship is a P0 invariant violation, guarded at render time and by properties

**Context.** The fused-rail defect from #26 recurred within the hour, in a second form:
adding a partner created a third union in a row and *its* connectors merged into one
continuous rail. Two occurrences of one class in a single session of real data entry.

The fix in #26 was real but scoped to the shape that had been reported — the **child bus**.
A union draws two horizontal rails, and the other one, the **partner rail**, was still
positioned from the generation alone (`union.y` is identical for every union in a row).
Measured on the live archive: **15 fused segments, every one partner × partner.**

Multiple unions per generation is not an edge case. It is the shape of every real family.

### The standing rule

**The renderer may not assert a relationship that is not in the data.** A chart is read as a
claim: a rail says "these people are one sibling set", a drop-line says "these two are that
child's parents". A wrong line is worse than a crash — a crash is obvious, and a false
ancestry looks fine and gets copied into someone's family history. This class is P0.

### 1. Invariants checked at render time, not only in tests

`graph/renderTruth.js` runs after every layout, in the app, in the same spirit as the
database CHECK constraints — the cheapest place to catch a false record is before it exists.
It parses the **emitted path strings**, not the model, so a layout that computes the right
answer and draws the wrong line still fails. Four rules:

- every horizontal run maps to exactly one existing union;
- no two runs of different unions touch, overlap or share a line;
- every drop-line ends on a member of its own union;
- no union's child sits inside another union's sibling run.

Violations are **returned, not thrown**: a lie on the canvas is worse than a missing
feature, but crashing the explorer over one bad rail is worse still. Dev shows an
undismissable red banner naming the offending union ids; production logs and draws.

### 2. Property-based testing, because example-based checks provably were not enough

This is not a matter of opinion. With the shipped defect reintroduced, **all 75
example-based layout checks pass**, while the property suite fails on **seed 1** — the first
family it generates. Example checks encode the shapes someone thought of, and both bugs
were "the shape I had just been shown". The class was always "any two unions in a row whose
rails overlap".

`scripts/check-properties.mjs` generates realistic families — 2-5 unions per row,
remarriages, single-parent unions, 0-6 children, 2-4 generations — and asserts the
invariants on the detail layout from several centres, on the packed overview, on every
intermediate state of building the family up one person at a time, and on
incremental-vs-full determinism. Seeded, so a failure prints a seed and the seed reproduces
the family exactly. The two shapes found by eye ("binu", "Augustine") are pinned in the
corpus for ever.

### 3. What the properties then found

Fixing the reported bug was the small part. Running the suite for the first time surfaced
**97 violations**, all of them layout nondeterminism — the picture depending on the order
the graph arrived in, meaning an incremental add and a reload draw different charts:

- `unionIdsByGeneration` sorted by generation only, leaving same-generation ties in array
  order. Relaxation shifts one union at a time and each shift moves the ground under the
  next, so this alone reordered whole rows.
- `spouseWithin` walked the row in array order, and the first sibling to claim a shared
  spouse decides which side that spouse sits on.

Neither was reported by anyone, neither was reachable from an example test, and both would
have produced exactly the kind of "the graph rearranged itself" bug that is impossible to
report usefully. 4000 generated families now pass.

The bus fix itself was generalised: `assignUnionLanes()` lanes **every** horizontal run a
union owns, in two bands — partner rails under the card row, child buses above the next —
rather than special-casing an edge type, which is what let the class survive its first fix.

### Why this is recorded as a contract and not a fix

Two defects of one class shipped past a green suite in one afternoon. The lesson is not
about buses; it is that **example-based checks cannot establish a universally-quantified
property**, and layout correctness is universally quantified over family shapes. Every
future layout change is now answerable to the properties, and the person entering their
family should never be the thing that notices.

---

## 30. Layered ordering (Sugiyama-style), corridor routing, and auto-fit

**Context.** With the render-truth invariants in place (#29) the guard started firing on the
owner's real archive: `interleaved-siblings ×3` on 25 people, later 38. The invariants were
right and the placement strategy could not satisfy them — a greedy seed order plus
relaxation has no way to keep every union's children contiguous once families interlock.

### Algorithm

A hand-rolled **Sugiyama-style layered layout**, in `graph/ordering.js`. Layers are
generations, which the server already assigns, so there is no cycle-breaking or
layer-assignment phase; the whole job is ordering within rows.

The hard constraint is expressed structurally rather than checked afterwards: a union's
children live in a **block**, and blocks are permuted whole and never split. Contiguity is
therefore not something the ordering can lose. Married-in partners join their spouse's
block, first marriage to the left and later ones to the right, which is what draws a
remarriage as one person between two union nodes.

Blocks are then ordered by the **barycenter heuristic** — median position of the people a
block connects to in the neighbouring row — swept down and up to a cap, keeping the
arrangement with fewest crossings. Median rather than mean, so one distant relative cannot
drag a sibling group across the chart. Blocks with nothing to align to keep their place;
sorting them to one end would reshuffle unrelated families every sweep and never converge.

**Limits, stated plainly.** Barycenter ordering is a heuristic and minimising crossings
exactly is NP-hard; this does not attempt it, and some crossings remain. Coordinate
assignment is still iterative relaxation, so x positions are "good enough and stable", not
optimal. Neither affects truth — the invariants are what guarantee that, and they are
checked on the output rather than assumed from the algorithm.

### Corridor routing

Real records put a child on a different row from their siblings: marrying a generation up
gets you placed by structural depth, not birth order. So a union can own children on two
rows, which means one bus cannot serve them and a drop must cross a whole row. Buses are now
per (union, child row), and a drop spanning more than one row **jogs sideways into a gap and
comes down there**, chosen from the free intervals of the rows it crosses.

Two corrections came out of getting this right, both found by the property suite:

- Buses were laned per the *union's* row, but a bus lives in the *child's* row. Two unions
  from different generations can own buses in the same row, and a per-union-row grouping
  never compares them. Laning is now global per child row.
- The jog was drawn at a y nothing had coloured, and landed on another union's bus. It now
  runs **along the union's own rail**, whose lane already accounts for its reach.

And a third, in the judge itself: `horizontalRuns` assumed the three-segment shape a simple
drop has, so the jog was invisible to the very check meant to catch it. It now parses
segments generically. *A judge that only reads the shapes it expects is not a judge* — the
same lesson as #28, in a different place.

### Auto-fit

Every layout change re-fits the whole graph with padding, so a family growing sideways stays
visible without hunting for what was just added. But a view someone positioned by hand is
theirs: any manual pan, zoom or pinch marks the view as "the user's" for a quiet period, and
while that holds, the previous anchor-preservation pan runs instead so the person being
worked on stays put. Pressing **Fit** clears the mark and hands control back. The canvas is
infinite and the layout takes the room it needs; the fit is what adapts.

Detail view now always draws cards. Semantic-zoom dots are the far-out overview's way of
showing a whole archive, and collapsing a neighbourhood you are reading is a different thing
entirely.

### Acceptance

The invariants are the judge, not the author's confidence:

- **10,000 generated families, zero violations** — 2-5 unions per row, remarriages,
  single-parent unions, 0-6 children, marry-ups, and every intermediate state of building a
  family up one person at a time.
- **The owner's real archive renders clean**, and its structural skeleton is pinned into the
  corpus (`scripts/fixtures/real-archive-shape.json` — synthetic ids, no names, dates,
  places or genders) because it produced two cases the generator could not.
- Determinism holds: same data, same layout, incremental identical to full.

Reverting either laning mechanism makes the suite fail, and in both cases **the real archive
is the first shape to fail** — which is the point of pinning it.
