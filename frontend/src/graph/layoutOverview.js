/**
 * Laying out the whole database.
 *
 * The detailed view has a centre to grow outwards from. An overview does not: it holds
 * every family in the archive, and most real archives are several disconnected families
 * plus a scatter of fragments nobody has joined up yet.
 *
 * So each connected family is laid out on its own with the ordinary generational layout —
 * which keeps parents above children and children under their union — and the families
 * are then packed left to right with a gutter between them. Two unrelated branches never
 * interleave, and the gaps between packed families are themselves informative: they are
 * the joins still waiting to be found.
 *
 * Vertical position comes from the server's `band`, which already offsets each family to
 * a shared timeline (see backend graph/overview.py), so packing only has to solve x.
 */

import {
  CARD_GAP,
  CARD_H,
  CARD_W,
  ROW_PITCH,
  assignUnionLanes,
  boundsOf,
  buildEdges,
  layoutGraph,
} from './layout.js'
import { auditLayout } from './renderTruth.js'

/** Space left between two unrelated families. Wide enough to read as a separation. */
export const COMPONENT_GAP = 220

/**
 * @param {{persons: Array, unions: Array, memberships: Array}} overview — `band` per node
 * @returns the same shape `layoutGraph` returns, spanning every family
 */
export function layoutOverview(overview) {
  if (!overview?.persons?.length) return null

  // The rest of the pipeline speaks `generation`; the overview endpoint says `band`.
  const persons = overview.persons.map((person) => ({
    ...person,
    generation: person.band ?? 0,
  }))
  const unions = overview.unions.map((union) => ({ ...union, generation: union.band ?? 0 }))

  const allComponents = splitComponents(persons, unions, overview.memberships)

  // People with no recorded relatives at all are separated out. Packed in a row like
  // families they would stretch the canvas by ~400px each — a few hundred of them and
  // nothing fits on any screen — and the stretch buys nothing, because a generation band
  // carries almost no meaning for someone with no relatives to be a generation *of*.
  // Families keep the shared timeline; unattached people are gathered into a block.
  const components = allComponents.filter((c) => c.persons.length > 1 || c.unions.length > 0)
  const unattached = allComponents
    .filter((c) => c.persons.length === 1 && c.unions.length === 0)
    .map((c) => c.persons[0])

  const merged = {
    persons: new Map(),
    unions: new Map(),
    edges: [],
    partnersOf: new Map(),
    childrenOf: new Map(),
    unionsAsChild: new Map(),
  }

  // Biggest family first: the main tree lands on the left where the eye starts, and the
  // smaller branches trail off to the right.
  components.sort((a, b) => b.persons.length - a.persons.length)

  let cursor = 0
  for (const component of components) {
    const seed = pickSeed(component)
    const laid = layoutGraph(component, seed)

    // Slide the whole family so it starts just right of the previous one.
    const shift = cursor - laid.bounds.minX
    for (const person of laid.persons.values()) {
      person.x += shift
      person.cx += shift
    }
    for (const union of laid.unions.values()) {
      union.x += shift
    }

    // Connectors are rebuilt rather than translated — the paths are baked strings.
    // Shifting the family sideways changed every span, so the rails are re-laned before
    // their paths are rebuilt — otherwise two families packed side by side can collide.
    assignUnionLanes(laid.persons, laid.unions)
    for (const edge of buildEdges(laid.persons, laid.unions, laid.childrenOf)) {
      merged.edges.push(edge)
    }

    for (const [id, person] of laid.persons) merged.persons.set(id, person)
    for (const [id, union] of laid.unions) merged.unions.set(id, union)
    for (const [id, value] of laid.partnersOf) merged.partnersOf.set(id, value)
    for (const [id, value] of laid.childrenOf) merged.childrenOf.set(id, value)
    for (const [id, value] of laid.unionsAsChild) merged.unionsAsChild.set(id, value)

    cursor += laid.bounds.maxX - laid.bounds.minX + COMPONENT_GAP
  }

  packUnattached(unattached, merged, cursor)

  merged.bounds = boundsOf(merged.persons)
  merged.rows = [...new Set([...merged.persons.values()].map((p) => p.generation))].sort(
    (a, b) => a - b,
  )
  merged.componentCount = components.length
  merged.unattachedCount = unattached.length
  // Packing families side by side can put two unrelated rails on the same line, so the
  // overview is audited in its own right rather than trusting the per-family layouts.
  merged.violations = auditLayout(merged, 'overview layout')
  return merged
}

