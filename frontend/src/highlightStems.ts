// Shared, dependency-free HTML-escaping and stem-match-highlighting logic.
// Used both worker-side (search-result snippet formatting, searchCore.ts)
// and on the main thread (PDF text-layer highlighting, PdfViewer.tsx).
import { tokenizeWithOffsets } from './textTokenize'
import { stem } from './germanStemmer'

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c])
}

// Splits `text` into escaped-HTML fragments, calling `wrap` for each
// substring whose stem is in `acceptedStems` so callers control their own
// markup (e.g. <mark> for the results list, <span class="highlight"> for
// react-pdf's text layer, which relies on that exact class name/convention).
// Matching is done on stems; the returned markup always uses the original
// surface substring, never the stem.
export function forEachStemMatch(
  text: string,
  acceptedStems: ReadonlySet<string>,
  wrap: (escapedMatch: string) => string,
): string {
  const tokens = tokenizeWithOffsets(text)
  let result = ''
  let last = 0
  for (const t of tokens) {
    if (!acceptedStems.has(stem(t.token))) continue
    result += escapeHtml(text.slice(last, t.start))
    result += wrap(escapeHtml(text.slice(t.start, t.end)))
    last = t.end
  }
  result += escapeHtml(text.slice(last))
  return result
}
