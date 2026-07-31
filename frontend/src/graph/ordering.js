/**
 * Layered ordering for a family graph — which people sit left of which, row by row.
 *
 * This is the ordering phase of a Sugiyama-style layered layout, specialised for the fact
 * that a Union is a node rather than an edge. Layers are generations, which the server
 * already assigns, so there is no cycle-breaking or layer-assignment phase; the whole job
 * is choosing an order within each row, and everything downstream (coordinates, rails)
 * follows from it.
 *
 * Three things are being traded off, in this priority order:
 *
 *   1. **A union's children are contiguous.** This is not aesthetic — a sibling bus spans
 *      its children, so an outsider standing between two of them is drawn under a rail that
 *      claims them. Contiguity is what makes the render-truth invariant satisfiable at all,
 *      so it is a hard constraint expressed in the data structure: siblings live in one
 *      *block* and blocks are permuted whole, never split.
 *   2. **Partners are adjacent.** Someone who marries into a family is placed beside their
 *      spouse rather than appended at the edge of the row. Soft, because a middle sibling's
 *      spouse cannot be adjacent without entering the sibling block — which is allowed, as
 *      no drop-line points at them.
 *   3. **Few crossings between rows.** Blocks are ordered by the barycenter heuristic,
 *      swept down and up until stable, keeping the best arrangement seen.
 *
 * Barycenter ordering is a heuristic: minimising crossings exactly is NP-hard, and this
 * does not attempt it. It is the standard choice because it is cheap, stable, and good
 * enough that the remaining crossings are the ones a human would also draw.
 */

/** Sweeps of down-then-up ordering. Past this the arrangement stops improving in practice. */
const MAX_SWEEPS = 12

/**
 * @param {object} graph  adjacency already built by layoutGraph
 * @returns {Map<number, string[]>} generation -> person ids, left to right
 */
export function orderRows({
  persons,
  rows,
  partnersOf,
  childrenOf,
  unionsAsPartner,
  unionsAsChild,
  seedOrder,
}) {
  const blocksByRow = new Map()
  for (const [generation, ids] of rows) {
    blocksByRow.set(
      generation,
      buildBlocks({ ids, persons, partnersOf, childrenOf, unionsAsPartner, unionsAsChild, seedOrder }),
    )
  }

  const generations = [...blocksByRow.keys()].sort((a, b) => a - b)
  let best = snapshot(blocksByRow, generations)
  let bestCrossings = countAllCrossings(best, { unionsAsChild, partnersOf, generations })

  for (let sweep = 0; sweep < MAX_SWEEPS; sweep += 1) {
    const downward = sweep % 2 === 0
    const order = downward ? generations : [...generations].reverse()

    for (const generation of order) {
      const blocks = blocksByRow.get(generation)
      if (!blocks || blocks.length < 2) continue
      const positions = positionsOf(blocksByRow, generations)
      const neighbourRow = generation + (downward ? -1 : 1)

      for (const block of blocks) {
        block.barycenter = barycenterOf(block, {
          positions,
          neighbourRow,
          downward,
          partnersOf,
          childrenOf,
          unionsAsPartner,
          unionsAsChild,
          persons,
        })
      }
      // Blocks with no neighbour to align to keep their place: sorting them to one end
      // would shuffle unrelated families on every sweep and never converge.
      stableSortBlocks(blocks)
    }

    const current = snapshot(blocksByRow, generations)
    const crossings = countAllCrossings(current, { unionsAsChild, partnersOf, generations })
    if (crossings < bestCrossings) {
      bestCrossings = crossings
      best = current
    }
    if (crossings === 0) break
  }

  const ordered = new Map()
  for (const generation of generations) ordered.set(generation, best.get(generation).flat())
  return ordered
}

/**
 * Group a row into blocks that must move as a unit.
 *
 * A block is one union's children in birth order, with married-in partners inserted beside
 * the sibling they married. Someone with no recorded parents who married nobody in this row
 * is a block of one, free to be placed wherever the barycenter wants them.
 */
function buildBlocks({ ids, persons, partnersOf, childrenOf, unionsAsPartner, unionsAsChild, seedOrder }) {
  const inRow = new Set(ids)
  const seed = (id) => seedOrder.get(id) ?? Number.MAX_SAFE_INTEGER
  const birthUnion = (id) => (unionsAsChild.get(id) ?? [])[0] ?? null

  const indexAmongSiblings = new Map()
  for (const kids of childrenOf.values()) {
    kids.forEach((kid, index) => indexAmongSiblings.set(kid.person, index))
  }

  // Walked in seed order so the sibling who claims a shared spouse is never decided by the
  // order the graph happened to arrive in.
  const claimOrder = [...ids].sort((a, b) => seed(a) - seed(b))
  const attachment = new Map() // marry-in -> { key, within }
  for (const id of claimOrder) {
    if (!birthUnion(id)) continue
    const base = indexAmongSiblings.get(id) ?? 0
    let taken = 0
    for (const unionId of unionsAsPartner.get(id) ?? []) {
      for (const partnerId of partnersOf.get(unionId) ?? []) {
        if (partnerId === id || !inRow.has(partnerId)) continue
        if (birthUnion(partnerId) || attachment.has(partnerId)) continue
        // First spouse to the left, later marriages to the right: that is what draws a
        // remarriage as one person sitting between two union nodes.
        attachment.set(partnerId, {
          key: birthUnion(id),
          within: taken === 0 ? base - 0.5 : base + 0.5 + (taken - 1) * 0.01,
        })
        taken += 1
      }
    }
  }

  const grouped = new Map()
  for (const id of ids) {
    const own = birthUnion(id)
    const attached = attachment.get(id)
    const key = own ?? attached?.key ?? `solo:${id}`
    const within = own ? (indexAmongSiblings.get(id) ?? 0) : (attached?.within ?? 0)
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key).push({ id, within })
  }

  const blocks = []
  for (const [key, members] of grouped) {
    members.sort((a, b) => a.within - b.within || seed(a.id) - seed(b.id))
    blocks.push({
      key,
      // The union whose children this block holds, if any — what the barycenter aligns to.
      unionId: String(key).startsWith('solo:') ? null : key,
      members: members.map((m) => m.id),
      barycenter: null,
      seed: Math.min(...members.map((m) => seed(m.id))),
    })
  }
  blocks.sort((a, b) => a.seed - b.seed || String(a.key).localeCompare(String(b.key)))
  return blocks
}

