// In-browser BM25F search index over extracted magazine pages.
// Built once per `issues` array (see `getIndex`) and queried per keystroke.
import type { IssueRecord, PageRecord } from './searchCore'
import { tokenize, tokenizeWithOffsets, type TokenOffset } from './textTokenize'
import { stem } from './germanStemmer'
import { STOPWORDS } from './germanStopwords'

const K1 = 1.2
const B_BODY = 0.75
const B_TITLE = 0 // titles are short/uniform-length; length-normalizing them adds noise
const W_TITLE = 3.0
const W_BODY = 1.0
const PHRASE_BOOST = 2.0
const RECENCY_WEIGHT = 0.15 // newest issue gets at most this much of a relative score bump
const HALFLIFE_YEARS = 15
const FUZZY_PENALTY = 0.6
const OCR_YEARS = new Set([1992, 1993])

interface Posting {
  tf: number
  positions: number[]
}

interface FieldIndex {
  postings: Map<string, Map<number, Posting>>
  docLen: number[]
  avgLen: number
}

interface DocMeta {
  issue: IssueRecord
  page: PageRecord
  year: number
}

export interface SearchIndex {
  N: number
  title: FieldIndex
  body: FieldIndex
  docMeta: DocMeta[]
  ocrVocab: Map<string, Set<number>>
  maxDate: string
}

export interface ParsedQuery {
  freeTerms: string[]
  phrases: string[][]
}

export interface QueryResult {
  rankedDocIds: number[]
  total: number
  acceptedStems: Set<string>
}

function addTokens(postings: Map<string, Map<number, Posting>>, tokens: TokenOffset[], docId: number): void {
  tokens.forEach((t, pos) => {
    const s = stem(t.token)
    let byDoc = postings.get(s)
    if (!byDoc) {
      byDoc = new Map()
      postings.set(s, byDoc)
    }
    let posting = byDoc.get(docId)
    if (!posting) {
      posting = { tf: 0, positions: [] }
      byDoc.set(docId, posting)
    }
    posting.tf++
    posting.positions.push(pos)
  })
}

function addToOcrVocab(ocrVocab: Map<string, Set<number>>, s: string, docId: number): void {
  let ids = ocrVocab.get(s)
  if (!ids) {
    ids = new Set()
    ocrVocab.set(s, ids)
  }
  ids.add(docId)
}

function average(arr: number[]): number {
  if (!arr.length) return 0
  return arr.reduce((a, b) => a + b, 0) / arr.length
}

export function buildIndex(issues: IssueRecord[]): SearchIndex {
  const titlePostings: Map<string, Map<number, Posting>> = new Map()
  const bodyPostings: Map<string, Map<number, Posting>> = new Map()
  const titleDocLen: number[] = []
  const bodyDocLen: number[] = []
  const docMeta: DocMeta[] = []
  const ocrVocab: Map<string, Set<number>> = new Map()
  let maxDate = ''

  let docId = 0
  for (const issue of issues) {
    if (issue.date > maxDate) maxDate = issue.date
    const year = parseInt(issue.date, 10)
    const isOcrYear = OCR_YEARS.has(year)
    for (const page of issue.pages) {
      const titleTokens = tokenizeWithOffsets(page.title ?? '')
      const bodyTokens = tokenizeWithOffsets(page.text)
      addTokens(titlePostings, titleTokens, docId)
      addTokens(bodyPostings, bodyTokens, docId)
      titleDocLen[docId] = titleTokens.length
      bodyDocLen[docId] = bodyTokens.length
      docMeta[docId] = { issue, page, year }
      if (isOcrYear) {
        for (const t of titleTokens) addToOcrVocab(ocrVocab, stem(t.token), docId)
        for (const t of bodyTokens) addToOcrVocab(ocrVocab, stem(t.token), docId)
      }
      docId++
    }
  }

  return {
    N: docId,
    title: { postings: titlePostings, docLen: titleDocLen, avgLen: average(titleDocLen) },
    body: { postings: bodyPostings, docLen: bodyDocLen, avgLen: average(bodyDocLen) },
    docMeta,
    ocrVocab,
    maxDate,
  }
}

