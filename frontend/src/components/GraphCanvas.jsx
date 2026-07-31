import { useEffect, useMemo, useRef } from 'react'

import { CARD_H, CARD_W } from '../graph/layout.js'
import {
  EDGE_ZOOM_THRESHOLD,
  dotRadius,
  intersects,
  renderModeFor,
  toScreen,
  visibleBox,
} from '../graph/layoutOverview.js'
import { accentFor, personName, personSecondaryName } from '../graph/person.js'
import { usePanZoom } from '../graph/usePanZoom.js'
import Affordances from './Affordances.jsx'

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
  editor,
  activeId,
  onActivate,
  onAddRelative,
  onChooseUnion,
  onEditYear,
  onEditName,
  focusId,
  labelFor,
  t,
}) {
  const svgRef = useRef(null)
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const { transform, viewport, fit, centerOn, zoomBy, panBy, isDragging, isNavigating, handlers } =
    usePanZoom(svgRef)
  // Dots are the far-out overview's way of showing a whole archive. In detail view the
  // neighbourhood is the thing you are reading, so it always draws as cards however far
  // out the fit had to go — nothing is collapsed or hidden there.
  const mode = centerId ? 'cards' : renderModeFor(transform.k)
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
    registerControls?.({
      fit: () => layout && fit(layout.bounds),
      zoomBy,
      centerOn,
      panBy,
      isNavigating,
      transform,
      toScreenPoint: (point) => toScreen(transform, point),
    })
  }, [registerControls, fit, zoomBy, centerOn, panBy, isNavigating, transform, layout])

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

  // Deliberately no early return for an empty layout: the first person in an archive is
  // placed *on* the canvas, so the sheet — and its transform, which the inline input is
  // positioned against — has to exist before there is anything to draw.
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
      onClick={(event) => {
        if (event.target === svgRef.current && !isDragging()) onActivate?.(null)
      }}
    >
      <g transform={`translate(${transform.x} ${transform.y}) scale(${transform.k})`}>
        {!layout && (
          <text
            x={0}
            y={0}
            textAnchor="middle"
            className="fill-[var(--muted)] select-none"
            style={{ fontSize: 16 }}
          >
            {t('graph.empty')}
          </text>
        )}
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
          {[...(layout?.unions.values() ?? [])].map((union) => {
            const choosing = editor?.mode === 'choosing-union'
            const isCandidate = choosing && editor.candidateUnions?.includes(union.id)
            return (
              <g key={union.id}>
                {isCandidate && (
                  // A pulsing halo, and a hit area a finger can actually land on.
                  <circle
                    cx={union.x}
                    cy={union.y}
                    r={22}
                    fill="var(--accent-strong)"
                    opacity={0.18}
                    className="cursor-pointer"
                    onClick={(event) => {
                      event.stopPropagation()
                      onChooseUnion?.(union.id)
                    }}
                  />
                )}
                <circle
                  cx={union.x}
                  cy={union.y}
                  r={isCandidate ? 9 : bigPicture ? 2 : 5}
                  fill={
                    isCandidate
                      ? 'var(--accent-strong)'
                      : union.status === 'ended'
                        ? 'var(--canvas-bg)'
                        : 'var(--edge-strong)'
                  }
                  stroke="var(--edge-strong)"
                  strokeWidth={1.5}
                  className={isCandidate ? 'cursor-pointer' : undefined}
                  onClick={
                    isCandidate
                      ? (event) => {
                          event.stopPropagation()
                          onChooseUnion?.(union.id)
                        }
                      : undefined
                  }
                />
              </g>
            )
          })}
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
                isActive={activeId === person.id}
                hasParents={layout ? hasParents(layout, person.id) : false}
                onSelect={() => !isDragging() && onSelect(person)}
                onActivate={() => !isDragging() && onActivate?.(person.id)}
                // Passed through as undefined when there is no handler, never wrapped in an
                // arrow that is truthy regardless. PersonCard draws the buttons if and only
                // if this is set, so "the affordance renders but does nothing" cannot be a
                // state the app can reach.
                onAddRelative={
                  onAddRelative ? (context) => onAddRelative(context, person) : undefined
                }
                onEditYear={() => onEditYear?.(person)}
                onEditName={() => onEditName?.(person)}
                isFocus={focusId === person.id}
                relationLabel={labelFor?.(person.id) ?? null}
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

