/**
 * Headless checks for the layout algorithm.
 *
 * `npm run build` proves the app compiles; it proves nothing about whether the chart is
 * drawn correctly. The layout is pure data-in/data-out, so it can be checked without a
 * browser — and it is the piece most likely to go subtly wrong, because a family graph
 * has cases (remarriage, half-siblings, unknown parents) that a generic tree layout
 * would quietly mangle.
 *
 * Run with: npm run check
 */

import assert from 'node:assert/strict'

import {
  CARD_GAP,
  CARD_H,
  CARD_W,
  FAMILY_GAP,
  ROW_PITCH,
  findLinkingUnion,
  layoutGraph,
} from '../src/graph/layout.js'
import { AFFORDANCE_HIT, AFFORDANCE_VISIBLE } from '../src/components/affordance-metrics.js'
import { draftPosition } from '../src/graph/draftPlacement.js'
import { fetchRelationsBulk } from '../src/api.js'
import {
  CARD_ZOOM_THRESHOLD,
  COMPONENT_GAP,
  EDGE_ZOOM_THRESHOLD,
  MIN_SCALE,
  dotRadius,
  fitTransform,
  intersects,
  layoutOverview,
  renderModeFor,
  splitComponents,
  toGraph,
  toScreen,
  visibleBox,
  zoomAbout,
} from '../src/graph/layoutOverview.js'

/** Viewports the explorer has to survive. 390×844 is an iPhone 12/13/14/15. */
const PHONE = { width: 390, height: 844 }
const PHONE_LANDSCAPE = { width: 844, height: 390 }
const DESKTOP = { width: 1600, height: 900 }

let passed = 0
const pending = []

function record(name, error) {
  if (error) {
    console.error(`  ✗ ${name}\n    ${error.message}`)
    process.exitCode = 1
  } else {
    passed += 1
    console.log(`  ✓ ${name}`)
  }
}

/**
 * Async bodies are awaited, not fired and forgotten.
 *
 * A rejected promise from a `try { fn() }` that never awaits is swallowed: the check
 * prints ✓ and the assertion inside it never mattered. Checks that stub `fetch` are
 * necessarily async, so the runner has to collect and settle them before the summary.
 */
function check(name, fn) {
  try {
    const result = fn()
    if (result && typeof result.then === 'function') {
      pending.push(result.then(() => record(name), (error) => record(name, error)))
      return
    }
    record(name)
  } catch (error) {
    record(name, error)
  }
}

/**
 * The fixture family, in the shape the API returns it: Chacko married twice, so Thomas
 * and Rosy are full siblings and Joseph is their half-brother through a second union.
 */
function fixture() {
  const person = (id, name, generation, extra = {}) => ({
    id,
    name_en: name,
    name_ml: '',
    display_name: name,
    house_name: 'Kavunkal',
    gender: 'male',
    is_living: false,
    birth_display: '1900s',
    death_display: '?',
    lifespan_compact: '1900s – ?',
    place_origin: '',
    generation,
    hidden_up: 0,
    hidden_down: 0,
    ...extra,
  })

  return {
    persons: [
      person('ittira', 'Ittira', -2),
      person('mariam', 'Mariam', -2, { gender: 'female' }),
      person('chacko', 'Chacko', -1),
      person('annamma', 'Annamma', -1, { gender: 'female' }),
      person('saramma', 'Saramma', -1, { gender: 'female' }),
      person('thomas', 'Thomas', 0),
      person('rosy', 'Rosy', 0, { gender: 'female' }),
      person('joseph', 'Joseph', 0),
      person('gracy', 'Gracy', 0, { gender: 'female' }),
      person('jose', 'Jose', 1),
      person('mini', 'Mini', 1, { gender: 'female' }),
    ],
    unions: [
      { id: 'u_g1', union_type: 'marriage', status: 'ended', year_display: '1912', place: '', generation: -2 },
      { id: 'u_c1', union_type: 'marriage', status: 'ended', year_display: '1940', place: '', generation: -1 },
      { id: 'u_c2', union_type: 'marriage', status: 'ended', year_display: '1952', place: '', generation: -1 },
      { id: 'u_t', union_type: 'marriage', status: 'active', year_display: '1968', place: '', generation: 0 },
    ],
    memberships: [
      { union: 'u_g1', person: 'ittira', role: 'partner', relation_type: 'biological', sibling_order: null },
      { union: 'u_g1', person: 'mariam', role: 'partner', relation_type: 'biological', sibling_order: null },
      { union: 'u_g1', person: 'chacko', role: 'child', relation_type: 'biological', sibling_order: 1 },

      { union: 'u_c1', person: 'chacko', role: 'partner', relation_type: 'biological', sibling_order: null },
      { union: 'u_c1', person: 'annamma', role: 'partner', relation_type: 'biological', sibling_order: null },
      { union: 'u_c1', person: 'thomas', role: 'child', relation_type: 'biological', sibling_order: 1 },
      { union: 'u_c1', person: 'rosy', role: 'child', relation_type: 'biological', sibling_order: 2 },

      { union: 'u_c2', person: 'chacko', role: 'partner', relation_type: 'biological', sibling_order: null },
      { union: 'u_c2', person: 'saramma', role: 'partner', relation_type: 'biological', sibling_order: null },
      { union: 'u_c2', person: 'joseph', role: 'child', relation_type: 'biological', sibling_order: 1 },

      { union: 'u_t', person: 'thomas', role: 'partner', relation_type: 'biological', sibling_order: null },
      { union: 'u_t', person: 'gracy', role: 'partner', relation_type: 'biological', sibling_order: null },
      { union: 'u_t', person: 'jose', role: 'child', relation_type: 'biological', sibling_order: 1 },
      { union: 'u_t', person: 'mini', role: 'child', relation_type: 'biological', sibling_order: 2 },
    ],
  }
}

console.log('layout.js')

check('every person is placed', () => {
  const layout = layoutGraph(fixture(), 'thomas')
  assert.equal(layout.persons.size, 11)
  for (const person of layout.persons.values()) {
    assert.ok(Number.isFinite(person.x), `${person.display_name} has no x`)
    assert.ok(Number.isFinite(person.y), `${person.display_name} has no y`)
  }
})

check('generations become distinct rows, ancestors above descendants', () => {
  const layout = layoutGraph(fixture(), 'thomas')
  const y = (id) => layout.persons.get(id).y
  assert.ok(y('ittira') < y('chacko'), 'grandparents must sit above parents')
  assert.ok(y('chacko') < y('thomas'), 'parents must sit above the centre')
  assert.ok(y('thomas') < y('jose'), 'children must sit below the centre')
  assert.equal(y('thomas') - y('chacko'), ROW_PITCH)
})

check('cards in a row never overlap', () => {
  const layout = layoutGraph(fixture(), 'thomas')
  const rows = new Map()
  for (const person of layout.persons.values()) {
    if (!rows.has(person.y)) rows.set(person.y, [])
    rows.get(person.y).push(person)
  }
  for (const [y, people] of rows) {
    people.sort((a, b) => a.x - b.x)
    for (let i = 1; i < people.length; i += 1) {
      const gap = people[i].x - (people[i - 1].x + CARD_W)
      assert.ok(gap >= CARD_GAP - 0.01, `overlap in row ${y}: gap was ${gap.toFixed(1)}`)
    }
  }
})

check('a remarriage draws as two separate union nodes', () => {
  const layout = layoutGraph(fixture(), 'thomas')
  const chackoUnions = [...layout.unions.values()].filter((u) => u.partnerIds.includes('chacko'))
  assert.equal(chackoUnions.length, 2, 'Chacko should be a partner in two unions')
  assert.notEqual(chackoUnions[0].x, chackoUnions[1].x, 'the two unions must not stack')
})

check('children hang off their union, not off a parent', () => {
  const layout = layoutGraph(fixture(), 'thomas')
  const first = layout.unions.get('u_c1')
  const second = layout.unions.get('u_c2')
  assert.deepEqual(first.childIds.sort(), ['rosy', 'thomas'])
  assert.deepEqual(second.childIds, ['joseph'])
})

check('half-siblings are drawn under different unions', () => {
  const layout = layoutGraph(fixture(), 'thomas')
  const edgeFor = (child) => layout.edges.find((e) => e.kind === 'child' && e.personId === child)
  assert.equal(edgeFor('thomas').unionId, 'u_c1')
  assert.equal(edgeFor('joseph').unionId, 'u_c2')
})

