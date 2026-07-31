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

import { orderRows } from './ordering.js'
import { auditLayout } from './renderTruth.js'

export const CARD_W = 178
export const CARD_H = 64
export const CARD_GAP = 26
/** Between two different sibling sets — visibly wider, so families read as families. */
export const FAMILY_GAP = 72
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
/** Clearance a corridor keeps from the cards either side of it. */
export const CORRIDOR_MARGIN = 14

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

  // Ordering is its own phase — see ordering.js. It decides left-to-right within every
  // row under one hard constraint (a union's children stay contiguous, because a sibling
  // bus spans them) and two soft ones (partners adjacent, few crossings between rows).
  const ordered = orderRows({
    persons,
    rows,
    partnersOf,
    childrenOf,
    unionsAsPartner,
    unionsAsChild,
    seedOrder: order,
  })
  for (const [generation, ids] of ordered) rows.set(generation, ids)

  /** Which union's children a person belongs to — used for the family gap below. */
  const birthGroupOf = (id) => (unionsAsChild.get(id) ?? [])[0] ?? `solo:${id}`

  const x = new Map()
  for (const ids of rows.values()) {
    let cursor = 0
    ids.forEach((id, index) => {
      if (index > 0) {
        // A wider gap between families than between siblings: the eye should be able to
        // see where one sibling set ends without following the rails to find out.
        const sameFamily = birthGroupOf(id) === birthGroupOf(ids[index - 1])
        cursor += CARD_W + (sameFamily ? CARD_GAP : FAMILY_GAP)
      }
      x.set(id, cursor)
    })
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
        const gap = birthGroupOf(ids[i]) === birthGroupOf(ids[i - 1]) ? CARD_GAP : FAMILY_GAP
        const minimum = x.get(ids[i - 1]) + CARD_W + gap
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
  const baseY = (union) => (union.generation ?? 0) * ROW_PITCH + CARD_H + UNION_DROP

  // --- 1. corridors, decided once, from the unlaned base y ----------------------------
  //
  // A child more than one row down is reached by jogging sideways into a gap and dropping
  // there. The decision uses the base y rather than the final laned one, so it does not
  // depend on the lane it will later help determine.
  for (const [, union] of unions) {
    union.corridorByRow = new Map()
    const rows = new Set()
    for (const id of union.childIds ?? []) {
      const child = persons.get(id)
      if (child) rows.add(child.y)
    }
    for (const childRow of rows) {
      if (childRow - baseY(union) <= ROW_PITCH) continue
      const corridor = freeCorridor(persons, baseY(union), childRow, union.x)
      if (corridor !== null && Math.abs(corridor - union.x) >= 0.5) {
        union.corridorByRow.set(childRow, corridor)
      }
    }
  }

  // --- 2. partner rails, one lane per union within its own row ------------------------
  //
  // The jog runs along the union's own rail, so its reach is part of this span. That is the
  // point: a jog drawn at some other y would be a rail nothing had coloured, which is
  // exactly how one slipped onto another union's line.
  const byUnionRow = new Map()
  for (const [unionId, union] of unions) {
    const rowBottom = (union.generation ?? 0) * ROW_PITCH + CARD_H
    if (!byUnionRow.has(rowBottom)) byUnionRow.set(rowBottom, [])
    byUnionRow.get(rowBottom).push({ unionId, union, rowBottom })
  }
  for (const [rowBottom, entries] of byUnionRow) {
    const spans = []
    for (const { unionId, union } of entries) {
      const xs = [
        union.x,
        ...(union.partnerIds ?? []).map((id) => persons.get(id)?.cx).filter((v) => v !== undefined),
        ...union.corridorByRow.values(),
      ]
      spans.push({ unionId, x0: Math.min(...xs), x1: Math.max(...xs) })
    }
    const offsets = laneOffsets(spans, (s) => s.unionId)
    for (const { unionId, union } of entries) {
      union.y = rowBottom + UNION_DROP + (offsets.get(unionId) ?? 0)
    }
  }

  // --- 3. child buses, one lane per union within the row their children sit in ---------
  //
  // Grouped by that row **globally**, not by the union's own row: a union whose child
  // married a generation up owns a bus two rows below itself, and it must be coloured
  // against every other bus there, including ones from a different generation.
  const byChildRow = new Map()
  for (const [unionId, union] of unions) {
    const rows = new Map()
    for (const id of union.childIds ?? []) {
      const child = persons.get(id)
      if (!child) continue
      if (!rows.has(child.y)) rows.set(child.y, [])
      rows.get(child.y).push(child.cx)
    }
    for (const [childRow, xs] of rows) {
      // A corridor-routed drop starts its bus at the corridor, which keeps a marry-up's
      // rail short instead of spanning the chart.
      const from = union.corridorByRow.get(childRow) ?? union.x
      if (!byChildRow.has(childRow)) byChildRow.set(childRow, [])
      byChildRow.get(childRow).push({
        unionId,
        childRow,
        x0: Math.min(from, ...xs),
        x1: Math.max(from, ...xs),
      })
    }
  }

  for (const [, union] of unions) union.busYByRow = new Map()
  for (const [childRow, spans] of byChildRow) {
    const offsets = laneOffsets(spans, (s) => s.unionId)
    for (const span of spans) {
      const union = unions.get(span.unionId)
      if (union) union.busYByRow.set(childRow, childRow - CHILD_BUS + (offsets.get(span.unionId) ?? 0))
    }
  }
  for (const [, union] of unions) {
    union.busY = [...union.busYByRow.values()][0] ?? baseY(union) + CHILD_BUS
  }
}