export function parseQuery(raw: string): ParsedQuery {
  const phrases: string[][] = []
  const phraseRe = /"([^"]+)"/g
  for (const m of raw.matchAll(phraseRe)) {
    const words = tokenize(m[1]).map(stem)
    if (words.length) phrases.push(words)
  }
  const remainder = raw.replace(phraseRe, ' ')
  const rawTerms = tokenize(remainder)
  const contentTerms = rawTerms.filter((t) => !STOPWORDS.has(t))
  // An all-stopword free-term query (e.g. "der die das") would otherwise be
  // silently emptied and short-circuit to zero results in queryIndex —
  // better to fall back to the unfiltered terms than to return nothing.
  const effectiveTerms = contentTerms.length > 0 || rawTerms.length === 0 ? contentTerms : rawTerms
  const freeTerms = Array.from(new Set(effectiveTerms.map(stem)))
  return { freeTerms, phrases }
}

function getDocIdsForStem(index: SearchIndex, s: string): Set<number> {
  const ids = new Set<number>()
  const titleMap = index.title.postings.get(s)
  if (titleMap) for (const id of titleMap.keys()) ids.add(id)
  const bodyMap = index.body.postings.get(s)
  if (bodyMap) for (const id of bodyMap.keys()) ids.add(id)
  return ids
}

function intersect(sets: Set<number>[]): Set<number> {
  if (!sets.length) return new Set()
  const sorted = [...sets].sort((a, b) => a.size - b.size)
  let result = new Set(sorted[0])
  for (let i = 1; i < sorted.length && result.size; i++) {
    const next = new Set<number>()
    for (const id of result) if (sorted[i].has(id)) next.add(id)
    result = next
  }
  return result
}

function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  let curr = new Array<number>(n + 1)
  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[n]
}

// Only ever scans `ocrVocab` (1992/93 stems only), so ordinary queries with
// exact hits never pay this cost.
function fuzzyMatchStems(index: SearchIndex, term: string): string[] {
  const maxDist = term.length <= 5 ? 1 : 2
  const matched: string[] = []
  for (const candidate of index.ocrVocab.keys()) {
    if (Math.abs(candidate.length - term.length) > maxDist) continue
    const dist = levenshtein(term, candidate)
    if (dist <= maxDist && dist / term.length < 0.3) matched.push(candidate)
  }
  return matched
}

interface TermInfo {
  stem: string
  docIds: Set<number>
  fuzzy: boolean
  matchedStems: string[]
}

function resolveTerm(index: SearchIndex, s: string): TermInfo {
  const exact = getDocIdsForStem(index, s)
  if (exact.size > 0) return { stem: s, docIds: exact, fuzzy: false, matchedStems: [s] }

  const matched = fuzzyMatchStems(index, s)
  if (matched.length === 0) return { stem: s, docIds: new Set(), fuzzy: false, matchedStems: [] }

  const docIds = new Set<number>()
  for (const m of matched) {
    const ids = index.ocrVocab.get(m)
    if (ids) for (const id of ids) docIds.add(id)
  }
  return { stem: s, docIds, fuzzy: true, matchedStems: matched }
}

function fieldPhraseMatch(field: FieldIndex, phraseStems: string[], docId: number): boolean {
  const firstPosting = field.postings.get(phraseStems[0])?.get(docId)
  if (!firstPosting) return false
  for (const startPos of firstPosting.positions) {
    let ok = true
    for (let i = 1; i < phraseStems.length; i++) {
      const posting = field.postings.get(phraseStems[i])?.get(docId)
      if (!posting || !posting.positions.includes(startPos + i)) {
        ok = false
        break
      }
    }
    if (ok) return true
  }
  return false
}