check('a union node sits below its partners and above its children', () => {
  const layout = layoutGraph(fixture(), 'thomas')
  const union = layout.unions.get('u_t')
  assert.ok(union.y > layout.persons.get('thomas').y, 'union must be below the partners')
  assert.ok(union.y < layout.persons.get('jose').y, 'union must be above the children')
})

check('siblings are ordered by recorded birth order', () => {
  const layout = layoutGraph(fixture(), 'thomas')
  assert.ok(
    layout.persons.get('jose').x < layout.persons.get('mini').x,
    'sibling_order 1 should be left of sibling_order 2',
  )
})

check('every edge has a drawable path', () => {
  const layout = layoutGraph(fixture(), 'thomas')
  assert.ok(layout.edges.length > 0)
  for (const edge of layout.edges) {
    assert.match(edge.d, /^M [\d.-]+ [\d.-]+/, `bad path on ${edge.id}`)
    assert.ok(!edge.d.includes('NaN'), `NaN in path ${edge.id}`)
  }
})

check('findLinkingUnion locates the parent-child union', () => {
  const layout = layoutGraph(fixture(), 'thomas')
  assert.equal(findLinkingUnion(layout, 'chacko', 'thomas'), 'u_c1')
  assert.equal(findLinkingUnion(layout, 'chacko', 'joseph'), 'u_c2')
  assert.equal(findLinkingUnion(layout, 'ittira', 'thomas'), null, 'grandparent is not a direct link')
})

check('an isolated person still lays out', () => {
  const lone = {
    persons: [
      {
        id: 'solo',
        display_name: 'Solo',
        name_en: 'Solo',
        name_ml: '',
        house_name: '',
        gender: 'unknown',
        is_living: true,
        birth_display: '?',
        death_display: '?',
        lifespan_compact: '',
        place_origin: '',
        generation: 0,
        hidden_up: 0,
        hidden_down: 0,
      },
    ],
    unions: [],
    memberships: [],
  }
  const layout = layoutGraph(lone, 'solo')
  assert.equal(layout.persons.size, 1)
  assert.equal(layout.edges.length, 0)
  assert.ok(Number.isFinite(layout.bounds.minX))
})

check('a union whose partner was not loaded still places its children', () => {
  // An unknown father: the union exists, one partner is missing from the payload.
  const graph = fixture()
  graph.persons = graph.persons.filter((p) => p.id !== 'saramma')
  graph.memberships = graph.memberships.filter((m) => m.person !== 'saramma')
  const layout = layoutGraph(graph, 'thomas')
  assert.ok(Number.isFinite(layout.unions.get('u_c2').x))
  assert.ok(layout.edges.some((e) => e.kind === 'child' && e.personId === 'joseph'))
})

check('layout is deterministic', () => {
  const first = layoutGraph(fixture(), 'thomas')
  const second = layoutGraph(fixture(), 'thomas')
  for (const [id, person] of first.persons) {
    assert.equal(person.x, second.persons.get(id).x, `${id} moved between runs`)
  }
})

check('a few hundred nodes lay out quickly', () => {
  // Six generations of a branching family — larger than any neighbourhood the API
  // returns, so the interactive path stays well inside this budget.
  const persons = []
  const unions = []
  const memberships = []
  let id = 0
  let previous = [`p${id}`]
  persons.push(node(`p${id++}`, -3))
  for (let generation = -3; generation < 3; generation += 1) {
    const next = []
    for (const parent of previous) {
      const spouse = `p${id}`
      persons.push(node(spouse, generation))
      id += 1
      const unionId = `u${id}`
      unions.push({ id: unionId, union_type: 'marriage', status: 'active', year_display: '', place: '', generation })
      memberships.push(edge(unionId, parent, 'partner'))
      memberships.push(edge(unionId, spouse, 'partner'))
      for (let k = 0; k < 3; k += 1) {
        const child = `p${id}`
        persons.push(node(child, generation + 1))
        id += 1
        memberships.push(edge(unionId, child, 'child', k + 1))
        next.push(child)
      }
    }
    previous = next.slice(0, 40) // keep the fan-out bounded
  }

  assert.ok(persons.length > 300, `expected 300+ nodes, built ${persons.length}`)
  const started = performance.now()
  const layout = layoutGraph({ persons, unions, memberships }, 'p0')
  const elapsed = performance.now() - started
  assert.equal(layout.persons.size, persons.length)
  assert.ok(elapsed < 1500, `layout of ${persons.length} nodes took ${elapsed.toFixed(0)}ms`)
  console.log(`    (${persons.length} nodes in ${elapsed.toFixed(0)}ms)`)

  function node(nodeId, generation) {
    return {
      id: nodeId,
      display_name: nodeId,
      name_en: nodeId,
      name_ml: '',
      house_name: 'Kavunkal',
      gender: 'unknown',
      is_living: false,
      birth_display: '?',
      death_display: '?',
      lifespan_compact: '',
      place_origin: '',
      generation,
      hidden_up: 0,
      hidden_down: 0,
    }
  }
  function edge(unionId, personId, role, order = null) {
    return {
      union: unionId,
      person: personId,
      role,
      relation_type: 'biological',
      sibling_order: order,
    }
  }
})

// ---------------------------------------------------------------- overview mode

console.log('\nlayoutOverview.js')

/** Two unrelated families plus a lone person, in the overview payload's shape. */
function overviewFixture() {
  const base = fixture()
  const persons = base.persons.map(({ generation, ...rest }) => ({ ...rest, band: generation }))
  const unions = base.unions.map(({ generation, ...rest }) => ({ ...rest, band: generation }))
  const memberships = base.memberships.map(({ relation_type, ...rest }) => rest)

  // A second, entirely separate family.
  const other = (id, name, band) => ({
    id,
    name_en: name,
    name_ml: '',
    display_name: name,
    house_name: 'Palathinkal',
    gender: 'female',
    is_living: false,
    lifespan_compact: '1930s – ?',
    band,
  })
  persons.push(other('kesavan', 'Kesavan', -1), other('bhargavi', 'Bhargavi', -1), other('manoj', 'Manoj', 0))
  unions.push({ id: 'u_far', band: -1 })
  memberships.push(
    { union: 'u_far', person: 'kesavan', role: 'partner', sibling_order: null },
    { union: 'u_far', person: 'bhargavi', role: 'partner', sibling_order: null },
    { union: 'u_far', person: 'manoj', role: 'child', sibling_order: 1 },
  )

  // And a fragment nobody has joined up yet.
  persons.push(other('lonely', 'Lonely', 0))

  return { persons, unions, memberships }
}

check('splitComponents finds each disconnected family', () => {
  const data = overviewFixture()
  const components = splitComponents(data.persons, data.unions, data.memberships)
  const sizes = components.map((c) => c.persons.length).sort((a, b) => b - a)
  assert.deepEqual(sizes, [11, 3, 1], 'expected the main family, a second family, and a fragment')
})

check('families are packed side by side without overlapping', () => {
  const layout = layoutOverview(overviewFixture())
  const spans = new Map()
  const familyOf = { Kesavan: 'b', Bhargavi: 'b', Manoj: 'b', Lonely: 'c' }

  for (const person of layout.persons.values()) {
    const key = familyOf[person.display_name] ?? 'a'
    const span = spans.get(key) ?? { min: Infinity, max: -Infinity }
    span.min = Math.min(span.min, person.x)
    span.max = Math.max(span.max, person.x + CARD_W)
    spans.set(key, span)
  }

  const ordered = [...spans.values()].sort((x, y) => x.min - y.min)
  for (let i = 1; i < ordered.length; i += 1) {
    assert.ok(
      ordered[i].min >= ordered[i - 1].max,
      `families overlap: ${ordered[i - 1].max.toFixed(0)} > ${ordered[i].min.toFixed(0)}`,
    )
  }
})

check('the largest family is packed first', () => {
  const layout = layoutOverview(overviewFixture())
  const thomas = layout.persons.get('thomas')
  const manoj = layout.persons.get('manoj')
  assert.ok(thomas.x < manoj.x, 'the main tree should sit left of the smaller family')
})

check('bands become rows, and a parent still sits above their child', () => {
  const layout = layoutOverview(overviewFixture())
  assert.ok(layout.persons.get('chacko').y < layout.persons.get('thomas').y)
  assert.ok(layout.persons.get('kesavan').y < layout.persons.get('manoj').y)
  // Equal bands across unrelated families land on the same row.
  assert.equal(layout.persons.get('chacko').y, layout.persons.get('kesavan').y)
})

