# Family Graph — Project Spec (anchor document)

Read this fully before writing any code. This file is the source of truth for architecture
decisions. Do not deviate from the data model without an explicit decision recorded in
DECISIONS.md.

## What this is

A collaborative family ancestry platform. Unbounded depth and width — the goal is tracing
ancestors, discovering unknown relatives, and finding common ancestors between members.
Primary contributors are elderly WhatsApp users; they interact through a mobile-first
card/swipe interface, never a tree view. Bilingual: Malayalam + English.

## Stack (fixed)

- Backend: Django 5.x + DRF, PostgreSQL 16 (recursive CTEs for graph traversal — no graph DB)
- Frontend: React + Vite PWA, mobile-first, Tailwind
- Auth: magic-link invites (no passwords). Each invite pre-anchored to a Person node.
- Dev: docker-compose (postgres + django + vite). Tests: pytest + factory_boy. All graph
  logic must be unit-tested against fixture families including edge cases (remarriage,
  half-siblings, unknown parents, merged persons).

## Core data model (GEDCOM-style, non-negotiable)

The family is a GRAPH, not a tree. Parent-child edges are NEVER stored directly between
two Person rows. All kinship flows through Union.

### Person
- id (UUID), status: canonical | merged_into(person_id) | tombstone
- name_en, name_ml, nicknames[] (JSONB), house_name (veedu/tharavadu — first-class field,
  strong identifier for pre-1950 births), gender, is_living (bool, default true unless
  death info present)
- Uncertainty-native dates: birth_year_min, birth_year_max, birth_date_exact (nullable),
  same trio for death. Never require exact dates.
- place_origin (free text + optional geocode), religion_community (nullable),
  institution (parish/mahallu/temple, nullable — disambiguator for old records)
- notes, created_by, source_invite (provenance)

### Union
- id, union_type: marriage | partnership | unknown
- year_min/max/exact (nullable), place (nullable), status: active | ended | unknown

### UnionMembership
- union_id, person_id, role: partner | child
- For role=child: relation_type: biological | adopted | step | unknown
- sibling_order (nullable int) — filled indirectly via "older/younger" swipe answers

### Fact provenance (applies to every assertable claim)
- Claim table: subject (person/union), predicate, value, created_by, confidence,
  confirmations_count, disputes_count, status: proposed | confirmed | contested | rejected
- Swipes write here. Contested claims enter the arbiter queue (Febin is sole arbiter in v1).

### Merge machinery
- MergeCandidate: person_a, person_b, score, evidence (JSONB), status
- Merges create a canonical Person; both originals kept with status=merged_into.
  Merges must be reversible (un-merge restores originals and re-points edges).
- Match scoring: relational context >> name similarity. Signals: shared/similar parent or
  sibling names, era overlap, place, house_name. Cross-script name normalization via a
  transliteration variant table (Ouseph/Yousef/ഔസേഫ്, Thoma/Thomas/തോമ്മാ, etc.).

### Media
- MediaItem: type photo | audio | document, owner, attached persons (M2M via tag claims)
- Voice notes are a primary input: store audio now, transcription pipeline later.

## Privacy rule (enforce from day one)

Deceased persons and their facts: visible to all authenticated members.
Living persons: visible only within 3 degrees of the viewer's anchor Person, or with
explicit consent flag. Photos/birthdates of living people never shown outside that radius.

## Interfaces

1. **Admin tree view** (Febin only, desktop): full graph explorer, seed data entry,
   merge queue, contested-claim queue. Function over beauty.
2. **Swipe deck** (everyone else, mobile PWA, Malayalam default):
   - Verification cards: "Is X the sibling of Y?" → right=yes, left=no, up=don't know
   - Contribution cards: "Do you know the siblings of X? Add names" (name-only quick add)
   - Photo cards: "Who is in this photo?"
   - Voice cards: "Tell me about your grandmother 🎤"
   - Relative ordering cards: "Was X older or younger than Y?"
3. **Person page**: ego-network (parents, siblings, spouse(s), children) + "How are we
   related?" path via bidirectional BFS over parent edges → common-ancestor display with
   both descent paths.

## Question engine (heart of the system)

For each user, rank candidate cards by:
1. Graph proximity to their anchor Person
2. Information value — cards that could CONNECT two disconnected components rank highest
   (route these to the oldest members of both clusters)
3. Likely knowledge (people know their elders + own generation)
4. Freshness / non-repetition (never re-ask answered cards)

## Build phases — implement strictly in order

- **Phase 1 (now):** Data model + migrations + admin tree view + seed-entry UX + fixtures
  + graph traversal library (ancestors, descendants, LCA, relationship-path naming) with
  full test coverage. No public UI yet.
- **Phase 2:** Magic-link invites + swipe deck in verification mode.
- **Phase 3:** Contribution cards, voice notes, photo tagging.
- **Phase 4:** Merge engine + common-ancestor showpiece feature.
- **Phase 5:** Member-initiated invites (viral growth loop).

## Conventions

- One migration per logical change; never edit applied migrations.
- Every graph function gets tests against the fixture families BEFORE integration.
- Record every architecture deviation or judgment call in DECISIONS.md with rationale.
- i18n from day one: all UI strings through the translation layer; Malayalam is the
  default locale for invited users, English for admin.
- API: versioned under /api/v1/. All list endpoints paginated.

## Phase 1 acceptance checks

- Can enter 200+ persons across 5 generations via admin without friction
- Fixture family with remarriage + half-siblings + unknown parent traverses correctly
- LCA query returns correct common ancestor + both paths on fixtures
- Merging two persons and un-merging restores exact prior state (test-proven)
- Living/deceased visibility rule enforced at the queryset level, not in views
