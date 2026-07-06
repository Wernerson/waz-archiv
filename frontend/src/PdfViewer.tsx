import { useCallback, useEffect, useRef, useState } from 'react'
import { Document, Page } from 'react-pdf'
import 'react-pdf/dist/Page/TextLayer.css'
import './PdfViewer.css'

const ZOOM_STEP = 0.25
const ZOOM_MIN  = 0.25
const ZOOM_MAX  = 3.0

function toSpreadLeft(page: number): number {
  if (page <= 1) return 1
  return page % 2 === 0 ? page : page - 1
}

function downloadFileName(title: string): string {
  const slug = title.trim().replace(/\s+/g, '_').replace(/[^\w.-]/g, '')
  return `${slug || 'waz'}.pdf`
}

interface Props {
  file: string
  startPage: number
  title: string
  onClose: () => void
  onPageChange?: (page: number) => void
}

export default function PdfViewer({ file, startPage, title, onClose, onPageChange }: Props) {
  const [numPages, setNumPages]   = useState(0)
  const [left, setLeft]           = useState(() => toSpreadLeft(startPage))
  const [pageHeight, setPageHeight] = useState(0)
  const [zoom, setZoom]           = useState(1.0)
  const [mode, setMode]           = useState<'pan' | 'select'>('pan')
  const bodyRef   = useRef<HTMLDivElement>(null)
  const docWrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => { onPageChange?.(left) }, [left, onPageChange])

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

  // Click-drag to pan with the mouse, only in "pan" mode; in "select" mode
  // pointerdown is left alone so native text selection works as usual
  // (touch already scrolls natively via overflow, so panning is mouse-only)
  useEffect(() => {
    const el = docWrapRef.current
    if (!el || mode !== 'pan') return

    let dragging = false
    let startX = 0, startY = 0, startScrollLeft = 0, startScrollTop = 0

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 || e.pointerType !== 'mouse') return
      e.preventDefault()
      dragging = true
      startX = e.clientX
      startY = e.clientY
      startScrollLeft = el.scrollLeft
      startScrollTop = el.scrollTop
      el.setPointerCapture(e.pointerId)
      el.classList.add('dragging')
    }
    const onPointerMove = (e: PointerEvent) => {
      if (!dragging) return
      el.scrollLeft = startScrollLeft - (e.clientX - startX)
      el.scrollTop = startScrollTop - (e.clientY - startY)
    }
    const stopDragging = () => {
      dragging = false
      el.classList.remove('dragging')
    }

    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('pointermove', onPointerMove)
    el.addEventListener('pointerup', stopDragging)
    el.addEventListener('pointercancel', stopDragging)
    return () => {
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointermove', onPointerMove)
      el.removeEventListener('pointerup', stopDragging)
      el.removeEventListener('pointercancel', stopDragging)
    }
  }, [mode])

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
          <div className="mode-controls">
            <button
              className={`mode-btn${mode === 'pan' ? ' mode-btn--active' : ''}`}
              onClick={() => setMode('pan')}
              aria-label="Verschieben"
              aria-pressed={mode === 'pan'}
              title="Verschieben (Ziehen zum Scrollen)"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2 L12 22 M2 12 L22 12 M5 9 L2 12 L5 15 M19 9 L22 12 L19 15 M9 5 L12 2 L15 5 M9 19 L12 22 L15 19" />
              </svg>
            </button>
            <button
              className={`mode-btn${mode === 'select' ? ' mode-btn--active' : ''}`}
              onClick={() => setMode('select')}
              aria-label="Text auswählen"
              aria-pressed={mode === 'select'}
              title="Text auswählen"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 4h6 M12 4v16 M9 20h6" />
              </svg>
            </button>
          </div>
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
          <a
            className="viewer-download"
            href={file}
            download={downloadFileName(title)}
            aria-label="PDF herunterladen"
            title="PDF herunterladen"
          >⬇</a>
          <button className="viewer-close" onClick={onClose} aria-label="Schließen">✕</button>
        </header>

        <div className="viewer-body" ref={bodyRef}>
          <button className="nav-btn" onClick={goPrev} disabled={!canPrev} aria-label="Vorherige Seite">‹</button>

          <div className="document-wrap" ref={docWrapRef} data-mode={mode}>
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
                      renderTextLayer
                      renderAnnotationLayer={false}
                    />
                  </div>
                  {!isCover && right && right <= numPages && (
                    <div className="page-wrap page-wrap--right">
                      <Page
                        pageNumber={right}
                        height={effectiveHeight}
                        renderTextLayer
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
