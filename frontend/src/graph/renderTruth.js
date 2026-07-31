/**
 * Render-truth invariants: the drawing may not assert a kinship the data does not hold.
 *
 * A family chart is read as a claim. A line from a couple down to a child says "these two
 * are that child's parents", and a horizontal rail says "everything hanging off me is one
 * sibling set". If two unions' connectors touch, the picture states a parentage nobody
 * entered — and unlike a crash, it looks fine. Someone copies it into their family history.
 *
 * So these are checked in code after every layout, not only in tests, in the same spirit as
 * the database CHECK constraints: the cheapest place to catch a false record is before it
 * exists. Two things have to be true for that to be worth anything —
 *
 *   1. the check reads the **rendered geometry**, parsing the path strings the browser will
 *      actually draw, rather than re-deriving intent from the model. A layout that computes
 *      the right answer and emits the wrong path must fail.
 *   2. it names the offending union ids, because "something overlaps" is not actionable.
 *
 * Violations are returned rather than thrown: a lie on the canvas is worse than a missing
 * feature, but crashing the whole explorer over one bad rail would be worse still. The dev
 * build shows them; production logs once and carries on.
 */

/** Horizontal runs must be this far apart in x before they count as separate. */
const TOUCH_EPSILON = 0.5
/** Two rails at y values closer than this read as one line on screen. */
const COLLINEAR_EPSILON = 1.5

/**
 * Every horizontal run the layout will draw, with the union that owns it.
 *
 * Parsed from the emitted `d` strings — the actual geometry, not the intent behind it.
 * Partner runs are `M cx cardBottom L cx unionY L unionX unionY`; child runs are
 * `M unionX unionY L unionX busY L childCx busY L childCx childTop`.
 */
export function horizontalRuns(layout) {
  const runs = []
  for (const edge of layout.edges ?? []) {
    const n = (edge.d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
    if (edge.kind === 'partner' && n.length >= 6) {
      runs.push({
        kind: 'partner',
        unionId: edge.unionId,
        personId: edge.personId,
        y: n[3],
        x0: Math.min(n[2], n[4]),
        x1: Math.max(n[2], n[4]),
      })
    } else if (edge.kind === 'child' && n.length >= 8) {
      runs.push({
        kind: 'child',
        unionId: edge.unionId,
        personId: edge.personId,
        y: n[3],
        x0: Math.min(n[2], n[4]),
        x1: Math.max(n[2], n[4]),
      })
    }
  }
  return runs
}

/**
 * @returns {Array<{rule: string, message: string, unions: string[]}>} empty when the
 * drawing says only what the data says.
 */
export function checkRenderTruth(layout) {
  if (!layout?.edges) return []
  const violations = []
  const runs = horizontalRuns(layout)

  // (a) Every run belongs to exactly one union, and that union exists.
  for (const run of runs) {
    if (!run.unionId || !layout.unions?.has(run.unionId)) {
      violations.push({
        rule: 'segment-ownership',
        message: `a ${run.kind} connector belongs to no known union`,
        unions: [run.unionId].filter(Boolean),
      })
    }
  }

  // (b) No two runs of different unions touch, overlap or connect.
  for (let i = 0; i < runs.length; i += 1) {
    for (let j = i + 1; j < runs.length; j += 1) {
      const a = runs[i]
      const b = runs[j]
      if (a.unionId === b.unionId) continue
      if (Math.abs(a.y - b.y) >= COLLINEAR_EPSILON) continue
      if (a.x0 > b.x1 + TOUCH_EPSILON || b.x0 > a.x1 + TOUCH_EPSILON) continue
      violations.push({
        rule: 'fused-rail',
        message:
          `${a.kind} rail of union ${a.unionId} and ${b.kind} rail of union ${b.unionId} ` +
          `share y=${a.y.toFixed(1)} and overlap in x ` +
          `([${a.x0.toFixed(0)},${a.x1.toFixed(0)}] vs [${b.x0.toFixed(0)},${b.x1.toFixed(0)}]) ` +
          '— the drawing claims a parentage that is not in the data',
        unions: [a.unionId, b.unionId],
      })
    }
  }

  // (c) Every drop-line ends on a member of its own union.
  for (const run of runs) {
    const union = layout.unions?.get(run.unionId)
    if (!union) continue
    const members = run.kind === 'partner' ? union.partnerIds : union.childIds
    if (!(members ?? []).includes(run.personId)) {
      violations.push({
        rule: 'foreign-drop-line',
        message: `union ${run.unionId} draws a ${run.kind} line to ${run.personId}, who is not one`,
        unions: [run.unionId],
      })
    }
  }

  // (d) A union's children occupy a span containing no other union's child.
  const birthUnion = new Map()
  for (const [unionId, union] of layout.unions ?? []) {
    for (const childId of union.childIds ?? []) birthUnion.set(childId, unionId)
  }
  for (const [unionId, union] of layout.unions ?? []) {
    const kids = (union.childIds ?? []).map((id) => layout.persons.get(id)).filter(Boolean)
    if (kids.length < 2) continue
    const lo = Math.min(...kids.map((k) => k.cx))
    const hi = Math.max(...kids.map((k) => k.cx))
    const row = kids[0].y
    for (const person of layout.persons.values()) {
      if (person.y !== row || union.childIds.includes(person.id)) continue
      if (person.cx <= lo || person.cx >= hi) continue
      // A married-in spouse between two siblings is allowed and has no drop-line
      // (DECISIONS.md #26); another union's child is a genuine interleave.
      const theirs = birthUnion.get(person.id)
      if (theirs && theirs !== unionId) {
        violations.push({
          rule: 'interleaved-siblings',
          message:
            `${person.id}, a child of union ${theirs}, sits inside union ${unionId}'s sibling run`,
          unions: [unionId, theirs],
        })
      }
    }
  }

  return violations
}

/**
 * Run the invariants and make a violation impossible to miss while developing.
 *
 * Returns the violations so a caller can surface them; also logs, because the first thing
 * anyone does with a banner is ask which unions.
 */
export function auditLayout(layout, label = 'layout') {
  const violations = checkRenderTruth(layout)
  if (violations.length && typeof console !== 'undefined') {
    console.error(
      `[render-truth] ${violations.length} violation(s) in ${label} — the canvas is asserting kinship that is not in the data`,
    )
    for (const violation of violations) console.error(`  ${violation.rule}: ${violation.message}`)
  }
  return violations
}
