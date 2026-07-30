/**
 * API client.
 *
 * Calls go to a same-origin path, proxied to Django by the Vite dev server. That is what
 * lets the admin session cookie authenticate the explorer: log into /admin once in this
 * browser and every request here is already signed in. `credentials: 'same-origin'` is
 * the piece that actually sends the cookie.
 *
 * A 403 is therefore not an error to retry — it means "go and log in", and the UI says so.
 */

// Optional chaining so this module is importable outside Vite — the headless checks drive
// the real request-building code rather than a copy of it.
const BASE = import.meta.env?.VITE_API_BASE_URL ?? '/api/v1'

export class NotAuthenticated extends Error {
  constructor() {
    super('Not signed in to the Django admin')
    this.name = 'NotAuthenticated'
  }
}

async function get(path, params = {}) {
  const url = new URL(`${BASE}${path}`, window.location.origin)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value)
  }

  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  })

  if (response.status === 403 || response.status === 401) throw new NotAuthenticated()
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url.pathname}`)
  return response.json()
}

function readCookie(name) {
  return document.cookie
    .split('; ')
    .find((row) => row.startsWith(`${name}=`))
    ?.split('=')[1]
}

async function send(method, path, body) {
  // DRF's SessionAuthentication enforces CSRF on unsafe methods. A client that has only
  // ever done GETs may not hold the cookie yet, so ask for one first.
  if (!readCookie('csrftoken')) await get('/csrf/')

  const response = await fetch(new URL(`${BASE}${path}`, window.location.origin), {
    method,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-CSRFToken': readCookie('csrftoken') ?? '',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  if (response.status === 403 || response.status === 401) throw new NotAuthenticated()
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const error = new Error(`${response.status} ${response.statusText}`)
    error.status = response.status
    // The server's structured refusals — "which marriage?", "already has parents",
    // "no longer undoable" — are answers the UI must act on, not just messages.
    error.code = payload?.code ?? null
    error.unions = payload?.unions ?? null
    error.detail = firstMessage(payload)
    throw error
  }
  return payload
}

const post = (path, body) => send('POST', path, body)

function firstMessage(payload) {
  if (!payload) return null
  if (typeof payload === 'string') return payload
  if (Array.isArray(payload)) return firstMessage(payload[0])
  if (payload.detail) return String(payload.detail)
  const first = Object.values(payload)[0]
  return first ? firstMessage(first) : null
}

export const searchPersons = (search) => get('/persons/', { search })
export const suggestedPersons = () => get('/persons/suggested/')

/** The whole graph, banded — one request, the landing view's data. */
export const fetchOverview = () => get('/overview/')

export const fetchNeighborhood = (personId, { up = 2, down = 2 } = {}) =>
  get(`/persons/${personId}/neighborhood/`, { generations_up: up, generations_down: down })

export const fetchRelation = (a, b) => get('/relate/', { a, b })

/** Create a household; returns the created subgraph, neighborhood-shaped, for merging. */
export const quickAdd = (payload) => post('/quick-add/', payload)

/**
 * Create one person already wired into a relationship — what a canvas affordance does.
 *
 * `context` is partner_of | child_of_person | child_of_union | parent_of. The server owns
 * what each means, including refusing to guess which marriage a child belongs to; a 409
 * with `code: "ambiguous_union"` carries the candidate unions for the UI to ask about.
 */
export const createPerson = (payload) => post('/persons/', payload)

export const updatePerson = (id, fields) => send('PATCH', `/persons/${id}/`, fields)

/** Undo a creation. 409 `not_provisional` means the node has grown edges of its own. */
export const deletePerson = (id) => send('DELETE', `/persons/${id}/`)

/** Detach a partner from a union — the inverse of joining an existing person to one. */
export const leaveUnion = (unionId, personId) =>
  send('DELETE', `/unions/${unionId}/partners/${personId}/`)

/** Who the signed-in user is, and which Person they are anchored to. */
export const fetchMe = () => get('/me/')

/** Set (or clear, with null) the anchor — the "this is me" action. */
export const setAnchor = (personId) => send('PATCH', '/me/anchor/', { person_id: personId })

/**
 * How each of `targetIds` relates to `fromId`, in one request.
 *
 * The server caps a call at 200 targets, so this batches. Labelling is only ever asked for
 * the cards actually on screen, and this is what keeps switching focus from costing a
 * round trip per visible card.
 */
export async function fetchRelationsBulk(fromId, targetIds, batchSize = 150) {
  // Self is dropped, not asked about: the focus wears its own chip. With one person in the
  // graph that empties the list, and a request with nothing to label is a request that
  // should not be made at all.
  const unique = [...new Set(targetIds)].filter((id) => id && id !== fromId)
  if (!fromId || !unique.length) return { stale: false, byPerson: {} }

  const results = {}
  for (let i = 0; i < unique.length; i += batchSize) {
    const batch = unique.slice(i, i + batchSize)
    const payload = await get('/relate-bulk/', { from: fromId, to: batch.join(',') })
    // `from: null` means the server has no such person — our focus outlived the row it
    // pointed at. Report it rather than showing a silently unlabelled graph.
    if (payload.from === null) return { stale: true, byPerson: {} }
    Object.assign(results, payload.results)
  }
  return { stale: false, byPerson: results }
}
