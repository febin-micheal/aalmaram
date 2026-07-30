import { useEffect, useRef, useState } from 'react'

import { searchPersons } from '../api.js'
import { accentFor, personName, personSecondaryName } from '../graph/person.js'

/**
 * Search, as a topbar overlay rather than a separate screen.
 *
 * Matches are highlighted where they sit in the overview — seeing *where* someone falls
 * in the whole tree is usually the answer to the question — and picking one dives into
 * their detailed neighbourhood.
 */
export default function SearchBox({ t, locale, onHighlight, onPick }) {
  const [term, setTerm] = useState('')
  const [results, setResults] = useState([])
  const [open, setOpen] = useState(false)
  const container = useRef(null)

  useEffect(() => {
    const query = term.trim()
    if (query.length < 2) {
      setResults([])
      onHighlight([])
      return undefined
    }
    // Debounced so a fast typist does not fire a request per keystroke.
    const timer = setTimeout(() => {
      searchPersons(query)
        .then((payload) => {
          setResults(payload.results)
          setOpen(true)
          onHighlight(payload.results.map((person) => person.id))
        })
        .catch(() => setResults([]))
    }, 220)
    return () => clearTimeout(timer)
  }, [term, onHighlight])

  useEffect(() => {
    const onClickAway = (event) => {
      if (container.current && !container.current.contains(event.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickAway)
    return () => document.removeEventListener('mousedown', onClickAway)
  }, [])

  const clear = () => {
    setTerm('')
    setResults([])
    setOpen(false)
    onHighlight([])
  }

  return (
    <div ref={container} className="relative min-w-0 flex-1 sm:max-w-xs">
      <input
        value={term}
        onChange={(event) => setTerm(event.target.value)}
        onFocus={() => results.length && setOpen(true)}
        placeholder={t('search.placeholder')}
        aria-label={t('search.placeholder')}
        className="w-full rounded-md border border-[var(--card-border)] bg-transparent px-3 py-1.5 text-sm outline-none focus:border-[var(--accent-strong)]"
      />
      {term && (
        <button
          type="button"
          onClick={clear}
          aria-label={t('search.clear')}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-sm opacity-50 hover:opacity-100"
        >
          ×
        </button>
      )}

      {open && (
        <ul className="absolute left-0 right-0 top-full z-30 mt-1 max-h-80 overflow-y-auto rounded-lg border border-[var(--card-border)] bg-[var(--card-bg)] shadow-xl">
          {results.length === 0 && (
            <li className="px-3 py-2 text-sm opacity-60">{t('search.noResults')}</li>
          )}
          {results.map((person) => (
            <li key={person.id}>
              <button
                type="button"
                onClick={() => {
                  setOpen(false)
                  onPick(person)
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--chip-bg)]"
              >
                <span
                  className="h-6 w-1 shrink-0 rounded"
                  style={{ background: accentFor(person) }}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{personName(person, locale)}</span>
                  <span className="block truncate text-xs opacity-60">
                    {[personSecondaryName(person, locale), person.house_name]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                <span className="shrink-0 text-xs tabular-nums opacity-60">
                  {person.lifespan_compact}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
