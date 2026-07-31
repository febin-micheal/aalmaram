import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { NotAuthenticated, fetchRelation } from './api.js'
import EmptyState from './components/EmptyState.jsx'
import FocusBar from './components/FocusBar.jsx'
import GraphCanvas from './components/GraphCanvas.jsx'
import QuickAddDialog from './components/QuickAddDialog.jsx'
import RelateBar from './components/RelateBar.jsx'
import RenderTruthBanner from './components/RenderTruthBanner.jsx'
import SeatChooser from './components/SeatChooser.jsx'
import SidePanel from './components/SidePanel.jsx'
import Toolbar from './components/Toolbar.jsx'
import InlineInput from './components/InlineInput.jsx'
import Toast from './components/Toast.jsx'
import { findLinkingUnion } from './graph/layout.js'
import { toScreen } from './graph/layoutOverview.js'
import { useEditor } from './graph/useEditor.js'
import { useFocus } from './graph/useFocus.js'
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
  const [toast, setToast] = useState(null)
  const [activeId, setActiveId] = useState(null)
  const [yearEditFor, setYearEditFor] = useState(null)
  const [nameEditFor, setNameEditFor] = useState(null)
  // True once "Add the first person" is clicked on an empty archive: the canvas takes
  // over from the empty screen even though there is nothing on it yet.
  const [startingFirstPerson, setStartingFirstPerson] = useState(false)
  const controls = useRef({})
  // Where the anchor sat on screen before a re-layout, so it can be put back.
  const anchorScreen = useRef(null)

  const t = translatorFor(locale)
  const focus = useFocus({ onError: (message) => showToastRef.current?.(message) })
  const overview = useOverview()
  const graph = useGraph()
  const { centerId } = graph

  const mode = centerId ? 'detail' : 'overview'
  const layout = centerId ? graph.layout : overview.layout
  const layoutRef = useRef(layout)
  layoutRef.current = layout

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

  const showToast = useCallback((message, tone = 'error') => {
    setToast({ message, tone, at: Date.now() })
  }, [])
  // useFocus is created before showToast exists; a ref bridges the two.
  const showToastRef = useRef(showToast)
  showToastRef.current = showToast

  /**
   * Adding a node re-runs the layout, which can shift everything sideways. Remember where
   * the anchor was on screen before the change and pan by the difference afterwards, so
   * the person you were working on does not move out from under your cursor.
   */
  const rememberAnchor = useCallback((personId) => {
    const person = layoutRef.current?.persons.get(personId)
    anchorScreen.current = person && controls.current.toScreenPoint
      ? { id: personId, screen: controls.current.toScreenPoint({ x: person.x, y: person.y }) }
      : null
  }, [])

  const editor = useEditor({
    onApplied: (created) => {
      graph.applyCreated(created, {
        context: editingContext.current?.context,
        anchorId: editingContext.current?.anchorId,
      })
    },
    onRemoved: (removed) => {
      graph.removeNodes(removed)
      setToast({ message: t('edit.undone'), tone: 'ok', at: Date.now() })
    },
    onError: (message) => showToast(message),
  })
  const editingContext = useRef(null)

  // After any layout change, put the anchor back where it was on screen.
  useEffect(() => {
    const remembered = anchorScreen.current
    if (!remembered || !layout) return
    const person = layout.persons.get(remembered.id)
    if (!person || !controls.current.toScreenPoint) return
    const now = controls.current.toScreenPoint({ x: person.x, y: person.y })
    const dx = remembered.screen.x - now.x
    const dy = remembered.screen.y - now.y
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) controls.current.panBy?.(dx, dy)
    anchorScreen.current = null
  }, [layout])

  /**
   * Begin the very first person, on the canvas rather than in a form.
   *
   * Every other affordance grows from an existing card; there is no card yet, so this
   * uses the `standalone` context and drops the input at the origin of an empty sheet.
   * From the resulting node, + partner / + child / + parents build out the rest.
   */
  const startFirstPerson = useCallback(() => {
    setStartingFirstPerson(true)
    editingContext.current = { context: 'standalone', anchorId: null }
    editor.begin('standalone', null)
  }, [editor])

  /**
   * Open an input for a new relative of `person`.
   *
   * Works in both views. This used to refuse in the overview on the grounds that "editing
   * happens in the detail view", which was true when the overview was a read-only
   * big picture — but a small archive never leaves the overview, so that rule made the
   * add-buttons dead exactly when the graph was small enough to need them most. The
   * overview reloads from the server after a commit rather than merging optimistically;
   * the new card arrives a beat later, which is the honest cost of laying out every
   * component at once.
   */
  const startAdd = useCallback(
    (context, person) => {
      editingContext.current = { context, anchorId: person.id }
      rememberAnchor(person.id)
      editor.begin(context, layoutRef.current?.persons.get(person.id) ?? person)
      setActiveId(person.id)
    },
    [editor, rememberAnchor],
  )

  const commitDraft = useCallback(
    async (name, options) => {
      const anchorId = editingContext.current?.anchorId
      if (anchorId) rememberAnchor(anchorId)
      const created = await editor.commit(name, options)
      if (created) {
        showToast(t('edit.added', { name: created.person.display_name }), 'ok')
        overview.refresh().catch(() => {})

        // The first person has nothing to merge into, so load them as the centre —
        // that is what puts a real card on the canvas with its affordances.
        if (editingContext.current?.context === 'standalone') {
          setStartingFirstPerson(false)
          editingContext.current = null
          try {
            await graph.loadCenter(created.person.id, { up: 1, down: 1 })
            setSelectedId(created.person.id)
            setActiveId(created.person.id)
          } catch (error) {
            handleError(error)
          }
        }
      }
    },
    [editor, rememberAnchor, showToast, t, overview, graph, handleError],
  )

  const chooseUnion = useCallback(
    async (unionId) => {
      const created = await editor.chooseUnion(unionId)
      if (created) {
        showToast(t('edit.added', { name: created.person.display_name }), 'ok')
        overview.refresh().catch(() => {})
      }
    },
    [editor, showToast, t, overview],
  )

  /**
   * Escape closes the topmost thing, innermost first.
   *
   * It used to be handled only inside the name input, so it worked while the caret was in
   * the box and nowhere else — press it after clicking away, or while the canvas was asking
   * which marriage a child belongs to, and nothing happened. A component that has already
   * dealt with the key calls `preventDefault`, and this skips those.
   */
  const escape = useCallback(() => {
    if (quickAddOpen) return setQuickAddOpen(false)
    if (nameEditFor) return setNameEditFor(null)
    if (yearEditFor) return setYearEditFor(null)
    if (editor.mode !== 'idle') {
      // Covers placing, choosing-union and choosing-seat alike.
      editor.cancel()
      setStartingFirstPerson(false)
      return undefined
    }
    if (relate.active) return setRelate(IDLE_RELATE)
    if (searchHighlight.length) return setSearchHighlight([])
    if (selectedId) return setSelectedId(null)
    return undefined
  }, [quickAddOpen, nameEditFor, yearEditFor, editor, relate.active, searchHighlight.length, selectedId])

  // Ctrl/Cmd+Z undoes, Ctrl+Y (or Ctrl/Cmd+Shift+Z) redoes, anywhere on the page.
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') {
        if (event.defaultPrevented) return
        event.preventDefault()
        escape()
        return
      }
      const accel = event.ctrlKey || event.metaKey
      if (accel && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        editor.redo()
        return
      }
      if (accel && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) editor.redo()
        else editor.undo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editor, escape])

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

  /**
   * Where to put the inline input, in screen pixels.
   *
   * Clamped into the viewport: on a narrow phone the natural position for "+ partner" can
   * fall off the right edge, and an input you cannot see is worse than one slightly out of
   * place.
   */
  /** Screen position for the rename box: over the card it is renaming. */
  const renameScreen = useMemo(() => {
    const person = nameEditFor && layout?.persons.get(nameEditFor.id)
    const transform = controls.current.transform
    if (!person || !transform) return { x: 24, y: 96 }
    const point = toScreen(transform, person)
    const width = window.innerWidth || 390
    return { x: Math.max(8, Math.min(point.x, width - 260)), y: Math.max(56, point.y) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nameEditFor, renderMode, layout])

  const draftScreen = useMemo(() => {
    const position = editor.draft?.position
    const transform = controls.current.transform
    if (!position || !transform) return { x: 24, y: 96 }
    const point = toScreen(transform, position)
    const width = window.innerWidth || 390
    return {
      x: Math.max(8, Math.min(point.x, width - 260)),
      y: Math.max(56, point.y),
    }
  }, [editor.draft, renderMode, layout])

  /**
   * Label only what is drawn.
   *
   * The canvas already culls to the viewport in card mode, and that same set is what gets
   * asked about — labelling the whole database would be wasted work that has to be redone
   * on every focus switch. In dot mode nothing is labelled, because a dot has no room for
   * a chip.
   */
  const visibleIds = useMemo(() => {
    if (!layout || renderMode !== 'cards') return []
    return [...layout.persons.keys()]
  }, [layout, renderMode])

  useEffect(() => {
    if (!focus.activeId || !visibleIds.length) return
    focus.loadRelations(visibleIds)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus.activeId, visibleIds.length, layout])

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

  if (overview.isEmpty && mode === 'overview' && !startingFirstPerson) {
    return (
      <>
        <EmptyState
          t={t}
          onAddFirstPerson={startFirstPerson}
          onUseForm={() => openQuickAdd(null)}
        />
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
        onUndo={() => {
          setToast(null)
          editor.undo()
        }}
        onRedo={() => {
          setToast(null)
          editor.redo()
        }}
        canUndo={editor.canUndo}
        canRedo={editor.canRedo}
        onHighlight={setSearchHighlight}
        onPick={openPerson}
        loading={graph.loading || overview.loading}
      />

      {/* Dev-only, and above everything: a false kinship on screen must not be something
          you have to notice by eye. */}
      {import.meta.env?.DEV && <RenderTruthBanner violations={layout?.violations} />}

      <FocusBar
        t={t}
        locale={locale}
        chips={focus.chips}
        activeId={focus.activeId}
        onActivate={focus.setActive}
        onUnpin={focus.unpin}
        onPin={() => focus.pin(selected)}
        canPin={Boolean(selected) && selected.id !== focus.me?.id && !focus.pins.some((p) => p.id === selected?.id)}
        onCenter={() => {
          const person = layout?.persons.get(focus.activeId)
          if (person) controls.current.centerOn?.({ x: person.cx, y: person.cy })
        }}
        loading={focus.loading}
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
          editor={editor}
          activeId={activeId}
          onActivate={setActiveId}
          onAddRelative={relate.active ? undefined : startAdd}
          onChooseUnion={chooseUnion}
          onEditYear={(person) => setYearEditFor(person)}
          onEditName={(person) => setNameEditFor(person)}
          focusId={focus.activeId}
          labelFor={(personId) => focus.labelFor(personId, locale)}
          registerControls={(api) => {
            controls.current = api
          }}
          t={t}
        />

        {nameEditFor && (
          <InlineInput
            focusKey={`rename:${nameEditFor.id}`}
            screenX={renameScreen.x}
            screenY={renameScreen.y}
            busy={editor.busy}
            hint={t('edit.renameHint')}
            initialValue={nameEditFor.name_en || nameEditFor.display_name || ''}
            initialGender={nameEditFor.gender ?? 'unknown'}
            onCancel={() => setNameEditFor(null)}
            onCommit={async (value, { gender }) => {
              const person = nameEditFor
              setNameEditFor(null)
              const fields = { name_en: value }
              if (gender && gender !== (person.gender ?? 'unknown')) fields.gender = gender
              await editor.editPerson(person, fields)
              overview.refresh().catch(() => {})
            }}
            t={t}
          />
        )}

        {editor.mode === 'placing' && editor.draft && (
          <InlineInput
            focusKey={editor.draft.seat}
            screenX={draftScreen.x}
            screenY={draftScreen.y}
            busy={editor.busy}
            hint={editor.draft?.secondParent ? t('edit.secondParentHint') : undefined}
            onCommit={commitDraft}
            onCancel={() => {
              editor.cancel()
              setStartingFirstPerson(false)
            }}
            t={t}
          />
        )}

        {editor.mode === 'choosing-seat' && (
          <SeatChooser
            t={t}
            locale={locale}
            name={editor.pendingName}
            seats={editor.openSeats}
            onJoin={async (unionId) => {
              const created = await editor.resolveSeat(unionId)
              if (created) {
                showToast(t('edit.added', { name: created.person.display_name }), 'ok')
                overview.refresh().catch(() => {})
              }
            }}
            onNewMarriage={async () => {
              const created = await editor.resolveSeat(null)
              if (created) {
                showToast(t('edit.added', { name: created.person.display_name }), 'ok')
                overview.refresh().catch(() => {})
              }
            }}
            onCancel={editor.cancel}
          />
        )}

        {editor.mode === 'choosing-union' && (
          <p className="absolute left-1/2 top-4 z-40 -translate-x-1/2 rounded-lg bg-[var(--accent-strong)] px-4 py-2 text-sm text-white shadow-xl">
            {t('edit.chooseUnion')}
            <button
              type="button"
              onClick={editor.cancel}
              className="ml-3 rounded border border-white/40 px-2 py-0.5"
            >
              {t('quickAdd.cancel')}
            </button>
          </p>
        )}

        {yearEditFor && (
          <YearEditor
            person={yearEditFor}
            t={t}
            onCancel={() => setYearEditFor(null)}
            onSave={async (value) => {
              const person = yearEditFor
              setYearEditFor(null)
              await editor.editPerson(person, { birth: value })
            }}
          />
        )}

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
            onEdit={(person, fields) => editor.editPerson(person, fields)}
            isMe={focus.me?.id === selected?.id}
            onClaimAsMe={async (person) => {
              const claimed = await focus.claimAsMe(person)
              if (claimed) showToast(t('focus.claimed', { name: claimed.display_name }), 'ok')
            }}
            onUnclaimMe={async () => {
              await focus.claimAsMe(null)
              showToast(t('focus.unclaimed'), 'ok')
            }}
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

      <Toast
        toast={toast}
        onDismiss={() => setToast(null)}
        onUndo={editor.canUndo ? () => { setToast(null); editor.undo() } : undefined}
        t={t}
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


/**
 * A one-field editor for the year chip.
 *
 * Uncertainty is the point: "1938", "1930s", "c. 1940" and "?" are all valid answers, and
 * the placeholder says so rather than demanding a number.
 */
function YearEditor({ person, t, onSave, onCancel }) {
  const [value, setValue] = useState(person.lifespan_compact?.split(' ')[0] ?? '')

  return (
    <div
      className="absolute inset-0 z-40 flex items-start justify-center bg-black/20 pt-24"
      onMouseDown={(event) => event.target === event.currentTarget && onCancel()}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          onSave(value)
        }}
        className="w-72 space-y-2 rounded-xl border border-[var(--card-border)] bg-[var(--card-bg)] p-4 shadow-2xl"
      >
        <label className="block text-sm font-medium">
          {t('edit.birthOf', { name: person.display_name })}
        </label>
        <input
          autoFocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => event.key === 'Escape' && onCancel()}
          placeholder={t('edit.yearPlaceholder')}
          className="w-full rounded-lg border border-[var(--card-border)] bg-transparent px-3 py-2"
        />
        <p className="text-xs opacity-60">{t('edit.yearHelp')}</p>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-lg border border-[var(--card-border)] px-3 py-1.5 text-sm">
            {t('quickAdd.cancel')}
          </button>
          <button type="submit" className="rounded-lg bg-[var(--accent-strong)] px-3 py-1.5 text-sm font-medium text-white">
            {t('quickAdd.save')}
          </button>
        </div>
      </form>
    </div>
  )
}
