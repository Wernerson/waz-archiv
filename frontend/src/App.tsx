import { useEffect, useRef, useState } from 'react'
import './App.css'
import IssuesBrowser from './IssuesBrowser'
import PdfViewer from './PdfViewer'

interface Source {
  title: string
  type: string
  issue_filename: string
  issue_date: string
  page_start: number
  page_end: number
}

interface Hit {
  _id: string
  _score: number
  _source: Source
  highlight?: { text?: string[]; title?: string[] }
}

interface ViewerState {
  filename: string
  startPage: number
  title: string
}

interface YearBounds {
  min: number
  max: number
}

const CURRENT_YEAR = new Date().getFullYear()
const FALLBACK_YEAR_BOUNDS: YearBounds = { min: CURRENT_YEAR - 30, max: CURRENT_YEAR }

async function searchArticles(
  query: string,
  startYear: number,
  endYear: number,
): Promise<{ hits: Hit[]; total: number }> {
  const res = await fetch('/opensearch/articles/_search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: {
        bool: {
          must: [
            {
              multi_match: {
                query,
                fields: ['title^3', 'text'],
                type: 'best_fields',
              },
            },
          ],
          filter: [
            {
              range: {
                issue_year: {
                  gte: startYear,
                  lte: endYear,
                },
              },
            },
          ],
        },
      },
      highlight: {
        fields: {
          text: { fragment_size: 260, number_of_fragments: 1 },
          title: {},
        },
        pre_tags: ['<mark>'],
        post_tags: ['</mark>'],
      },
      _source: ['title', 'type', 'issue_filename', 'issue_date', 'page_start', 'page_end'],
      size: 20,
    }),
  })
  if (!res.ok) throw new Error(`OpenSearch error: ${res.status}`)
  const data = await res.json()
  return { hits: data.hits.hits, total: data.hits.total.value }
}

async function fetchYearBounds(): Promise<YearBounds> {
  const res = await fetch('/opensearch/articles/_search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      size: 0,
      aggs: {
        min_year: { min: { field: 'issue_year' } },
        max_year: { max: { field: 'issue_year' } },
      },
    }),
  })

  if (!res.ok) throw new Error(`OpenSearch error: ${res.status}`)
  const data = await res.json()
  const min = Math.floor(data.aggregations?.min_year?.value ?? NaN)
  const max = Math.floor(data.aggregations?.max_year?.value ?? NaN)
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    throw new Error('Invalid year bounds')
  }
  return { min, max }
}

function formatDate(iso: string): string {
  if (!iso) return ''
  const [year, month] = iso.split('-')
  return month && month !== '01' ? `${month}/${year}` : year
}