/**
 * Gather people with no recorded relatives into a roughly square block to the right.
 *
 * Roughly square, not a row, so the block's width grows as √n instead of n — which is
 * what keeps the whole archive fitting on a phone when a few hundred people have been
 * entered but not yet connected to anyone.
 */
function packUnattached(people, merged, startX) {
  if (!people.length) return

  const columns = Math.max(1, Math.ceil(Math.sqrt(people.length)))
  const cellW = CARD_W + CARD_GAP
  const cellH = ROW_PITCH
  // Sit the block at the median band of its members so it lands in roughly the right era.
  const bands = people.map((p) => p.generation ?? 0).sort((a, b) => a - b)
  const baseY = (bands[Math.floor(bands.length / 2)] ?? 0) * ROW_PITCH

  const ordered = [...people].sort((a, b) =>
    (a.display_name ?? '').localeCompare(b.display_name ?? ''),
  )

  ordered.forEach((person, index) => {
    const placed = { ...person }
    placed.x = startX + (index % columns) * cellW
    placed.y = baseY + Math.floor(index / columns) * cellH
    placed.cx = placed.x + CARD_W / 2
    placed.cy = placed.y + CARD_H / 2
    placed.unattached = true
    merged.persons.set(placed.id, placed)
  })
}

/** Split the graph into connected families, over "shares a union in any role". */
export function splitComponents(persons, unions, memberships) {
  const byId = new Map(persons.map((person) => [person.id, person]))
  const unionById = new Map(unions.map((union) => [union.id, union]))

  const membersOfUnion = new Map()
  const unionsOfPerson = new Map()
  for (const membership of memberships) {
    if (!byId.has(membership.person) || !unionById.has(membership.union)) continue
    if (!membersOfUnion.has(membership.union)) membersOfUnion.set(membership.union, [])
    membersOfUnion.get(membership.union).push(membership.person)
    if (!unionsOfPerson.has(membership.person)) unionsOfPerson.set(membership.person, [])
    unionsOfPerson.get(membership.person).push(membership.union)
  }

  const seen = new Set()
  const components = []

  for (const person of persons) {
    if (seen.has(person.id)) continue

    const personIds = new Set()
    const unionIds = new Set()
    const stack = [person.id]
    seen.add(person.id)

    while (stack.length) {
      const current = stack.pop()
      personIds.add(current)
      for (const unionId of unionsOfPerson.get(current) ?? []) {
        unionIds.add(unionId)
        for (const other of membersOfUnion.get(unionId) ?? []) {
          if (!seen.has(other)) {
            seen.add(other)
            stack.push(other)
          }
        }
      }
    }

    components.push({
      persons: [...personIds].map((id) => byId.get(id)),
      unions: [...unionIds].map((id) => unionById.get(id)),
      memberships: memberships.filter((m) => personIds.has(m.person) && unionIds.has(m.union)),
    })
  }

  return components
}

/** Start each family's layout walk from its oldest, best-connected member. */
function pickSeed(component) {
  let best = component.persons[0]
  for (const person of component.persons) {
    if ((person.generation ?? 0) < (best.generation ?? 0)) best = person
  }
  return best.id
}

/**
 * Above this zoom, cards; below it, dots.
 *
 * Chosen so the swap happens where a card's text stops being legible rather than at an
 * arbitrary round number: a 14px name at k=0.45 renders around 6px.
 */
export const CARD_ZOOM_THRESHOLD = 0.45

/** Below this, connectors are sub-pixel hairlines and cost more than they show. */
export const EDGE_ZOOM_THRESHOLD = 0.12

export function renderModeFor(scale) {
  return scale >= CARD_ZOOM_THRESHOLD ? 'cards' : 'dots'
}

/**
 * Nodes intersecting the viewport, in graph coordinates.
 *
 * This is what keeps a thousand-node archive fluid: dots are cheap enough to draw in
 * full, but a thousand card groups with three text runs each are not, and at card zoom
 * only a handful are on screen anyway.
 */
