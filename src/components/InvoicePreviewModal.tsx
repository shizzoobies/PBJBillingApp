import { useEffect, useState } from 'react'
import { invoicePreviewPdfUrl, previewInvoiceRequest, type InvoicePreview } from '../lib/api'

/**
 * Preview: exactly what the client receives (featreq-459bdfc2 item 3).
 *
 * The server builds the email and the PDF with the SAME code Send uses, so this
 * is not a third rendering of the invoice but the real two, shown before
 * anything goes out. Offered on a draft on purpose: the point is to look before
 * Mark reviewed, not after.
 *
 * The email is rendered in a sandboxed frame from the HTML the server returned:
 * no scripts, and every link retargeted to a new window the sandbox refuses to
 * open, so nothing in it can be clicked through. That matters for a sent
 * invoice, whose Pay button is its live payment page - opening that mints a
 * Stripe session and logs a click the client never made. The PDF is the
 * server's own stream, embedded.
 * The notes under the tabs say the things a preview cannot show: who it goes
 * to, that a draft's dates are as of today, that the Pay button's address is
 * created at send time.
 */
/**
 * Prepended to the email HTML inside the frame. The sandbox allows no popups,
 * so a link aimed at a new window goes nowhere - the email stays a picture.
 */
export const PREVIEW_FRAME_PREFIX = '<base target="_blank">'

export function InvoicePreviewModal({
  invoiceId,
  invoiceLabel,
  onClose,
}: {
  invoiceId: string
  /** What is being previewed, in words: "Invoice INV-2026-08-001 for Acme LLC". */
  invoiceLabel: string
  onClose: () => void
}) {
  const [tab, setTab] = useState<'email' | 'pdf'>('email')
  const [preview, setPreview] = useState<InvoicePreview | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    previewInvoiceRequest(invoiceId)
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
  }, [invoiceId])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const notes: string[] = []
  if (preview) {
    if (preview.delivery === 'never-emailed') {
      notes.push(
        "This client's invoices are never emailed from the app. The email is shown for reference; the PDF is what you hand them.",
      )
    } else if (preview.delivery === 'opted-out') {
      notes.push('This client is invoiced outside the app, so nothing is sent from here.')
    } else if (preview.to.length > 0) {
      notes.push(`To: ${preview.to.join(', ')}`)
    } else {
      notes.push(preview.recipientNote ?? 'No email address on file; Send will ask you to type one.')
    }
    if (preview.datesAsIfSentToday) {
      notes.push('Not sent yet: the dates that follow from the send are shown as if it were sent today.')
    }
    if (preview.coverageUnconfirmed) {
      notes.push('Send would refuse this invoice until its covered dates are confirmed.')
    }
    if (preview.payLink === 'placeholder') {
      notes.push("The Pay button links to this invoice's own payment page, which is created when you send.")
    }
    if (!preview.pdfAvailable) {
      notes.push('The PDF could not be built; Send would go out without the attachment.')
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
        aria-label={`Preview of ${invoiceLabel}`}
      >
        <div className="modal-body">
          <h2 className="modal-title">What the client receives</h2>
          <p className="modal-intro">
            {invoiceLabel}, built by the same code as Send. Nothing is sent or saved from here.
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
                  src={invoicePreviewPdfUrl(invoiceId)}
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
