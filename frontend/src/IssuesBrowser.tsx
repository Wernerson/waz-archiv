import { useEffect, useRef, useState } from 'react'
import { Document, Page } from 'react-pdf'
import './IssuesBrowser.css'
import { listIssues, loadPages, type Issue } from './searchIndex'

const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun',
                'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez']

async function fetchIssues(startYear: number, endYear: number): Promise<Issue[]> {
  const pages = await loadPages()
  return listIssues(pages).filter(
    (issue) => issue.issue_year >= startYear && issue.issue_year <= endYear,
  )
}

function Thumbnail({ filename, onClick }: { filename: string; onClick: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) setVisible(true) },
      { rootMargin: '400px' },
    )
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)))
    io.observe(el)
    ro.observe(el)
    return () => { io.disconnect(); ro.disconnect() }
  }, [])

  return (
    <div
      ref={ref}
      className="issue-thumb"
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => e.key === 'Enter' && onClick()}
    >
      {visible && width > 0 && (
        <Document
          file={`/pdfs/${filename}`}
          loading={null}
          error={<span className="thumb-error">–</span>}
        >
          <Page
            pageNumber={1}
            width={width}
            renderTextLayer={false}
            renderAnnotationLayer={false}
          />
        </Document>
      )}
    </div>
  )
}

interface Props {
  startYear: number
  endYear: number
  onOpen: (filename: string, title: string) => void
}

export default function IssuesBrowser({ startYear, endYear, onOpen }: Props) {
  const [issues, setIssues] = useState<Issue[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
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
                      filename={issue.issue_filename}
                      onClick={() => onOpen(issue.issue_filename, label)}
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
    </div>
  )
}
