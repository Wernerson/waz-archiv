// Client-side search over the extracted magazine pages: downloads pages.json
// once and answers all queries in memory — no search backend required.
// PDFs and cover images are downloaded once by extract_pages.py and served
// directly from this server (dev: vite, prod: Nginx) under /pdfs and /covers.
// Ranking is BM25F (see ./bm25Index.ts) built once per pages.json payload.
import { buildIndex, queryIndex, type SearchIndex } from './bm25Index'
import { tokenizeWithOffsets } from './textTokenize'
import { stem } from './germanStemmer'

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

export const RESULT_LIMIT = 20
const SNIPPET_LENGTH = 260

let cached: Promise<IssueRecord[]> | null = null
const indexCache = new WeakMap<IssueRecord[], SearchIndex>()

function getIndex(issues: IssueRecord[]): SearchIndex {
  let index = indexCache.get(issues)
  if (!index) {
    index = buildIndex(issues)
    indexCache.set(issues, index)
  }
  return index
}

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

// Wraps every token whose stem is in `acceptedStems` in <mark>, using the
// original surface substring (never the stem) so display text is untouched.
function highlight(text: string, acceptedStems: Set<string>): string {
  const tokens = tokenizeWithOffsets(text)
  let result = ''
  let last = 0
  for (const t of tokens) {
    if (!acceptedStems.has(stem(t.token))) continue
    result += escapeHtml(text.slice(last, t.start))
    result += `<mark>${escapeHtml(text.slice(t.start, t.end))}</mark>`
    last = t.end
  }
  result += escapeHtml(text.slice(last))
  return result
}

function makeSnippet(text: string, acceptedStems: Set<string>): string {
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
): { hits: SearchHit[]; total: number } {
  const index = getIndex(issues)
  const { rankedDocIds, total, acceptedStems } = queryIndex(index, query, startYear, endYear)

  const hits: SearchHit[] = rankedDocIds.slice(0, RESULT_LIMIT).map((docId) => {
    const { issue, page } = index.docMeta[docId]
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

  return { hits, total }
}
