import { useState, useRef } from 'react'
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

async function searchArticles(query: string): Promise<{ hits: Hit[]; total: number }> {
  const res = await fetch('/opensearch/articles/_search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: {
        multi_match: {
          query,
          fields: ['title^3', 'text'],
          type: 'best_fields',
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
  const inputRef = useRef<HTMLInputElement>(null)

  const showBrowser = total === null && !loading

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
      const result = await searchArticles(q)
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

  return (
    <div className="app">
      <header className="header">
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
        {!showBrowser && (
          <button className="back-btn" onClick={resetSearch}>
            ← Alle Ausgaben
          </button>
        )}
      </header>

      {showBrowser ? (
        <IssuesBrowser onOpen={(filename, title) => openViewer(filename, title)} />
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
