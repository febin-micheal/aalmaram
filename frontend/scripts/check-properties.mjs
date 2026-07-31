/**
 * Property-based layout checks.
 *
 * Example-based checks encode the shapes someone thought of. Two separate false-kinship
 * bugs shipped past a green suite in one afternoon — the child bus, then the partner rail —
 * because each example pinned the shape that had just been reported, and the *class* was
 * "any two unions in a row whose rails overlap". Real families are 2-5 unions per
 * generation with remarriages and half-siblings, so that class is the normal case, not an
 * edge case.
 *
 * So this generates families instead of listing them, and asserts the render-truth
 * invariants on every one. Failures print the seed, and a seed reproduces the exact family,
 * so a random failure becomes a permanent regression test in one line.
 *
 * Run with: npm run check:properties  (npm run check runs it after the others)
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { layoutGraph } from '../src/graph/layout.js'
import { layoutOverview } from '../src/graph/layoutOverview.js'
import { checkRenderTruth } from '../src/graph/renderTruth.js'

const CASES = Number(process.env.PROPERTY_CASES ?? 400)

/** Deterministic PRNG, so a seed names one family for ever. */
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A random but *realistic* family.
 *
 * Realistic is the point: uniformly random graphs would mostly be shapes no family has, and
 * would miss the ones every family has. So generations are built downward, each with
 * several unions, some partners remarrying into a second union, some unions holding a
 * single recorded parent, and children drawn from the generation below.
 */
function generateFamily(seed) {
  const random = rng(seed)
  const pick = (n) => Math.floor(random() * n)
  const between = (lo, hi) => lo + pick(hi - lo + 1)

  const persons = []
  const unions = []
  const memberships = []
  let nextPerson = 0
  let nextUnion = 0

  const generations = between(2, 4)
  const rowsOfPeople = []

  const makePerson = (generation) => {
    const id = `p${nextPerson++}`
    persons.push({
      id,
      name_en: id,
      name_ml: '',
      display_name: id,
      house_name: 'H',
      gender: random() < 0.5 ? 'male' : 'female',
      is_living: true,
      birth_display: '',
      death_display: '',
      lifespan_compact: '',
      place_origin: '',
      generation,
      hidden_up: 0,
      hidden_down: 0,
    })
    return id
  }

  // Top generation: the founders, as loose people.
  rowsOfPeople[0] = Array.from({ length: between(2, 6) }, () => makePerson(0))

  for (let generation = 0; generation < generations - 1; generation += 1) {
    const parents = [...rowsOfPeople[generation]]
    const children = []
    const unionCount = Math.min(between(2, 5), Math.max(1, Math.floor(parents.length / 1.5)))

    for (let u = 0; u < unionCount && parents.length; u += 1) {
      const unionId = `u${nextUnion++}`
      unions.push({
        id: unionId,
        union_type: 'marriage',
        status: random() < 0.2 ? 'ended' : 'active',
        year_display: '',
        place: '',
        generation,
      })

      // Single-parent unions are common in real records — one name remembered, one lost.
      const partnerCount = random() < 0.18 ? 1 : 2
      const chosen = []
      for (let k = 0; k < partnerCount && parents.length; k += 1) {
        // Remarriage: sometimes reuse a partner already in another union this row.
        const reuse = random() < 0.22 && rowsOfPeople[generation].length > parents.length
        const pool = reuse ? rowsOfPeople[generation] : parents
        const index = pick(pool.length)
        const person = pool[index]
        if (chosen.includes(person)) continue
        chosen.push(person)
        if (!reuse) parents.splice(index, 1)
      }
      for (const person of chosen) {
        memberships.push({
          union: unionId,
          person,
          role: 'partner',
          relation_type: 'biological',
          sibling_order: null,
        })
      }

      const childCount = between(0, 6)
      for (let c = 0; c < childCount; c += 1) {
        const child = makePerson(generation + 1)
        children.push(child)
        memberships.push({
          union: unionId,
          person: child,
          role: 'child',
          relation_type: random() < 0.1 ? 'adopted' : 'biological',
          // Real data often has no recorded order at all.
          sibling_order: random() < 0.5 ? c + 1 : null,
        })
      }
    }

    // People who married in from outside, so a row is not only siblings.
    for (let extra = 0; extra < between(0, 2); extra += 1) children.push(makePerson(generation + 1))

    /**
     * Marry-ups: a child recorded a generation away from their own siblings.
     *
     * This is not exotic. Someone who marries a person a generation older is placed by the
     * server's structural depth, not by their birth order, so their union's children end up
     * split across two rows — which means one sibling bus cannot serve them and a drop has
     * to cross a whole row. The corridor routing exists for this, and the case was invisible
     * to the generator until it produced one, so the first real archive found it instead.
     */
    if (children.length > 1 && random() < 0.3) {
      const moved = children[pick(children.length)]
      const person = persons.find((p) => p.id === moved)
      if (person) person.generation = generation + 2
    }

    rowsOfPeople[generation + 1] = children.filter((id) => {
      const person = persons.find((p) => p.id === id)
      return person && person.generation === generation + 1
    })
  }

  return { persons, unions, memberships }
}