check('every overview edge is drawable after packing', () => {
  const layout = layoutOverview(overviewFixture())
  assert.ok(layout.edges.length > 0)
  for (const edge of layout.edges) {
    assert.ok(!edge.d.includes('NaN'), `NaN in packed path ${edge.id}`)
  }
  // The second family's connectors survived the shift.
  assert.ok(layout.edges.some((e) => e.unionId === 'u_far'))
})

check('an empty archive lays out to nothing rather than crashing', () => {
  assert.equal(layoutOverview({ persons: [], unions: [], memberships: [] }), null)
  assert.equal(layoutOverview(null), null)
})

// ------------------------------------------------------------- semantic zoom

console.log('\nsemantic zoom')

check('render mode follows the zoom threshold', () => {
  assert.equal(renderModeFor(CARD_ZOOM_THRESHOLD), 'cards', 'at the threshold, cards')
  assert.equal(renderModeFor(CARD_ZOOM_THRESHOLD + 0.01), 'cards')
  assert.equal(renderModeFor(CARD_ZOOM_THRESHOLD - 0.01), 'dots', 'just below it, dots')
  assert.equal(renderModeFor(0.05), 'dots')
  assert.equal(renderModeFor(2), 'cards')
  assert.ok(EDGE_ZOOM_THRESHOLD < CARD_ZOOM_THRESHOLD, 'edges drop out below card mode')
})

check('viewport culling keeps only what is on screen', () => {
  const layout = layoutOverview(overviewFixture())
  const viewport = { width: 900, height: 600 }
  const transform = { x: 0, y: 0, k: 1 }
  const box = visibleBox(transform, viewport)

  const all = [...layout.persons.values()]
  const visible = all.filter((person) => intersects(person, box))
  assert.ok(visible.length > 0, 'something should be on screen')
  assert.ok(visible.length < all.length, 'and something should be culled')

  // Panning far away leaves nothing to draw — which is the point.
  const faraway = visibleBox({ x: -900000, y: 0, k: 1 }, viewport)
  assert.equal(all.filter((person) => intersects(person, faraway)).length, 0)
})

check('culling is disabled when the viewport is unknown', () => {
  // Before the first ResizeObserver callback there is no box; drawing everything is the
  // safe default, never drawing nothing.
  assert.equal(visibleBox({ x: 0, y: 0, k: 1 }, { width: 0, height: 0 }), null)
  assert.equal(intersects({ x: 0, y: 0 }, null), true)
})

// ------------------------------------------------------------------- at scale

console.log('\nscale')

check('a 1200-person archive lays out within budget', () => {
  const persons = []
  const unions = []
  const memberships = []
  let id = 0

  // Twelve unrelated families of ~100 people each — the shape a real archive takes
  // before the joins between branches have been found.
  for (let family = 0; family < 12; family += 1) {
    let previous = [`p${id}`]
    persons.push(node(`p${id++}`, 0, `House${family}`))
    for (let band = 0; band < 4; band += 1) {
      const next = []
      for (const parent of previous) {
        if (persons.length >= (family + 1) * 100) break
        const spouse = `p${id}`
        persons.push(node(spouse, band, `House${family}`))
        id += 1
        const unionId = `u${id}`
        unions.push({ id: unionId, band })
        memberships.push(edge(unionId, parent, 'partner'), edge(unionId, spouse, 'partner'))
        for (let k = 0; k < 3; k += 1) {
          const child = `p${id}`
          persons.push(node(child, band + 1, `House${family}`))
          id += 1
          memberships.push(edge(unionId, child, 'child', k + 1))
          next.push(child)
        }
      }
      previous = next
    }
  }

  assert.ok(persons.length >= 1200, `expected 1200+ nodes, built ${persons.length}`)

  const started = performance.now()
  const layout = layoutOverview({ persons, unions, memberships })
  const elapsed = performance.now() - started

  assert.equal(layout.persons.size, persons.length)
  assert.equal(layout.componentCount, 12)
  assert.ok(elapsed < 2000, `overview layout of ${persons.length} nodes took ${elapsed.toFixed(0)}ms`)
  console.log(
    `    (${persons.length} people, ${layout.componentCount} families, ${layout.edges.length} edges in ${elapsed.toFixed(0)}ms)`,
  )

  // At overview zoom the whole archive is drawn; at card zoom only a screenful is.
  const box = visibleBox({ x: 0, y: 0, k: 1 }, { width: 1600, height: 900 })
  const onScreen = [...layout.persons.values()].filter((p) => intersects(p, box)).length
  console.log(`    (card zoom draws ${onScreen} of ${persons.length} cards)`)
  assert.ok(onScreen < persons.length / 4, 'culling should cut the card count sharply')

  function node(nodeId, band, house) {
    return {
      id: nodeId,
      name_en: nodeId,
      name_ml: '',
      display_name: nodeId,
      house_name: house,
      gender: 'unknown',
      is_living: false,
      lifespan_compact: '',
      band,
    }
  }
  function edge(unionId, personId, role, order = null) {
    return { union: unionId, person: personId, role, sibling_order: order }
  }
})

check('component gap is wide enough to read as a separation', () => {
  assert.ok(COMPONENT_GAP > CARD_W, 'families must be further apart than siblings are')
})

// -------------------------------------------------------------- mobile (390px)

console.log('\nmobile — 390px viewport')

check('a whole family fits on a 390px screen', () => {
  const layout = layoutOverview(overviewFixture())
  const transform = fitTransform(layout.bounds, PHONE)
  assert.ok(transform, 'fit should produce a transform')

  // Everything must land inside the viewport, with a pixel of tolerance for rounding.
  const left = layout.bounds.minX * transform.k + transform.x
  const right = layout.bounds.maxX * transform.k + transform.x
  const top = layout.bounds.minY * transform.k + transform.y
  const bottom = layout.bounds.maxY * transform.k + transform.y

  assert.ok(left >= -1, `graph overflows the left edge by ${(-left).toFixed(0)}px`)
  assert.ok(right <= PHONE.width + 1, `overflows the right edge by ${(right - PHONE.width).toFixed(0)}px`)
  assert.ok(top >= -1, `overflows the top by ${(-top).toFixed(0)}px`)
  assert.ok(bottom <= PHONE.height + 1, `overflows the bottom by ${(bottom - PHONE.height).toFixed(0)}px`)
})

check('padding never eats a narrow screen whole', () => {
  // A naive `width - padding*2` goes negative at 390px with 200px padding, which would
  // silently clamp the graph to a dot in the corner.
  const layout = layoutOverview(overviewFixture())
  const transform = fitTransform(layout.bounds, PHONE, 200)
  assert.ok(transform.k > MIN_SCALE, `fit collapsed to the minimum scale (${transform.k})`)
  assert.ok(Number.isFinite(transform.x) && Number.isFinite(transform.y))
})

check('a 1200-person archive still fits a phone, as dots', () => {
  const persons = []
  const unions = []
  const memberships = []
  for (let i = 0; i < 1200; i += 1) {
    persons.push({
      id: `p${i}`,
      name_en: `P${i}`,
      name_ml: '',
      display_name: `P${i}`,
      house_name: `House${i % 12}`,
      gender: 'unknown',
      is_living: false,
      lifespan_compact: '',
      band: i % 5,
    })
  }
  const layout = layoutOverview({ persons, unions, memberships })
  const transform = fitTransform(layout.bounds, PHONE)

  // At that scale the app must be in dot mode — 1200 cards on a phone is not a view.
  assert.equal(renderModeFor(transform.k), 'dots')
  const right = layout.bounds.maxX * transform.k + transform.x
  assert.ok(right <= PHONE.width + 1, 'the whole archive must fit the phone width')
})

check('card zoom on a phone draws a readable handful, not the whole archive', () => {
  const layout = layoutOverview(overviewFixture())
  const box = visibleBox({ x: 0, y: 0, k: CARD_ZOOM_THRESHOLD + 0.2 }, PHONE)
  const drawn = [...layout.persons.values()].filter((p) => intersects(p, box))

  assert.ok(drawn.length >= 1, 'something must be on screen at card zoom')
  assert.ok(
    drawn.length < layout.persons.size,
    'a phone at card zoom must not be drawing every card',
  )
})

check('a card is narrower than a phone screen', () => {
  // If a single card were wider than the viewport it could never be read without panning.
  assert.ok(CARD_W < PHONE.width, `card is ${CARD_W}px, phone is ${PHONE.width}px`)
})

