import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import type { Suburb } from '../../shared/suburbs'
import { suburbKey, suburbLabel } from '../../shared/suburbs'

/**
 * Suburb autocomplete. Brief s4 step 3: AUTOCOMPLETE ONLY, NO FREE TEXT.
 *
 * There is deliberately no path from typed text to a saved value. The input is a search box, the
 * only way to add a suburb is to choose a result, and pressing Enter with no highlighted result
 * does nothing. Free text here is how service names ended up in the service-area field.
 */

export function SuburbSearch({
  onPick,
  placeholder = 'Start typing a suburb or postcode',
  exclude = [],
}: {
  onPick: (s: Suburb) => void
  placeholder?: string
  exclude?: Suburb[]
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Suburb[]>([])
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  const excluded = new Set(exclude.map(suburbKey))

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([])
      return
    }
    let cancelled = false
    const timer = setTimeout(async () => {
      setLoading(true)
      setError(null)
      try {
        const res = await api.searchSuburbs(query)
        if (!cancelled) {
          setResults(res.results.filter((r) => !excluded.has(suburbKey(r))))
          setHighlight(0)
          setOpen(true)
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Suburb lookup failed')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 180)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, exclude.length])

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  const choose = (s: Suburb) => {
    onPick(s)
    setQuery('')
    setResults([])
    setOpen(false)
  }

  return (
    <div className="relative" ref={boxRef}>
      <input
        className="input"
        value={query}
        placeholder={placeholder}
        autoComplete="off"
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => results.length > 0 && setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setHighlight((h) => Math.min(h + 1, results.length - 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setHighlight((h) => Math.max(h - 1, 0))
          } else if (e.key === 'Enter') {
            // Enter only ever selects an existing result. It never accepts typed text.
            e.preventDefault()
            const picked = results[highlight]
            if (picked) choose(picked)
          } else if (e.key === 'Escape') {
            setOpen(false)
          }
        }}
      />
      {loading ? (
        <span className="absolute top-3 right-3 h-4 w-4 animate-spin rounded-full border-2 border-ice-200 border-t-ice-500" />
      ) : null}

      {error ? <p className="field-error">{error}</p> : null}

      {open && results.length > 0 ? (
        <ul className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-ice-200 bg-white shadow-lg">
          {results.map((s, i) => (
            <li key={suburbKey(s)}>
              <button
                type="button"
                className={`block w-full px-3.5 py-2 text-left text-sm ${
                  i === highlight ? 'bg-ice-100' : 'hover:bg-ice-50'
                }`}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => choose(s)}
              >
                {suburbLabel(s)}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {open && !loading && query.trim().length >= 2 && results.length === 0 ? (
        <div className="absolute z-20 mt-1 w-full rounded-lg border border-ice-200 bg-white px-3.5 py-3 text-sm text-ice-500 shadow-lg">
          No suburb matches that. Try the postcode, or a nearby suburb.
        </div>
      ) : null}
    </div>
  )
}

export function SuburbChips({
  suburbs,
  onRemove,
}: {
  suburbs: Suburb[]
  onRemove: (s: Suburb) => void
}) {
  if (suburbs.length === 0) return null
  return (
    <ul className="mt-3 flex flex-wrap gap-2">
      {suburbs.map((s) => (
        <li key={suburbKey(s)}>
          <span className="chip-off">
            {s.name}
            <button
              type="button"
              aria-label={`Remove ${s.name}`}
              className="ml-1 text-ice-500 hover:text-red-600"
              onClick={() => onRemove(s)}
            >
              &times;
            </button>
          </span>
        </li>
      ))}
    </ul>
  )
}