export default function App() {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<Hit[]>([])
  const [total, setTotal] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [viewer, setViewer] = useState<ViewerState | null>(null)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [yearBounds, setYearBounds] = useState<YearBounds>(FALLBACK_YEAR_BOUNDS)
  const [startYear, setStartYear] = useState(FALLBACK_YEAR_BOUNDS.min)
  const [endYear, setEndYear] = useState(FALLBACK_YEAR_BOUNDS.max)
  const [activeHandle, setActiveHandle] = useState<'start' | 'end' | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const showBrowser = total === null && !loading
  const yearSpan = Math.max(1, yearBounds.max - yearBounds.min)
  const startPercent = ((startYear - yearBounds.min) / yearSpan) * 100
  const endPercent = ((endYear - yearBounds.min) / yearSpan) * 100

  useEffect(() => {
    fetchYearBounds()
      .then((bounds) => {
        setYearBounds(bounds)
        setStartYear(bounds.min)
        setEndYear(bounds.max)
      })
      .catch((err) => {
        console.error('Failed to load year bounds', err)
      })
  }, [])

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    const q = query.trim()
    if (!q) {
      resetSearch()
      return
    }
    setLoading(true)
    setError(null)
    try {
      const result = await searchArticles(q, startYear, endYear)
      setHits(result.hits)
      setTotal(result.total)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed')
      setHits([])
      setTotal(null)
    } finally {
      setLoading(false)
    }
  }

  function resetSearch() {
    setQuery('')
    setHits([])
    setTotal(null)
    setError(null)
    inputRef.current?.focus()
  }

  function openViewer(filename: string, title: string, startPage = 1) {
    if (!filename) return
    setViewer({ filename, startPage, title })
  }

  function openArticle(src: Source) {
    if (!src.issue_filename || src.page_start == null) return
    openViewer(src.issue_filename, src.title, src.page_start)
  }

  function handleStartYearChange(value: number) {
    const clamped = Math.max(yearBounds.min, Math.min(value, endYear))
    setStartYear(clamped)
  }

  function handleEndYearChange(value: number) {
    const clamped = Math.min(yearBounds.max, Math.max(value, startYear))
    setEndYear(clamped)
  }

  return (
    <div className="app">
      <header className="header">
        <div className="header-inner">
          <h1>WAZ Archiv</h1>
          <p className="subtitle">Durchsuche 30 Jahre Ausgaben</p>
          <form className="search-form" onSubmit={handleSearch}>
            <input
              ref={inputRef}
              className="search-input"
              type="search"
              placeholder="Suchbegriff eingeben…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
            <button className="search-btn" type="submit" disabled={loading}>
              {loading ? '…' : 'Suchen'}
            </button>
          </form>
          <button
            type="button"
            className="filter-toggle"
            onClick={() => setFiltersOpen((open) => !open)}
            aria-expanded={filtersOpen}
          >
            {filtersOpen ? 'Filter ausblenden' : 'Filter anzeigen'}
          </button>
          {filtersOpen && (
            <div className="filters-panel">
              <div className="filters-header">
                <span>Zeitraum</span>
                <span className="filters-value">
                  {startYear}–{endYear}
                </span>
              </div>
              <div className="year-range-slider" aria-label="Jahresbereich auswählen">
                <div className="year-range-track" />
                <div
                  className="year-range-selection"
                  style={{
                    left: `calc(${startPercent}% + var(--year-thumb-radius))`,
                    width: `calc(${Math.max(0, endPercent - startPercent)}% - (var(--year-thumb-radius) * 2))`,
                  }}
                />
                <input
                  id="year-start"
                  className={`year-slider year-slider--start${activeHandle === 'start' ? ' is-active' : ''}`}
                  type="range"
                  min={yearBounds.min}
                  max={yearBounds.max}
                  value={startYear}
                  onChange={(e) => handleStartYearChange(Number(e.target.value))}
                  onPointerDown={() => setActiveHandle('start')}
                  onPointerUp={() => setActiveHandle(null)}
                  onPointerCancel={() => setActiveHandle(null)}
                  onBlur={() => setActiveHandle(null)}
                  aria-label="Startjahr"
                />
                <input
                  id="year-end"
                  className={`year-slider year-slider--end${activeHandle === 'end' ? ' is-active' : ''}`}
                  type="range"
                  min={yearBounds.min}
                  max={yearBounds.max}
                  value={endYear}
                  onChange={(e) => handleEndYearChange(Number(e.target.value))}
                  onPointerDown={() => setActiveHandle('end')}
                  onPointerUp={() => setActiveHandle(null)}
                  onPointerCancel={() => setActiveHandle(null)}
                  onBlur={() => setActiveHandle(null)}
                  aria-label="Endjahr"
                />
              </div>
            </div>
          )}
          {!showBrowser && (
            <button className="back-btn" onClick={resetSearch}>
              ← Alle Ausgaben
            </button>
          )}
        </div>
      </header>

      {showBrowser ? (
        <IssuesBrowser
          startYear={startYear}
          endYear={endYear}
          onOpen={(filename, title) => openViewer(filename, title)}
        />
      ) : (
        <main className="results">
          {error && <p className="error">{error}</p>}

          {total !== null && !loading && (
            <p className="result-count">
              {total === 0
                ? 'Keine Ergebnisse gefunden.'
                : `${total.toLocaleString()} Treffer`}
            </p>
          )}

          {hits.map((hit) => {
            const src = hit._source
            const snippet = hit.highlight?.text?.[0] ?? hit.highlight?.title?.[0] ?? ''
            const titleHtml = hit.highlight?.title?.[0] ?? src.title
            const clickable = !!(src.issue_filename && src.page_start != null)

            return (
              <article
                key={hit._id}
                className={`result-card${clickable ? ' result-card--clickable' : ''}`}
                onClick={clickable ? () => openArticle(src) : undefined}
                role={clickable ? 'button' : undefined}
                tabIndex={clickable ? 0 : undefined}
                onKeyDown={clickable ? (e) => e.key === 'Enter' && openArticle(src) : undefined}
              >
                <div className="result-meta">
                  <span className={`badge ${src.type}`}>
                    {src.type === 'advertisement' ? 'Anzeige' : 'Artikel'}
                  </span>
                  <span className="issue-info">
                    {formatDate(src.issue_date)}
                    {src.issue_filename && ` · ${src.issue_filename}`}
                    {src.page_start != null && ` · S. ${src.page_start}${src.page_end !== src.page_start ? `–${src.page_end}` : ''}`}
                  </span>
                  {clickable && <span className="open-hint">PDF öffnen →</span>}
                </div>
                <h2
                  className="result-title"
                  dangerouslySetInnerHTML={{ __html: titleHtml }}
                />
                {snippet && (
                  <p
                    className="result-snippet"
                    dangerouslySetInnerHTML={{ __html: `…${snippet}…` }}
                  />
                )}
              </article>
            )
          })}
        </main>
      )}

      {viewer && (
        <PdfViewer
          filename={viewer.filename}
          startPage={viewer.startPage}
          title={viewer.title}
          onClose={() => setViewer(null)}
        />
      )}
    </div>
  )
}