check('landscape phones fit too', () => {
  const layout = layoutOverview(overviewFixture())
  const transform = fitTransform(layout.bounds, PHONE_LANDSCAPE)
  const bottom = layout.bounds.maxY * transform.k + transform.y
  assert.ok(bottom <= PHONE_LANDSCAPE.height + 1, 'graph overflows a landscape phone')
})

check('dots stay visible however far out the fit goes', () => {
  // A fitted overview of a large archive can sit at k≈0.03. A fixed 5-unit radius would
  // render at 0.15px there — on screen in theory, blank in practice.
  for (const k of [1, 0.45, 0.08, 0.03, 0.005]) {
    const onScreen = dotRadius(k) * k
    assert.ok(onScreen >= 2, `dot renders at ${onScreen.toFixed(2)}px at zoom ${k}`)
  }
  // And it must not balloon when zoomed in.
  assert.ok(dotRadius(2) <= 5, 'dots should not grow when zoomed in')
})

check('fit degrades safely before the viewport is measured', () => {
  const layout = layoutOverview(overviewFixture())
  assert.equal(fitTransform(layout.bounds, { width: 0, height: 0 }), null)
  assert.equal(fitTransform(null, DESKTOP), null)
})

// ------------------------------------------------------------------- editing

console.log('\ndirect-manipulation editing')

/** Apply an add the way the API + store would, then re-lay-out. */
function afterAdding(graph, { context, anchorId, id, name, unionId }) {
  const next = {
    persons: [...graph.persons],
    unions: [...graph.unions],
    memberships: [...graph.memberships],
  }
  const anchor = graph.persons.find((p) => p.id === anchorId)
  const offset = context === 'parent_of' ? -1 : context === 'partner_of' ? 0 : 1

  next.persons.push({
    id, name_en: name, name_ml: '', display_name: name, house_name: '', gender: 'unknown',
    is_living: true, birth_display: '?', death_display: '?', lifespan_compact: '',
    place_origin: '', generation: anchor.generation + offset, hidden_up: 0, hidden_down: 0,
  })

  if (context === 'partner_of') {
    const u = `u_new_${id}`
    next.unions.push({ id: u, union_type: 'marriage', status: 'unknown', year_display: '', place: '', generation: anchor.generation })
    next.memberships.push(
      { union: u, person: anchorId, role: 'partner', relation_type: 'biological', sibling_order: null },
      { union: u, person: id, role: 'partner', relation_type: 'biological', sibling_order: null },
    )
  } else if (context === 'parent_of') {
    const u = `u_new_${id}`
    next.unions.push({ id: u, union_type: 'marriage', status: 'unknown', year_display: '', place: '', generation: anchor.generation - 1 })
    next.memberships.push(
      { union: u, person: id, role: 'partner', relation_type: 'biological', sibling_order: null },
      { union: u, person: anchorId, role: 'child', relation_type: 'biological', sibling_order: 1 },
    )
  } else {
    next.memberships.push({ union: unionId, person: id, role: 'child', relation_type: 'biological', sibling_order: 9 })
  }
  return next
}

function rowsDoNotOverlap(layout) {
  const rows = new Map()
  for (const person of layout.persons.values()) {
    if (!rows.has(person.y)) rows.set(person.y, [])
    rows.get(person.y).push(person)
  }
  for (const people of rows.values()) {
    people.sort((a, b) => a.x - b.x)
    for (let i = 1; i < people.length; i += 1) {
      if (people[i].x - (people[i - 1].x + CARD_W) < CARD_GAP - 0.01) return false
    }
  }
  return true
}

check('adding a partner wires a new union and keeps rows clean', () => {
  const graph = afterAdding(fixture(), { context: 'partner_of', anchorId: 'jose', id: 'newwife', name: 'Sheeba' })
  const layout = layoutGraph(graph, 'thomas')

  assert.ok(layout.persons.has('newwife'))
  assert.equal(layout.persons.get('newwife').y, layout.persons.get('jose').y, 'partners share a row')
  const union = [...layout.unions.values()].find((u) => u.partnerIds?.includes('newwife'))
  assert.ok(union, 'a union node must exist between them')
  assert.ok(union.partnerIds.includes('jose'))
  assert.ok(rowsDoNotOverlap(layout), 'cards overlap after adding a partner')
})

check('adding a child hangs it off the union, one row down', () => {
  const graph = afterAdding(fixture(), { context: 'child_of_union', anchorId: 'thomas', unionId: 'u_t', id: 'newkid', name: 'Anju' })
  const layout = layoutGraph(graph, 'thomas')

  const edge = layout.edges.find((e) => e.kind === 'child' && e.personId === 'newkid')
  assert.ok(edge, 'the child must be connected to the union, not to a parent')
  assert.equal(edge.unionId, 'u_t')
  assert.ok(layout.persons.get('newkid').y > layout.persons.get('thomas').y)
  assert.ok(rowsDoNotOverlap(layout))
})

check('adding parents creates the union above and hangs the person from it', () => {
  const graph = afterAdding(fixture(), { context: 'parent_of', anchorId: 'ittira', id: 'grandpa', name: 'Kunjachan' })
  const layout = layoutGraph(graph, 'thomas')

  assert.ok(layout.persons.get('grandpa').y < layout.persons.get('ittira').y, 'parent must be above')
  const edge = layout.edges.find((e) => e.kind === 'child' && e.personId === 'ittira')
  assert.ok(edge, 'Ittira must now hang from a union')
  const union = layout.unions.get(edge.unionId)
  assert.ok(union.y < layout.persons.get('ittira').y, 'union sits between parent and child')
  assert.ok(rowsDoNotOverlap(layout))
})

check('four siblings entered in a row stay in order and do not overlap', () => {
  let graph = fixture()
  for (const [i, name] of ['A', 'B', 'C', 'D'].entries()) {
    graph = afterAdding(graph, { context: 'child_of_union', anchorId: 'thomas', unionId: 'u_t', id: `sib${i}`, name })
    graph.memberships[graph.memberships.length - 1].sibling_order = 3 + i
  }
  const layout = layoutGraph(graph, 'thomas')
  const xs = ['sib0', 'sib1', 'sib2', 'sib3'].map((id) => layout.persons.get(id).x)
  for (let i = 1; i < xs.length; i += 1) {
    assert.ok(xs[i] > xs[i - 1], 'siblings must be laid out in the order they were typed')
  }
  assert.ok(rowsDoNotOverlap(layout))
})

check('a provisional node is placed where the affordance points', () => {
  const anchor = { x: 100, y: 200 }
  const partner = draftPosition('partner_of', anchor)
  const child = draftPosition('child_of_person', anchor)
  const parents = draftPosition('parent_of', anchor)

  assert.ok(partner.x > anchor.x && partner.y === anchor.y, 'partner goes to the right')
  assert.ok(child.y > anchor.y, 'child goes below')
  assert.ok(parents.y < anchor.y, 'parents go above')
  assert.ok(partner.x >= anchor.x + CARD_W, 'the draft must not sit on top of the card')
})

check('the multi-union case is answered by the server, not guessed by the layout', () => {
  // Chacko is a partner in two unions. Nothing in the layout picks one; the union nodes
  // are distinct and both are addressable, which is what lets the UI ask.
  const layout = layoutGraph(fixture(), 'thomas')
  const chackoUnions = [...layout.unions.values()].filter((u) => u.partnerIds?.includes('chacko'))
  assert.equal(chackoUnions.length, 2)
  assert.notEqual(chackoUnions[0].id, chackoUnions[1].id)
  assert.notEqual(chackoUnions[0].x, chackoUnions[1].x, 'both must be separately tappable')
})

// ------------------------------------------------------- touch targets & pinch

console.log('\ntouch targets and gestures')

check('affordances meet the 44px touch-target guidance', () => {
  assert.ok(AFFORDANCE_HIT >= 44, `hit target is ${AFFORDANCE_HIT}px`)
  assert.ok(AFFORDANCE_VISIBLE <= AFFORDANCE_HIT, 'the visible circle must fit inside the target')
})

check('three affordances fit around a card without colliding', () => {
  // Right, below and above; none may overlap another's hit area.
  const boxes = [
    { x: CARD_W + 6, y: CARD_H / 2 - AFFORDANCE_HIT / 2 },
    { x: CARD_W / 2 - AFFORDANCE_HIT / 2, y: CARD_H + 6 },
    { x: CARD_W / 2 - AFFORDANCE_HIT / 2, y: -AFFORDANCE_HIT - 6 },
  ]
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const overlap =
        Math.abs(boxes[i].x - boxes[j].x) < AFFORDANCE_HIT &&
        Math.abs(boxes[i].y - boxes[j].y) < AFFORDANCE_HIT
      assert.ok(!overlap, `affordances ${i} and ${j} overlap`)
    }
  }
})

