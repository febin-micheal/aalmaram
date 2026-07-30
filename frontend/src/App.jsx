import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { NotAuthenticated, fetchRelation } from './api.js'
import EmptyState from './components/EmptyState.jsx'
import GraphCanvas from './components/GraphCanvas.jsx'
import QuickAddDialog from './components/QuickAddDialog.jsx'
import RelateBar from './components/RelateBar.jsx'
import SidePanel from './components/SidePanel.jsx'
import Toolbar from './components/Toolbar.jsx'
import { findLinkingUnion } from './graph/layout.js'
import { useGraph } from './graph/useGraph.js'
import { useOverview } from './graph/useOverview.js'
import { AVAILABLE_LOCALES, detectLocale, setLocale, translatorFor } from './i18n/index.js'

const IDLE_RELATE = { active: false, a: null, b: null, result: null, working: false, allLoaded: true }

/**
 * The explorer.
 *
 * Two views over the same canvas: an **overview** of the whole archive (the landing
 * state), and a **detail** neighbourhood centred on one person. Detail is reached by
 * clicking someone; the overview is always one button away.
 */
export default function App() {
  const [locale, setActiveLocale] = useState(detectLocale)
  const [selectedId, setSelectedId] = useState(null)
  const [relate, setRelate] = useState(IDLE_RELATE)
  const [searchHighlight, setSearchHighlight] = useState([])
  const [renderMode, setRenderMode] = useState('dots')
  const [quickAddFor, setQuickAddFor] = useState(null)
  const [quickAddOpen, setQuickAddOpen] = useState(false)
  const [authNeeded, setAuthNeeded] = useState(false)
  const [failure, setFailure] = useState(null)
  const controls = useRef({})

  const t = translatorFor(locale)
  const overview = useOverview()
  const graph = useGraph()
  const { centerId } = graph

  const mode = centerId ? 'detail' : 'overview'
  const layout = centerId ? graph.layout : overview.layout

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  const handleError = useCallback((error) => {
    if (!error) return
    if (error instanceof NotAuthenticated) setAuthNeeded(true)
    else setFailure(error.message)
  }, [])

  useEffect(() => {
    overview.load().catch(handleError)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openPerson = useCallback(
    async (person) => {
      try {
        await graph.loadCenter(person.id, { up: 2, down: 2 })
        setSelectedId(person.id)
        setSearchHighlight([])
      } catch (error) {
        handleError(error)
      }
    },
    [graph, handleError],
  )

  const backToOverview = useCallback(() => {
    graph.reset()
    setSelectedId(null)
    setRelate(IDLE_RELATE)
  }, [graph])

  const expand = useCallback(
    async (person, direction) => {
      try {
        await graph.expand(person.id, direction)
      } catch (error) {
        handleError(error)
      }
    },
    [graph, handleError],
  )

  // --- relate mode ---------------------------------------------------------

  const pickForRelate = useCallback(
    async (person) => {
      if (!relate.a) {
        setRelate((state) => ({ ...state, a: person, result: null }))
        return
      }
      if (relate.a.id === person.id) return

      setRelate((state) => ({ ...state, b: person, working: true }))
      try {
        const result = await fetchRelation(relate.a.id, person.id)
        setRelate((state) => ({ ...state, result, working: false }))
      } catch (error) {
        setRelate((state) => ({ ...state, working: false }))
        handleError(error)
      }
    },
    [relate.a, handleError],
  )

  const onNodeClick = useCallback(
    (person) => {
      if (relate.active) pickForRelate(person)
      else if (mode === 'overview') openPerson(person)
      else setSelectedId(person.id)
    },
    [relate.active, pickForRelate, mode, openPerson],
  )

  const highlight = useMemo(() => {
    const persons = new Set(searchHighlight)
    const edges = new Set()

    if (relate.result?.is_related && layout) {
      for (const common of relate.result.common_ancestors) {
        for (const path of [common.path_subject, common.path_other]) {
          path.forEach((step, index) => {
            persons.add(step.id)
            if (index === 0) return
            // Paths run ancestor-first, so the previous step is this one's parent.
            const unionId = findLinkingUnion(layout, path[index - 1].id, step.id)
            if (unionId) {
              edges.add(`c:${unionId}:${step.id}`)
              edges.add(`p:${unionId}:${path[index - 1].id}`)
            }
          })
        }
      }
    }
    return { persons, edges }
  }, [relate.result, layout, searchHighlight])

  const allPathNodesLoaded = useMemo(() => {
    if (!relate.result?.is_related || !layout) return true
    return relate.result.common_ancestors.every((common) =>
      [...common.path_subject, ...common.path_other].every((step) => layout.persons.has(step.id)),
    )
  }, [relate.result, layout])

  const centerOnCommonAncestor = async () => {
    const common = relate.result?.common_ancestors?.[0]
    if (!common) return
    const depth = Math.max(common.depth_subject, common.depth_other)
    try {
      await graph.loadCenter(common.person.id, { up: 1, down: Math.min(depth, 4) })
    } catch (error) {
      handleError(error)
    }
  }

  // --- quick add -----------------------------------------------------------

  const openQuickAdd = (person = null) => {
    setQuickAddFor(person)
    setQuickAddOpen(true)
  }

  const onHouseholdCreated = async (created) => {
    setQuickAddOpen(false)
    setQuickAddFor(null)
    // The overview is stale the moment a household exists that it does not know about.
    overview.refresh().catch(handleError)
    if (!created?.center) return
    try {
      // Land on the new household in detail view — you almost always want to keep going.
      await graph.loadCenter(created.center, { up: 1, down: 2 })
      setSelectedId(created.center)
    } catch (error) {
      handleError(error)
    }
  }

  // --- render --------------------------------------------------------------

  if (authNeeded) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-6 text-center">
        <h1 className="text-2xl font-semibold">{t('auth.needed')}</h1>
        <p className="opacity-70">{t('auth.body')}</p>
        <a
          href="/admin/"
          target="_blank"
          rel="noreferrer"
          className="rounded-lg bg-[var(--accent-strong)] px-4 py-3 font-medium text-white"
        >
          {t('auth.link')}
        </a>
        <button
          type="button"
          onClick={() => setAuthNeeded(false)}
          className="rounded-lg border border-[var(--card-border)] px-4 py-3"
        >
          {t('auth.retry')}
        </button>
      </main>
    )
  }

  if (overview.isEmpty && mode === 'overview') {
    return (
      <>
        <EmptyState t={t} onAddHousehold={() => openQuickAdd(null)} />
        {quickAddOpen && (
          <QuickAddDialog
            t={t}
            locale={locale}
            anchor={null}
            onClose={() => setQuickAddOpen(false)}
            onCreated={onHouseholdCreated}
          />
        )}
      </>
    )
  }

  const center = centerId ? layout?.persons.get(centerId) : null
  const selected = selectedId ? layout?.persons.get(selectedId) : null

  return (
    <div className="flex h-dvh flex-col">
      <Toolbar
        t={t}
        locale={locale}
        onToggleLocale={() =>
          setActiveLocale(setLocale(AVAILABLE_LOCALES.find((l) => l !== locale) ?? locale))
        }
        mode={mode}
        center={center}
        stats={overview.stats}
        personCount={layout?.persons.size ?? 0}
        unionCount={layout?.unions.size ?? 0}
        renderMode={renderMode}
        relateActive={relate.active}
        onToggleRelate={() =>
          setRelate((state) => (state.active ? IDLE_RELATE : { ...IDLE_RELATE, active: true }))
        }
        onFit={() => controls.current.fit?.()}
        onZoomIn={() => controls.current.zoomBy?.(1.4)}
        onZoomOut={() => controls.current.zoomBy?.(0.7)}
        onOverview={backToOverview}
        onAddHousehold={() => openQuickAdd(null)}
        onHighlight={setSearchHighlight}
        onPick={openPerson}
        loading={graph.loading || overview.loading}
      />

      {failure && (
        <p className="bg-red-100 px-4 py-2 text-sm text-red-900">
          {t('error.generic', { message: failure })}
        </p>
      )}

      <div className="relative flex-1 overflow-hidden">
        <GraphCanvas
          layout={layout}
          centerId={centerId}
          selectedId={selectedId}
          locale={locale}
          highlight={highlight}
          relateSelection={[relate.a?.id, relate.b?.id].filter(Boolean)}
          expandingId={graph.expanding}
          onSelect={onNodeClick}
          onExpand={expand}
          onRenderModeChange={setRenderMode}
          registerControls={(api) => {
            controls.current = api
          }}
          t={t}
        />

        {renderMode === 'dots' && (
          <p className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-[var(--card-bg)] px-4 py-1.5 text-xs opacity-80">
            {t('big.legend')}
          </p>
        )}

        {!relate.active && mode === 'detail' && (
          <SidePanel
            layout={layout}
            person={selected}
            locale={locale}
            t={t}
            onClose={() => setSelectedId(null)}
            onSetCenter={openPerson}
            onRelateFrom={(person) => setRelate({ ...IDLE_RELATE, active: true, a: person })}
            onAddHousehold={openQuickAdd}
            onSelect={(person) => setSelectedId(person.id)}
          />
        )}
      </div>

      <RelateBar
        t={t}
        locale={locale}
        state={{ ...relate, allLoaded: allPathNodesLoaded }}
        onClear={() => setRelate(IDLE_RELATE)}
        onCenterAncestor={centerOnCommonAncestor}
        onSelect={(person) => {
          setRelate(IDLE_RELATE)
          openPerson(person)
        }}
      />

      {quickAddOpen && (
        <QuickAddDialog
          t={t}
          locale={locale}
          anchor={quickAddFor}
          onClose={() => {
            setQuickAddOpen(false)
            setQuickAddFor(null)
          }}
          onCreated={onHouseholdCreated}
        />
      )}
    </div>
  )
}
