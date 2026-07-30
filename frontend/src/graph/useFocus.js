import { useCallback, useEffect, useMemo, useState } from 'react'

import { fetchMe, fetchRelationsBulk, setAnchor } from '../api.js'

/**
 * Whose point of view the graph is drawn from.
 *
 * Two different things, deliberately kept apart:
 *
 * **The anchor ("me")** lives on the server, on `accounts.User.anchor_person`. It is one
 * per user because it is the same field Phase 2's privacy radius measures from — a second
 * notion of "me" would mean two different answers to "who may see this living relative".
 *
 * **Pins** are a scratchpad: people you are currently working between. They live in
 * localStorage, per device, because they are a working set rather than a fact about the
 * family — closer to which tabs you have open than to who you are. Losing them on another
 * machine costs nothing; syncing them would mean a migration and an API for something
 * ephemeral. (DECISIONS.md #22.)
 */

const PINS_KEY = 'aalmaram.pins'
const FOCUS_KEY = 'aalmaram.focus'

function readPins() {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(PINS_KEY) ?? '[]')
    return Array.isArray(raw) ? raw.filter((p) => p?.id) : []
  } catch {
    return []
  }
}

function writePins(pins) {
  try {
    globalThis.localStorage?.setItem(PINS_KEY, JSON.stringify(pins))
  } catch {
    /* private browsing, quota — pins are not worth failing over */
  }
}

export function useFocus({ onError } = {}) {
  const [me, setMe] = useState(null)
  const [pins, setPins] = useState(readPins)
  const [activeId, setActiveId] = useState(() => globalThis.localStorage?.getItem(FOCUS_KEY) ?? null)
  const [relations, setRelations] = useState({})
  const [loading, setLoading] = useState(false)

  // Restore "me" on load rather than asking again.
  useEffect(() => {
    fetchMe()
      .then((payload) => {
        setMe(payload.anchor_person ?? null)
        setActiveId((current) => current ?? payload.anchor_person?.id ?? null)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (activeId) globalThis.localStorage?.setItem(FOCUS_KEY, activeId)
    else globalThis.localStorage?.removeItem(FOCUS_KEY)
  }, [activeId])

  useEffect(() => writePins(pins), [pins])

  const claimAsMe = useCallback(
    async (person) => {
      try {
        const payload = await setAnchor(person?.id ?? null)
        setMe(payload.anchor_person ?? null)
        setActiveId(payload.anchor_person?.id ?? null)
        // "Me" is never also a pin — it is always chip #1 in its own right.
        setPins((current) => current.filter((p) => p.id !== payload.anchor_person?.id))
        return payload.anchor_person
      } catch (error) {
        onError?.(error.detail ?? error.message)
        return null
      }
    },
    [onError],
  )

  const pin = useCallback(
    (person) => {
      if (!person || person.id === me?.id) return
      setPins((current) =>
        current.some((p) => p.id === person.id)
          ? current
          : [...current, { id: person.id, name_en: person.name_en, name_ml: person.name_ml, display_name: person.display_name }],
      )
    },
    [me],
  )

  const unpin = useCallback(
    (personId) => {
      setPins((current) => current.filter((p) => p.id !== personId))
      setActiveId((current) => (current === personId ? (me?.id ?? null) : current))
    },
    [me],
  )

  /** Chip #1 is always "me" when set, and it cannot be removed from here. */
  const chips = useMemo(() => {
    const list = []
    if (me) list.push({ ...me, isMe: true, removable: false })
    for (const p of pins) list.push({ ...p, isMe: false, removable: true })
    return list
  }, [me, pins])

  const activeFocus = useMemo(
    () => chips.find((chip) => chip.id === activeId) ?? null,
    [chips, activeId],
  )

  /** Drop a focus id the server no longer knows, falling back to "me" if that still holds. */
  const dropStaleFocus = useCallback((deadId) => {
    setPins((current) => current.filter((p) => p.id !== deadId))
    setMe((current) => (current?.id === deadId ? null : current))
    setActiveId((current) => (current === deadId ? null : current))
    // Re-read the anchor: after a reset it is null, and that is the honest new state.
    fetchMe()
      .then((payload) => {
        setMe(payload.anchor_person ?? null)
        setActiveId((current) => current ?? payload.anchor_person?.id ?? null)
      })
      .catch(() => {})
  }, [])

  /** Fetch labels for exactly these people, relative to the active focus. */
  const loadRelations = useCallback(
    async (personIds) => {
      const targets = (personIds ?? []).filter((id) => id && id !== activeId)
      if (!activeId || !targets.length) {
        // Nobody to label — the one-person graph, or a graph showing only the focus.
        setRelations({})
        return
      }
      setLoading(true)
      try {
        const { stale, byPerson } = await fetchRelationsBulk(activeId, targets)
        if (stale) {
          setRelations({})
          dropStaleFocus(activeId)
          return
        }
        // Keyed by focus so a stale response for a previous focus cannot be applied.
        setRelations({ focus: activeId, byPerson })
      } catch (error) {
        // Labels are decoration on top of a graph that renders fine without them. A failure
        // here costs the chips, not the view, so it is logged rather than thrown at the
        // user as a toast they can do nothing about.
        console.warn('Could not load relationship labels', error)
        setRelations({})
      } finally {
        setLoading(false)
      }
    },
    [activeId, dropStaleFocus],
  )

  const labelFor = useCallback(
    (personId, locale) => {
      if (!activeId || relations.focus !== activeId) return null
      if (personId === activeId) return null // the focus shows its own chip, not a label
      const entry = relations.byPerson?.[personId]
      if (!entry) return null // disconnected, or not asked about
      return entry.labels?.[locale] || entry.labels?.en || null
    },
    [activeId, relations],
  )

  return {
    me,
    pins,
    chips,
    activeId,
    activeFocus,
    loading,
    setActive: setActiveId,
    claimAsMe,
    pin,
    unpin,
    loadRelations,
    labelFor,
    hasFocus: Boolean(activeId),
  }
}