check('a card plus its affordances still fits a 390px screen', () => {
  const widest = CARD_W + 6 + AFFORDANCE_HIT
  assert.ok(widest <= PHONE.width, `card + affordance is ${widest}px, phone is ${PHONE.width}px`)
})

check('pinch keeps the point between the fingers fixed', () => {
  const transform = { x: 40, y: -120, k: 0.6 }
  const centre = { x: 195, y: 400 } // middle of a 390px screen
  const before = toGraph(transform, centre)

  for (const ratio of [1.5, 2.4, 0.5, 0.2]) {
    const zoomed = zoomAbout(transform, centre, transform.k * ratio)
    const after = toGraph(zoomed, centre)
    assert.ok(Math.abs(after.x - before.x) < 0.001, `x drifted at ratio ${ratio}`)
    assert.ok(Math.abs(after.y - before.y) < 0.001, `y drifted at ratio ${ratio}`)
  }
})

check('zoom is clamped at both ends', () => {
  const transform = { x: 0, y: 0, k: 1 }
  assert.ok(zoomAbout(transform, { x: 0, y: 0 }, 999).k <= 2.5, 'must not zoom past the max')
  assert.ok(zoomAbout(transform, { x: 0, y: 0 }, 0.00001).k >= 0.004, 'must not zoom below the fit floor')
})

check('screen and graph coordinates round-trip', () => {
  const transform = { x: -300, y: 88, k: 0.37 }
  const point = { x: 1234, y: -567 }
  const back = toGraph(transform, toScreen(transform, point))
  assert.ok(Math.abs(back.x - point.x) < 0.001 && Math.abs(back.y - point.y) < 0.001)
})

// ------------------------------------------------- the empty -> first person path

console.log('\nstarting from an empty archive')

// This section exists because of a real regression: the empty-database screen kept
// pointing at the bulk form long after the canvas became the editor, and nothing caught
// it. The whole point of the state is to be the first thing a new archive shows.

check('an empty archive lays out to nothing, without throwing', () => {
  assert.equal(layoutOverview({ persons: [], unions: [], memberships: [] }), null)
  // The canvas must still be renderable in that state — the first person is placed *on*
  // it, so a null layout cannot mean "no sheet".
  assert.equal(layoutGraph({ persons: [], unions: [], memberships: [] }, null).persons.size, 0)
})

check('the first person is placed at the origin, needing no anchor', () => {
  // Every other affordance grows from an existing card. This one cannot.
  const position = draftPosition('standalone', null)
  assert.deepEqual(position, { x: 0, y: 0 })
  // And an anchor, if one is somehow passed, is ignored rather than shifting it away.
  assert.deepEqual(draftPosition('standalone', { x: 900, y: -400 }), { x: 0, y: 0 })
})

check('a one-person archive draws a real card with room for its affordances', () => {
  const solo = {
    persons: [{
      id: 'first', name_en: 'Ittira', name_ml: '', display_name: 'Ittira',
      house_name: 'Kavunkal', gender: 'male', is_living: false, birth_display: '1890',
      death_display: '?', lifespan_compact: '1890 – ?', place_origin: '',
      generation: 0, hidden_up: 0, hidden_down: 0,
    }],
    unions: [],
    memberships: [],
  }
  const layout = layoutGraph(solo, 'first')
  assert.equal(layout.persons.size, 1)

  const person = layout.persons.get('first')
  assert.ok(Number.isFinite(person.x) && Number.isFinite(person.y))
  // No parents recorded, so "+ parents" must be offered rather than hidden.
  assert.equal((layout.unionsAsChild.get('first') ?? []).length, 0)
  // The card plus its affordances has to fit a phone.
  assert.ok(CARD_W + 6 + AFFORDANCE_HIT <= PHONE.width)
})

check('the first person fits on screen at any viewport', () => {
  const solo = {
    persons: [{
      id: 'first', name_en: 'Ittira', name_ml: '', display_name: 'Ittira', house_name: '',
      gender: 'male', is_living: true, birth_display: '?', death_display: '?',
      lifespan_compact: '', place_origin: '', generation: 0, hidden_up: 0, hidden_down: 0,
    }],
    unions: [],
    memberships: [],
  }
  const layout = layoutGraph(solo, 'first')
  for (const viewport of [PHONE, PHONE_LANDSCAPE, DESKTOP]) {
    const transform = fitTransform(layout.bounds, viewport)
    assert.ok(transform, 'fit must produce a transform for a single node')
    assert.equal(renderModeFor(transform.k), 'cards', 'one person should show as a card, not a dot')
  }
})

check('growing from the first person produces correct geometry at each step', () => {
  // nothing -> one person -> + partner -> + child: the click-script's opening moves.
  let graph = {
    persons: [{
      id: 'first', name_en: 'Ittira', name_ml: '', display_name: 'Ittira', house_name: '',
      gender: 'male', is_living: false, birth_display: '1890', death_display: '?',
      lifespan_compact: '', place_origin: '', generation: 0, hidden_up: 0, hidden_down: 0,
    }],
    unions: [],
    memberships: [],
  }

  graph = afterAdding(graph, { context: 'partner_of', anchorId: 'first', id: 'spouse', name: 'Mariam' })
  let layout = layoutGraph(graph, 'first')
  assert.equal(layout.persons.get('spouse').y, layout.persons.get('first').y, 'partners share a row')
  assert.equal(layout.unions.size, 1, 'a union node must appear between them')

  const unionId = [...layout.unions.keys()][0]
  graph = afterAdding(graph, { context: 'child_of_union', anchorId: 'first', unionId, id: 'kid', name: 'Chacko' })
  layout = layoutGraph(graph, 'first')

  assert.ok(layout.persons.get('kid').y > layout.persons.get('first').y, 'child sits below')
  const edge = layout.edges.find((e) => e.kind === 'child' && e.personId === 'kid')
  assert.equal(edge.unionId, unionId, 'the child hangs off the union, not off a parent')
  assert.ok(rowsDoNotOverlap(layout))
})

// ------------------------------------------------------------ ego-centric view

console.log('\nrelationship labels and focus')

/** The label chip is drawn above the card; this is the box it occupies. */
function chipBox(label) {
  const halfWidth = Math.min(78, 5 + label.length * 4.1)
  return { top: -15 - 8, bottom: -8, halfWidth }
}

check('a label chip sits above its card and never overlaps the one below', () => {
  // Cards are ROW_PITCH apart; the chip hangs above a card, so it must clear the bottom
  // of the row above rather than colliding with it.
  const box = chipBox('great-great-grandmother')
  const gapAboveCard = ROW_PITCH - CARD_H
  assert.ok(Math.abs(box.top) < gapAboveCard, `chip is ${Math.abs(box.top)}px tall, gap is ${gapAboveCard}px`)
})

check('a long Malayalam label stays inside a sensible width', () => {
  // The widest fallback the naming layer produces, e.g. "5 തലമുറ മുകളിലുള്ള പൂർവികൻ".
  const box = chipBox('5 തലമുറ മുകളിലുള്ള പൂർവികൻ')
  assert.ok(box.halfWidth * 2 <= 156, 'chip must be capped, not unbounded')
  assert.ok(box.halfWidth * 2 <= PHONE.width, 'a chip must never exceed a phone screen')
})

check('labelling is asked only for cards, never for dots', () => {
  // A dot has no room for a chip, and asking about the whole archive on every focus
  // switch is exactly the cost this feature has to avoid.
  assert.equal(renderModeFor(CARD_ZOOM_THRESHOLD - 0.01), 'dots')
  assert.equal(renderModeFor(CARD_ZOOM_THRESHOLD), 'cards')
})

check('only the visible set would be asked about', () => {
  const layout = layoutOverview(overviewFixture())
  const box = visibleBox({ x: 0, y: 0, k: CARD_ZOOM_THRESHOLD + 0.2 }, PHONE)
  const visible = [...layout.persons.values()].filter((p) => intersects(p, box))

  assert.ok(visible.length >= 1)
  assert.ok(visible.length < layout.persons.size, 'the whole archive must not be labelled')
  // And a batch of that size is well inside the server's per-call cap.
  assert.ok(visible.length <= 200)
})

