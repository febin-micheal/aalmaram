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
export const CHILD_BUS = 34 // how far below the union node the sibling bus runs
/** Vertical separation between two unions' buses that would otherwise touch. */
export const BUS_LANE_GAP = 13
/** Horizontal clearance two buses need before they may share a lane. */
export const BUS_MIN_GAP = 24
/** Vertical room available for bus lanes, between the union node and the child row. */
export const BUS_BAND = ROW_PITCH - CARD_H - UNION_DROP - 16

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

  /**
   * Make every adjacency list independent of the order the graph arrived in.
   *
   * The seed walk below reads these lists, so their order decides the layout. They are
   * built by appending memberships as they come, which means the same family laid out from
   * an incremental add (new person appended last) and from a reload (server's own order)
   * produced *different pictures* — the graph rearranged itself on refresh. Sorting on
   * stable keys makes the layout a function of the graph alone.
   */
  const nameOf = (id) => persons.get(id)?.display_name ?? ''
  const byPerson = (a, b) => nameOf(a).localeCompare(nameOf(b)) || String(a).localeCompare(String(b))
  const byUnion = (a, b) =>
    (unions.get(a)?.generation ?? 0) - (unions.get(b)?.generation ?? 0) ||
    String(a).localeCompare(String(b))

  for (const [unionId, ids] of partnersOf) partnersOf.set(unionId, [...ids].sort(byPerson))
  for (const [personId, ids] of unionsAsPartner) unionsAsPartner.set(personId, [...ids].sort(byUnion))
  for (const [personId, ids] of unionsAsChild) unionsAsChild.set(personId, [...ids].sort(byUnion))

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
  // Anything the walk could not reach, in a stable order rather than insertion order.
  for (const id of [...persons.keys()].sort(byPerson)) visit(id)

  // --- 2. initial placement, row by row ------------------------------------
  const rows = new Map() // generation -> [personId]
  for (const [id, person] of persons) push(rows, person.generation ?? 0, id)

  /**
   * Where a person sits among their own siblings — their union of birth, and their index
   * within it. Someone with no recorded parents is their own group of one.
   */
  const birthGroupOf = (id) => (unionsAsChild.get(id) ?? [])[0] ?? `solo:${id}`
  const indexAmongSiblings = new Map()
  for (const kids of childrenOf.values()) {
    kids.forEach((kid, index) => indexAmongSiblings.set(kid.person, index))
  }

  /**
   * Order each row by sibling group, keeping every group unbroken.
   *
   * The walk above is a depth-first traversal, so it can wander from one child into that
   * child's marriage and number a same-generation in-law before coming back for the next
   * sibling. The row then interleaves two families — and nothing downstream can recover,
   * because relaxation only ever shifts groups and `separateRows` preserves whatever left
   * to right order it is given. That is how a newly added child ended up beyond an
   * unrelated family instead of beside its siblings.
   *
   * So the row is ordered by *group*, not by person: groups take the position of their
   * earliest-visited member, and within a group siblings sit in recorded birth order.
   * A union's children are therefore always adjacent, whatever the walk did.
   */
  for (const [generation, ids] of rows) {
    const inRow = new Set(ids)

    /**
     * Which block a person belongs to. Someone with recorded parents belongs to their
     * siblings; someone without joins the block of a partner who has some, so a couple is
     * not split; failing both, they are a block of one.
     *
     * The rule is that two *birth groups* never interleave. A married-in spouse sitting
     * between two siblings is fine — no drop-line goes to them, and keeping them beside
     * their partner is worth more than a perfectly unbroken sibling run.
     */
    const isSolo = (id) => String(birthGroupOf(id)).startsWith('solo:')

    /**
     * Married-in spouses, placed around the sibling they married.
     *
     * Someone with two marriages is drawn between their two spouses, which is what makes a
     * remarriage legible — one person sitting between two union nodes, each with its own
     * children. So the first spouse goes to the sibling's left and the rest to the right,
     * rather than stacking them all on one side.
     */
    const spouseWithin = new Map()
    for (const id of ids) {
      if (isSolo(id)) continue
      const base = indexAmongSiblings.get(id) ?? 0
      const spouses = []
      for (const unionId of unionsAsPartner.get(id) ?? []) {
        for (const partnerId of partnersOf.get(unionId) ?? []) {
          if (partnerId !== id && inRow.has(partnerId) && isSolo(partnerId) && !spouseWithin.has(partnerId)) {
            spouses.push(partnerId)
            spouseWithin.set(partnerId, null) // claimed; filled in below
          }
        }
      }
      spouses.forEach((partnerId, index) => {
        spouseWithin.set(partnerId, {
          key: birthGroupOf(id),
          within: index === 0 ? base - 0.5 : base + 0.5 + (index - 1) * 0.01,
        })
      })
    }

    const blockOf = (id) => {
      if (!isSolo(id)) return { key: birthGroupOf(id), within: indexAmongSiblings.get(id) ?? 0 }
      return spouseWithin.get(id) ?? { key: birthGroupOf(id), within: 0 }
    }

    const block = new Map(ids.map((id) => [id, blockOf(id)]))
    const blockSeed = new Map()
    for (const id of ids) {
      const { key } = block.get(id)
      const seed = order.get(id) ?? Number.MAX_SAFE_INTEGER
      if (!blockSeed.has(key) || seed < blockSeed.get(key)) blockSeed.set(key, seed)
    }

    ids.sort((a, b) => {
      const blockA = block.get(a)
      const blockB = block.get(b)
      if (blockA.key !== blockB.key) return blockSeed.get(blockA.key) - blockSeed.get(blockB.key)
      if (blockA.within !== blockB.within) return blockA.within - blockB.within
      return (order.get(a) ?? 0) - (order.get(b) ?? 0)
    })
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

  /**
   * Push apart anything that overlaps, **in the row's established order**.
   *
   * This used to re-derive the order from the current x on every pass, which let a relaxed
   * node drift past its neighbour and swap with it — so the sibling grouping decided above
   * survived seeding and was then quietly undone. Walking `ids` as ordered means the final
   * left-to-right order is exactly the seeded one, and a union's children stay adjacent
   * however hard the passes pull.
   */
  const separateRows = () => {
    for (const ids of rows.values()) {
      if (!ids.length) continue
      const before = midpoint(ids)
      for (let i = 1; i < ids.length; i += 1) {
        const minimum = x.get(ids[i - 1]) + CARD_W + CARD_GAP
        if (x.get(ids[i]) < minimum) x.set(ids[i], minimum)
      }
      // Separation only ever pushes right, so without this the row creeps further right on
      // every pass and the whole layout inflates. Re-centring keeps the widths the passes
      // negotiated while leaving the row where it was.
      const after = midpoint(ids)
      if (before !== null && after !== null) shift(ids, before - after)
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
/**
 * The horizontal run each union's sibling bus occupies: from its own drop-line across to
 * its outermost child.
 */
const pushInto = (map, key, value) => {
  if (!map.has(key)) map.set(key, [])
  map.get(key).push(value)
}

function busSpan(union, persons) {
  const xs = [union.x]
  for (const childId of union.childIds ?? []) {
    const child = persons.get(childId)
    if (child) xs.push(child.cx)
  }
  return { x0: Math.min(...xs), x1: Math.max(...xs) }
}

/**
 * Give every union's sibling bus a y at which it cannot touch another union's.
 *
 * A bus says "these children belong to this union". Two unions in the same generation
 * previously drew their buses at the same y — `union.y + CHILD_BUS` depends only on the
 * generation — so wherever their spans overlapped, two separate paths landed on one
 * unbroken horizontal line. The render then asserted a kinship that is not in the data:
 * every child on that rail appearing to belong to both sets of parents.
 *
 * Unions whose spans come within `BUS_MIN_GAP` of each other are therefore put on
 * different lanes. Lanes are spread around `CHILD_BUS` and squeezed to fit the band
 * between the union row and the child row, so a single unconflicted bus — overwhelmingly
 * the common case — still draws exactly where it always did.
 */
export function assignBusLanes(persons, unions) {
  const byRow = new Map()
  for (const [unionId, union] of unions) {
    if (!union.childIds?.length) continue
    pushInto(byRow, union.y, { unionId, ...busSpan(union, persons) })
  }

  const laneOf = new Map()
  for (const entries of byRow.values()) {
    entries.sort((a, b) => a.x0 - b.x0 || a.x1 - b.x1)
    const lastEnd = [] // rightmost x reached in each lane so far
    let used = 1
    for (const entry of entries) {
      let lane = lastEnd.findIndex((end) => end + BUS_MIN_GAP <= entry.x0)
      if (lane === -1) lane = lastEnd.length
      lastEnd[lane] = entry.x1
      laneOf.set(entry.unionId, lane)
      used = Math.max(used, lastEnd.length)
    }
    // Fit however many lanes were needed into the band, centred on the usual position.
    const spacing = Math.min(BUS_LANE_GAP, BUS_BAND / used)
    for (const entry of entries) {
      const lane = laneOf.get(entry.unionId)
      laneOf.set(entry.unionId, CHILD_BUS + (lane - (used - 1) / 2) * spacing)
    }
  }
  return laneOf
}

export function buildEdges(persons, unions, childrenOf) {
  const edges = []
  // Computed here rather than during placement so it survives the overview shifting a
  // whole family sideways — that changes the spans, and so can change which buses collide.
  const busOffset = assignBusLanes(persons, unions)
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
    const busY = union.y + (busOffset.get(unionId) ?? CHILD_BUS)
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
