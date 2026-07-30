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

import { CARD_GAP, CARD_W, boundsOf, buildEdges, layoutGraph } from './layout.js'

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

  const components = splitComponents(persons, unions, overview.memberships)

  const merged = {
    persons: new Map(),
    unions: new Map(),
    edges: [],
    partnersOf: new Map(),
    childrenOf: new Map(),
    unionsAsChild: new Map(),
  }

  // Biggest family first: the main tree lands on the left where the eye starts, and the
  // unattached fragments trail off to the right.
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

  merged.bounds = boundsOf(merged.persons)
  merged.rows = [...new Set([...merged.persons.values()].map((p) => p.generation))].sort(
    (a, b) => a - b,
  )
  merged.componentCount = components.length
  return merged
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

export function intersects(person, box, width = CARD_W, height = CARD_GAP + 40) {
  if (!box) return true
  return (
    person.x + width >= box.minX &&
    person.x <= box.maxX &&
    person.y + height >= box.minY &&
    person.y <= box.maxY
  )
}