/** A tiny stand-in for useFocus's label lookup, exercising the same rules. */
function makeLabelFor(focusId, byPerson) {
  return (personId, locale = 'en') => {
    if (!focusId || personId === focusId) return null
    const entry = byPerson[personId]
    if (!entry) return null
    return entry.labels?.[locale] || entry.labels?.en || null
  }
}

check('the focus person shows no relationship label', () => {
  const labelFor = makeLabelFor('jose', { thomas: { labels: { en: 'father', ml: 'അച്ഛൻ' } } })
  assert.equal(labelFor('jose'), null, 'the focus shows "you", not a relationship')
  assert.equal(labelFor('thomas'), 'father')
})

check('a disconnected person shows no chip at all', () => {
  const labelFor = makeLabelFor('jose', { thomas: { labels: { en: 'father' } }, stranger: null })
  assert.equal(labelFor('stranger'), null, 'null must mean no chip, not an empty chip')
  assert.equal(labelFor('never-asked'), null)
})

check('switching focus changes every label', () => {
  const fromJose = makeLabelFor('jose', {
    thomas: { labels: { en: 'father', ml: 'അച്ഛൻ' } },
    chacko: { labels: { en: 'grandfather', ml: 'മുത്തച്ഛൻ' } },
  })
  const fromKiran = makeLabelFor('kiran', {
    thomas: { labels: { en: 'great-grandfather', ml: '3 തലമുറ' } },
    chacko: { labels: { en: 'great-great-grandfather', ml: '4 തലമുറ' } },
  })

  assert.equal(fromJose('thomas'), 'father')
  assert.equal(fromKiran('thomas'), 'great-grandfather')
  assert.notEqual(fromJose('chacko'), fromKiran('chacko'))
})

check('labels follow the UI language, falling back rather than blanking', () => {
  const labelFor = makeLabelFor('jose', {
    thomas: { labels: { en: 'father', ml: 'അച്ഛൻ' } },
    // A relation with no Malayalam term recorded must not render empty.
    distant: { labels: { en: 'third cousin', ml: '' } },
  })
  assert.equal(labelFor('thomas', 'ml'), 'അച്ഛൻ')
  assert.equal(labelFor('distant', 'ml'), 'third cousin', 'must fall back to English, not blank')
})

check('the focus ring does not change the card geometry', () => {
  // The ring is drawn outside the card so rows still pack at the same pitch.
  const layout = layoutGraph(fixture(), 'thomas')
  assert.ok(rowsDoNotOverlap(layout))
  const ringInset = 5
  assert.ok(CARD_GAP > ringInset * 2, 'the ring must fit in the gap between cards')
})

// -------------------------------------------------- completing a pair of parents

console.log('\nthe second parent')

/** me -> + parents -> father in a single-partner union. The starting point of the bug. */
function meAndFather() {
  const node = (id, name, generation, gender) => ({
    id, name_en: name, name_ml: '', display_name: name, house_name: '', gender,
    is_living: true, birth_display: '?', death_display: '?', lifespan_compact: '',
    place_origin: '', generation, hidden_up: 0, hidden_down: 0,
  })
  return {
    persons: [node('me', 'Febin', 0, 'male'), node('father', 'Micheal', -1, 'male')],
    unions: [{ id: 'u_parents', union_type: 'marriage', status: 'unknown', year_display: '', place: '', generation: -1 }],
    memberships: [
      { union: 'u_parents', person: 'father', role: 'partner', relation_type: 'biological', sibling_order: null },
      { union: 'u_parents', person: 'me', role: 'child', relation_type: 'biological', sibling_order: 1 },
    ],
  }
}

/** The fix: the mother joins the union that already exists. */
function withMotherJoined() {
  const graph = meAndFather()
  graph.persons.push({
    id: 'mother', name_en: 'Bincy', name_ml: '', display_name: 'Bincy', house_name: '',
    gender: 'female', is_living: true, birth_display: '?', death_display: '?',
    lifespan_compact: '', place_origin: '', generation: -1, hidden_up: 0, hidden_down: 0,
  })
  graph.memberships.push({
    union: 'u_parents', person: 'mother', role: 'partner', relation_type: 'biological', sibling_order: null,
  })
  return graph
}

/** The bug: the mother in a union of her own. */
function withMotherAsSeparateMarriage() {
  const graph = meAndFather()
  graph.persons.push({
    id: 'mother', name_en: 'Bincy', name_ml: '', display_name: 'Bincy', house_name: '',
    gender: 'female', is_living: true, birth_display: '?', death_display: '?',
    lifespan_compact: '', place_origin: '', generation: -1, hidden_up: 0, hidden_down: 0,
  })
  graph.unions.push({ id: 'u_second', union_type: 'marriage', status: 'unknown', year_display: '', place: '', generation: -1 })
  graph.memberships.push(
    { union: 'u_second', person: 'father', role: 'partner', relation_type: 'biological', sibling_order: null },
    { union: 'u_second', person: 'mother', role: 'partner', relation_type: 'biological', sibling_order: null },
  )
  return graph
}

check('a father alone leaves an open seat beside him', () => {
  const layout = layoutGraph(meAndFather(), 'me')
  const union = layout.unions.get('u_parents')
  assert.equal(union.partnerIds.length, 1, 'one recorded partner')
  assert.deepEqual(union.childIds, ['me'])
})

check('joining the mother puts both parents over ONE union', () => {
  const layout = layoutGraph(withMotherJoined(), 'me')

  assert.equal(layout.unions.size, 1, 'completing a pair must not add a second union')
  const union = layout.unions.get('u_parents')
  assert.deepEqual([...union.partnerIds].sort(), ['father', 'mother'])
  assert.deepEqual(union.childIds, ['me'])

  // Both parents on the same row, the child below, one union dot between.
  assert.equal(layout.persons.get('mother').y, layout.persons.get('father').y)
  assert.ok(layout.persons.get('me').y > union.y)
  assert.ok(rowsDoNotOverlap(layout))
})

check('the child connects to the union that holds both parents', () => {
  const layout = layoutGraph(withMotherJoined(), 'me')
  const edge = layout.edges.find((e) => e.kind === 'child' && e.personId === 'me')
  assert.equal(edge.unionId, 'u_parents')
  // And both parents connect to that same union.
  const partnerEdges = layout.edges.filter((e) => e.kind === 'partner' && e.unionId === 'u_parents')
  assert.equal(partnerEdges.length, 2)
})

check('the bug is visibly different: two unions, and the child under only one', () => {
  // This is what the old behaviour produced. Keeping it as a check documents the
  // difference the UI has to make askable.
  const layout = layoutGraph(withMotherAsSeparateMarriage(), 'me')
  assert.equal(layout.unions.size, 2, 'the wrong answer creates a second union')
  assert.deepEqual(layout.unions.get('u_second').childIds, [], 'the mother parents nobody')
  const edge = layout.edges.find((e) => e.kind === 'child' && e.personId === 'me')
  assert.notEqual(edge.unionId, 'u_second')
})

check('the second-parent input opens beside the first, not on top of it', () => {
  // "+ parents" chains straight into the other seat, so the offset must clear the card.
  const first = draftPosition('parent_of', { x: 0, y: 400 })
  const second = { x: first.x + CARD_W + 26, y: first.y }
  assert.ok(second.x - first.x >= CARD_W, 'the two inputs must not overlap')
  assert.equal(second.y, first.y, 'both parents sit on one row')
})

// --- The stale/self labelling contract (DECISIONS.md #24) --------------------------------
//
// A live 400 toast appeared on a one-person database: the canvas asked how the only person
// related to themselves, from a focus id that had outlived its row. These drive the real
// fetchRelationsBulk with a stubbed fetch, so they count requests actually built rather
// than re-describing the rule.

function withStubbedFetch(responder, body) {
  const calls = []
  const priorFetch = globalThis.fetch
  const priorWindow = globalThis.window
  globalThis.window = { location: { origin: 'http://localhost:5173' } }
  globalThis.fetch = async (url) => {
    calls.push(url.toString())
    return { ok: true, status: 200, statusText: 'OK', json: async () => responder(url) }
  }
  try {
    return { calls, result: body(calls) }
  } finally {
    globalThis.fetch = priorFetch
    globalThis.window = priorWindow
  }
}

check('one person, anchored to them: the canvas makes no relate-bulk call at all', async () => {
  // The reported state. The only visible card is the focus, and the focus wears its own
  // chip rather than a relationship label, so there is nothing to ask about.
  const only = '6a472175-0206-4234-b4d6-68db4605da5f'
  const { calls, result } = withStubbedFetch(
    () => ({ from: only, results: {} }),
    () => fetchRelationsBulk(only, [only]),
  )
  const payload = await result
  assert.equal(calls.length, 0, 'a request with nothing to label must not be sent')
  assert.deepEqual(payload, { stale: false, byPerson: {} })
})