/** The same graph with everything in a different order — what an incremental add produces. */
function shuffled(graph, seed) {
  const random = rng(seed ^ 0x9e3779b9)
  const mix = (list) => {
    const copy = [...list]
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1))
      ;[copy[i], copy[j]] = [copy[j], copy[i]]
    }
    return copy
  }
  return {
    persons: mix(graph.persons),
    unions: mix(graph.unions),
    memberships: mix(graph.memberships),
  }
}

/** Rebuild the graph one person at a time, as the editor does, laying out at each step. */
function incrementalStates(graph) {
  const states = []
  const order = [...graph.persons]
  for (let n = 1; n <= order.length; n += 1) {
    const persons = order.slice(0, n)
    const ids = new Set(persons.map((p) => p.id))
    const memberships = graph.memberships.filter((m) => ids.has(m.person))
    const usedUnions = new Set(memberships.map((m) => m.union))
    states.push({
      persons,
      unions: graph.unions.filter((u) => usedUnions.has(u.id)),
      memberships,
    })
  }
  return states
}

function overviewShape(graph) {
  return {
    persons: graph.persons.map((p) => ({ ...p, band: p.generation })),
    unions: graph.unions.map((u) => ({ id: u.id, band: u.generation })),
    memberships: graph.memberships.map((m) => ({
      union: m.union,
      person: m.person,
      role: m.role,
      sibling_order: m.sibling_order ?? null,
    })),
    stats: { persons: graph.persons.length, unions: graph.unions.length, components: 1 },
  }
}

let failures = 0
const failedSeeds = []

function report(seed, where, violations) {
  failures += 1
  if (failedSeeds.length < 6) {
    failedSeeds.push(seed)
    console.error(`\n  ✗ seed ${seed} (${where})`)
    for (const violation of violations.slice(0, 4)) {
      console.error(`      ${violation.rule}: ${violation.message}`)
    }
    if (violations.length > 4) console.error(`      … and ${violations.length - 4} more`)
  }
}

console.log(`property checks — ${CASES} generated families`)

/**
 * The two shapes that were reported by eye, pinned so they can never regress silently.
 * Their seeds are arbitrary; what matters is that the shapes are in the corpus for ever.
 */
const PINNED = {
  // "binu": two unrelated families in one row, joined only one generation below.
  binu: {
    persons: ['a1', 'a2', 'b1', 'b2', 'biju', 'bindu', 'pecsy', 'binu', 'abin', 'febin'].map(
      (id, index) => ({
        id,
        name_en: id,
        name_ml: '',
        display_name: id,
        house_name: 'H',
        gender: 'male',
        is_living: true,
        birth_display: '',
        death_display: '',
        lifespan_compact: '',
        place_origin: '',
        generation: index < 4 ? -1 : index < 8 ? 0 : 1,
        hidden_up: 0,
        hidden_down: 0,
      }),
    ),
    unions: [
      { id: 'UA', generation: -1 },
      { id: 'UB', generation: -1 },
      { id: 'UC', generation: 0 },
    ].map((u) => ({ ...u, union_type: 'marriage', status: 'active', year_display: '', place: '' })),
    memberships: [
      ['UA', 'a1', 'partner'], ['UA', 'a2', 'partner'],
      ['UA', 'biju', 'child'], ['UA', 'bindu', 'child'], ['UA', 'binu', 'child'],
      ['UB', 'b1', 'partner'], ['UB', 'b2', 'partner'], ['UB', 'pecsy', 'child'],
      ['UC', 'pecsy', 'partner'], ['UC', 'bindu', 'partner'],
      ['UC', 'abin', 'child'], ['UC', 'febin', 'child'],
    ].map(([union, person, role]) => ({
      union,
      person,
      role,
      relation_type: 'biological',
      sibling_order: null,
    })),
  },
  // "Augustine": a third union appears in a row that already had two.
  augustine: {
    persons: ['a1', 'a2', 'b1', 'b2', 'jessy', 'augustine', 'k1', 'k2', 'k3'].map((id, index) => ({
      id,
      name_en: id,
      name_ml: '',
      display_name: id,
      house_name: 'H',
      gender: 'male',
      is_living: true,
      birth_display: '',
      death_display: '',
      lifespan_compact: '',
      place_origin: '',
      generation: index < 6 ? 0 : 1,
      hidden_up: 0,
      hidden_down: 0,
    })),
    unions: [
      { id: 'UA', generation: 0 },
      { id: 'UB', generation: 0 },
      { id: 'UJ', generation: 0 },
    ].map((u) => ({ ...u, union_type: 'marriage', status: 'active', year_display: '', place: '' })),
    memberships: [
      ['UA', 'a1', 'partner'], ['UA', 'a2', 'partner'], ['UA', 'k1', 'child'],
      ['UB', 'b1', 'partner'], ['UB', 'b2', 'partner'], ['UB', 'k2', 'child'],
      ['UJ', 'jessy', 'partner'], ['UJ', 'augustine', 'partner'], ['UJ', 'k3', 'child'],
    ].map(([union, person, role]) => ({
      union,
      person,
      role,
      relation_type: 'biological',
      sibling_order: null,
    })),
  },
}

