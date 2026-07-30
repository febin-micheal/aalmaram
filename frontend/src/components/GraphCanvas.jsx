import { useEffect, useMemo, useRef } from 'react'

import { CARD_H, CARD_W } from '../graph/layout.js'
import {
  EDGE_ZOOM_THRESHOLD,
  dotRadius,
  intersects,
  renderModeFor,
  visibleBox,
} from '../graph/layoutOverview.js'
import { accentFor, personName, personSecondaryName } from '../graph/person.js'
import { usePanZoom } from '../graph/usePanZoom.js'

/**
 * The chart.
 *
 * Everything is one SVG with a single transform group, so panning and zooming never
 * re-layout anything. Person cards and union connectors are drawn from the positions
 * layout.js computed; this component only decides what a node *looks* like.
 *
 * Detail follows zoom rather than a mode switch: zoomed out, a person is a dot and
 * house names label the clusters; zoomed in, the full cards appear, culled to what is
 * actually on screen. That is what lets the whole archive be the landing view.
 */
export default function GraphCanvas({
  layout,
  centerId,
  selectedId,
  locale,
  highlight,
  relateSelection,
  expandingId,
  onSelect,
  onExpand,
  registerControls,
  onRenderModeChange,
  t,
}) {
  const svgRef = useRef(null)
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const { transform, viewport, fit, centerOn, zoomBy, isDragging, handlers } = usePanZoom(svgRef)
  const mode = renderModeFor(transform.k)
  const bigPicture = mode === 'dots'

  useEffect(() => {
    onRenderModeChange?.(mode)
  }, [mode, onRenderModeChange])

  // Re-fit whenever a new centre is loaded, but not when the user expands a node —
  // yanking the viewport away from what they just clicked would be disorienting.
  // Deferred a frame because on first mount the SVG has no measured box yet, and a fit
  // against a zero-sized viewport silently leaves the graph parked off-screen.
  useEffect(() => {
    if (!layoutRef.current) return undefined
    const frame = requestAnimationFrame(() => {
      if (layoutRef.current) fit(layoutRef.current.bounds)
    })
    return () => cancelAnimationFrame(frame)
  }, [centerId, fit])

  useEffect(() => {
    registerControls?.({ fit: () => layout && fit(layout.bounds), zoomBy, centerOn })
  }, [registerControls, fit, zoomBy, centerOn, layout])

  const houseClusters = useMemo(
    () => (bigPicture && layout ? clusterByHouse(layout) : []),
    [bigPicture, layout],
  )

  // Dots are cheap enough to draw in full; a thousand card groups are not, and at card
  // zoom only a handful are on screen. Culling happens here, not in the layout.
  const { drawnPersons, drawnEdges } = useMemo(() => {
    if (!layout) return { drawnPersons: [], drawnEdges: [] }

    const all = [...layout.persons.values()]
    if (bigPicture) {
      const edges = transform.k < EDGE_ZOOM_THRESHOLD ? [] : layout.edges
      return { drawnPersons: all, drawnEdges: edges }
    }

    const box = visibleBox(transform, viewport)
    const visible = all.filter((person) => intersects(person, box))
    const visibleIds = new Set(visible.map((person) => person.id))
    return {
      drawnPersons: visible,
      drawnEdges: layout.edges.filter((edge) => visibleIds.has(edge.personId)),
    }
  }, [layout, bigPicture, transform, viewport])

  if (!layout) {
    return <div className="flex h-full items-center justify-center opacity-60">{t('graph.empty')}</div>
  }

  const highlightedPersons = highlight?.persons ?? new Set()
  const highlightedEdges = highlight?.edges ?? new Set()
  const dimmed = highlightedPersons.size > 0

  return (
    <svg
      ref={svgRef}
      className="h-full w-full touch-none select-none bg-[var(--canvas-bg)]"
      role="application"
      aria-label="Family graph"
      {...handlers}
    >
      <g transform={`translate(${transform.x} ${transform.y}) scale(${transform.k})`}>
        {/* Edges first so cards always sit on top of their connectors. */}
        <g fill="none" strokeLinejoin="round">
          {drawnEdges.map((edge) => {
            const lit = highlightedEdges.has(edge.id)
            return (
              <path
                key={edge.id}
                d={edge.d}
                stroke={lit ? 'var(--accent-strong)' : 'var(--edge)'}
                strokeWidth={lit ? 3.5 : 1.5}
                strokeDasharray={edge.relationType === 'adopted' ? '6 5' : undefined}
                opacity={dimmed && !lit ? 0.25 : 1}
              />
            )
          })}
        </g>

        {/* Union nodes: the join a couple's children actually hang from. */}
        <g>
          {[...layout.unions.values()].map((union) => (
            <circle
              key={union.id}
              cx={union.x}
              cy={union.y}
              r={bigPicture ? 2 : 5}
              fill={union.status === 'ended' ? 'var(--canvas-bg)' : 'var(--edge-strong)'}
              stroke="var(--edge-strong)"
              strokeWidth={1.5}
            />
          ))}
        </g>

        <g>
          {drawnPersons.map((person) =>
            bigPicture ? (
              <circle
                key={person.id}
                cx={person.cx}
                cy={person.cy}
                r={dotRadius(
                  transform.k,
                  person.id === centerId ? 9 : highlightedPersons.has(person.id) ? 8 : 5,
                )}
                fill={highlightedPersons.has(person.id) ? 'var(--accent-strong)' : accentFor(person)}
                opacity={dimmed && !highlightedPersons.has(person.id) ? 0.25 : person.is_living ? 1 : 0.55}
                className="cursor-pointer"
                onClick={() => !isDragging() && onSelect(person)}
              >
                <title>{personName(person, locale)}</title>
              </circle>
            ) : (
              <PersonCard
                key={person.id}
                person={person}
                locale={locale}
                isCenter={person.id === centerId}
                isSelected={person.id === selectedId}
                isHighlighted={highlightedPersons.has(person.id)}
                isDimmed={dimmed && !highlightedPersons.has(person.id)}
                relateIndex={relateSelection?.indexOf(person.id) ?? -1}
                isExpanding={expandingId === person.id}
                onSelect={() => !isDragging() && onSelect(person)}
                onExpand={(direction) => !isDragging() && onExpand(person, direction)}
                t={t}
              />
            ),
          )}
        </g>

        {/* House-name cluster labels, only in the zoomed-out overview. */}
        <g>
          {houseClusters.map((cluster) => (
            <text
              key={cluster.house}
              x={cluster.x}
              y={cluster.y}
              textAnchor="middle"
              className="fill-[var(--muted)]"
              style={{ fontSize: 34 / transform.k, fontWeight: 600 }}
            >
              {cluster.house} · {cluster.count}
            </text>
          ))}
        </g>
      </g>
    </svg>
  )
}

