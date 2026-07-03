import { useEffect, useRef, useState } from 'react'
import './App.css'
import IssuesBrowser from './IssuesBrowser'
import PdfViewer from './PdfViewer'
import { loadPages, searchPages, yearBounds, type SearchHit } from './searchIndex'

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
): Promise<{ hits: SearchHit[]; total: number }> {
  const pages = await loadPages()
  return searchPages(pages, query, startYear, endYear)
}

async function fetchYearBounds(): Promise<YearBounds> {
  return yearBounds(await loadPages())
}

function formatDate(iso: string): string {
  if (!iso) return ''
  const [year, month] = iso.split('-')
  return month && month !== '01' ? `${month}/${year}` : year
}

export default function App() {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
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

  function openArticle(hit: SearchHit) {
    openViewer(hit.issue_filename, hit.displayTitle, hit.page)
  }

  function handleStartYearChange(value: number) {
    const clamped = Math.max(yearBounds.min, Math.min(value, endYear))
    setStartYear(clamped)
  }

  function handleEndYearChange(value: number) {
    const clamped = Math.min(yearBounds.max, Math.max(value, startYear))
    setEndYear(clamped)
  }

  function resetYearFilter() {
    setStartYear(yearBounds.min)
    setEndYear(yearBounds.max)
  }

  return (
    <div className="app">
      <header className="header">
        <div className="header-inner">
          <h1>WAZ Archiv</h1>
          <p className="subtitle">Durchsuche {yearBounds.max - yearBounds.min} Jahre Walder Zeitschrift!</p>
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
                <div className="filters-actions">
                  <span className="filters-value">
                    {startYear}–{endYear}
                  </span>
                  <button
                    type="button"
                    className="filters-reset-btn"
                    onClick={resetYearFilter}
                    disabled={startYear === yearBounds.min && endYear === yearBounds.max}
                  >
                    Zurücksetzen
                  </button>
                </div>
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

          {hits.map((hit) => (
            <article
              key={hit.id}
              className="result-card result-card--clickable"
              onClick={() => openArticle(hit)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && openArticle(hit)}
            >
              <div className="result-meta">
                <span className="badge article">Artikel</span>
                <span className="issue-info">
                  {formatDate(hit.issue_date)}
                  {` · ${hit.issue_filename}`}
                  {` · S. ${hit.page}`}
                </span>
                <span className="open-hint">PDF öffnen →</span>
              </div>
              <h2
                className="result-title"
                dangerouslySetInnerHTML={{ __html: hit.titleHtml }}
              />
              {hit.snippetHtml && (
                <p
                  className="result-snippet"
                  dangerouslySetInnerHTML={{ __html: `…${hit.snippetHtml}…` }}
                />
              )}
            </article>
          ))}
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
