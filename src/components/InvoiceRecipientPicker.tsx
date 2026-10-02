import { useId, useState } from 'react'
import { MAX_EXTRA_INVOICE_RECIPIENTS, isPlausibleEmail } from '../../lib/invoice-recipients.js'
import type { InvoiceRecipientDetail } from '../lib/utils'

/**
 * "Send this to whom?" — a confirm dialog with checkboxes, and one small way to
 * add an address for just this send.
 *
 * Clients often have more than one address attached: a contact's company
 * address, that same contact's personal one, another contact entirely, and the
 * address on the client record. All of them are legitimate ways to reach the
 * client, so all of them are ticked when this opens — "send to everyone" stays
 * the default and one click still does it. The checkboxes exist for the times
 * she wants to leave one out.
 *
 * Under the list, "Add another address for this send only" takes an address
 * that is NOT on the client — one client sometimes has more emails than the
 * contact list holds. It joins the list ticked, marked "this send only", and can
 * be removed. Nothing here saves it to the client or its contacts; the caller
 * sends it as `extra` and the server refuses anything that is not a valid
 * address, so this checks only what she can fix as she types.
 *
 * Deliberately NOT shown for a single address on the ordinary Send: a dialog that
 * asks a question with one possible answer is friction, not a safeguard. The
 * caller decides — and offers a "Send to other addresses..." link that opens it
 * anyway, even for a client with one address (or none, where the extras alone
 * are the recipients).
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
  /** Every address on file for this client, each named. May be empty. */
  details: InvoiceRecipientDetail[]
  busy?: boolean
  /** `to` is the ticked addresses on file; `extra` the ticked one-time ones. */
  onSend: (to: string[], extra: string[]) => void
  onCancel: () => void
}) {
  // Keyed by the address itself. Everyone starts ticked.
  const [chosen, setChosen] = useState<string[]>(() => details.map((detail) => detail.email))
  // The addresses added for this send only, in the order she added them.
  const [extras, setExtras] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const draftId = useId()

  const toggle = (email: string) =>
    setChosen((current) =>
      current.includes(email)
        ? current.filter((entry) => entry !== email)
        : [...current, email],
    )

  const addExtra = () => {
    const email = draft.trim()
    if (extras.length >= MAX_EXTRA_INVOICE_RECIPIENTS) {
      setAddError(
        `You can add up to ${MAX_EXTRA_INVOICE_RECIPIENTS} extra addresses for one send.`,
      )
      return
    }
    // The same plausibility check the server applies, so what she is told here
    // is what the send would refuse anyway.
    if (!isPlausibleEmail(email)) {
      setAddError('Type one valid email address, like name@company.com.')
      return
    }
    const key = email.toLowerCase()
    if ([...details.map((detail) => detail.email), ...extras].some((have) => have.toLowerCase() === key)) {
      setAddError('That address is already in the list.')
      return
    }
    setExtras((current) => [...current, email])
    setChosen((current) => [...current, email])
    setDraft('')
    setAddError(null)
  }

  const removeExtra = (email: string) => {
    setExtras((current) => current.filter((entry) => entry !== email))
    setChosen((current) => current.filter((entry) => entry !== email))
    setAddError(null)
  }

  // Send in the resolved ORDER rather than click order, so the To: line reads
  // the same way the list she just looked at did.
  const selected = details
    .filter((detail) => chosen.includes(detail.email))
    .map((detail) => detail.email)
  const selectedExtras = extras.filter((email) => chosen.includes(email))
  const total = selected.length + selectedExtras.length
  // The server's rule: at least one address ON FILE must be on the send — unless
  // the client has none at all, where the extras alone are the recipients.
  const canSend = details.length > 0 ? selected.length > 0 : selectedExtras.length > 0

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
            {extras.map((email) => (
              <li key={email} className="invoice-recipient-extra">
                <label className="invoice-recipient-choice">
                  <input
                    type="checkbox"
                    checked={chosen.includes(email)}
                    onChange={() => toggle(email)}
                  />
                  <span className="invoice-recipient-who">this send only</span>
                  <span className="invoice-recipient-email">{email}</span>
                </label>
                <button
                  type="button"
                  className="ghost-action"
                  aria-label={`Remove ${email}`}
                  disabled={busy}
                  onClick={() => removeExtra(email)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>

          <div className="invoice-recipient-add">
            <label htmlFor={draftId}>Add another address for this send only</label>
            <div className="invoice-recipient-add-row">
              <input
                id={draftId}
                className="input"
                type="email"
                value={draft}
                disabled={busy}
                placeholder="name@company.com"
                onChange={(event) => {
                  setDraft(event.target.value)
                  setAddError(null)
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  addExtra()
                }}
              />
              <button type="button" className="secondary-action" disabled={busy} onClick={addExtra}>
                Add
              </button>
            </div>
            {addError ? (
              <p className="invoice-run-error" role="alert">
                {addError}
              </p>
            ) : null}
          </div>

          {details.length === 0 && selectedExtras.length === 0 ? (
            <p className="invoice-run-sent">
              No address is on file for this client. Add one above to send this invoice to it
              once.
            </p>
          ) : null}
          {details.length > 0 && selected.length === 0 ? (
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
              disabled={busy || !canSend}
              onClick={() => onSend(selected, selectedExtras)}
            >
              {busy ? 'Sending…' : `Send to ${total} ${total === 1 ? 'person' : 'people'}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
