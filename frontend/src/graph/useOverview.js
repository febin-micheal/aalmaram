import { useCallback, useMemo, useState } from 'react'

import { fetchOverview } from '../api.js'
import { layoutOverview } from './layoutOverview.js'

/**
 * The whole archive, loaded once.
 *
 * One request on open, then reused: the overview is the landing view and the place the
 * user returns to, and refetching it on every navigation would make going "back" feel
 * slower than going in. `refresh()` is called after a household is added, which is the
 * only thing that changes it from inside the app.
 */
export function useOverview() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const payload = await fetchOverview()
      setData(payload)
      return payload
    } catch (err) {
      setError(err)
      throw err
    } finally {
      setLoading(false)
    }
  }, [])

  const layout = useMemo(() => (data ? layoutOverview(data) : null), [data])

  return {
    data,
    stats: data?.stats ?? null,
    isEmpty: Boolean(data) && data.stats.persons === 0,
    layout,
    loading,
    error,
    load,
    refresh: load,
  }
}
