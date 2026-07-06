// Client-side search over the extracted magazine pages: downloads pages.json
// once and answers all queries in memory — no search backend required.
// PDFs and cover images are downloaded once by extract_pages.py and served
// directly from this server (dev: vite, prod: Nginx) under /pdfs and /covers.

export interface PageRecord {
  page: number
  title: string | null
  text: string
}

export interface IssueRecord {
  title: string
  number: string | null
  date: string // yyyy-MM-dd (real release date)
  url: string
  pdf: string
  pdf_url: string
  cover: string
  cover_url: string
  toc: string[]
  pages: PageRecord[]
}

export interface Issue {
  issue_id: string
  pdf_path: string
  cover_path: string | undefined
  issue_title: string
  issue_date: string
  issue_year: number
  issue_number: string | null
  toc: string[]
}

export interface SearchHit {
  id: string
  score: number
  pdf_path: string
  issue_title: string
  issue_date: string
  issue_number: string | null
  page: number
  displayTitle: string
  titleHtml: string
  snippetHtml: string
}

export const RESULT_LIMIT = 20
const SNIPPET_LENGTH = 260
const TITLE_BOOST = 3

let cached: Promise<IssueRecord[]> | null = null

export function loadIssues(): Promise<IssueRecord[]> {
  cached ??= fetch('/pages.json').then((res) => {
    if (!res.ok) throw new Error(`pages.json: HTTP ${res.status}`)
    return res.json() as Promise<IssueRecord[]>
  })
  return cached
}

// Same-origin path of the locally stored PDF (downloaded once by extract_pages.py).
export function pdfPath(issue: IssueRecord): string {
  return `/pdfs/${issue.pdf}`
}

// Same-origin path of the locally stored cover image — lets thumbnails
// render without opening the PDF.
export function coverPath(issue: IssueRecord): string | undefined {
  return issue.cover ? `/covers/${issue.cover}` : undefined
}

export function findIssueByPdfPath(issues: IssueRecord[], path: string): IssueRecord | undefined {
  return issues.find((issue) => pdfPath(issue) === path)
}

export function listIssues(issues: IssueRecord[]): Issue[] {
  return issues
    .map((issue) => ({
      issue_id: issue.url,
      pdf_path: pdfPath(issue),
      cover_path: coverPath(issue),
      issue_title: issue.title,
      issue_date: issue.date,
      issue_year: parseInt(issue.date, 10),
      issue_number: issue.number,
      toc: issue.toc,
    }))
    .sort((a, b) => b.issue_date.localeCompare(a.issue_date))
}

export function yearBounds(issues: IssueRecord[]): { min: number; max: number } {
  if (!issues.length) throw new Error('pages.json is empty')
  let min = Infinity
  let max = -Infinity
  for (const issue of issues) {
    const year = parseInt(issue.date, 10)
    if (year < min) min = year
    if (year > max) max = year
  }
  return { min, max }
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c])
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function highlight(text: string, terms: string[]): string {
  const re = new RegExp(`(${terms.map(escapeRegex).join('|')})`, 'gi')
  return text
    .split(re)
    .map((part, i) => (i % 2 === 1 ? `<mark>${escapeHtml(part)}</mark>` : escapeHtml(part)))
    .join('')
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    count++
    idx = haystack.indexOf(needle, idx + needle.length)
  }
  return count
}

function makeSnippet(text: string, textLower: string, terms: string[]): string {
  let pos = -1
  for (const term of terms) {
    const i = textLower.indexOf(term)
    if (i !== -1 && (pos === -1 || i < pos)) pos = i
  }
  let start = pos === -1 ? 0 : Math.max(0, pos - Math.floor(SNIPPET_LENGTH / 3))
  if (start > 0) {
    const wordBreak = text.indexOf(' ', start)
    if (wordBreak !== -1 && wordBreak < start + 40) start = wordBreak + 1
  }
  let end = Math.min(text.length, start + SNIPPET_LENGTH)
  if (end < text.length) {
    const wordBreak = text.lastIndexOf(' ', end)
    if (wordBreak > start) end = wordBreak
  }
  const fragment = text.slice(start, end).replace(/\s+/g, ' ')
  return highlight(fragment, terms)
}

export function searchPages(
  issues: IssueRecord[],
  query: string,
  startYear: number,
  endYear: number,
): { hits: SearchHit[]; total: number } {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return { hits: [], total: 0 }

  const scored: SearchHit[] = []
  for (const issue of issues) {
    const year = parseInt(issue.date, 10)
    if (year < startYear || year > endYear) continue
    const path = pdfPath(issue)
    for (const p of issue.pages) {
      const textLower = p.text.toLowerCase()
      const titleLower = (p.title ?? '').toLowerCase()
      let score = 0
      let matchesAll = true
      for (const term of terms) {
        const inTitle = countOccurrences(titleLower, term)
        const inText = countOccurrences(textLower, term)
        if (inTitle + inText === 0) {
          matchesAll = false
          break
        }
        score += TITLE_BOOST * inTitle + inText
      }
      if (!matchesAll) continue

      const displayTitle = p.title ?? `Seite ${p.page}`
      scored.push({
        id: `${issue.url}#${p.page}`,
        score,
        pdf_path: path,
        issue_title: issue.title,
        issue_date: issue.date,
        issue_number: issue.number,
        page: p.page,
        displayTitle,
        titleHtml: p.title ? highlight(p.title, terms) : escapeHtml(displayTitle),
        snippetHtml: makeSnippet(p.text, textLower, terms),
      })
    }
  }
  scored.sort((a, b) => b.score - a.score)
  return { hits: scored.slice(0, RESULT_LIMIT), total: scored.length }
}
