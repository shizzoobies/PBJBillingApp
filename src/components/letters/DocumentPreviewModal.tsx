import { useEffect, useRef, useState } from 'react'
import { PREVIEW_FRAME_PREFIX } from '../InvoicePreviewModal'

/** What every letter preview carries: the email and whether there is a PDF to show. */
export type DocumentPreviewShape = {
  subject: string
  html: string
  pdfAvailable: boolean
}

/**
 * The preview window Letters and Engagements share: Email and PDF attachment tabs,
 * the server's own email in a sandboxed frame (no scripts, every link retargeted to a
 * window the sandbox refuses to open) and the server's own PDF stream. What to fetch
 * is a parameter: `load` is called once per `loadKey`; `notes` turns the answer into
 * the sentences under the title (who it goes to, what is missing, what stops Send).
 */
export function DocumentPreviewModal<P extends DocumentPreviewShape>({
  loadKey,
  load,
  pdfUrl,
  title,
  ariaLabel,
  notes,
  onClose,
}: {
  loadKey: string
  load: () => Promise<P>
  pdfUrl: string
  title: string
  ariaLabel: string
  notes: (preview: P) => string[]
  onClose: () => void
}) {
  const [tab, setTab] = useState<'email' | 'pdf'>('email')
  const [preview, setPreview] = useState<P | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The fetcher of the latest render; the effect reruns only when what it fetches changes.
  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  }, [load])

  useEffect(() => {
    let cancelled = false
    loadRef
      .current()
      .then((result) => {
        if (!cancelled) setPreview(result)
      })
      .catch((reason: unknown) => {
        if (cancelled) return
        setError(reason instanceof Error ? reason.message : 'Could not build the preview.')
      })
    return () => {
      cancelled = true
    }
  }, [loadKey])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const lines = preview ? notes(preview) : []

  return (
    <div
      className="modal-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="modal-panel invoice-preview-panel" role="dialog" aria-modal="true" aria-label={ariaLabel}>
        <div className="modal-body">
          <h2 className="modal-title">{title}</h2>
          <p className="modal-intro">Built by the same code as Send. Nothing is sent or saved from here.</p>

          <div className="task-area-tabs" role="tablist" aria-label="Preview sections">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'email'}
              className={`task-area-tab${tab === 'email' ? ' is-active' : ''}`}
              onClick={() => setTab('email')}
            >
              Email
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'pdf'}
              className={`task-area-tab${tab === 'pdf' ? ' is-active' : ''}`}
              onClick={() => setTab('pdf')}
            >
              PDF attachment
            </button>
          </div>

          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          {!preview && !error ? <p className="empty-state">Building the preview...</p> : null}

          {preview ? (
            <>
              {lines.length > 0 ? (
                <ul className="invoice-preview-notes">
                  {lines.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              ) : null}
              {tab === 'email' ? (
                <>
                  <p className="invoice-preview-subject">
                    <strong>Subject:</strong> {preview.subject}
                  </p>
                  <iframe
                    className="invoice-preview-frame"
                    title="Email preview"
                    sandbox=""
                    srcDoc={PREVIEW_FRAME_PREFIX + preview.html}
                  />
                </>
              ) : preview.pdfAvailable ? (
                <iframe className="invoice-preview-frame" title="PDF preview" src={pdfUrl} />
              ) : (
                <p className="empty-state">There is no PDF to show.</p>
              )}
            </>
          ) : null}

          <div className="button-row">
            <button type="button" className="secondary-action" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