/** Current index of every person, so barycenters can be read without coordinates. */
function positionsOf(blocksByRow, generations) {
  const positions = new Map()
  for (const generation of generations) {
    let index = 0
    for (const block of blocksByRow.get(generation)) {
      for (const id of block.members) positions.set(id, index++)
    }
  }
  return positions
}

/**
 * Where a block "wants" to be: the median position of the people it connects to in the
 * neighbouring row. Median rather than mean — one distant relative should not drag a whole
 * sibling group across the chart.
 */
function barycenterOf(block, { positions, downward, partnersOf, childrenOf, unionsAsPartner, unionsAsChild, persons }) {
  const anchors = []

  if (downward) {
    // Align under the parents.
    if (block.unionId) {
      for (const parentId of partnersOf.get(block.unionId) ?? []) {
        const at = positions.get(parentId)
        if (at !== undefined) anchors.push(at)
      }
    }
    // A marry-in with no parents here still has a partner to sit beside.
    if (!anchors.length) {
      for (const id of block.members) {
        for (const unionId of unionsAsPartner.get(id) ?? []) {
          for (const other of partnersOf.get(unionId) ?? []) {
            const at = positions.get(other)
            if (other !== id && at !== undefined) anchors.push(at)
          }
        }
      }
    }
  } else {
    // Align over the children.
    for (const id of block.members) {
      for (const unionId of unionsAsPartner.get(id) ?? []) {
        for (const kid of childrenOf.get(unionId) ?? []) {
          const at = positions.get(kid.person)
          if (at !== undefined) anchors.push(at)
        }
      }
    }
    if (!anchors.length && block.unionId) {
      for (const parentId of partnersOf.get(block.unionId) ?? []) {
        const at = positions.get(parentId)
        if (at !== undefined) anchors.push(at)
      }
    }
  }

  if (!anchors.length) return null
  anchors.sort((a, b) => a - b)
  const middle = Math.floor(anchors.length / 2)
  return anchors.length % 2 ? anchors[middle] : (anchors[middle - 1] + anchors[middle]) / 2
}

/** Sort by barycenter, leaving unanchored blocks exactly where they were. */
function stableSortBlocks(blocks) {
  const anchored = []
  for (let i = 0; i < blocks.length; i += 1) {
    if (blocks[i].barycenter !== null) anchored.push({ index: i, block: blocks[i] })
  }
  const sorted = [...anchored].sort(
    (a, b) =>
      a.block.barycenter - b.block.barycenter ||
      a.block.seed - b.block.seed ||
      String(a.block.key).localeCompare(String(b.block.key)),
  )
  anchored.forEach(({ index }, k) => {
    blocks[index] = sorted[k].block
  })
}

function snapshot(blocksByRow, generations) {
  const copy = new Map()
  for (const generation of generations) {
    copy.set(
      generation,
      blocksByRow.get(generation).map((block) => [...block.members]),
    )
  }
  return copy
}

/**
 * Crossings between every pair of adjacent rows, counted over parent→child links.
 *
 * The standard pairwise count: two links cross when their endpoints are in opposite order
 * in the two rows. Only used to decide which sweep produced the better arrangement, so an
 * O(n²) count over a neighbourhood is cheap enough and easier to trust than a clever one.
 */
function countAllCrossings(rowsOfBlocks, { unionsAsChild, partnersOf, generations }) {
  const positions = new Map()
  for (const generation of generations) {
    let index = 0
    for (const members of rowsOfBlocks.get(generation)) {
      for (const id of members) positions.set(id, index++)
    }
  }

  let total = 0
  for (let g = 1; g < generations.length; g += 1) {
    const upper = generations[g - 1]
    const lower = generations[g]
    if (lower - upper !== 1) continue

    const links = []
    for (const members of rowsOfBlocks.get(lower)) {
      for (const childId of members) {
        for (const unionId of unionsAsChild.get(childId) ?? []) {
          for (const parentId of partnersOf.get(unionId) ?? []) {
            const from = positions.get(parentId)
            const to = positions.get(childId)
            if (from !== undefined && to !== undefined) links.push([from, to])
          }
        }
      }
    }
    for (let i = 0; i < links.length; i += 1) {
      for (let j = i + 1; j < links.length; j += 1) {
        const [a1, a2] = links[i]
        const [b1, b2] = links[j]
        if ((a1 - b1) * (a2 - b2) < 0) total += 1
      }
    }
  }
  return total
}

export { countAllCrossings }
