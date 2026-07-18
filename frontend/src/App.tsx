import { useEffect, useRef, useState } from 'react'
import './App.css'
import IssuesBrowser from './IssuesBrowser'
import PdfViewer from './PdfViewer'
import {
  findIssueByPdfPath,
  loadIssues,
  RESULT_LIMIT,
  searchPages,
  yearBounds as fetchYearBounds,
  type SearchHit,
} from './searchIndex'

const PDF_PARAM = 'pdf'
const PAGE_PARAM = 'page'
const QUERY_PARAM = 'q'
const YEAR_PARAM = 'years'
const DEBOUNCE_MS = 300
// Highlighting matched search terms inside the opened PDF — disabled for now.
const ENABLE_PDF_HIGHLIGHTING = false

type UrlWriteMode = 'push' | 'replace'

// Discrete navigations (submitting a search, resetting to browse, opening/
// closing the viewer) push a new history entry so Back/Forward can step
// through them; in-place refinements of the current view (live-search sync,
// slider drags, per-page-turn updates) keep the default 'replace'.
function writeUrl(params: URLSearchParams, mode: UrlWriteMode) {
  const search = params.toString()
  const url = search ? `?${search}` : window.location.pathname
  if (mode === 'push') window.history.pushState(null, '', url)
  else window.history.replaceState(null, '', url)
}

function setViewerUrl(pdfPath: string, page: number, mode: UrlWriteMode = 'replace') {
  const params = new URLSearchParams(window.location.search)
  params.set(PDF_PARAM, pdfPath)
  params.set(PAGE_PARAM, String(page))
  writeUrl(params, mode)
}

function clearViewerUrl(mode: UrlWriteMode = 'replace') {
  const params = new URLSearchParams(window.location.search)
  params.delete(PDF_PARAM)
  params.delete(PAGE_PARAM)
  writeUrl(params, mode)
}

function setSearchUrl(query: string, mode: UrlWriteMode = 'replace') {
  const params = new URLSearchParams(window.location.search)
  if (query) {
    params.set(QUERY_PARAM, query)
  } else {
    params.delete(QUERY_PARAM)
  }
  writeUrl(params, mode)
}

interface ViewerState {
  pdfPath: string
  startPage: number
  title: string
  highlightStems: Set<string>
}

interface YearBounds {
  min: number
  max: number
}

const CURRENT_YEAR = new Date().getFullYear()
const FALLBACK_YEAR_BOUNDS: YearBounds = { min: CURRENT_YEAR - 30, max: CURRENT_YEAR }
const EMPTY_STEMS: Set<string> = new Set()

function setYearUrl(startYear: number, endYear: number, bounds: YearBounds, mode: UrlWriteMode = 'replace') {
  const params = new URLSearchParams(window.location.search)
  if (startYear === bounds.min && endYear === bounds.max) {
    params.delete(YEAR_PARAM)
  } else {
    params.set(YEAR_PARAM, `${startYear}-${endYear}`)
  }
  writeUrl(params, mode)
}

