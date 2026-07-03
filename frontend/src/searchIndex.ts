// Client-side search over the extracted magazine pages: downloads pages.json
// once and answers all queries in memory — no search backend required.

export interface PageRecord {
  issue_date: string // yyyy-MM-dd, day is always 01
  page: number
  title: string | null
  text: string
}

export interface Issue {
  issue_id: string
  issue_filename: string
  issue_date: string
  issue_year: number
  issue_number: number | null
}

export interface SearchHit {
  id: string
  score: number
  issue_filename: string
  issue_date: string
  page: number
  displayTitle: string
  titleHtml: string
  snippetHtml: string
}

export const RESULT_LIMIT = 20
const SNIPPET_LENGTH = 260
const TITLE_BOOST = 3

let cached: Promise<PageRecord[]> | null = null

export function loadPages(): Promise<PageRecord[]> {
  cached ??= fetch('/pages.json').then((res) => {
    if (!res.ok) throw new Error(`pages.json: HTTP ${res.status}`)
    return res.json() as Promise<PageRecord[]>
  })
  return cached
}

export function issueFilename(issueDate: string): string {
  const [year, month] = issueDate.split('-')
  return `${year}_${month}.pdf`
}

export function listIssues(pages: PageRecord[]): Issue[] {
  const byDate = new Map<string, Issue>()
  for (const p of pages) {
    if (!byDate.has(p.issue_date)) {
      const [year, month] = p.issue_date.split('-')
      byDate.set(p.issue_date, {
        issue_id: p.issue_date,
        issue_filename: issueFilename(p.issue_date),
        issue_date: p.issue_date,
        issue_year: parseInt(year, 10),
        issue_number: parseInt(month, 10) || null,
      })
    }
  }
  return [...byDate.values()].sort((a, b) => b.issue_date.localeCompare(a.issue_date))
}

export function yearBounds(pages: PageRecord[]): { min: number; max: number } {
  if (!pages.length) throw new Error('pages.json is empty')
  let min = Infinity
  let max = -Infinity
  for (const p of pages) {
    const year = parseInt(p.issue_date, 10)
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
  pages: PageRecord[],
  query: string,
  startYear: number,
  endYear: number,
): { hits: SearchHit[]; total: number } {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return { hits: [], total: 0 }

  const scored: SearchHit[] = []
  for (const p of pages) {
    const year = parseInt(p.issue_date, 10)
    if (year < startYear || year > endYear) continue
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
      id: `${p.issue_date}#${p.page}`,
      score,
      issue_filename: issueFilename(p.issue_date),
      issue_date: p.issue_date,
      page: p.page,
      displayTitle,
      titleHtml: p.title ? highlight(p.title, terms) : escapeHtml(displayTitle),
      snippetHtml: makeSnippet(p.text, textLower, terms),
    })
  }
  scored.sort((a, b) => b.score - a.score)
  return { hits: scored.slice(0, RESULT_LIMIT), total: scored.length }
}