export function visibleBox(transform, viewport, margin = CARD_W) {
  if (!viewport?.width || !viewport?.height) return null
  return {
    minX: (-transform.x) / transform.k - margin,
    minY: (-transform.y) / transform.k - margin,
    maxX: (viewport.width - transform.x) / transform.k + margin,
    maxY: (viewport.height - transform.y) / transform.k + margin,
  }
}

/** Floor for interactive zoom-out: below this, scrolling further tells you nothing. */
export const MIN_SCALE = 0.08
export const MAX_SCALE = 2.5
/**
 * Floor for *fitting*, which is lower on purpose.
 *
 * Fit has one job: show everything. Clamping it up to MIN_SCALE would silently leave part
 * of a large archive off-screen — content hidden with no indication it exists, which is
 * worse than content drawn small. Dot size is compensated for zoom in GraphCanvas, so a
 * far-out fit still shows visible dots.
 */
export const FIT_MIN_SCALE = 0.004

/**
 * The transform that fits `bounds` inside `viewport`.
 *
 * Pure maths, kept out of the React hook so it can be checked headlessly — in particular
 * at a 390px phone width, where "fits on screen" is a far tighter constraint than on a
 * desktop and is easy to get wrong without noticing.
 */
export function fitTransform(bounds, viewport, padding = 80) {
  if (!bounds || !viewport?.width || !viewport?.height) return null

  const boxW = Math.max(bounds.maxX - bounds.minX, 1)
  const boxH = Math.max(bounds.maxY - bounds.minY, 1)
  // Never let padding eat the whole viewport on a narrow phone.
  const usableW = Math.max(viewport.width - padding * 2, viewport.width * 0.5)
  const usableH = Math.max(viewport.height - padding * 2, viewport.height * 0.5)

  const k = Math.min(MAX_SCALE, Math.max(FIT_MIN_SCALE, Math.min(usableW / boxW, usableH / boxH)))
  return {
    k,
    x: viewport.width / 2 - ((bounds.minX + bounds.maxX) / 2) * k,
    y: viewport.height / 2 - ((bounds.minY + bounds.maxY) / 2) * k,
  }
}

/**
 * Dot radius in graph units that renders at a constant size on screen.
 *
 * Without this a fitted overview of a large archive draws sub-pixel dots — technically on
 * screen, visually blank.
 */
/**
 * Zoom about a fixed screen point.
 *
 * Used by the wheel, by trackpad pinch (ctrlKey+wheel) and by two-finger touch pinch —
 * all three are the same operation, so they share the maths. The graph point under the
 * cursor or under the midpoint of the two fingers must not move, which is what makes
 * zooming feel like handling the sheet rather than moving a camera.
 */
export function zoomAbout(transform, screenPoint, nextScale) {
  const k = Math.min(MAX_SCALE, Math.max(FIT_MIN_SCALE, nextScale))
  return {
    k,
    x: screenPoint.x - ((screenPoint.x - transform.x) / transform.k) * k,
    y: screenPoint.y - ((screenPoint.y - transform.y) / transform.k) * k,
  }
}

/** Screen coordinates of a graph point, for positioning HTML overlays over the SVG. */
export function toScreen(transform, point) {
  return { x: point.x * transform.k + transform.x, y: point.y * transform.k + transform.y }
}

/** The reverse: where in the graph a screen point lands. */
export function toGraph(transform, point) {
  return { x: (point.x - transform.x) / transform.k, y: (point.y - transform.y) / transform.k }
}

export function dotRadius(scale, base = 5) {
  // Clamping the divisor rather than capping the result: a dot then renders at a constant
  // `base` screen pixels everywhere down to the fit floor, and shrinks normally when
  // zoomed in past 1.
  return base / Math.max(scale, FIT_MIN_SCALE)
}

export function intersects(person, box, width = CARD_W, height = CARD_GAP + 40) {
  if (!box) return true
  return (
    person.x + width >= box.minX &&
    person.x <= box.maxX &&
    person.y + height >= box.minY &&
    person.y <= box.maxY
  )
}
