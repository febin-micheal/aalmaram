import { CARD_H, CARD_W } from '../graph/layout.js'
import { AFFORDANCE_HIT, AFFORDANCE_VISIBLE } from './affordance-metrics.js'

/**
 * The three add-buttons that appear on a card.
 *
 * Placed where the relationship goes, not in a menu: partner to the right, child below,
 * parents above. The position *is* the label — you learn the union model by using it.
 *
 * Sized for a thumb. HIT is the invisible touch target (>=44px, above Apple's and
 * Google's 44/48px guidance); the visible circle is smaller so the card is not swamped.
 * On a phone these appear on tap rather than hover, so they must be reachable without
 * precision.
 */

export { AFFORDANCE_HIT, AFFORDANCE_VISIBLE }

export default function Affordances({ person, hasParents, onAdd, t }) {
  const midX = CARD_W / 2

  return (
    <g className="affordances" data-testid="affordances">
      <Affordance
        x={CARD_W + 6}
        y={CARD_H / 2 - AFFORDANCE_HIT / 2}
        label="+"
        title={t('edit.addPartner')}
        onActivate={() => onAdd('partner_of')}
      />
      <Affordance
        x={midX - AFFORDANCE_HIT / 2}
        y={CARD_H + 6}
        label="+"
        title={t('edit.addChild')}
        onActivate={() => onAdd('child_of_person')}
      />
      {/* Hidden entirely when the person already hangs from a union of birth: a second
          set of parents is not a thing this model can express, so offering it would be a
          lie the API would then have to refuse. */}
      {!hasParents && (
        <Affordance
          x={midX - AFFORDANCE_HIT / 2}
          y={-AFFORDANCE_HIT - 6}
          label="+"
          title={t('edit.addParents')}
          onActivate={() => onAdd('parent_of')}
        />
      )}
    </g>
  )
}

function Affordance({ x, y, label, title, onActivate }) {
  const centre = AFFORDANCE_HIT / 2
  return (
    <g
      transform={`translate(${x} ${y})`}
      className="cursor-pointer"
      onPointerDown={(event) => {
        // Stop the canvas from treating this as the start of a pan.
        event.stopPropagation()
      }}
      onClick={(event) => {
        event.stopPropagation()
        onActivate()
      }}
    >
      <title>{title}</title>
      {/* Invisible but full-size: the touch target, not the artwork. */}
      <rect width={AFFORDANCE_HIT} height={AFFORDANCE_HIT} fill="transparent" />
      <circle
        cx={centre}
        cy={centre}
        r={AFFORDANCE_VISIBLE / 2}
        fill="var(--card-bg)"
        stroke="var(--accent-strong)"
        strokeWidth={1.5}
      />
      <text
        x={centre}
        y={centre + 6}
        textAnchor="middle"
        className="fill-[var(--accent-strong)] select-none"
        style={{ fontSize: 18, fontWeight: 700 }}
      >
        {label}
      </text>
    </g>
  )
}
