import { useCallback, useMemo, useState } from 'react'

import { fetchNeighborhood } from '../api.js'
import { layoutGraph } from './layout.js'

const EMPTY = { persons: [], unions: [], memberships: [] }

const membershipKey = (m) => `${m.union}:${m.person}:${m.role}`

/**
 * The loaded subgraph, and how it grows.
 *
 * The explorer never holds the whole database. It loads a neighbourhood around one
 * person and merges more in when the user expands a node. The one subtlety is that
 * `generation` is *relative to whatever person the server was asked about*, so an
 * expansion's rows have to be shifted onto the generations already on screen before its
 * nodes can be merged — otherwise a grandparent fetched from a cousin's perspective
 * lands in the wrong row.
 */
export function useGraph() {
  const [graph, setGraph] = useState(EMPTY)
  const [centerId, setCenterId] = useState(null)
  const [loading, setLoading] = useState(false)
  const [expanding, setExpanding] = useState(null)
  const [error, setError] = useState(null)

  const loadCenter = useCallback(async (personId, { up = 2, down = 2 } = {}) => {
    setLoading(true)
    setError(null)
    try {
      const payload = await fetchNeighborhood(personId, { up, down })
      setGraph({
        persons: payload.persons,
        unions: payload.unions,
        memberships: payload.memberships,
      })
      setCenterId(payload.center)
      return payload
    } catch (err) {
      setError(err)
      throw err
    } finally {
      setLoading(false)
    }
  }, [])

  const expand = useCallback(
    async (personId, direction) => {
      setExpanding(personId)
      setError(null)
      try {
        const up = direction === 'up' ? 2 : 1
        const down = direction === 'down' ? 2 : 1
        const payload = await fetchNeighborhood(personId, { up, down })

        setGraph((current) => {
          const anchor = current.persons.find((p) => p.id === personId)
          // Shift the incoming rows onto the ones already drawn.
          const offset = anchor ? anchor.generation : 0

          const persons = new Map(current.persons.map((p) => [p.id, p]))
          for (const incoming of payload.persons) {
            const shifted = { ...incoming, generation: incoming.generation + offset }
            const existing = persons.get(shifted.id)
            // Keep the generation already on screen; only take the new hidden counts,
            // which are what the expand chips are drawn from.
            persons.set(
              shifted.id,
              existing
                ? { ...existing, hidden_up: shifted.hidden_up, hidden_down: shifted.hidden_down }
                : shifted,
            )
          }

          const unions = new Map(current.unions.map((u) => [u.id, u]))
          for (const incoming of payload.unions) {
            if (!unions.has(incoming.id)) {
              unions.set(incoming.id, { ...incoming, generation: incoming.generation + offset })
            }
          }

          const memberships = new Map(current.memberships.map((m) => [membershipKey(m), m]))
          for (const incoming of payload.memberships) {
            memberships.set(membershipKey(incoming), incoming)
          }

          return {
            persons: [...persons.values()],
            unions: [...unions.values()],
            memberships: [...memberships.values()],
          }
        })
        return payload
      } catch (err) {
        setError(err)
        throw err
      } finally {
        setExpanding(null)
      }
    },
    [],
  )

  const reset = useCallback(() => {
    setGraph(EMPTY)
    setCenterId(null)
    setError(null)
  }, [])

  const layout = useMemo(
    () => (graph.persons.length ? layoutGraph(graph, centerId) : null),
    [graph, centerId],
  )

  return { graph, layout, centerId, loading, expanding, error, loadCenter, expand, reset }
}
