/**
 * The loud failure when the canvas is about to state something the data does not say.
 *
 * Deliberately ugly, deliberately unmissable, and deliberately not dismissable: this is the
 * pixel equivalent of a database CHECK constraint firing. The two false-kinship bugs that
 * prompted it were both found by a person noticing a wrong line by eye, hours apart, in a
 * chart that otherwise looked plausible — which is the failure mode this exists to end.
 *
 * Dev only. In production a violation is logged (see auditLayout) but the graph still
 * draws, because a family archive that refuses to open helps nobody; the banner is for the
 * person who can actually fix it.
 */
export default function RenderTruthBanner({ violations }) {
  if (!violations?.length) return null

  const byRule = new Map()
  for (const violation of violations) {
    byRule.set(violation.rule, (byRule.get(violation.rule) ?? 0) + 1)
  }
  const unions = [...new Set(violations.flatMap((v) => v.unions ?? []))]

  return (
    <div
      role="alert"
      data-render-truth-banner
      className="absolute inset-x-0 top-0 z-50 border-b-4 border-red-500 bg-red-950/95 px-4 py-3 text-sm text-red-50 shadow-lg"
    >
      <p className="font-semibold">
        Render-truth violation — the canvas is drawing a relationship that is not in the data.
      </p>
      <p className="mt-1 opacity-90">
        {[...byRule.entries()].map(([rule, count]) => `${rule} ×${count}`).join(' · ')}
      </p>
      <p className="mt-1 font-mono text-xs opacity-80">
        unions: {unions.slice(0, 6).join(', ')}
        {unions.length > 6 ? ` … +${unions.length - 6}` : ''}
      </p>
      <p className="mt-1 text-xs opacity-70">
        Full details in the console. Do not trust this chart until it clears.
      </p>
    </div>
  )
}
