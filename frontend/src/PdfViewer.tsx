import { useCallback, useEffect, useRef, useState } from 'react'
import { Document, Page } from 'react-pdf'
import './PdfViewer.css'

const ZOOM_STEP = 0.25
const ZOOM_MIN  = 0.25
const ZOOM_MAX  = 3.0

function toSpreadLeft(page: number): number {
  if (page <= 1) return 1
  return page % 2 === 0 ? page : page - 1
}

interface Props {
  file: string
  startPage: number
  title: string
  onClose: () => void
}

export default function PdfViewer({ file, startPage, title, onClose }: Props) {
  const [numPages, setNumPages]   = useState(0)
  const [left, setLeft]           = useState(() => toSpreadLeft(startPage))
  const [pageHeight, setPageHeight] = useState(0)
  const [zoom, setZoom]           = useState(1.0)
  const bodyRef   = useRef<HTMLDivElement>(null)
  const docWrapRef = useRef<HTMLDivElement>(null)

  const isCover = left === 1
  const right   = isCover ? null : left + 1
  const canPrev = left > 1
  const canNext = isCover ? numPages > 1 : left + 2 <= numPages

  const goPrev    = useCallback(() => setLeft(l => l <= 2 ? 1 : l - 2), [])
  const goNext    = useCallback(() => setLeft(l => l === 1 ? 2 : l + 2), [])
  const zoomIn    = useCallback(() => setZoom(z => parseFloat(Math.min(ZOOM_MAX, z + ZOOM_STEP).toFixed(2))), [])
  const zoomOut   = useCallback(() => setZoom(z => parseFloat(Math.max(ZOOM_MIN, z - ZOOM_STEP).toFixed(2))), [])
  const zoomReset = useCallback(() => setZoom(1.0), [])

  // Keyboard: navigation (←/→) + zoom (+/-/0)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return }
      if (e.ctrlKey || e.metaKey) return
      if (e.key === 'ArrowRight') goNext()
      if (e.key === 'ArrowLeft')  goPrev()
      if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomIn() }
      if (e.key === '-')                  { e.preventDefault(); zoomOut() }
      if (e.key === '0')                  { e.preventDefault(); zoomReset() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, goNext, goPrev, zoomIn, zoomOut, zoomReset])

  // Ctrl+Wheel zoom on the document area
  useEffect(() => {
    const el = docWrapRef.current
    if (!el) return
    const handler = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      e.deltaY < 0 ? zoomIn() : zoomOut()
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [zoomIn, zoomOut])

  // Lock body scroll while viewer is open
  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  // Measure available page height from body container
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const obs = new ResizeObserver(([entry]) => {
      setPageHeight(Math.floor(entry.contentRect.height) - 32)
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  const pageLabel = numPages
    ? isCover
      ? `S. 1 / ${numPages}`
      : `S. ${left}–${Math.min(left + 1, numPages)} / ${numPages}`
    : '…'

  const effectiveHeight = pageHeight > 0 ? Math.round(pageHeight * zoom) : 0

  return (
    <div className="viewer-overlay" onClick={onClose}>
      <div className="viewer-modal" onClick={e => e.stopPropagation()}>

        <header className="viewer-header">
          <span className="viewer-title">{title}</span>
          <span className="viewer-page-label">{pageLabel}</span>
          <div className="zoom-controls">
            <button
              className="zoom-btn"
              onClick={zoomOut}
              disabled={zoom <= ZOOM_MIN}
              aria-label="Verkleinern"
            >−</button>
            <button
              className="zoom-level"
              onClick={zoomReset}
              title="Zoom zurücksetzen (0)"
            >{Math.round(zoom * 100)}%</button>
            <button
              className="zoom-btn"
              onClick={zoomIn}
              disabled={zoom >= ZOOM_MAX}
              aria-label="Vergrößern"
            >+</button>
          </div>
          <button className="viewer-close" onClick={onClose} aria-label="Schließen">✕</button>
        </header>

        <div className="viewer-body" ref={bodyRef}>
          <button className="nav-btn" onClick={goPrev} disabled={!canPrev} aria-label="Vorherige Seite">‹</button>

          <div className="document-wrap" ref={docWrapRef}>
            <Document
              file={file}
              onLoadSuccess={({ numPages }) => setNumPages(numPages)}
              loading={<div className="viewer-status">Lade PDF…</div>}
              error={<div className="viewer-status">Fehler beim Laden.</div>}
            >
              {effectiveHeight > 0 && (
                <div className={`spread${isCover ? ' spread--single' : ''}`}>
                  <div className="page-wrap page-wrap--left">
                    <Page
                      pageNumber={left}
                      height={effectiveHeight}
                      renderTextLayer={false}
                      renderAnnotationLayer={false}
                    />
                  </div>
                  {!isCover && right && right <= numPages && (
                    <div className="page-wrap page-wrap--right">
                      <Page
                        pageNumber={right}
                        height={effectiveHeight}
                        renderTextLayer={false}
                        renderAnnotationLayer={false}
                      />
                    </div>
                  )}
                </div>
              )}
            </Document>
          </div>

          <button className="nav-btn" onClick={goNext} disabled={!canNext} aria-label="Nächste Seite">›</button>
        </div>

      </div>
    </div>
  )
}
