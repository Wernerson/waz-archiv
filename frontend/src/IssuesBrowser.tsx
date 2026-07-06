import { useEffect, useRef, useState } from 'react'
import './IssuesBrowser.css'
import { listIssues, loadIssues, type Issue } from './searchIndex'

const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun',
                'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez']

const FULL_MONTHS = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
]

function formatReleaseDate(iso: string): string {
  const [year, month, day] = iso.split('-').map((n) => parseInt(n, 10))
  return `${day}. ${FULL_MONTHS[month - 1] ?? ''} ${year}`
}

async function fetchIssues(startYear: number, endYear: number): Promise<Issue[]> {
  const issues = await loadIssues()
  return listIssues(issues).filter(
    (issue) => issue.issue_year >= startYear && issue.issue_year <= endYear,
  )
}

function Thumbnail({ src, alt, onClick }: { src: string | undefined; alt: string; onClick: () => void }) {
  const [failed, setFailed] = useState(false)

  return (
    <div
      className="issue-thumb"
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => e.key === 'Enter' && onClick()}
    >
      {!failed && src
        ? <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} />
        : <span className="thumb-error">–</span>}
    </div>
  )
}

function IssuePreview({ issue, onClose, onRead }: {
  issue: Issue
  onClose: () => void
  onRead: (title: string) => void
}) {
  const month = parseInt(issue.issue_date.split('-')[1], 10)
  const heading = `WAZ ${issue.issue_number ?? ''} ${FULL_MONTHS[month - 1] ?? ''} ${issue.issue_year}`
    .replace(/\s+/g, ' ').trim()

  return (
    <div className="preview-overlay" onClick={onClose}>
      <div className="preview-modal" onClick={(e) => e.stopPropagation()}>
        <button className="preview-close" onClick={onClose} aria-label="Schließen">✕</button>
        <div className="preview-thumb">
          <Thumbnail src={issue.cover_path} alt={heading} onClick={() => onRead(heading)} />
        </div>
        <div className="preview-info">
          <h2 className="preview-heading">{heading}</h2>
          <p className="preview-date">Erscheinungsdatum: {formatReleaseDate(issue.issue_date)}</p>
          {issue.toc.length > 0 && (
            <>
              <h3 className="preview-toc-heading">Inhalt</h3>
              <ul className="preview-toc">
                {issue.toc.map((entry, i) => <li key={i}>{entry}</li>)}
              </ul>
            </>
          )}
          <button className="preview-read-btn" onClick={() => onRead(heading)}>Jetzt lesen</button>
        </div>
      </div>
    </div>
  )
}

interface Props {
  startYear: number
  endYear: number
  onOpen: (pdfPath: string, title: string) => void
}

export default function IssuesBrowser({ startYear, endYear, onOpen }: Props) {
  const [issues, setIssues] = useState<Issue[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<Issue | null>(null)
  const sectionRefs = useRef(new Map<number, HTMLElement>())

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetchIssues(startYear, endYear)
      .then(setIssues)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [startYear, endYear])

  if (loading) return <p className="browser-status">Lade Ausgaben…</p>
  if (error)   return <p className="browser-status browser-status--error">{error}</p>

  // Group by year, Map preserves insertion order (newest first from the sort)
  const byYear = new Map<number, Issue[]>()
  for (const issue of issues) {
    if (issue.issue_year < startYear || issue.issue_year > endYear) continue
    const group = byYear.get(issue.issue_year) ?? []
    group.push(issue)
    byYear.set(issue.issue_year, group)
  }
  const years = [...byYear.keys()]

  function scrollToYear(year: number) {
    sectionRefs.current.get(year)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="browser">
      <div className="browser-main">
        {[...byYear.entries()].map(([year, yearIssues]) => (
          <section
            key={year}
            className="year-section"
            ref={(el) => {
              if (el) sectionRefs.current.set(year, el)
              else sectionRefs.current.delete(year)
            }}
          >
            <div className="year-divider">
              <span className="year-heading">{year}</span>
              <div className="year-rule" />
            </div>
            <div className="issue-grid">
              {yearIssues.map((issue) => {
                const month = parseInt(issue.issue_date.split('-')[1], 10)
                const label = `${MONTHS[month - 1] ?? ''} ${year}`
                return (
                  <div key={issue.issue_id} className="issue-card">
                    <Thumbnail
                      src={issue.cover_path}
                      alt={label}
                      onClick={() => setPreview(issue)}
                    />
                    <div className="issue-label">{label}</div>
                  </div>
                )
              })}
            </div>
          </section>
        ))}
      </div>

      <aside className="year-nav">
        {years.map((year) => (
          <button key={year} className="year-nav-btn" onClick={() => scrollToYear(year)}>
            {year}
          </button>
        ))}
      </aside>

      {preview && (
        <IssuePreview
          issue={preview}
          onClose={() => setPreview(null)}
          onRead={(title) => onOpen(preview.pdf_path, title)}
        />
      )}
    </div>
  )
}
