// Search index core: fetches pages.json, builds the BM25F index, and answers
// queries. Runs only inside searchWorker.ts, never on the main thread, so the
// 18MB dataset and the (potentially expensive) index build never block the
// UI. See ./searchIndex.ts for the main-thread client that talks to it.
import { buildIndex, queryIndex, type SearchIndex } from './bm25Index'
import { tokenizeWithOffsets } from './textTokenize'
import { stem } from './germanStemmer'
import { forEachStemMatch, escapeHtml } from './highlightStems'

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
  pdf_path: string
  issue_title: string
  issue_date: string
  issue_number: string | null
  page: number
  displayTitle: string
  titleHtml: string
  snippetHtml: string
}

// Worker request/response protocol, shared by searchWorker.ts (worker side)
// and searchIndex.ts (main-thread client). Requests/responses are correlated
// by `id`, an incrementing counter owned by the client.
export type WorkerRequest =
  | { id: number; type: 'loadIssues' }
  | { id: number; type: 'search'; query: string; startYear: number; endYear: number }
  | { id: number; type: 'listIssues' }
  | { id: number; type: 'yearBounds' }
  | { id: number; type: 'findIssueByPdfPath'; path: string }

export type WorkerResponse =
  | { id: number; type: 'loadIssues' }
  | { id: number; type: 'search'; hits: SearchHit[]; total: number; highlightStems: string[] }
  | { id: number; type: 'listIssues'; issues: Issue[] }
  | { id: number; type: 'yearBounds'; bounds: { min: number; max: number } }
  | { id: number; type: 'findIssueByPdfPath'; issue: Issue | undefined }
  | { id: number; type: 'error'; error: string }

// Formatted-hit cap: generous enough that "load more" (see searchIndex.ts's
// client-side RESULT_LIMIT paging) never needs a second worker round-trip,
// while still bounding how much snippet/highlight formatting work is done
// for very common queries. `total` (the true match count) is unaffected.
const MAX_FORMATTED_HITS = 200
const SNIPPET_LENGTH = 260

let issuesPromise: Promise<IssueRecord[]> | null = null
// A worker only ever holds one issues array for its whole lifetime, so a
// plain singleton replaces the old WeakMap-keyed index cache.
let index: SearchIndex | null = null

export function ensureIssues(): Promise<IssueRecord[]> {
  issuesPromise ??= fetch('/pages.json').then((res) => {
    if (!res.ok) throw new Error(`pages.json: HTTP ${res.status}`)
    return res.json() as Promise<IssueRecord[]>
  })
  return issuesPromise
}

function ensureIndex(issues: IssueRecord[]): SearchIndex {
  index ??= buildIndex(issues)
  return index
}

// Same-origin path of the locally stored PDF (downloaded once by extract_pages.py).
function pdfPath(issue: IssueRecord): string {
  return `/pdfs/${issue.pdf}`
}

// Same-origin path of the locally stored cover image — lets thumbnails
// render without opening the PDF.
function coverPath(issue: IssueRecord): string | undefined {
  return issue.cover ? `/covers/${issue.cover}` : undefined
}

function toIssue(issue: IssueRecord): Issue {
  return {
    issue_id: issue.url,
    pdf_path: pdfPath(issue),
    cover_path: coverPath(issue),
    issue_title: issue.title,
    issue_date: issue.date,
    issue_year: parseInt(issue.date, 10),
    issue_number: issue.number,
    toc: issue.toc,
  }
}

export function findIssueByPdfPath(issues: IssueRecord[], path: string): Issue | undefined {
  const issue = issues.find((issue) => pdfPath(issue) === path)
  return issue ? toIssue(issue) : undefined
}

export function listIssues(issues: IssueRecord[]): Issue[] {
  return issues.map(toIssue).sort((a, b) => b.issue_date.localeCompare(a.issue_date))
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

function highlight(text: string, acceptedStems: ReadonlySet<string>): string {
  return forEachStemMatch(text, acceptedStems, (m) => `<mark>${m}</mark>`)
}

function makeSnippet(text: string, acceptedStems: ReadonlySet<string>): string {
  const tokens = tokenizeWithOffsets(text)
  let pos = -1
  for (const t of tokens) {
    if (acceptedStems.has(stem(t.token))) {
      pos = t.start
      break
    }
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
  return highlight(fragment, acceptedStems)
}

export function searchPages(
  issues: IssueRecord[],
  query: string,
  startYear: number,
  endYear: number,
): { hits: SearchHit[]; total: number; highlightStems: string[] } {
  const idx = ensureIndex(issues)
  const { rankedDocIds, total, acceptedStems } = queryIndex(idx, query, startYear, endYear)

  const hits: SearchHit[] = rankedDocIds.slice(0, MAX_FORMATTED_HITS).map((docId) => {
    const { issue, page } = idx.docMeta[docId]
    const displayTitle = page.title ?? `Seite ${page.page}`
    return {
      id: `${issue.url}#${page.page}`,
      pdf_path: pdfPath(issue),
      issue_title: issue.title,
      issue_date: issue.date,
      issue_number: issue.number,
      page: page.page,
      displayTitle,
      titleHtml: page.title ? highlight(page.title, acceptedStems) : escapeHtml(displayTitle),
      snippetHtml: makeSnippet(page.text, acceptedStems),
    }
  })

  return { hits, total, highlightStems: Array.from(acceptedStems) }
}