function PersonCard({
  person,
  locale,
  isCenter,
  isSelected,
  isHighlighted,
  isDimmed,
  relateIndex,
  isExpanding,
  onSelect,
  onExpand,
  t,
}) {
  const name = personName(person, locale)
  const secondary = personSecondaryName(person, locale)
  const accent = accentFor(person)
  const border = isSelected || isCenter ? 'var(--accent-strong)' : isHighlighted ? 'var(--accent-strong)' : 'var(--card-border)'

  return (
    <g
      transform={`translate(${person.x} ${person.y})`}
      opacity={isDimmed ? 0.3 : 1}
      className="cursor-pointer"
      onClick={onSelect}
    >
      <rect
        width={CARD_W}
        height={CARD_H}
        rx={9}
        fill="var(--card-bg)"
        stroke={border}
        strokeWidth={isSelected || isCenter || isHighlighted ? 2.5 : 1}
        // Deceased people are drawn slightly recessed rather than greyed out; they are
        // most of the graph and should not read as disabled.
        strokeDasharray={person.is_living ? undefined : undefined}
      />
      {/* Gender accent bar. */}
      <rect width={5} height={CARD_H} rx={2.5} fill={accent} />
      {!person.is_living && (
        <rect x={CARD_W - 5} width={5} height={CARD_H} rx={2.5} fill="var(--edge)" opacity={0.6} />
      )}

      <text x={16} y={23} className="fill-[var(--ink)]" style={{ fontSize: 14, fontWeight: 600 }}>
        {truncate(name, 20)}
      </text>
      <text x={16} y={39} className="fill-[var(--muted)]" style={{ fontSize: 11 }}>
        {truncate(secondary || person.house_name || '', 26)}
      </text>
      <text x={16} y={54} className="fill-[var(--muted)]" style={{ fontSize: 11 }}>
        {person.lifespan_compact || person.birth_display}
      </text>

      {relateIndex >= 0 && (
        <g transform={`translate(${CARD_W - 26} 8)`}>
          <circle r={9} cx={9} cy={9} fill="var(--accent-strong)" />
          <text x={9} y={13} textAnchor="middle" fill="#fff" style={{ fontSize: 11, fontWeight: 700 }}>
            {relateIndex === 0 ? 'A' : 'B'}
          </text>
        </g>
      )}

      {person.hidden_up > 0 && (
        <ExpandChip
          x={CARD_W / 2 - 15}
          y={-13}
          label={`↑${person.hidden_up}`}
          title={t('graph.expandUp', { count: person.hidden_up })}
          busy={isExpanding}
          onClick={(event) => {
            event.stopPropagation()
            onExpand('up')
          }}
        />
      )}
      {person.hidden_down > 0 && (
        <ExpandChip
          x={CARD_W / 2 - 15}
          y={CARD_H - 8}
          label={`↓${person.hidden_down}`}
          title={t('graph.expandDown', { count: person.hidden_down })}
          busy={isExpanding}
          onClick={(event) => {
            event.stopPropagation()
            onExpand('down')
          }}
        />
      )}
    </g>
  )
}

function ExpandChip({ x, y, label, title, busy, onClick }) {
  return (
    <g transform={`translate(${x} ${y})`} onClick={onClick} className="cursor-pointer">
      <title>{title}</title>
      <rect width={30} height={20} rx={10} fill="var(--chip-bg)" stroke="var(--card-border)" />
      <text
        x={15}
        y={14}
        textAnchor="middle"
        className="fill-[var(--ink)]"
        style={{ fontSize: 10, fontWeight: 700 }}
      >
        {busy ? '…' : label}
      </text>
    </g>
  )
}

function truncate(value, max) {
  if (!value) return ''
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/** Centroids of each house name, for the zoomed-out overview's labels. */
function clusterByHouse(layout) {
  const groups = new Map()
  for (const person of layout.persons.values()) {
    if (!person.house_name) continue
    if (!groups.has(person.house_name)) groups.set(person.house_name, [])
    groups.get(person.house_name).push(person)
  }
  return [...groups.entries()]
    .filter(([, people]) => people.length >= 3)
    .map(([house, people]) => ({
      house,
      count: people.length,
      x: people.reduce((sum, p) => sum + p.cx, 0) / people.length,
      y: people.reduce((sum, p) => sum + p.cy, 0) / people.length - 26,
    }))
}
