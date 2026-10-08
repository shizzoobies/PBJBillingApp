import { useEffect, useState } from 'react'
import { letterPreviewPdfUrl, previewLetterRequest } from '../lib/api'
import type { LetterPreview } from '../lib/types'
import { retiredSentence } from '../../lib/letter-template.js'
import { PREVIEW_FRAME_PREFIX } from './InvoicePreviewModal'

/**
 * Preview: exactly what one client receives for the engagement letter
 * (featreq-5e195707). A copy of InvoicePreviewModal for letters.
 *
 * The server builds the email and the PDF from the STORED letter with the SAME
 * code Send uses, so this is the real two, shown before anything goes out. The
 * email is rendered in a sandboxed frame (no scripts, every link retargeted to a
 * window the sandbox refuses to open), and the PDF is the server's own stream.
 * The notes under the title say what a preview cannot show: who it goes to,
 * what is missing for this client, and what would make Send skip them.
 */
export function LetterPreviewModal({
  clientId,
  clientName,
  onClose,
}: {
  clientId: string
  clientName: string
  onClose: () => void
}) {
  const [tab, setTab] = useState<'email' | 'pdf'>('email')
  const [preview, setPreview] = useState<LetterPreview | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    previewLetterRequest(clientId)
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
  }, [clientId])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const notes: string[] = []
  if (preview) {
    if (preview.to.length > 0) {
      notes.push(`To: ${preview.to.join(', ')}`)
    } else {
      notes.push(preview.refusal ?? 'No email address on file, so Send would skip this client.')
    }
    if (preview.missing.length > 0) {
      notes.push(
        `Missing for this client: ${preview.missing.map((key) => `{{${key}}}`).join(', ')}. Send skips this client.`,
      )
      if (preview.missingNote) notes.push(preview.missingNote)
    }
    if (preview.unknown.length > 0) {
      notes.push(
        `Not a placeholder the app fills in: ${preview.unknown.map((key) => `{{${key}}}`).join(', ')}. Send refuses until it is fixed.`,
      )
    }
    if (preview.retired.length > 0) {
      notes.push(`${retiredSentence(preview.retired)}. Send refuses until it is taken out.`)
    }
    if (preview.flags.neverEmailed) {
      notes.push('This client is set to never have invoices emailed. A letter is not an invoice, so it still goes.')
    }
    if (preview.flags.billedOutside) {
      notes.push('This client is invoiced outside the app. A letter is not an invoice, so it still goes.')
    }
    if (preview.flags.billingMasterSub) {
      notes.push(`This client is billed through ${preview.flags.billingMasterSub}.`)
    }
    if (!preview.pdfAvailable) {
      notes.push('The PDF could not be built, so Send would skip this client.')
    }
  }

  return (
    <div
      className="modal-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="modal-panel invoice-preview-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`Preview of the letter for ${clientName}`}
      >
        <div className="modal-body">
          <h2 className="modal-title">What {clientName} receives</h2>
          <p className="modal-intro">
            Built by the same code as Send. Nothing is sent or saved from here.
          </p>

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
              {notes.length > 0 ? (
                <ul className="invoice-preview-notes">
                  {notes.map((note) => (
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
                <iframe
                  className="invoice-preview-frame"
                  title="PDF preview"
                  src={letterPreviewPdfUrl(clientId)}
                />
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
