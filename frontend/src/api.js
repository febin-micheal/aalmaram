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

const BASE = import.meta.env.VITE_API_BASE_URL ?? '/api/v1'

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

async function post(path, body) {
  // DRF's SessionAuthentication enforces CSRF on unsafe methods. A client that has only
  // ever done GETs may not hold the cookie yet, so ask for one first.
  if (!readCookie('csrftoken')) await get('/csrf/')

  const response = await fetch(new URL(`${BASE}${path}`, window.location.origin), {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-CSRFToken': readCookie('csrftoken') ?? '',
    },
    body: JSON.stringify(body),
  })

  if (response.status === 403 || response.status === 401) throw new NotAuthenticated()
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const error = new Error(`${response.status} ${response.statusText}`)
    // Surface the field-level message DRF returns rather than a bare status code.
    error.detail = firstMessage(payload)
    throw error
  }
  return payload
}

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
