import { useEffect, useRef, useState } from 'react'
import './App.css'
import IssuesBrowser from './IssuesBrowser'
import PdfViewer from './PdfViewer'
import { findIssueByPdfPath, loadIssues, searchPages, yearBounds, type SearchHit } from './searchIndex'

const PDF_PARAM = 'pdf'
const PAGE_PARAM = 'page'
const QUERY_PARAM = 'q'

function setViewerUrl(pdfPath: string, page: number) {
  const params = new URLSearchParams(window.location.search)
  params.set(PDF_PARAM, pdfPath)
  params.set(PAGE_PARAM, String(page))
  const query = params.toString()
  window.history.replaceState(null, '', query ? `?${query}` : window.location.pathname)
}

function clearViewerUrl() {
  const params = new URLSearchParams(window.location.search)
  params.delete(PDF_PARAM)
  params.delete(PAGE_PARAM)
  const query = params.toString()
  window.history.replaceState(null, '', query ? `?${query}` : window.location.pathname)
}

function setSearchUrl(query: string) {
  const params = new URLSearchParams(window.location.search)
  if (query) {
    params.set(QUERY_PARAM, query)
  } else {
    params.delete(QUERY_PARAM)
  }
  const search = params.toString()
  window.history.replaceState(null, '', search ? `?${search}` : window.location.pathname)
}

interface ViewerState {
  pdfPath: string
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
  const issues = await loadIssues()
  return searchPages(issues, query, startYear, endYear)
}

async function fetchYearBounds(): Promise<YearBounds> {
  return yearBounds(await loadIssues())
}

// A single requestAnimationFrame fires *before* the browser paints, so it
// doesn't actually guarantee the loading spinner became visible yet — only
// waiting for a second one does (the first frame's paint has then happened).
function waitForPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

function formatDate(iso: string): string {
  if (!iso) return ''
  const [year, month] = iso.split('-')
  return month ? `${month}/${year}` : year
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

  // Deep link support: restore ?q=… once the real year bounds are known, so
  // the year-range filter used for the very first search is correct (the
  // fallback bounds would otherwise wrongly exclude the archive's early years).
  useEffect(() => {
    const initialQuery = new URLSearchParams(window.location.search).get(QUERY_PARAM)
    fetchYearBounds()
      .then((bounds) => {
        setYearBounds(bounds)
        setStartYear(bounds.min)
        setEndYear(bounds.max)
        if (initialQuery) {
          setQuery(initialQuery)
          void runSearch(initialQuery, bounds.min, bounds.max)
        }
      })
      .catch((err) => {
        console.error('Failed to load year bounds', err)
      })
  }, [])

  // Deep link support: restore the viewer from ?pdf=…&page=… on first load.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const pdf = params.get(PDF_PARAM)
    if (!pdf) return
    const page = parseInt(params.get(PAGE_PARAM) ?? '1', 10) || 1
    loadIssues()
      .then((issues) => {
        const issue = findIssueByPdfPath(issues, pdf)
        if (issue) openViewer(pdf, issue.title, page)
      })
      .catch((err) => {
        console.error('Failed to restore viewer from URL', err)
      })
  }, [])

  async function runSearch(q: string, searchStartYear: number, searchEndYear: number) {
    setLoading(true)
    setError(null)
    try {
      // Let the loading spinner actually paint before the (possibly slow,
      // first-time-only) synchronous index build blocks the main thread.
      await waitForPaint()
      const result = await searchArticles(q, searchStartYear, searchEndYear)
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

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    const q = query.trim()
    if (!q) {
      resetSearch()
      return
    }
    setSearchUrl(q)
    await runSearch(q, startYear, endYear)
  }

  function resetSearch() {
    setQuery('')
    setHits([])
    setTotal(null)
    setError(null)
    setSearchUrl('')
    inputRef.current?.focus()
  }

  function openViewer(pdfPath: string, title: string, startPage = 1) {
    if (!pdfPath) return
    setViewer({ pdfPath, startPage, title })
    setViewerUrl(pdfPath, startPage)
  }

  function closeViewer() {
    setViewer(null)
    clearViewerUrl()
  }

  function openArticle(hit: SearchHit) {
    openViewer(hit.pdf_path, hit.displayTitle, hit.page)
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
              {loading ? <span className="spinner" aria-hidden="true" /> : 'Suchen'}
            </button>
          </form>
          {loading && (
            <p className="search-status">
              <span className="spinner" aria-hidden="true" />
              Durchsuche Archiv…
            </p>
          )}
          {!showBrowser && (
            <>
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
              <button className="back-btn" onClick={resetSearch}>
                ← Alle Ausgaben
              </button>
            </>
          )}
        </div>
      </header>

      {showBrowser ? (
        <IssuesBrowser
          startYear={yearBounds.min}
          endYear={yearBounds.max}
          onOpen={(pdfPath, title) => openViewer(pdfPath, title)}
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
                <span className="badge article">
                  {hit.issue_title}
                </span>
                <span className="issue-info">
                  {formatDate(hit.issue_date)}
                  {` · S. ${hit.page}`}
                  {` · ${hit.displayTitle}`}
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
          file={viewer.pdfPath}
          startPage={viewer.startPage}
          title={viewer.title}
          onClose={closeViewer}
          onPageChange={(page) => setViewerUrl(viewer.pdfPath, page)}
        />
      )}
    </div>
  )
}