function parseYearParam(raw: string | null, bounds: YearBounds): { start: number; end: number } | null {
  const m = raw ? /^(\d{4})-(\d{4})$/.exec(raw) : null
  if (!m) return null
  const start = Math.max(bounds.min, Math.min(Number(m[1]), bounds.max))
  const end = Math.max(bounds.min, Math.min(Number(m[2]), bounds.max))
  return start <= end ? { start, end } : null
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
  const [visibleCount, setVisibleCount] = useState(RESULT_LIMIT)
  const [highlightStems, setHighlightStems] = useState<Set<string>>(EMPTY_STEMS)
  const inputRef = useRef<HTMLInputElement>(null)
  const requestIdRef = useRef(0)
  const lastRunKeyRef = useRef<string | null>(null)

  const showBrowser = total === null && !loading
  const yearSpan = Math.max(1, yearBounds.max - yearBounds.min)
  const startPercent = ((startYear - yearBounds.min) / yearSpan) * 100
  const endPercent = ((endYear - yearBounds.min) / yearSpan) * 100

  // Re-derives all app state (query/results, year filter, open viewer) from
  // the current URL. All app state is URL-driven, so this one function
  // covers both the initial mount restore and every popstate (Back/Forward).
  async function restoreFromUrl(bounds: YearBounds) {
    const params = new URLSearchParams(window.location.search)
    const q = params.get(QUERY_PARAM) ?? ''
    const years = parseYearParam(params.get(YEAR_PARAM), bounds) ?? { start: bounds.min, end: bounds.max }
    setStartYear(years.start)
    setEndYear(years.end)

    let stemsForViewer = EMPTY_STEMS
    if (q) {
      setQuery(q)
      stemsForViewer = await runSearch(q, years.start, years.end)
    } else {
      setQuery('')
      setHits([])
      setTotal(null)
      setHighlightStems(EMPTY_STEMS)
    }

    const pdf = params.get(PDF_PARAM)
    if (!pdf) {
      setViewer(null)
      return
    }
    const page = parseInt(params.get(PAGE_PARAM) ?? '1', 10) || 1
    try {
      const issue = await findIssueByPdfPath(pdf)
      const highlightStemsForViewer = ENABLE_PDF_HIGHLIGHTING ? stemsForViewer : EMPTY_STEMS
      setViewer(issue ? { pdfPath: pdf, startPage: page, title: issue.issue_title, highlightStems: highlightStemsForViewer } : null)
    } catch (err) {
      console.error('Failed to restore viewer from URL', err)
    }
  }

  // Initial load: warm the worker, fetch real year bounds (the year-range
  // filter used for the very first search needs these, not the fallback
  // bounds, or the archive's early years would be wrongly excluded), then
  // restore whatever the URL describes.
  useEffect(() => {
    void loadIssues() // fire-and-forget: warms the worker's fetch+index build before the user finishes typing
    fetchYearBounds()
      .then((bounds) => {
        setYearBounds(bounds)
        void restoreFromUrl(bounds)
      })
      .catch((err) => {
        console.error('Failed to load year bounds', err)
      })
  }, [])

  // Back/Forward: re-derive state from the URL the browser just navigated to.
  useEffect(() => {
    function onPopState() {
      void restoreFromUrl(yearBounds)
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [yearBounds])

  // Debounced search-as-you-type, alongside the explicit "Suchen" submit.
  // Skips re-running if handleSearch already just ran this exact query/year
  // combination, so pressing "Suchen" right before the debounce fires
  // doesn't cause a redundant refetch/loading-spinner flicker.
  useEffect(() => {
    const q = query.trim()
    if (!q) return
    const timer = setTimeout(() => {
      const key = `${q}|${startYear}|${endYear}`
      if (key === lastRunKeyRef.current) return
      setSearchUrl(q)
      setYearUrl(startYear, endYear, yearBounds)
      void runSearch(q, startYear, endYear)
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query, startYear, endYear, yearBounds])

  async function runSearch(q: string, searchStartYear: number, searchEndYear: number): Promise<Set<string>> {
    lastRunKeyRef.current = `${q}|${searchStartYear}|${searchEndYear}`
    const myId = ++requestIdRef.current
    setLoading(true)
    setError(null)
    try {
      const result = await searchPages(q, searchStartYear, searchEndYear)
      if (myId !== requestIdRef.current) return result.highlightStems // superseded by a newer search
      setHits(result.hits)
      setTotal(result.total)
      setVisibleCount(RESULT_LIMIT)
      setHighlightStems(result.highlightStems)
      return result.highlightStems
    } catch (err) {
      if (myId !== requestIdRef.current) return EMPTY_STEMS
      setError(err instanceof Error ? err.message : 'Search failed')
      setHits([])
      setTotal(null)
      setHighlightStems(EMPTY_STEMS)
      return EMPTY_STEMS
    } finally {
      if (myId === requestIdRef.current) setLoading(false)
    }
  }

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    const q = query.trim()
    if (!q) {
      resetSearch()
      return
    }
    setSearchUrl(q, 'push')
    await runSearch(q, startYear, endYear)
  }

  function resetSearch() {
    setQuery('')
    setHits([])
    setTotal(null)
    setError(null)
    setVisibleCount(RESULT_LIMIT)
    setHighlightStems(EMPTY_STEMS)
    setSearchUrl('', 'push')
    inputRef.current?.focus()
  }

  function openViewer(pdfPath: string, title: string, startPage = 1, stems: Set<string> = EMPTY_STEMS) {
    if (!pdfPath) return
    setViewer({ pdfPath, startPage, title, highlightStems: ENABLE_PDF_HIGHLIGHTING ? stems : EMPTY_STEMS })
    setViewerUrl(pdfPath, startPage, 'push')
  }

  function closeViewer() {
    setViewer(null)
    clearViewerUrl('push')
  }

  function openArticle(hit: SearchHit) {
    openViewer(hit.pdf_path, hit.displayTitle, hit.page, highlightStems)
  }

  function handleStartYearChange(value: number) {
    const clamped = Math.max(yearBounds.min, Math.min(value, endYear))
    setStartYear(clamped)
    setYearUrl(clamped, endYear, yearBounds)
  }

  function handleEndYearChange(value: number) {
    const clamped = Math.min(yearBounds.max, Math.max(value, startYear))
    setEndYear(clamped)
    setYearUrl(startYear, clamped, yearBounds)
  }

  function resetYearFilter() {
    setStartYear(yearBounds.min)
    setEndYear(yearBounds.max)
    setYearUrl(yearBounds.min, yearBounds.max, yearBounds)
  }

  return (
    <div className="app">
      <header className="header">
        <div className="header-inner">
          <a href="/"><h1><img src="/logo.svg"  alt="Logo"/> Archiv</h1></a>
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
                        left: `calc(${startPercent}%`,
                        width: `calc(${Math.max(0, endPercent - startPercent)}%)`,
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

          {hits.slice(0, visibleCount).map((hit) => (
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

          {visibleCount < hits.length && (
            <button
              type="button"
              className="load-more-btn"
              onClick={() => setVisibleCount((v) => v + RESULT_LIMIT)}
            >
              Weitere Treffer laden
            </button>
          )}
        </main>
      )}

      {viewer && (
        <PdfViewer
          file={viewer.pdfPath}
          startPage={viewer.startPage}
          title={viewer.title}
          highlightStems={viewer.highlightStems}
          onClose={closeViewer}
          onPageChange={(page) => setViewerUrl(viewer.pdfPath, page)}
        />
      )}
    </div>
  )
}
