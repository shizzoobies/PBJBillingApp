import { useId, useState, type ReactNode } from 'react'
import { MAX_EXTRA_INVOICE_RECIPIENTS, isPlausibleEmail } from '../../lib/invoice-recipients.js'
import type { InvoiceRecipientDetail } from '../lib/utils'
import {
  PICK_ONE_ON_FILE,
  initialRecipientSelection,
  recipientListLabel,
  recipientSelectionResult,
  type RecipientSelection,
} from '../lib/recipientSelection'

/**
 * "Send this to whom?" - THE recipient picker, shown before every manual client
 * email (featreq-34627da1: "I want to be able to manually select who I am
 * sending emails to"): invoice Send, Send reminder and Remind all, Letters, the
 * engagement letter, the proposal, the questionnaire link and the autopay
 * invitation.
 *
 * It lists the addresses on file for that send - a client's contacts by name and
 * the client record, or a prospect's own address - with that surface's default
 * ticked (everyone, unless the caller says otherwise). She can untick any of
 * them, and "Add another address for this send only" takes up to three more that
 * are NOT on file. Those join the list ticked, marked "this send only", can be
 * removed, and are saved nowhere: the caller posts them as `extra` and the server
 * refuses anything that is not a valid address.
 *
 * The server's rule, said here too: at least one address ON FILE must stay
 * ticked - a send never goes to one-time addresses alone - unless nothing is on
 * file at all, where the added ones are the only way to reach anyone.
 *
 * Shown even for a single address: seeing who it goes to is the point.
 */

/**
 * The list itself - checkboxes, the add box and the one-on-file warning - with
 * the selection held by the caller. The dialog below wraps it; Send reminder and
 * Remind all put it inside their own confirms.
 */
export function RecipientChoices({
  details,
  selection,
  onChange,
  busy = false,
  emptyNote = 'No address is on file for this client. Add one above to send to it once.',
}: {
  details: InvoiceRecipientDetail[]
  selection: RecipientSelection
  onChange: (next: RecipientSelection) => void
  busy?: boolean
  /** Said when nothing is on file and nothing has been added yet. */
  emptyNote?: string
}) {
  const [draft, setDraft] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const draftId = useId()
  const { chosen, extras } = selection

  const toggle = (email: string) =>
    onChange({
      chosen: chosen.includes(email) ? chosen.filter((entry) => entry !== email) : [...chosen, email],
      extras,
    })

  const addExtra = () => {
    const email = draft.trim()
    if (extras.length >= MAX_EXTRA_INVOICE_RECIPIENTS) {
      setAddError(`You can add up to ${MAX_EXTRA_INVOICE_RECIPIENTS} extra addresses for one send.`)
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
    onChange({ chosen: [...chosen, email], extras: [...extras, email] })
    setDraft('')
    setAddError(null)
  }

  const removeExtra = (email: string) => {
    onChange({
      chosen: chosen.filter((entry) => entry !== email),
      extras: extras.filter((entry) => entry !== email),
    })
    setAddError(null)
  }

  const { to, extra } = recipientSelectionResult(details, selection)

  return (
    <>
      <ul className="invoice-recipient-picker">
        {details.map((detail) => (
          <li key={detail.email}>
            <label className="invoice-recipient-choice">
              <input
                type="checkbox"
                checked={chosen.includes(detail.email)}
                disabled={busy}
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
                disabled={busy}
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

      {details.length === 0 && extra.length === 0 ? <p className="invoice-run-sent">{emptyNote}</p> : null}
      {details.length > 0 && to.length === 0 ? (
        <p className="invoice-run-error" role="alert">
          {PICK_ONE_ON_FILE}
        </p>
      ) : null}
    </>
  )
}

/**
 * The dialog: the list, the final "Goes to" line, Cancel and the action button.
 * `onSend` gets the ticked on-file addresses (`to`) and the ticked added ones
 * (`extra`).
 */
export function RecipientPicker({
  label,
  details,
  defaultTo,
  busy = false,
  onSend,
  onCancel,
  actionLabel,
  emptyNote,
  children,
}: {
  /** What is being sent, in words: "Invoice INV-2026-08-001 for Acme LLC". */
  label: string
  /** Every address on file for this send, each named. May be empty. */
  details: InvoiceRecipientDetail[]
  /** The addresses ticked when it opens; everyone on file when omitted. */
  defaultTo?: string[] | null
  busy?: boolean
  onSend: (to: string[], extra: string[]) => void
  onCancel: () => void
  /** The action button's words for `total` recipients; "Send to N people" by default. */
  actionLabel?: (total: number) => string
  emptyNote?: string
  /** Anything else the confirm must say, above the buttons. */
  children?: ReactNode
}) {
  const [selection, setSelection] = useState<RecipientSelection>(() =>
    initialRecipientSelection(details, defaultTo),
  )
  const { to, extra, total, canSend } = recipientSelectionResult(details, selection)
  const words = actionLabel ?? ((count: number) => `Send to ${count} ${count === 1 ? 'person' : 'people'}`)

  return (
    <div
      className="modal-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <div className="modal-panel" role="dialog" aria-modal="true" aria-label="Choose who this goes to">
        <div className="modal-body">
          <h2 className="modal-title">Send to</h2>
          <p className="modal-intro">{label} will go to the addresses you leave ticked.</p>

          <RecipientChoices
            details={details}
            selection={selection}
            onChange={setSelection}
            busy={busy}
            {...(emptyNote ? { emptyNote } : {})}
          />

          {total > 0 ? <p className="recipient-picker-final">{`Goes to: ${recipientListLabel(to, extra)}`}</p> : null}
          {children}

          <div className="button-row">
            <button type="button" className="secondary-action" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="primary-action"
              disabled={busy || !canSend}
              onClick={() => onSend(to, extra)}
            >
              {busy ? 'Sending…' : words(total)}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
