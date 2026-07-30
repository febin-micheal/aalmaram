import { useCallback, useRef, useState } from 'react'

import { createPerson, deletePerson, updatePerson } from '../api.js'
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
 * **Undo is narrow.** One step, implemented as the inverse API call (DELETE), and only for
 * a node just created. The server refuses once that node has acquired edges of its own, so
 * undo cannot become an accidental delete button.
 */

const IDLE = { mode: 'idle', draft: null, candidateUnions: [], error: null }

export function useEditor({ onApplied, onRemoved, onError }) {
  const [state, setState] = useState(IDLE)
  const [busy, setBusy] = useState(false)
  const lastCreated = useRef(null)

  const cancel = useCallback(() => setState(IDLE), [])

  /** Open an inline input next to `anchor` for the given relationship. */
  const begin = useCallback((context, anchor, options = {}) => {
    setState({
      mode: 'placing',
      draft: {
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
        context: draft.unionId ? 'child_of_union' : draft.context,
        name_en: name.trim(),
        gender,
      }
      if (draft.unionId) payload.union = draft.unionId
      else payload.target = draft.targetId

      setBusy(true)
      try {
        const created = await createPerson(payload)
        lastCreated.current = created
        onApplied?.(created)

        if (andSibling) {
          // Straight into the next sibling on the same union: five names, five Enters.
          const unionId = created.union
          setState({
            mode: 'placing',
            draft: {
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
    [state.draft, onApplied, onError],
  )

  /** Answer the "which marriage?" question by tapping one of the highlighted dots. */
  const chooseUnion = useCallback(
    async (unionId) => {
      const { draft, pendingName, pendingGender } = state
      if (!draft || !pendingName) return null

      setBusy(true)
      try {
        const created = await createPerson({
          context: 'child_of_union',
          union: unionId,
          name_en: pendingName,
          gender: pendingGender ?? 'unknown',
        })
        lastCreated.current = created
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
    [state, onApplied, onError],
  )

  /** Single-step undo: the inverse API call for the node just created. */
  const undo = useCallback(async () => {
    const created = lastCreated.current
    if (!created) return false
    setBusy(true)
    try {
      const removed = await deletePerson(created.person.id)
      lastCreated.current = null
      onRemoved?.(removed, created)
      return true
    } catch (error) {
      onError?.(error.detail ?? error.message)
      return false
    } finally {
      setBusy(false)
    }
  }, [onRemoved, onError])

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
        return updated
      } catch (error) {
        onApplied?.({ person: before, memberships: [], created_unions: [] })
        onError?.(error.detail ?? error.message)
        return null
      }
    },
    [onApplied, onError],
  )

  return {
    ...state,
    busy,
    canUndo: Boolean(lastCreated.current),
    begin,
    cancel,
    commit,
    chooseUnion,
    undo,
    editPerson,
    forgetUndo: () => {
      lastCreated.current = null
    },
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