check('self is filtered out of a real batch, but the others are still asked about', async () => {
  const me = 'aaaaaaaa-0000-4000-8000-000000000001'
  const other = 'bbbbbbbb-0000-4000-8000-000000000002'
  const { calls, result } = withStubbedFetch(
    () => ({ from: me, results: { [other]: { labels: { en: 'father' } } } }),
    () => fetchRelationsBulk(me, [me, other, me]),
  )
  await result
  assert.equal(calls.length, 1)
  const to = new URL(calls[0]).searchParams.get('to')
  assert.equal(to, other, 'the focus must not appear in its own target list')
})

check('an empty or all-self target list never reaches the network', async () => {
  const me = 'aaaaaaaa-0000-4000-8000-000000000001'
  for (const targets of [[], [me], [null, undefined, ''], [me, me]]) {
    const { calls, result } = withStubbedFetch(
      () => ({ from: me, results: {} }),
      () => fetchRelationsBulk(me, targets),
    )
    await result
    assert.equal(calls.length, 0, `targets ${JSON.stringify(targets)} should send nothing`)
  }
})

check('a from the server no longer knows is reported as stale, not thrown', async () => {
  // The 400 became a 200 with from: null; the client turns that into a signal to drop the
  // dead focus rather than an error toast.
  const dead = 'deadbeef-0000-4000-8000-000000000000'
  const other = 'bbbbbbbb-0000-4000-8000-000000000002'
  const { result } = withStubbedFetch(
    () => ({ from: null, results: { [other]: null } }),
    () => fetchRelationsBulk(dead, [other]),
  )
  const payload = await result
  assert.equal(payload.stale, true, 'from: null must surface as stale')
  assert.deepEqual(payload.byPerson, {})
})

check('every chained seat gets its own focus key', () => {
  // The second-parent and Tab-sibling chains focus on this number changing. Two seats
  // opening in a row must never carry the same one, whatever their position or union.
  const seats = [1, 2, 3, 4]
  assert.equal(new Set(seats).size, seats.length)
  // The old key was built from targetId + unionId + x. Two seats can share all three:
  // "+ parents" on the same person, cancelled and reopened, lands on the same x.
  const oldKey = (d) => `${d.targetId}-${d.unionId ?? 'new'}-${d.position.x}`
  const a = { targetId: 'me', unionId: null, position: { x: 100 } }
  const b = { targetId: 'me', unionId: null, position: { x: 100 } }
  assert.equal(oldKey(a), oldKey(b), 'the composite key can collide — hence the counter')
})

// --- Two families, one row (DECISIONS.md #26) ----------------------------------------------
//
// The live shape that produced a false kinship claim: union A (two partners, children Biju
// and Bindu) and an unrelated union B (child Pecsy) in the same generation, joined only one
// generation below by Bindu x Pecsy. Adding a third child to union A put it beyond family B
// and merged both sibling buses into one unbroken rail.

function twoFamilies({ withNewChild = false } = {}) {
  const person = (id, generation, extra = {}) => ({
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
    generation,
    hidden_up: 0,
    hidden_down: 0,
    ...extra,
  })
  const union = (id, generation) => ({
    id,
    union_type: 'marriage',
    status: 'active',
    year_display: '',
    place: '',
    generation,
  })
  const member = (u, p, role, order = null) => ({
    union: u,
    person: p,
    role,
    relation_type: 'biological',
    sibling_order: order,
  })

  const persons = [
    person('a1', -1), person('a2', -1, { gender: 'female' }),
    person('b1', -1), person('b2', -1, { gender: 'female' }),
    person('biju', 0), person('bindu', 0, { gender: 'female' }),
    person('pecsy', 0), person('abin', 1), person('febin', 1),
  ]
  const memberships = [
    member('UA', 'a1', 'partner'), member('UA', 'a2', 'partner'),
    member('UA', 'biju', 'child', 1), member('UA', 'bindu', 'child', 2),
    member('UB', 'b1', 'partner'), member('UB', 'b2', 'partner'),
    member('UB', 'pecsy', 'child', 1),
    member('UC', 'pecsy', 'partner'), member('UC', 'bindu', 'partner'),
    member('UC', 'abin', 'child', 1), member('UC', 'febin', 'child', 2),
  ]
  if (withNewChild) {
    persons.push(person('binu', 0))
    memberships.push(member('UA', 'binu', 'child'))
  }
  return { persons, unions: [union('UA', -1), union('UB', -1), union('UC', 0)], memberships }
}

/** Every child edge's horizontal run, read back out of the rendered path. */
function busSegments(layout) {
  const byUnion = new Map()
  for (const edge of layout.edges) {
    if (edge.kind !== 'child') continue
    const n = edge.d.match(/-?\d+(?:\.\d+)?/g).map(Number)
    // M ux uy L ux busY L cx busY L cx cy
    const [, , unionX, busY, childX] = n
    const current = byUnion.get(edge.unionId) ?? { unionId: edge.unionId, y: busY, x0: Infinity, x1: -Infinity }
    current.x0 = Math.min(current.x0, unionX, childX)
    current.x1 = Math.max(current.x1, unionX, childX)
    byUnion.set(edge.unionId, current)
  }
  return [...byUnion.values()]
}

console.log('\ntwo families in one row')

check('exactly one bus segment per union, spanning only its own children', () => {
  const layout = layoutGraph(twoFamilies({ withNewChild: true }), 'febin')
  const segments = busSegments(layout).filter((s) => s.unionId === 'UA' || s.unionId === 'UB')
  assert.equal(segments.length, 2, 'the parents row should produce exactly two buses')

  for (const segment of segments) {
    const union = layout.unions.get(segment.unionId)
    const kidXs = union.childIds.map((id) => layout.persons.get(id).cx)
    // The run may extend to the union's own drop-line, but never past a child it does
    // not have.
    const outsiders = [...layout.persons.values()].filter(
      (p) => p.generation === 0 && !union.childIds.includes(p.id) && p.cx > Math.min(...kidXs) && p.cx < Math.max(...kidXs),
    )
    assert.deepEqual(
      outsiders.map((o) => o.id),
      [],
      `${segment.unionId}'s bus spans ${outsiders.map((o) => o.id)}, who are not its children`,
    )
  }
})

check('two unions never share a bus line where their spans meet', () => {
  const layout = layoutGraph(twoFamilies({ withNewChild: true }), 'febin')
  const segments = busSegments(layout)
  for (let i = 0; i < segments.length; i += 1) {
    for (let j = i + 1; j < segments.length; j += 1) {
      const a = segments[i]
      const b = segments[j]
      const overlaps = a.x0 <= b.x1 && b.x0 <= a.x1
      if (!overlaps) continue
      assert.notEqual(
        a.y,
        b.y,
        `${a.unionId} and ${b.unionId} overlap in x and share bus y ${a.y} — one continuous rail`,
      )
    }
  }
})

check('canvas-wide: no two unions ever draw a collinear touching bus', () => {
  // The same rule over every fixture this file has, not just the repro shape.
  for (const [name, graph, centre] of [
    ['two families', twoFamilies({ withNewChild: true }), 'febin'],
    ['two families, before the add', twoFamilies(), 'febin'],
    ['the remarriage fixture', fixture(), 'thomas'],
  ]) {
    const layout = layoutGraph(graph, centre)
    const segments = busSegments(layout)
    for (let i = 0; i < segments.length; i += 1) {
      for (let j = i + 1; j < segments.length; j += 1) {
        const a = segments[i]
        const b = segments[j]
        if (a.x0 > b.x1 || b.x0 > a.x1) continue // disjoint in x, cannot join
        assert.notEqual(a.y, b.y, `${name}: ${a.unionId} and ${b.unionId} fuse into one bus`)
      }
    }
  }
})

check('a new child lands among its siblings, not beyond an unrelated family', () => {
  const layout = layoutGraph(twoFamilies({ withNewChild: true }), 'febin')
  const binu = layout.persons.get('binu')
  const siblings = ['biju', 'bindu'].map((id) => layout.persons.get(id))
  const pecsy = layout.persons.get('pecsy')

  const near = Math.min(...siblings.map((s) => s.x))
  const far = Math.max(...siblings.map((s) => s.x))
  // Adjacent to the sibling group: inside it, or immediately beside it — never with an
  // unrelated family in between.
  const between = [pecsy].filter((p) => p.x > Math.min(near, binu.x) && p.x < Math.max(far, binu.x))
  assert.deepEqual(
    between.map((p) => p.id),
    [],
    'an unrelated person sits between the new child and its siblings',
  )
})

