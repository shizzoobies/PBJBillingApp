import { useEffect, useId, useState } from 'react'
import { CLIENT_RECORD_SOURCE, isPlausibleEmail } from '../../../lib/invoice-recipients.js'
import { esignSignerName } from '../../../lib/esign-signer.js'
import { engagementRecipientsRequest } from '../../lib/api'
import { ESIGNATURES_AUTO_REMINDER_NOTE, ESIGN_TEST_MODE_NOTE, esignProviderName } from '../../lib/engagements'
import {
  chosenSigner,
  initialSignerSelection,
  type EsignSignerPost,
  type SignerParty,
  type SignerSelection,
} from '../../lib/esignSigner'
import { ApiError, type EsignProvider } from '../../lib/types'
import type { InvoiceRecipientDetail } from '../../lib/utils'

/**
 * The whole confirm of Send for signature, shared by the letter's page (EsignPanel) and the client's Billing
 * tab (ClientEngagementsCard) so the two never drift: it reads who may sign (the server's on-file list for
 * the letter), offers the choices, names the signer, says what the provider does, and hands the chosen
 * signer to `onSend`. `fresh` (a refusal's list as it is now) opens it on that list without reading again.
 */
export function EsignSendConfirm({
  engagementId,
  partyName,
  party,
  provider,
  testMode,
  fresh = null,
  busy = false,
  onSend,
  onCancel,
}: {
  engagementId: string
  partyName: string
  party: SignerParty
  provider: EsignProvider | null | undefined
  testMode: boolean
  fresh?: InvoiceRecipientDetail[] | null
  busy?: boolean
  onSend: (signer: EsignSignerPost) => void
  onCancel: () => void
}) {
  const partyEmail = String(party.email ?? '').trim()
  const [signers, setSigners] = useState<InvoiceRecipientDetail[] | null>(fresh)
  const [selection, setSelection] = useState<SignerSelection>(() =>
    fresh ? initialSignerSelection(fresh, partyEmail ? [partyEmail] : []) : null,
  )
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    if (fresh) return
    let cancelled = false
    engagementRecipientsRequest(engagementId).then(
      (list) => {
        if (cancelled) return
        setSigners(list.details)
        setSelection(initialSignerSelection(list.details, list.defaultTo))
      },
      (err: unknown) => {
        if (cancelled) return
        // The contacts could not be read: the party's address (the server still checks it) or a typed one.
        const fallback = partyEmail ? [{ email: partyEmail, source: String(party.contactName || partyName) }] : []
        setSigners(fallback)
        setSelection(initialSignerSelection(fallback, partyEmail ? [partyEmail] : []))
        const why = (err instanceof ApiError ? err.message : "Could not read the client's contacts").replace(/\.$/, '')
        setLoadError(`${why}. You can still send to the party's address or type one.`)
      },
    )
    return () => {
      cancelled = true
    }
  }, [engagementId, fresh, partyEmail, party.contactName, partyName])

  const signer = signers ? chosenSigner(selection, signers, party) : null
  const providerName = esignProviderName(provider)

  return (
    <div className="esign-confirm" role="group" aria-label="Confirm send for signature">
      <p>{`Who signs the engagement letter for ${partyName}? One person signs; ${providerName} emails them a link to sign it.`}</p>
      {loadError ? (
        <p className="form-error" role="alert">
          {loadError}
        </p>
      ) : null}
      {signers === null ? (
        <p className="muted-text">Reading who can sign...</p>
      ) : (
        <SignerChoices details={signers} selection={selection} party={party} onChange={setSelection} busy={busy} />
      )}
      {signer ? <p className="recipient-picker-final">{`Signer: ${signer.name} (${signer.email})`}</p> : null}
      {provider === 'esignatures' ? <p className="muted-text">{ESIGNATURES_AUTO_REMINDER_NOTE}</p> : null}
      {testMode ? <p className="muted-text">{ESIGN_TEST_MODE_NOTE}</p> : null}
      <div className="button-row">
        <button
          type="button"
          className="primary-action"
          disabled={busy || !signer}
          onClick={() => {
            if (!signer) return
            onSend({
              email: signer.email,
              ...(signer.oneTime ? { oneTime: true as const, ...(signer.typedName ? { name: signer.typedName } : {}) } : {}),
            })
          }}
        >
          {signer ? `Send for signature to ${signer.email}` : 'Choose who signs'}
        </button>
        <button type="button" className="ghost-action" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

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