function phraseMatch(index: SearchIndex, phraseStems: string[], docId: number): boolean {
  return fieldPhraseMatch(index.title, phraseStems, docId) || fieldPhraseMatch(index.body, phraseStems, docId)
}

function idf(index: SearchIndex, s: string): number {
  const ids = getDocIdsForStem(index, s)
  const df = ids.size
  if (df === 0) return 0
  return Math.log(1 + (index.N - df + 0.5) / (df + 0.5))
}

function bm25f(index: SearchIndex, s: string, docId: number): number {
  const tfTitle = index.title.postings.get(s)?.get(docId)?.tf ?? 0
  const tfBody = index.body.postings.get(s)?.get(docId)?.tf ?? 0
  if (tfTitle === 0 && tfBody === 0) return 0

  const tfNormTitle = tfTitle / (1 - B_TITLE + (B_TITLE * index.title.docLen[docId]) / (index.title.avgLen || 1))
  const tfNormBody = tfBody / (1 - B_BODY + (B_BODY * index.body.docLen[docId]) / (index.body.avgLen || 1))
  const tfTilde = W_TITLE * tfNormTitle + W_BODY * tfNormBody
  if (tfTilde === 0) return 0

  return idf(index, s) * (tfTilde / (K1 + tfTilde))
}

function recencyMultiplier(index: SearchIndex, docId: number): number {
  const maxTime = Date.parse(`${index.maxDate}T00:00:00Z`)
  const docTime = Date.parse(`${index.docMeta[docId].issue.date}T00:00:00Z`)
  const ageYears = Math.max(0, (maxTime - docTime) / (365.25 * 24 * 3600 * 1000))
  return 1 + RECENCY_WEIGHT * Math.pow(2, -ageYears / HALFLIFE_YEARS)
}

function termContribution(term: TermInfo, docId: number, index: SearchIndex): number {
  if (!term.fuzzy) return bm25f(index, term.stem, docId)
  let best = 0
  for (const s of term.matchedStems) best = Math.max(best, bm25f(index, s, docId))
  return FUZZY_PENALTY * best
}

export function queryIndex(index: SearchIndex, rawQuery: string, startYear: number, endYear: number): QueryResult {
  const { freeTerms, phrases } = parseQuery(rawQuery)
  if (!freeTerms.length && !phrases.length) return { rankedDocIds: [], total: 0, acceptedStems: new Set() }

  const termInfos = freeTerms.map((t) => resolveTerm(index, t))

  const phraseDocIdSets: Set<number>[] = phrases.map((phraseStems) => {
    const seed = intersect(phraseStems.map((s) => getDocIdsForStem(index, s)))
    const matched = new Set<number>()
    for (const docId of seed) if (phraseMatch(index, phraseStems, docId)) matched.add(docId)
    return matched
  })

  const candidateSets = [...termInfos.map((t) => t.docIds), ...phraseDocIdSets]
  let candidates = intersect(candidateSets)
  candidates = new Set([...candidates].filter((docId) => {
    const year = index.docMeta[docId].year
    return year >= startYear && year <= endYear
  }))

  const scored: { docId: number; score: number }[] = []
  for (const docId of candidates) {
    let score = 0
    for (const term of termInfos) score += termContribution(term, docId, index)
    for (const phraseStems of phrases) {
      for (const s of phraseStems) score += PHRASE_BOOST * bm25f(index, s, docId)
    }
    scored.push({ docId, score: score * recencyMultiplier(index, docId) })
  }
  scored.sort((a, b) => b.score - a.score)

  const acceptedStems = new Set<string>()
  for (const term of termInfos) {
    for (const s of term.matchedStems) acceptedStems.add(s)
  }
  for (const phraseStems of phrases) for (const s of phraseStems) acceptedStems.add(s)

  return { rankedDocIds: scored.map((s) => s.docId), total: scored.length, acceptedStems }
}