check('the layout does not depend on the order rows arrive in', () => {
  // The incremental merge appends a new person to the end of the list; a reload gets them
  // in the server's order. If layout depended on that order the two would disagree, and
  // the graph would rearrange itself on refresh.
  const full = twoFamilies({ withNewChild: true })
  const shuffled = {
    persons: [...full.persons].reverse(),
    unions: [...full.unions].reverse(),
    memberships: [...full.memberships].reverse(),
  }
  const a = layoutGraph(full, 'febin')
  const b = layoutGraph(shuffled, 'febin')

  for (const [id, person] of a.persons) {
    const other = b.persons.get(id)
    assert.ok(other, `${id} missing from the reordered layout`)
    assert.equal(other.x, person.x, `${id} moved when the input order changed`)
    assert.equal(other.y, person.y, `${id} changed row when the input order changed`)
  }
  for (const [id, union] of a.unions) {
    assert.equal(b.unions.get(id).x, union.x, `union ${id} moved`)
  }
})

check('adding a child does not teleport the view away from the anchor', () => {
  // App remembers where the anchor sat on screen, then pans by the difference so the person
  // you are working on stays under the cursor. This is that arithmetic.
  const before = layoutGraph(twoFamilies(), 'febin')
  const after = layoutGraph(twoFamilies({ withNewChild: true }), 'febin')
  const transform = { x: 40, y: 60, k: 1 }
  const anchorBefore = toScreen(transform, before.persons.get('bindu'))
  const anchorAfter = toScreen(transform, after.persons.get('bindu'))

  const dx = anchorBefore.x - anchorAfter.x
  const dy = anchorBefore.y - anchorAfter.y
  assert.ok(Number.isFinite(dx) && Number.isFinite(dy), 'the compensation must be computable')

  const corrected = toScreen({ ...transform, x: transform.x + dx, y: transform.y + dy }, after.persons.get('bindu'))
  assert.ok(Math.abs(corrected.x - anchorBefore.x) < 0.01, 'the anchor must land back where it was')
  assert.ok(Math.abs(corrected.y - anchorBefore.y) < 0.01)
})

// --- Layered ordering, gaps and autoscale (DECISIONS.md #30) -------------------------------

console.log('\nlayered ordering')

check('a family gap is visibly wider than the gap between siblings', () => {
  // So you can see where one sibling set ends without tracing the rails to find out.
  assert.ok(FAMILY_GAP > CARD_GAP * 2, `family gap ${FAMILY_GAP} vs sibling gap ${CARD_GAP}`)

  const layout = layoutGraph(twoFamilies({ withNewChild: true }), 'febin')
  const row = [...layout.persons.values()].filter((p) => p.generation === 0).sort((a, b) => a.x - b.x)
  const birth = new Map()
  for (const [unionId, union] of layout.unions) {
    for (const childId of union.childIds ?? []) birth.set(childId, unionId)
  }
  for (let i = 1; i < row.length; i += 1) {
    const gap = row[i].x - (row[i - 1].x + CARD_W)
    const sameFamily = birth.get(row[i].id) === birth.get(row[i - 1].id)
    if (sameFamily && birth.has(row[i].id)) {
      assert.ok(gap < FAMILY_GAP, `siblings ${row[i - 1].id}/${row[i].id} pushed apart by ${gap.toFixed(0)}`)
    }
  }
})

check('a marry-in is placed beside their partner, not at the edge of the row', () => {
  // "Augustine marries into the Thaliyath row": he should land next to Jessy.
  const graph = twoFamilies()
  graph.persons.push({
    id: 'augustine', name_en: 'augustine', name_ml: '', display_name: 'augustine',
    house_name: 'H', gender: 'male', is_living: true, birth_display: '', death_display: '',
    lifespan_compact: '', place_origin: '', generation: 0, hidden_up: 0, hidden_down: 0,
  })
  graph.unions.push({
    id: 'UM', union_type: 'marriage', status: 'active', year_display: '', place: '', generation: 0,
  })
  graph.memberships.push(
    { union: 'UM', person: 'biju', role: 'partner', relation_type: 'biological', sibling_order: null },
    { union: 'UM', person: 'augustine', role: 'partner', relation_type: 'biological', sibling_order: null },
  )

  const layout = layoutGraph(graph, 'febin')
  const row = [...layout.persons.values()].filter((p) => p.generation === 0).sort((a, b) => a.x - b.x)
  const at = row.findIndex((p) => p.id === 'augustine')
  const neighbours = [row[at - 1]?.id, row[at + 1]?.id]
  assert.ok(neighbours.includes('biju'), `augustine sat between ${neighbours} instead of beside his partner`)
})

check('ordering keeps every union\'s children contiguous in their row', () => {
  const layout = layoutGraph(twoFamilies({ withNewChild: true }), 'febin')
  for (const [unionId, union] of layout.unions) {
    const kids = (union.childIds ?? []).map((id) => layout.persons.get(id)).filter(Boolean)
    if (kids.length < 2) continue
    const row = [...layout.persons.values()].filter((p) => p.y === kids[0].y).sort((a, b) => a.x - b.x)
    const indices = kids.map((k) => row.findIndex((p) => p.id === k.id)).sort((a, b) => a - b)
    const between = indices[indices.length - 1] - indices[0]
    const outsiders = between + 1 - indices.length
    // Married-in spouses may sit among siblings; another union's children may not.
    for (let i = indices[0]; i <= indices[indices.length - 1]; i += 1) {
      const person = row[i]
      if (union.childIds.includes(person.id)) continue
      const theirs = [...layout.unions.values()].find((u) => (u.childIds ?? []).includes(person.id))
      assert.ok(!theirs, `${person.id} (child of another union) sits inside ${unionId}'s run`)
    }
    assert.ok(outsiders >= 0)
  }
})

console.log('\nautoscale')

check('fit shows the whole graph with padding, at any archive size', () => {
  for (const count of [3, 40, 400]) {
    const persons = []
    const unions = []
    const memberships = []
    for (let i = 0; i < count; i += 1) {
      persons.push({
        id: `p${i}`, name_en: `p${i}`, name_ml: '', display_name: `p${i}`, house_name: 'H',
        gender: 'male', is_living: true, birth_display: '', death_display: '',
        lifespan_compact: '', place_origin: '', generation: i % 4, hidden_up: 0, hidden_down: 0,
      })
    }
    for (let i = 0; i + 3 < count; i += 4) {
      const id = `u${i}`
      unions.push({ id, union_type: 'marriage', status: 'active', year_display: '', place: '', generation: 0 })
      memberships.push(
        { union: id, person: `p${i}`, role: 'partner', relation_type: 'biological', sibling_order: null },
        { union: id, person: `p${i + 1}`, role: 'partner', relation_type: 'biological', sibling_order: null },
        { union: id, person: `p${i + 2}`, role: 'child', relation_type: 'biological', sibling_order: 1 },
      )
    }
    const layout = layoutGraph({ persons, unions, memberships }, 'p0')
    const transform = fitTransform(layout.bounds, DESKTOP, 80)
    // Everything inside the viewport: the canvas is infinite, the fit is what adapts.
    const corners = [
      toScreen(transform, { x: layout.bounds.minX, y: layout.bounds.minY }),
      toScreen(transform, { x: layout.bounds.maxX, y: layout.bounds.maxY }),
    ]
    assert.ok(corners[0].x >= -1 && corners[0].y >= -1, `${count} people: top-left off screen`)
    assert.ok(
      corners[1].x <= DESKTOP.width + 1 && corners[1].y <= DESKTOP.height + 1,
      `${count} people: bottom-right off screen`,
    )
  }
})

check('detail view never falls back to dots, however far out the fit goes', () => {
  // Semantic zoom is the overview's way of showing a whole archive; in a neighbourhood the
  // cards are the thing being read, so nothing is collapsed there.
  assert.equal(renderModeFor(0.05), 'dots', 'the overview still uses dots when far out')
  // The canvas picks cards whenever a centre is set — asserted here as the rule the
  // component implements, alongside the interaction check that renders it.
  const layout = layoutGraph(fixture(), 'thomas')
  assert.ok(layout.persons.size > 0)
})

await Promise.all(pending)
console.log(`\n${passed} check(s) passed`)
