import { useCallback, useRef, useState } from 'react'

import { createPerson, deletePerson, leaveUnion, updatePerson } from '../api.js'
import { draftPosition } from './draftPlacement.js'
import { CARD_H, CARD_W } from './layout.js'

/**
 * The editing state machine behind direct manipulation.
 *
 * Three ideas hold it together:
 *
 * **Optimistic, but honest.** A typed name appears instantly as a provisional node so the
 * canvas keeps up with someone reciting a family out loud. If the server refuses, the node
 * is removed and the reason is shown — the graph never silently keeps something the
 * database rejected.
 *
 * **Never guess a union.** When a person has two marriages, "add a child" has no answer.
 * The server refuses with the candidates, and the editor moves into `choosing-union`
 * rather than picking. Crucially, no create request is sent again until a union is chosen.
 *
 * **Undo is a stack of real API calls.** Every step is inverted against the server rather
 * than rewound locally, because the database is the record — a local-only undo would be a
 * lie the next reload exposes. Steps unwind newest-first, and the server refuses to delete
 * a node that has since acquired relatives of its own, so undo cannot become a bulk delete.
 * Redo replays the same descriptors forward.
 */

const IDLE = { mode: 'idle', draft: null, candidateUnions: [], openSeats: [], error: null }

export function useEditor({ onApplied, onRemoved, onError }) {
  const [state, setState] = useState(IDLE)
  const [busy, setBusy] = useState(false)
  /**
   * The undo/redo stack.
   *
   * State, not a ref, because the toolbar buttons have to enable and disable as it
   * changes. Each entry knows how to invert itself *and* how to re-apply itself, so undo
   * and redo are the same machinery read in opposite directions.
   */
  const [history, setHistory] = useState({ past: [], future: [] })
  const remember = useCallback((entry) => {
    // Any new action discards the redo branch — the standard rule, and the only honest
    // one once the graph has moved on from where those steps applied.
    setHistory((current) => ({ past: [...current.past, entry], future: [] }))
  }, [])
  // Every opened seat gets its own number. The input box focuses on this changing, so
  // chained seats (father then mother, sibling then sibling) can never collide the way a
  // key built from position or union id could.
  const seat = useRef(0)

  const cancel = useCallback(() => setState(IDLE), [])

  /** Open an inline input next to `anchor` for the given relationship. */
  const begin = useCallback((context, anchor, options = {}) => {
    setState({
      mode: 'placing',
      draft: {
        seat: ++seat.current,
        context,
        anchor,
        targetId: anchor?.id ?? null,
        unionId: options.unionId ?? null,
        position: options.position ?? draftPosition(context, anchor),
        // Keeping the union lets Tab open the next sibling on the same one.
        keepUnionForSiblings: options.keepUnionForSiblings ?? false,
      },
      candidateUnions: [],
      error: null,
    })
  }, [])

  /**
   * Commit the typed name. Returns { created, nextDraft } so the caller can decide
   * whether to open another input (the Tab sibling flow).
   */
  const commit = useCallback(
    async (name, { gender = 'unknown', andSibling = false } = {}) => {
      const draft = state.draft
      if (!draft || !name.trim()) {
        setState(IDLE)
        return null
      }

      const payload = {
        context: draft.unionId ? draft.unionContext ?? 'child_of_union' : draft.context,
        name_en: name.trim(),
        gender,
      }
      if (draft.unionId) payload.union = draft.unionId
      else if (draft.context !== 'standalone') payload.target = draft.targetId
      if (draft.forceNewUnion) payload.force_new_union = true

      setBusy(true)
      try {
        const created = await createPerson(payload)
        remember({ kind: 'create', payload, created })
        onApplied?.(created)

        // "+ parents" opens the second seat straight away: father, Tab, mother, Enter.
        // The common case therefore never reaches the open-seat question at all.
        if (draft.context === 'parent_of' && created.union) {
          setState({
            mode: 'placing',
            draft: {
              seat: ++seat.current,
              context: 'partner_in_union',
              unionContext: 'partner_in_union',
              anchor: draft.anchor,
              targetId: draft.targetId,
              unionId: created.union,
              position: { x: draft.position.x + CARD_W + 26, y: draft.position.y },
              secondParent: true,
            },
            candidateUnions: [],
            openSeats: [],
            error: null,
          })
          return created
        }

        if (andSibling) {
          // Straight into the next sibling on the same union: five names, five Enters.
          const unionId = created.union
          setState({
            mode: 'placing',
            draft: {
              seat: ++seat.current,
              context: 'child_of_union',
              anchor: draft.anchor,
              targetId: draft.targetId,
              unionId,
              position: {
                x: draft.position.x + CARD_W + 26,
                y: draft.position.y,
              },
              keepUnionForSiblings: true,
            },
            candidateUnions: [],
            error: null,
          })
        } else {
          setState(IDLE)
        }
        return created
      } catch (error) {
        if (error.code === 'open_partner_slot') {
          // "The other parent of those children" and "a second marriage" are different
          // facts. Ask, and send nothing more until answered.
          setState((current) => ({
            ...current,
            mode: 'choosing-seat',
            openSeats: error.unions ?? [],
            error: null,
            pendingName: name.trim(),
            pendingGender: gender,
          }))
          return null
        }
        if (error.code === 'ambiguous_union') {
          // The one case where the UI must ask rather than retry. No further request is
          // made until a union dot is tapped.
          setState((current) => ({
            ...current,
            mode: 'choosing-union',
            candidateUnions: error.unions ?? [],
            error: null,
            pendingName: name.trim(),
            pendingGender: gender,
          }))
          return null
        }
        setState(IDLE)
        onError?.(error.detail ?? error.message)
        return null
      } finally {
        setBusy(false)
      }
    },
    [state.draft, onApplied, onError, remember],
  )

  /** Answer the "which marriage?" question by tapping one of the highlighted dots. */
  const chooseUnion = useCallback(
    async (unionId) => {
      const { draft, pendingName, pendingGender } = state
      if (!draft || !pendingName) return null

      setBusy(true)
      try {
        const payload = {
          context: 'child_of_union',
          union: unionId,
          name_en: pendingName,
          gender: pendingGender ?? 'unknown',
        }
        const created = await createPerson(payload)
        remember({ kind: 'create', payload, created })
        onApplied?.(created)
        setState(IDLE)
        return created
      } catch (error) {
        setState(IDLE)
        onError?.(error.detail ?? error.message)
        return null
      } finally {
        setBusy(false)
      }
    },
    [state, onApplied, onError, remember],
  )

  /** Answer the open-seat question: join this union, or start a new marriage. */
  const resolveSeat = useCallback(
    async (unionId) => {
      const { draft, pendingName, pendingGender } = state
      if (!pendingName) return null

      setBusy(true)
      try {
        const payload = unionId
          ? { context: 'partner_in_union', union: unionId, name_en: pendingName, gender: pendingGender }
          : {
              context: 'partner_of',
              target: draft?.targetId,
              name_en: pendingName,
              gender: pendingGender,
              force_new_union: true,
            }
        const created = await createPerson(payload)
        remember({ kind: 'create', payload, created })
        onApplied?.(created)
        setState(IDLE)
        return created
      } catch (error) {
        setState(IDLE)
        onError?.(error.detail ?? error.message)
        return null
      } finally {
        setBusy(false)
      }
    },
    [state, onApplied, onError, remember],
  )

  /**
   * Undo and redo, as one engine read in two directions.
   *
   * Every step is a real API call, not a local rewind — the database is the record, so an
   * undo that only changed the canvas would be a lie the next reload exposes. Steps are
   * taken newest-first, and the server refuses to delete a node that has since acquired
   * relatives of its own (`not_provisional`), so a deep undo cannot become a bulk delete.
   *
   * **Redoing a creation makes a new node, not the old one back.** The row was really
   * deleted, so the replacement gets a fresh id. That is why the stack entry is rewritten
   * with the new response: a later undo must delete the node that now exists, not the one
   * that does not. Nothing else can be holding a reference, because undo refuses once
   * anything points at it.
   */
  const applyInverse = useCallback(async (entry) => {
    if (entry.kind === 'edit') {
      const updated = await updatePerson(entry.personId, entry.before)
      onApplied?.({ person: updated, memberships: [], created_unions: [] })
      return { entry, removedUnions: [] }
    }
    // Joining someone already in the graph must not delete them: they are somebody else's
    // relative and existed before this step.
    const removed = entry.created.created_person === false
      ? await leaveUnion(entry.created.union, entry.created.person.id)
      : await deletePerson(entry.created.person.id)
    onRemoved?.(removed, entry.created)
    return { entry, removedUnions: removed?.unions ?? [] }
  }, [onApplied, onRemoved])

  const applyForward = useCallback(async (entry) => {
    if (entry.kind === 'edit') {
      const updated = await updatePerson(entry.personId, entry.after)
      onApplied?.({ person: updated, memberships: [], created_unions: [] })
      return entry
    }
    const created = await createPerson(entry.payload)
    onApplied?.(created)
    return { ...entry, created }
  }, [onApplied])

  const step = useCallback(
    async (direction) => {
      // Read the stack straight from state. Peeking through a `setHistory` updater looks
      // tempting but React does not run updaters synchronously, so the entry was always
      // still null by the time it was needed.
      const source = direction === 'undo' ? history.past : history.future
      const entry = source[source.length - 1]
      if (!entry) return false

      setBusy(true)
      try {
        if (direction === 'redo') {
          const settled = await applyForward(entry)
          setHistory((current) => ({
            past: [...current.past, settled],
            future: current.future.slice(0, -1),
          }))
          return true
        }

        const { entry: settled, removedUnions } = await applyInverse(entry)
        setHistory((current) => ({
          past: current.past.slice(0, -1),
          // Undoing the last partner out of a marriage deletes the marriage too, and a
          // `partner_in_union` step cannot re-create one. Rather than let redo fail with a
          // reference to a union that no longer exists, those steps leave the branch.
          future: [...current.future, settled].filter(
            (queued) => !(queued.payload?.union && removedUnions.includes(queued.payload.union)),
          ),
        }))
        return true
      } catch (error) {
        onError?.(error.detail ?? error.message)
        return false
      } finally {
        setBusy(false)
      }
    },
    [history, applyInverse, applyForward, onError],
  )

  const undo = useCallback(() => step('undo'), [step])
  const redo = useCallback(() => step('redo'), [step])

  /**
   * Inline field edit. Optimistic: the card updates at once and rolls back on refusal,
   * so a rejected year never leaves the canvas showing something the database does not
   * hold.
   */
  const editPerson = useCallback(
    async (person, fields) => {
      const before = { ...person }
      onApplied?.({ person: { ...person, ...previewOf(fields, person) }, memberships: [], created_unions: [] })
      try {
        const updated = await updatePerson(person.id, fields)
        onApplied?.({ person: updated, memberships: [], created_unions: [] })
        // Undo restores exactly the fields this edit touched, not the whole record — so
        // undoing a rename cannot silently revert someone else's concurrent change.
        remember({
          kind: 'edit',
          personId: person.id,
          before: Object.fromEntries(Object.keys(fields).map((key) => [key, before[key] ?? null])),
          after: fields,
        })
        return updated
      } catch (error) {
        onApplied?.({ person: before, memberships: [], created_unions: [] })
        onError?.(error.detail ?? error.message)
        return null
      }
    },
    [onApplied, onError, remember],
  )

  return {
    ...state,
    busy,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    undoDepth: history.past.length,
    begin,
    cancel,
    commit,
    chooseUnion,
    resolveSeat,
    undo,
    redo,
    editPerson,
  }
}

/**
 * What the card should show while a field edit is in flight.
 *
 * Only the fields the UI can render from the raw input — the server owns turning "1930s"
 * into a stored range, so the optimistic view shows the typed text rather than pretending
 * to know how it will parse.
 */
function previewOf(fields, person) {
  const preview = {}
  for (const key of ['name_en', 'name_ml', 'gender', 'house_name', 'is_living']) {
    if (key in fields) preview[key] = fields[key]
  }
  if ('name_en' in fields || 'name_ml' in fields) {
    preview.display_name = fields.name_en || fields.name_ml || person.display_name
  }
  if ('birth' in fields) preview.lifespan_compact = fields.birth || '?'
  return preview
}

export { CARD_H, CARD_W, draftPosition }
