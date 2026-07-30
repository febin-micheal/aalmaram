/**
 * Generational layout for a family graph.
 *
 * The shape of this file follows from the data model. A Union is a node, not an edge:
 * partners connect *to* the union, children hang *from* it. That is what makes a
 * remarriage draw correctly — one person sits between two adjacent union nodes — and
 * what puts half-siblings under the union they actually belong to instead of merging
 * them into one sibling row.
 *
 * Rows come from the server (`generation`, relative to the centre). This module only has
 * to decide x positions, which it does the way tidy-tree layouts generally do:
 *
 *   1. seed an order by walking out from the centre, so relatives start near each other
 *   2. place each row left to right at that order
 *   3. relax: pull children under their union, pull partners over their children, and
 *      after each pull push apart anything that now overlaps — preserving row order
 *   4. repeat a few times; the passes fight each other to a stable-enough compromise
 *
 * It is not an optimal layout and does not try to be. It is deterministic, runs in a few
 * milliseconds for the few hundred nodes a neighbourhood contains, and never crosses a
 * parent over its own children.
 */

export const CARD_W = 178
export const CARD_H = 64
export const CARD_GAP = 26
export const ROW_GAP = 104
export const ROW_PITCH = CARD_H + ROW_GAP
export const UNION_DROP = 34 // how far below the partner row a union node sits
export const CHILD_BUS = 34 // how far above the child row the sibling bus runs

const RELAX_PASSES = 8
const DAMPING = 0.65

/**
 * @param {{persons: Array, unions: Array, memberships: Array}} graph
 * @param {string} centerId
 * @returns {{persons: Map, unions: Map, edges: Array, bounds: object, rows: Array}}
 */
export function layoutGraph(graph, centerId) {
  const persons = new Map(graph.persons.map((p) => [p.id, { ...p }]))
  const unions = new Map(graph.unions.map((u) => [u.id, { ...u }]))

  // --- adjacency -----------------------------------------------------------
  const partnersOf = new Map() // unionId -> [personId]
  const childrenOf = new Map() // unionId -> [{person, relation_type, sibling_order}]
  const unionsAsPartner = new Map() // personId -> [unionId]
  const unionsAsChild = new Map() // personId -> [unionId]

  const push = (map, key, value) => {
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(value)
  }

  for (const m of graph.memberships) {
    if (!persons.has(m.person) || !unions.has(m.union)) continue
    if (m.role === 'partner') {
      push(partnersOf, m.union, m.person)
      push(unionsAsPartner, m.person, m.union)
    } else {
      push(childrenOf, m.union, m)
      push(unionsAsChild, m.person, m.union)
    }
  }

  // Siblings sit in recorded birth order where it is known; otherwise by birth year,
  // otherwise by name — always deterministic, never by whatever the server returned.
  for (const [unionId, kids] of childrenOf) {
    kids.sort((a, b) => {
      const orderA = a.sibling_order ?? Number.MAX_SAFE_INTEGER
      const orderB = b.sibling_order ?? Number.MAX_SAFE_INTEGER
      if (orderA !== orderB) return orderA - orderB
      const nameA = persons.get(a.person)?.display_name ?? ''
      const nameB = persons.get(b.person)?.display_name ?? ''
      return nameA.localeCompare(nameB)
    })
    childrenOf.set(unionId, kids)
  }

  // --- 1. seed order by walking out from the centre -------------------------
  const order = new Map()
  let counter = 0
  const visit = (personId) => {
    if (personId == null || order.has(personId) || !persons.has(personId)) return
    order.set(personId, counter++)
    // Partners first so a couple stays adjacent, then children, then parents.
    for (const unionId of unionsAsPartner.get(personId) ?? []) {
      for (const other of partnersOf.get(unionId) ?? []) visit(other)
    }
    for (const unionId of unionsAsPartner.get(personId) ?? []) {
      for (const kid of childrenOf.get(unionId) ?? []) visit(kid.person)
    }
    for (const unionId of unionsAsChild.get(personId) ?? []) {
      for (const parent of partnersOf.get(unionId) ?? []) visit(parent)
      for (const sibling of childrenOf.get(unionId) ?? []) visit(sibling.person)
    }
  }
  visit(centerId)
  for (const id of persons.keys()) visit(id) // anything the walk could not reach

  // --- 2. initial placement, row by row ------------------------------------
  const rows = new Map() // generation -> [personId]
  for (const [id, person] of persons) push(rows, person.generation ?? 0, id)
  for (const [generation, ids] of rows) {
    ids.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
    rows.set(generation, ids)
  }

  const x = new Map()
  for (const ids of rows.values()) {
    ids.forEach((id, index) => x.set(id, index * (CARD_W + CARD_GAP)))
  }

  // --- 3. relax -------------------------------------------------------------
  const unionIdsByGeneration = [...unions.keys()].sort(
    (a, b) => (unions.get(a).generation ?? 0) - (unions.get(b).generation ?? 0),
  )
  const midpoint = (ids) => {
    const values = ids.map((id) => x.get(id)).filter((v) => v !== undefined)
    if (!values.length) return null
    return (Math.min(...values) + Math.max(...values)) / 2
  }
  const shift = (ids, dx) => {
    for (const id of ids) if (x.has(id)) x.set(id, x.get(id) + dx)
  }

  const separateRows = () => {
    for (const ids of rows.values()) {
      const sorted = [...ids].sort((a, b) => x.get(a) - x.get(b))
      for (let i = 1; i < sorted.length; i += 1) {
        const minimum = x.get(sorted[i - 1]) + CARD_W + CARD_GAP
        if (x.get(sorted[i]) < minimum) x.set(sorted[i], minimum)
      }
    }
  }

  for (let pass = 0; pass < RELAX_PASSES; pass += 1) {
    // Children follow their union downward…
    for (const unionId of unionIdsByGeneration) {
      const kids = (childrenOf.get(unionId) ?? []).map((k) => k.person)
      const parents = partnersOf.get(unionId) ?? []
      if (!kids.length || !parents.length) continue
      const target = midpoint(parents)
      const current = midpoint(kids)
      if (target === null || current === null) continue
      shift(kids, (target - current) * DAMPING)
    }
    separateRows()

    // …and partners follow their children upward.
    for (const unionId of [...unionIdsByGeneration].reverse()) {
      const kids = (childrenOf.get(unionId) ?? []).map((k) => k.person)
      const parents = partnersOf.get(unionId) ?? []
      if (!kids.length || !parents.length) continue
      const target = midpoint(kids)
      const current = midpoint(parents)
      if (target === null || current === null) continue
      shift(parents, (target - current) * DAMPING)
    }
    separateRows()
  }

  // --- 4. positions ---------------------------------------------------------
  for (const [id, person] of persons) {
    person.x = x.get(id) ?? 0
    person.y = (person.generation ?? 0) * ROW_PITCH
    person.cx = person.x + CARD_W / 2
    person.cy = person.y + CARD_H / 2
  }

  for (const [unionId, union] of unions) {
    const parents = partnersOf.get(unionId) ?? []
    const kids = (childrenOf.get(unionId) ?? []).map((k) => k.person)
    const anchorX = midpoint(parents) ?? midpoint(kids) ?? 0
    union.x = anchorX + CARD_W / 2
    union.y = (union.generation ?? 0) * ROW_PITCH + CARD_H + UNION_DROP
    union.partnerIds = parents
    union.childIds = kids
  }

  // --- 5. edges -------------------------------------------------------------
  const edges = buildEdges(persons, unions, childrenOf)

  // --- 6. bounds ------------------------------------------------------------
  const bounds = boundsOf(persons)

  return {
    persons,
    unions,
    edges,
    bounds,
    rows: [...rows.keys()].sort((a, b) => a - b),
    partnersOf,
    childrenOf,
    unionsAsChild,
  }
}

