// Main-thread client for the search index. All real work (fetching
// pages.json, building the BM25F index, answering queries) happens inside a
// Web Worker (searchWorker.ts / searchCore.ts) so the 18MB dataset and the
// index build never block the UI. This module just posts typed requests and
// awaits typed responses, correlated by an incrementing id.
export type { IssueRecord, PageRecord, Issue, SearchHit } from './searchCore'
import type { WorkerRequest, WorkerResponse, Issue, SearchHit } from './searchCore'

export const RESULT_LIMIT = 20

// Plain Omit<WorkerRequest, 'id'> doesn't distribute over the WorkerRequest
// union (Pick/Omit key sets only ever include keys common to every member),
// which would collapse every request down to just `{ type }` and drop
// `query`/`path`/etc. This distributes Omit over each union member instead.
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, { resolve: (v: WorkerResponse) => void; reject: (e: Error) => void }>()

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./searchWorker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if (msg.type === 'error') p.reject(new Error(msg.error))
      else p.resolve(msg)
    }
  }
  return worker
}

function call<T extends WorkerResponse>(req: DistributiveOmit<WorkerRequest, 'id'>): Promise<T> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: WorkerResponse) => void, reject })
    getWorker().postMessage({ id, ...req } as WorkerRequest)
  })
}

// Kicks off the pages.json fetch + index build inside the worker. Not
// required before calling the other functions (they await it internally),
// but calling it once, unawaited, near app mount lets the worker start
// warming up before the user finishes typing their first query.
export function loadIssues(): Promise<void> {
  return call({ type: 'loadIssues' }).then(() => undefined)
}

export async function searchPages(
  query: string,
  startYear: number,
  endYear: number,
): Promise<{ hits: SearchHit[]; total: number; highlightStems: Set<string> }> {
  const res = await call<Extract<WorkerResponse, { type: 'search' }>>({ type: 'search', query, startYear, endYear })
  return { hits: res.hits, total: res.total, highlightStems: new Set(res.highlightStems) }
}

export async function listIssues(): Promise<Issue[]> {
  return (await call<Extract<WorkerResponse, { type: 'listIssues' }>>({ type: 'listIssues' })).issues
}

export async function yearBounds(): Promise<{ min: number; max: number }> {
  return (await call<Extract<WorkerResponse, { type: 'yearBounds' }>>({ type: 'yearBounds' })).bounds
}

export async function findIssueByPdfPath(path: string): Promise<Issue | undefined> {
  return (await call<Extract<WorkerResponse, { type: 'findIssueByPdfPath' }>>({ type: 'findIssueByPdfPath', path }))
    .issue
}
