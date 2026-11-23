import { useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import { getDocument, GlobalWorkerOptions, version } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { useTranslate } from '../../../i18n/index.js'
import styles from './WorkspacePane.module.css'

GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url).toString()

export default function WorkspacePdf({ bytes }: { bytes: Uint8Array }) {
  const t = useTranslate()
  const canvas = useRef<HTMLCanvasElement>(null)
  const [doc, setDoc] = useState<PDFDocumentProxy>()
  const [page, setPage] = useState(1)
  const [pending, setPending] = useState(true)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let active = true
    setDoc(undefined)
    setPage(1)
    setFailed(false)
    setPending(true)
    const assets = new URL(`static/pdf/${version}/`, document.baseURI)
    const loading = getDocument({
      data: new Uint8Array(bytes),
      cMapUrl: new URL('cmaps/', assets).toString(),
      cMapPacked: true,
      standardFontDataUrl: new URL('standard_fonts/', assets).toString(),
      wasmUrl: new URL('wasm/', assets).toString(),
      iccUrl: new URL('iccs/', assets).toString(),
      enableXfa: false,
      isOffscreenCanvasSupported: false,
      maxImageSize: 8_000_000,
    })
    void loading.promise.then((result) => {
      if (active) setDoc(result)
    }).catch(() => {
      if (active) setFailed(true)
    })
    return () => {
      active = false
      void loading.destroy().catch(() => undefined)
    }
  }, [bytes])

  useEffect(() => {
    if (!doc || !canvas.current) return
    const output = canvas.current
    let active = true
    let render: RenderTask | undefined
    setPending(true)
    void doc.getPage(page).then((current) => {
      if (!active) return
      const fit = current.getViewport({ scale: 1 })
      const scale = Math.min(2, 1600 / Math.max(fit.width, fit.height))
      const viewport = current.getViewport({ scale })
      if (!Number.isFinite(scale) || scale <= 0) throw new Error('Invalid PDF page size')
      output.width = Math.max(1, Math.ceil(viewport.width))
      output.height = Math.max(1, Math.ceil(viewport.height))
      render = current.render({ canvas: output, viewport })
      return render.promise
    }).then(() => {
      if (active) setPending(false)
    }).catch(() => {
      if (active) setFailed(true)
    })
    return () => {
      active = false
      render?.cancel()
    }
  }, [doc, page])

  if (failed) return <div role="alert" className={styles.error}>{t('workspacePaneDocumentError')}</div>
  const label = doc ? t('workspacePaneDocumentPage', { page, total: doc.numPages }) : undefined
  return <>
    {doc && <div className={styles.documentPager}>
      <button type="button" className={styles.moreButton} disabled={pending || page <= 1}
        onClick={() => setPage(page - 1)}>{t('workspacePaneDocumentPrevious')}</button>
      <span className={styles.previewMeta} aria-live="polite">{label}</span>
      <button type="button" className={styles.moreButton} disabled={pending || page >= doc.numPages}
        onClick={() => setPage(page + 1)}>{t('workspacePaneDocumentNext')}</button>
    </div>}
    {pending && <div className={styles.notice}>{t('workspacePaneLoading')}</div>}
    <canvas ref={canvas} aria-label={label} className={styles.documentCanvas} hidden={pending} />
  </>
}
