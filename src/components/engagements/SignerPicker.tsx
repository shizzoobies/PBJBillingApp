import { useId } from 'react'
import { CLIENT_RECORD_SOURCE, isPlausibleEmail } from '../../../lib/invoice-recipients.js'
import { esignSignerName } from '../../../lib/esign-signer.js'
import type { SignerParty, SignerSelection } from '../../lib/esignSigner'
import type { InvoiceRecipientDetail } from '../../lib/utils'

/**
 * "Who signs?" - the confirm step of Send for signature (Alex, 2026-10-27: "confirm or specify the email
 * before sending"). An engagement letter is signed by exactly ONE person, so this is a single choice, not
 * the recipient picker's checkboxes (RecipientPicker must keep one address on file ticked and allows three
 * extras - neither fits one signer). It is built from the same pieces: the server's on-file list for the
 * letter (the party's address, then the linked client's contacts and record; never a team member's), the
 * same row styling, and the same plausibility check on a typed address.
 *
 * The party's address is chosen when it opens; any other address on file can be chosen instead; or one
 * address (and, optionally, the signer's name) typed for this send only - saved nowhere, the party record is
 * not changed. The server checks the choice again (lib/esign-signer.js) and refuses a team mailbox.
 */

/** The choices: one radio per address on file (name and address), and one for an address for this send only. */
export function SignerChoices({
  details,
  selection,
  party,
  onChange,
  busy = false,
}: {
  details: InvoiceRecipientDetail[]
  selection: SignerSelection
  party: SignerParty
  onChange: (next: SignerSelection) => void
  busy?: boolean
}) {
  const group = useId()
  const typedId = useId()
  const typedNameId = useId()
  const typed = selection?.mode === 'oneTime' ? selection : null
  const typedEmail = typed?.email ?? ''
  const typedProblem = typed && typedEmail.trim() !== '' && !isPlausibleEmail(typedEmail) ? 'Type one valid email address, like name@company.com.' : ''

  return (
    <div role="radiogroup" aria-label="Who signs">
      <ul className="invoice-recipient-picker">
        {details.map((detail) => (
          <li key={detail.email}>
            <label className="invoice-recipient-choice">
              <input
                type="radio"
                name={group}
                checked={selection?.mode === 'onFile' && selection.email === detail.email}
                disabled={busy}
                onChange={() => onChange({ mode: 'onFile', email: detail.email })}
              />
              <span className="invoice-recipient-who">
                {detail.source.toLowerCase() === CLIENT_RECORD_SOURCE ? 'Client record' : esignSignerName({ email: detail.email, details, party })}
              </span>
              <span className="invoice-recipient-email">{detail.email}</span>
            </label>
          </li>
        ))}
        <li>
          <label className="invoice-recipient-choice">
            <input
              type="radio"
              name={group}
              checked={Boolean(typed)}
              disabled={busy}
              onChange={() => onChange({ mode: 'oneTime', email: typedEmail, name: typed?.name ?? '' })}
            />
            <span className="invoice-recipient-who">Another address for this send only</span>
          </label>
        </li>
      </ul>
      {typed ? (
        <div className="invoice-recipient-add">
          <label htmlFor={typedId}>Signer&apos;s email for this send only</label>
          <input
            id={typedId}
            className="input"
            type="email"
            value={typedEmail}
            disabled={busy}
            placeholder="name@company.com"
            onChange={(event) => onChange({ mode: 'oneTime', email: event.target.value, name: typed.name })}
          />
          <label htmlFor={typedNameId}>Signer&apos;s name (optional)</label>
          <input
            id={typedNameId}
            className="input"
            type="text"
            value={typed.name}
            disabled={busy}
            maxLength={200}
            placeholder={esignSignerName({ email: '', details: [], party })}
            onChange={(event) => onChange({ mode: 'oneTime', email: typedEmail, name: event.target.value })}
          />
          <p className="muted-text">Used for this send only; the party&apos;s address is not changed.</p>
          {typedProblem ? (
            <p className="invoice-run-error" role="alert">
              {typedProblem}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
