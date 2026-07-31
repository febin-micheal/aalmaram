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

import { auditLayout } from './renderTruth.js'

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
/** How far a lane may sit either side of its band's centre. */
export const BAND_HALF = 13

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
    // Walked in seed order, not in the order the graph happened to list people: the first
    // sibling to claim a shared spouse decides which side that spouse sits on, so an
    // arbitrary walk order here made the whole row depend on the input order.
    const claimOrder = [...ids].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
    for (const id of claimOrder) {
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
  // Total order, not just by generation: relaxation shifts groups one union at a time and
  // each shift moves the ground under the next, so ties left to insertion order made the
  // whole layout depend on the order the graph arrived in.
  const unionIdsByGeneration = [...unions.keys()].sort(
    (a, b) =>
      (unions.get(a).generation ?? 0) - (unions.get(b).generation ?? 0) ||
      String(a).localeCompare(String(b)),
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

  // --- 5. rails and edges ---------------------------------------------------
  // Lanes before edges: the paths are built from the ys this assigns.
  assignUnionLanes(persons, unions)
  const edges = buildEdges(persons, unions, childrenOf)

  // --- 6. bounds ------------------------------------------------------------
  const bounds = boundsOf(persons)

  const layout = {
    persons,
    unions,
    edges,
    bounds,
    rows: [...rows.keys()].sort((a, b) => a - b),
    partnersOf,
    childrenOf,
    unionsAsChild,
  }

  // The invariants run on every layout, not only under test. A chart that asserts a
  // parentage nobody entered is worse than a missing feature, and the only place to catch
  // it before a person reads it is here.
  layout.violations = auditLayout(layout, 'detail layout')
  return layout
}

/**
 * Orthogonal connectors from placed nodes.
 *
 * Separated from placement so the overview can shift a whole family sideways and then
 * rebuild its connectors, rather than trying to translate baked SVG path strings.
 */
/**
 * Give every union its own y for both of its horizontal rails.
 *
 * A union draws two: the **partner rail**, which each partner drops onto before running
 * across to the union dot, and the **child bus**, which runs from the dot across to each
 * child. Both used to be positioned from the generation alone — `union.y` is the same for
 * every union in a row — so any two unions whose rails overlapped in x landed on one
 * unbroken line. That reads as "all these people belong to all these parents".
 *
 * It was fixed once for the child bus and recurred within the hour on the partner rail,
 * because the fix was per-edge-type rather than over the geometry. So this assigns lanes to
 * **every** horizontal run a union owns, in two bands: partner rails just under the card
 * row, child buses just above the next one. Within a band, unions whose spans come within
 * `BUS_MIN_GAP` take different lanes — the usual interval-graph colouring — and the lanes
 * are spread symmetrically around the band's centre, so the common unconflicted case draws
 * exactly where it always did.
 *
 * Mutates `union.y` and `union.busY`. Called by `layoutGraph`, and again by the overview
 * after it shifts families sideways, because that changes the spans and so can change which
 * rails would collide.
 */
export function assignUnionLanes(persons, unions) {
  const rows = new Map()
  for (const [unionId, union] of unions) {
    const rowBottom = (union.generation ?? 0) * ROW_PITCH + CARD_H
    if (!rows.has(rowBottom)) rows.set(rowBottom, [])
    rows.get(rowBottom).push({ unionId, union })
  }

  for (const [rowBottom, entries] of rows) {
    const partnerSpans = []
    const childSpans = []
    for (const { unionId, union } of entries) {
      const partnerXs = (union.partnerIds ?? [])
        .map((id) => persons.get(id)?.cx)
        .filter((v) => v !== undefined)
      if (partnerXs.length) {
        partnerSpans.push({ unionId, x0: Math.min(union.x, ...partnerXs), x1: Math.max(union.x, ...partnerXs) })
      }
      const childXs = (union.childIds ?? [])
        .map((id) => persons.get(id)?.cx)
        .filter((v) => v !== undefined)
      if (childXs.length) {
        childSpans.push({ unionId, x0: Math.min(union.x, ...childXs), x1: Math.max(union.x, ...childXs) })
      }
    }

    const partnerY = laneOffsets(partnerSpans)
    const childY = laneOffsets(childSpans)
    for (const { unionId, union } of entries) {
      union.y = rowBottom + UNION_DROP + (partnerY.get(unionId) ?? 0)
      union.busY = rowBottom + UNION_DROP + CHILD_BUS + (childY.get(unionId) ?? 0)
    }
  }
}

/**
 * Interval-graph colouring: spans that come within `BUS_MIN_GAP` get different lanes.
 * Returns a signed offset per union, centred on zero and squeezed to stay inside the band.
 */
function laneOffsets(spans) {
  const offsets = new Map()
  if (!spans.length) return offsets

  const ordered = [...spans].sort(
    (a, b) => a.x0 - b.x0 || a.x1 - b.x1 || String(a.unionId).localeCompare(String(b.unionId)),
  )
  const lastEnd = []
  const lane = new Map()
  for (const span of ordered) {
    let index = lastEnd.findIndex((end) => end + BUS_MIN_GAP <= span.x0)
    if (index === -1) index = lastEnd.length
    lastEnd[index] = span.x1
    lane.set(span.unionId, index)
  }

  const used = lastEnd.length
  // Never zero: two rails one pixel apart still read as two, one rail read as two families
  // does not. Squeezing is the lesser evil against ever sharing a y.
  const spacing = used > 1 ? Math.max(2, Math.min(BUS_LANE_GAP, (2 * BAND_HALF) / (used - 1))) : 0
  for (const [unionId, index] of lane) {
    offsets.set(unionId, (index - (used - 1) / 2) * spacing)
  }
  return offsets
}

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
    const busY = union.busY ?? union.y + CHILD_BUS
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
