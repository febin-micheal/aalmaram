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

import { CARD_GAP, CARD_H, CARD_W, ROW_PITCH, findLinkingUnion, layoutGraph } from '../src/graph/layout.js'
import { AFFORDANCE_HIT, AFFORDANCE_VISIBLE } from '../src/components/affordance-metrics.js'
import { draftPosition } from '../src/graph/draftPlacement.js'
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
function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    console.error(`  ✗ ${name}\n    ${error.message}`)
    process.exitCode = 1
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

console.log(`\n${passed} check(s) passed`)
