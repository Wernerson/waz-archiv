/// <reference lib="webworker" />
// Message-loop shim: dispatches WorkerRequests to searchCore.ts and posts
// back WorkerResponses. Kept intentionally thin — all real logic lives in
// searchCore.ts so it stays testable without a worker/DOM environment.
import { ensureIssues, findIssueByPdfPath, listIssues, searchPages, yearBounds } from './searchCore'
import type { WorkerRequest, WorkerResponse } from './searchCore'

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const req = e.data
  try {
    switch (req.type) {
      case 'loadIssues': {
        await ensureIssues()
        respond({ id: req.id, type: 'loadIssues' })
        break
      }
      case 'search': {
        const issues = await ensureIssues()
        const result = searchPages(issues, req.query, req.startYear, req.endYear)
        respond({ id: req.id, type: 'search', ...result })
        break
      }
      case 'listIssues': {
        const issues = await ensureIssues()
        respond({ id: req.id, type: 'listIssues', issues: listIssues(issues) })
        break
      }
      case 'yearBounds': {
        const issues = await ensureIssues()
        respond({ id: req.id, type: 'yearBounds', bounds: yearBounds(issues) })
        break
      }
      case 'findIssueByPdfPath': {
        const issues = await ensureIssues()
        respond({ id: req.id, type: 'findIssueByPdfPath', issue: findIssueByPdfPath(issues, req.path) })
        break
      }
    }
  } catch (err) {
    respond({ id: req.id, type: 'error', error: err instanceof Error ? err.message : String(err) })
  }
}

function respond(msg: WorkerResponse): void {
  self.postMessage(msg)
}
