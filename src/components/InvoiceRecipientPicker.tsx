import { useState } from 'react'
import type { InvoiceRecipientDetail } from '../lib/utils'

/**
 * "Send this to whom?" — a confirm dialog with checkboxes, and nothing else.
 *
 * Clients often have more than one address attached: a contact's company
 * address, that same contact's personal one, another contact entirely, and the
 * address on the client record. All of them are legitimate ways to reach the
 * client, so all of them are ticked when this opens — "send to everyone" stays
 * the default and one click still does it. The checkboxes exist for the times
 * she wants to leave one out.
 *
 * Deliberately NOT shown for a single address: a dialog that asks a question
 * with one possible answer is friction, not a safeguard. The caller decides.
 */
export function InvoiceRecipientPicker({
  invoiceLabel,
  details,
  busy = false,
  onSend,
  onCancel,
}: {
  /** What is being sent, in words: "Invoice INV-2026-08-001 for Acme LLC". */
  invoiceLabel: string
  /** Every address on file for this client, each named. */
  details: InvoiceRecipientDetail[]
  busy?: boolean
  onSend: (to: string[]) => void
  onCancel: () => void
}) {
  // Keyed by the address itself. Everyone starts ticked.
  const [chosen, setChosen] = useState<string[]>(() => details.map((detail) => detail.email))

  const toggle = (email: string) =>
    setChosen((current) =>
      current.includes(email)
        ? current.filter((entry) => entry !== email)
        : [...current, email],
    )

  // Send in the resolved ORDER rather than click order, so the To: line reads
  // the same way the list she just looked at did.
  const selected = details
    .filter((detail) => chosen.includes(detail.email))
    .map((detail) => detail.email)

  return (
    <div
      className="modal-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <div
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Choose who this invoice goes to"
      >
        <div className="modal-body">
          <h2 className="modal-title">Send to</h2>
          <p className="modal-intro">
            {invoiceLabel} will go to the addresses you leave ticked.
          </p>

          <ul className="invoice-recipient-picker">
            {details.map((detail) => (
              <li key={detail.email}>
                <label className="invoice-recipient-choice">
                  <input
                    type="checkbox"
                    checked={chosen.includes(detail.email)}
                    onChange={() => toggle(detail.email)}
                  />
                  <span className="invoice-recipient-who">{detail.source}</span>
                  <span className="invoice-recipient-email">{detail.email}</span>
                </label>
              </li>
            ))}
          </ul>

          {selected.length === 0 ? (
            <p className="invoice-run-error" role="alert">
              Pick at least one address — an invoice with nobody on it cannot be sent.
            </p>
          ) : null}

          <div className="button-row">
            <button type="button" className="secondary-action" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="primary-action"
              disabled={busy || selected.length === 0}
              onClick={() => onSend(selected)}
            >
              {busy
                ? 'Sending…'
                : `Send to ${selected.length} ${selected.length === 1 ? 'person' : 'people'}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