/**
 * The owner's own archive, as pure structure.
 *
 * Ids are synthetic and there are no names, dates or places — only bands, genders and who
 * belongs to which union. It is here because it is the shape that found two defects the
 * generator could not produce: unions whose children span two rows, which is what marrying
 * a generation up does to a real family.
 */
const realShape = JSON.parse(
  readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures/real-archive-shape.json'), 'utf8'),
)
PINNED['real-archive'] = {
  persons: realShape.persons.map((p) => ({
    id: p.id,
    name_en: p.id,
    name_ml: '',
    display_name: p.id,
    house_name: 'H',
    gender: 'unknown',
    is_living: true,
    birth_display: '',
    death_display: '',
    lifespan_compact: '',
    place_origin: '',
    generation: p.band,
    hidden_up: 0,
    hidden_down: 0,
  })),
  unions: realShape.unions.map((u) => ({
    id: u.id,
    union_type: 'marriage',
    status: 'active',
    year_display: '',
    place: '',
    generation: u.band,
  })),
  memberships: realShape.memberships.map((m) => ({ ...m, relation_type: 'biological' })),
}

for (const [name, graph] of Object.entries(PINNED)) {
  for (const centre of graph.persons.map((p) => p.id)) {
    const violations = checkRenderTruth(layoutGraph(graph, centre))
    if (violations.length) report(`pinned:${name}`, `centred on ${centre}`, violations)
  }
}

for (let seed = 1; seed <= CASES; seed += 1) {
  const graph = generateFamily(seed)
  if (!graph.persons.length) continue

  // 1. Render truth on the detail layout, from a few different centres.
  const centres = [graph.persons[0].id, graph.persons[graph.persons.length - 1].id]
  for (const centre of centres) {
    const layout = layoutGraph(graph, centre)
    const violations = checkRenderTruth(layout)
    if (violations.length) report(seed, `detail centred on ${centre}`, violations)
  }

  // 2. Render truth on the overview, where families are packed side by side.
  const overview = layoutOverview(overviewShape(graph))
  const overviewViolations = checkRenderTruth(overview)
  if (overviewViolations.length) report(seed, 'overview', overviewViolations)

  // 3. Incremental == full: the picture must not depend on the order people arrived in.
  const centre = graph.persons[0].id
  const full = layoutGraph(graph, centre)
  const reordered = layoutGraph(shuffled(graph, seed), centre)
  for (const [id, person] of full.persons) {
    const other = reordered.persons.get(id)
    if (!other || other.x !== person.x || other.y !== person.y) {
      report(seed, 'incremental vs full', [
        {
          rule: 'nondeterministic-layout',
          message: `${id} at (${person.x?.toFixed(1)}, ${person.y}) reordered to (${other?.x?.toFixed(1)}, ${other?.y}) — a reload would redraw the graph differently`,
        },
      ])
      break
    }
  }

  // 4. Every intermediate state of building the family up must also be truthful — this is
  //    what the editor actually produces, one person at a time.
  if (seed % 20 === 0) {
    for (const state of incrementalStates(graph)) {
      if (!state.persons.length) continue
      const violations = checkRenderTruth(layoutGraph(state, state.persons[0].id))
      if (violations.length) {
        report(seed, `partial graph of ${state.persons.length} people`, violations)
        break
      }
    }
  }
}

if (failures) {
  console.error(`\n${failures} property violation(s). Reproduce with: PROPERTY_CASES=<n>, seeds ${failedSeeds.join(', ')}`)
  process.exitCode = 1
} else {
  console.log(`  ✓ render truth held on every generated family and both pinned repros`)
  console.log(`  ✓ layout is independent of the order the graph arrives in`)
  console.log(`\n${CASES} families checked, no violations`)
}

export { generateFamily, PINNED }