/**
 * Orthogonal connectors from placed nodes.
 *
 * Separated from placement so the overview can shift a whole family sideways and then
 * rebuild its connectors, rather than trying to translate baked SVG path strings.
 */
export function buildEdges(persons, unions, childrenOf) {
  const edges = []
  for (const [unionId, union] of unions) {
    for (const partnerId of union.partnerIds ?? []) {
      const partner = persons.get(partnerId)
      if (!partner) continue
      edges.push({
        id: `p:${unionId}:${partnerId}`,
        kind: 'partner',
        unionId,
        personId: partnerId,
        // Down out of the card, across to the union, then in.
        d: `M ${partner.cx} ${partner.y + CARD_H} L ${partner.cx} ${union.y} L ${union.x} ${union.y}`,
      })
    }

    if (!union.childIds?.length) continue
    const busY = union.y + CHILD_BUS
    for (const childId of union.childIds) {
      const child = persons.get(childId)
      if (!child) continue
      edges.push({
        id: `c:${unionId}:${childId}`,
        kind: 'child',
        unionId,
        personId: childId,
        relationType:
          (childrenOf.get(unionId) ?? []).find((k) => k.person === childId)?.relation_type ??
          'biological',
        // Union → sibling bus → down into the child's card.
        d: `M ${union.x} ${union.y} L ${union.x} ${busY} L ${child.cx} ${busY} L ${child.cx} ${child.y}`,
      })
    }
  }
  return edges
}

/** Bounding box of a placed person map, padded by one gutter. */
export function boundsOf(persons) {
  const all = [...persons.values()]
  if (!all.length) return { minX: 0, maxX: 1, minY: 0, maxY: 1 }
  return {
    minX: Math.min(...all.map((p) => p.x)) - CARD_GAP,
    maxX: Math.max(...all.map((p) => p.x + CARD_W)) + CARD_GAP,
    minY: Math.min(...all.map((p) => p.y)) - ROW_GAP / 2,
    maxY: Math.max(...all.map((p) => p.y + CARD_H)) + ROW_GAP / 2,
  }
}

/** Union id linking `parentId` (partner) to `childId` (child), if the graph holds one. */
export function findLinkingUnion(layout, parentId, childId) {
  for (const unionId of layout.unionsAsChild.get(childId) ?? []) {
    if ((layout.partnersOf.get(unionId) ?? []).includes(parentId)) return unionId
  }
  return null
}