/**
 * Interval-graph colouring: spans that come within `BUS_MIN_GAP` get different lanes.
 * Returns a signed offset per union, centred on zero and squeezed to stay inside the band.
 */
function laneOffsets(spans, keyOf = (s) => s.unionId) {
  const offsets = new Map()
  if (!spans.length) return offsets

  const ordered = [...spans].sort(
    (a, b) => a.x0 - b.x0 || a.x1 - b.x1 || String(keyOf(a)).localeCompare(String(keyOf(b))),
  )
  const lastEnd = []
  const lane = new Map()
  for (const span of ordered) {
    let index = lastEnd.findIndex((end) => end + BUS_MIN_GAP <= span.x0)
    if (index === -1) index = lastEnd.length
    lastEnd[index] = span.x1
    lane.set(keyOf(span), index)
  }

  const used = lastEnd.length
  // Never zero: two rails one pixel apart still read as two, one rail read as two families
  // does not. Squeezing is the lesser evil against ever sharing a y.
  const spacing = used > 1 ? Math.max(2, Math.min(BUS_LANE_GAP, (2 * BAND_HALF) / (used - 1))) : 0
  for (const [key, index] of lane) {
    offsets.set(key, (index - (used - 1) / 2) * spacing)
  }
  return offsets
}

/**
 * A vertical strip that crosses no card, for a drop that spans more than one row.
 *
 * A union whose child sits two rows down has to get past the row between them. Going
 * straight down puts the wire through whoever happens to be standing there, which reads as
 * that person being on the line between a parent and a child. So the drop jogs sideways
 * into a gap and comes down there — simple orthogonal routing, no diagonals, no curves.
 *
 * Returns the free x nearest `preferredX`, or null when the rows are wall-to-wall (in which
 * case the caller draws straight and the invariant reports it rather than the drawing
 * quietly lying).
 */
function freeCorridor(persons, y0, y1, preferredX) {
  const crossed = [...persons.values()].filter((p) => p.y > y0 - 1 && p.y + CARD_H < y1 + 1)
  if (!crossed.length) return preferredX

  const blocked = crossed
    .map((p) => [p.x - CORRIDOR_MARGIN, p.x + CARD_W + CORRIDOR_MARGIN])
    .sort((a, b) => a[0] - b[0])

  // Merge overlapping blocked spans, then the gaps between them are the corridors.
  const merged = [blocked[0]]
  for (const span of blocked.slice(1)) {
    const last = merged[merged.length - 1]
    if (span[0] <= last[1]) last[1] = Math.max(last[1], span[1])
    else merged.push([...span])
  }

  const candidates = [merged[0][0], merged[merged.length - 1][1]]
  for (let i = 1; i < merged.length; i += 1) {
    candidates.push((merged[i - 1][1] + merged[i][0]) / 2)
  }
  // Only gaps wide enough to be a corridor rather than a hairline.
  const usable = candidates.filter((x) =>
    merged.every(([lo, hi]) => x <= lo || x >= hi),
  )
  if (!usable.length) return null
  return usable.reduce((best, x) => (Math.abs(x - preferredX) < Math.abs(best - preferredX) ? x : best))
}

/** The bus serving the row this child sits on. */
function busYFor(union, child) {
  const perRow = union.busYByRow
  if (perRow && perRow.has(child.y)) return perRow.get(child.y)
  return union.busY ?? union.y + CHILD_BUS
}

/**
 * The orthogonal path from a union down to one child.
 *
 * The ordinary case is three segments: down out of the union, across the sibling bus, down
 * into the card. When the child is more than one row below, two more are inserted — a short
 * jog into a clear corridor and the long drop down it.
 */
function dropPath(union, child, busY) {
  // Exactly the corridor chosen while laning, or none — never a fresh calculation, because
  // laning and drawing disagreeing is how two coloured-apart rails ended up on one line.
  const corridor = union.corridorByRow?.get(child.y)
  if (corridor === undefined) {
    return `M ${union.x} ${union.y} L ${union.x} ${busY} L ${child.cx} ${busY} L ${child.cx} ${child.y}`
  }
  // The jog runs along the union's own rail, whose lane already accounts for it.
  return (
    `M ${union.x} ${union.y} L ${corridor} ${union.y} ` +
    `L ${corridor} ${busY} L ${child.cx} ${busY} L ${child.cx} ${child.y}`
  )
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
    for (const childId of union.childIds) {
      const child = persons.get(childId)
      if (!child) continue
      // One bus per row the union has children on. Real records put a child on a different
      // row from their siblings (someone who married a generation up), and a single rail
      // reaching two rows would have to cross everything between them.
      const busY = busYFor(union, child)
      edges.push({
        id: `c:${unionId}:${childId}`,
        kind: 'child',
        unionId,
        personId: childId,
        relationType:
          (childrenOf.get(unionId) ?? []).find((k) => k.person === childId)?.relation_type ??
          'biological',
        // Union → sibling bus → down into the child's card. A drop spanning more than one
        // row is routed round the row it would otherwise cut through.
        d: dropPath(union, child, busY),
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