/** Does this person already hang from a union of birth? Decides the "+ parents" chip. */
function hasParents(layout, personId) {
  return (layout.unionsAsChild.get(personId) ?? []).length > 0
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
  isActive,
  isFocus,
  relationLabel,
  hasParents: personHasParents,
  onSelect,
  onActivate,
  onAddRelative,
  onEditYear,
  onEditName,
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
      className="cursor-pointer group"
      data-person-id={person.id}
      onClick={(event) => {
        event.stopPropagation()
        // One tap reveals the add-buttons and selects; the affordances handle their own
        // clicks. On desktop hover shows them too, via CSS.
        onActivate?.()
        onSelect?.()
      }}
    >
      {isFocus && (
        // A ring outside the card, so "where am I looking from" is findable at a glance
        // without changing the card's own geometry.
        <rect
          x={-5}
          y={-5}
          width={CARD_W + 10}
          height={CARD_H + 10}
          rx={13}
          fill="none"
          stroke="var(--accent-strong)"
          strokeWidth={3}
          opacity={0.85}
        />
      )}
      <rect
        width={CARD_W}
        height={CARD_H}
        rx={9}
        fill={isFocus ? 'var(--chip-bg)' : 'var(--card-bg)'}
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

      {/* The name is the field people fix most — a misheard spelling, a missing initial —
          so it is editable in place, exactly like the years below it. */}
      <g
        className="cursor-text"
        data-edit-name={person.id}
        onClick={(event) => {
          event.stopPropagation()
          onEditName?.()
        }}
      >
        <title>{t('edit.editName')}</title>
        <rect x={12} y={8} width={CARD_W - 24} height={20} rx={4} fill="transparent" />
        <text x={16} y={23} className="fill-[var(--ink)]" style={{ fontSize: 14, fontWeight: 600 }}>
          {truncate(name, 20)}
        </text>
      </g>
      <text x={16} y={39} className="fill-[var(--muted)]" style={{ fontSize: 11 }}>
        {truncate(secondary || person.house_name || '', 26)}
      </text>
      <g
        className="cursor-text"
        data-edit-years={person.id}
        onClick={(event) => {
          event.stopPropagation()
          onEditYear?.()
        }}
      >
        <title>{t('edit.editYears')}</title>
        <rect x={12} y={42} width={CARD_W - 40} height={18} rx={4} fill="transparent" />
        <text x={16} y={54} className="fill-[var(--muted)]" style={{ fontSize: 11 }}>
          {person.lifespan_compact || person.birth_display || '?'}
        </text>
      </g>

      {relateIndex >= 0 && (
        <g transform={`translate(${CARD_W - 26} 8)`}>
          <circle r={9} cx={9} cy={9} fill="var(--accent-strong)" />
          <text x={9} y={13} textAnchor="middle" fill="#fff" style={{ fontSize: 11, fontWeight: 700 }}>
            {relateIndex === 0 ? 'A' : 'B'}
          </text>
        </g>
      )}

      {(relationLabel || isFocus) && (
        // Sits above the card rather than inside it: the card's three lines are already
        // the person's own facts, and this is a fact about the *viewer's* relationship
        // to them, which changes when the focus does.
        <g transform={`translate(${CARD_W / 2} -8)`}>
          <rect
            x={-Math.min(78, 5 + (isFocus ? 22 : relationLabel.length * 4.1))}
            y={-15}
            width={Math.min(156, 10 + (isFocus ? 44 : relationLabel.length * 8.2))}
            height={19}
            rx={9.5}
            fill={isFocus ? 'var(--accent-strong)' : 'var(--chip-bg)'}
            stroke={isFocus ? 'var(--accent-strong)' : 'var(--card-border)'}
          />
          <text
            y={-1.5}
            textAnchor="middle"
            className={isFocus ? 'fill-white' : 'fill-[var(--ink)]'}
            style={{ fontSize: 11, fontWeight: 600 }}
          >
            {isFocus ? t('focus.you') : truncate(relationLabel, 18)}
          </text>
        </g>
      )}

      {onAddRelative && (
        <g className={isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}>
          <Affordances
            person={person}
            hasParents={personHasParents}
            onAdd={onAddRelative}
            t={t}
          />
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
