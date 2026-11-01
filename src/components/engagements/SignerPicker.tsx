import { useEffect, useId, useState } from 'react'
import { CLIENT_RECORD_SOURCE } from '../../../lib/invoice-recipients.js'
import { esignSignerName, isReplyToSigner, isSignerEmail } from '../../../lib/esign-signer.js'
import { engagementRecipientsRequest, esignLetterPreviewRequest } from '../../lib/api'
import { ESIGNATURES_AUTO_REMINDER_NOTE, ESIGN_TEST_MODE_NOTE, esignProviderName } from '../../lib/engagements'
import {
  chosenSigner,
  initialSignerSelection,
  selectionNeedsName,
  type EsignSignerPost,
  type SignerParty,
  type SignerSelection,
} from '../../lib/esignSigner'
import { ApiError, type EsignLetterPreview, type EsignProvider } from '../../lib/types'
import { PREVIEW_FRAME_PREFIX } from '../InvoicePreviewModal'
import type { InvoiceRecipientDetail } from '../../lib/utils'

/**
 * "Who signs?" - the confirm of Send for signature (Alex, 2026-10-27: "confirm or specify the email before
 * sending"), shared by the letter's page (EsignPanel) and the client's Billing tab (ClientEngagementsCard) so
 * the two never drift. An engagement letter is signed by exactly ONE person, so this is a single choice, not
 * the recipient picker's checkboxes (RecipientPicker must keep one address on file ticked and allows three
 * extras - neither fits one signer). It is built from the same pieces: the server's on-file list for the letter
 * (`GET /api/engagements/:id/recipients`: the party's address, then the linked client's contacts and record;
 * never a team member's) and the same row styling.
 *
 * The party's address is chosen when it opens; any other address on file can be chosen; or one address typed
 * for this send only - saved nowhere, the party record is not changed. The signer's name goes on a binding
 * document, so it is never borrowed: the party's own address and a named contact sign under their own names;
 * the client record's address, an unnamed contact and a one-time address ask for the name (lib/esign-signer.js,
 * whose helpers this uses, so the name shown is the name the provider gets). An address on file that is not one
 * plain address can't be chosen, nor can the firm's reply-to mailbox unless it is the party's own address. The
 * server checks everything again and refuses a team mailbox.
 *
 * `fresh` (a refusal's list as it is now) opens it on that list without reading again; the caller remounts it
 * (a `key`) to reopen.
 *
 * With eSignatures.io (it takes no PDF and draws the letter's Markdown in its own plain layout) the confirm
 * also shows the letter THE WAY THE SIGNER WILL SEE IT (`EsignLetterPreviewFrame`, read with `templateHash`):
 * the signed copy looks like that, not like the letterhead PDF that Preview shows for plain Send.
 */
export function EsignSendConfirm({
  engagementId,
  partyName,
  party,
  provider,
  testMode,
  templateHash = '',
  replyTo = '',
  fresh = null,
  busy = false,
  onSend,
  onCancel,
}: {
  engagementId: string
  partyName: string
  party: SignerParty
  /** The hash of the letter as the page loaded it: the signing preview is of exactly that letter. */
  templateHash?: string
  /** The firm's reply-to mailbox (the engagement view's sender.replyTo): it signs only as the party's own address. */
  replyTo?: string
  provider: EsignProvider | null | undefined
  testMode: boolean
  fresh?: InvoiceRecipientDetail[] | null
  busy?: boolean
  /** `markdownHash`: the letter the signing preview showed (eSignatures.io), for the send to check; absent without one. */
  onSend: (signer: EsignSignerPost, markdownHash?: string) => void
  onCancel: () => void
}) {
  const partyEmail = String(party.email ?? '').trim()
  const [signers, setSigners] = useState<InvoiceRecipientDetail[] | null>(fresh)
  const [selection, setSelection] = useState<SignerSelection>(() =>
    fresh ? initialSignerSelection(fresh, partyEmail ? [partyEmail] : []) : null,
  )
  const [loadError, setLoadError] = useState('')
  // The hash of the letter the signing preview showed: the send refuses if the letter moved since.
  const [markdownHash, setMarkdownHash] = useState<string | null>(null)

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

  const signer = signers ? chosenSigner(selection, signers, party, replyTo) : null
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
        <SignerChoices details={signers} selection={selection} party={party} replyTo={replyTo} onChange={setSelection} busy={busy} />
      )}
      {signer ? (
        <p className="recipient-picker-final">{`Signer: ${signer.name} (${signer.email})`}</p>
      ) : signers !== null && !selection ? (
        <p className="muted-text">Choose who signs.</p>
      ) : null}
      {provider === 'esignatures' ? <p className="muted-text">{ESIGNATURES_AUTO_REMINDER_NOTE}</p> : null}
      {testMode ? <p className="muted-text">{ESIGN_TEST_MODE_NOTE}</p> : null}
      {provider === 'esignatures' && templateHash ? (
        <EsignLetterPreviewFrame engagementId={engagementId} templateHash={templateHash} onLoaded={setMarkdownHash} />
      ) : null}
      <div className="button-row">
        <button
          type="button"
          className="primary-action"
          disabled={busy || !signer}
          onClick={() => {
            if (signer) onSend(signer.post, provider === 'esignatures' && markdownHash ? markdownHash : undefined)
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

/** The label over the signing preview: what it is, and that the signed copy will look like it. */
export const ESIGN_PREVIEW_LABEL =
  'This is how the signing service presents the letter. The signed copy will look like this, not like the letterhead PDF.'

/**
 * The letter as eSignatures.io presents it: the server's HTML of the exact Markdown the send posts (every
 * character escaped there), in a sandboxed frame with no scripts - never injected into the page.
 */
export function EsignLetterPreviewFrame({
  engagementId,
  templateHash,
  onLoaded,
}: {
  engagementId: string
  templateHash: string
  /** Told the shown letter's hash (null when it could not be built). */
  onLoaded?: (markdownHash: string | null) => void
}) {
  const [shown, setShown] = useState<{ key: string; preview: EsignLetterPreview | null; error: string } | null>(null)
  const key = `${engagementId}:${templateHash}`

  useEffect(() => {
    let cancelled = false
    esignLetterPreviewRequest(engagementId, templateHash).then(
      (preview) => {
        if (cancelled) return
        setShown({ key, preview, error: '' })
        onLoaded?.(typeof preview.markdownHash === 'string' && preview.markdownHash ? preview.markdownHash : null)
      },
      (err: unknown) => {
        if (cancelled) return
        const why = err instanceof ApiError ? err.message : 'Could not build the signing preview'
        setShown({ key, preview: null, error: why })
        onLoaded?.(null)
      },
    )
    return () => {
      cancelled = true
    }
  }, [engagementId, templateHash, key, onLoaded])

  const current = shown?.key === key ? shown : null
  return (
    <section className="esign-letter-preview" aria-label="Letter as the signer will see it">
      <p className="esign-letter-preview-label">
        <strong>{ESIGN_PREVIEW_LABEL}</strong>
      </p>
      {current === null ? <p className="muted-text">Building the signing preview...</p> : null}
      {current?.error ? (
        <p className="form-error" role="alert">
          {current.error}
        </p>
      ) : null}
      {current?.preview ? (
        <iframe
          className="invoice-preview-frame esign-letter-preview-frame"
          title="Letter as the signing service presents it"
          sandbox=""
          srcDoc={PREVIEW_FRAME_PREFIX + current.preview.html}
        />
      ) : null}
    </section>
  )
}

/** The choices: one radio per address on file (name and address), one for an address for this send only, and the name when one is needed. */
export function SignerChoices({
  details,
  selection,
  party,
  replyTo = '',
  onChange,
  busy = false,
}: {
  details: InvoiceRecipientDetail[]
  selection: SignerSelection
  party: SignerParty
  replyTo?: string
  onChange: (next: SignerSelection) => void
  busy?: boolean
}) {
  const group = useId()
  const typedId = useId()
  const nameId = useId()
  const typed = selection?.mode === 'oneTime' ? selection : null
  const typedEmail = typed?.email ?? ''
  const typedProblem =
    typed && typedEmail.trim() !== ''
      ? !isSignerEmail(typedEmail)
        ? 'Type one valid email address, like name@company.com.'
        : isReplyToSigner({ email: typedEmail, party, replyTo })
          ? "That is the firm's reply-to mailbox: it signs only as the party's own address."
          : ''
      : ''
  const needsName = selectionNeedsName(selection, details, party)

  return (
    <div role="radiogroup" aria-label="Who signs">
      <ul className="invoice-recipient-picker">
        {details.map((detail) => {
          const plain = isSignerEmail(detail.email)
          const firmMailbox = isReplyToSigner({ email: detail.email, party, replyTo })
          const named = esignSignerName({ email: detail.email, details, party })
          return (
            <li key={detail.email}>
              <label className="invoice-recipient-choice">
                <input
                  type="radio"
                  name={group}
                  checked={selection?.mode === 'onFile' && selection.email === detail.email}
                  disabled={busy || !plain || firmMailbox}
                  onChange={() => onChange({ mode: 'onFile', email: detail.email, name: '' })}
                />
                <span className="invoice-recipient-who">
                  {detail.source.toLowerCase() === CLIENT_RECORD_SOURCE ? 'Client record' : named || 'Unnamed contact'}
                </span>
                <span className="invoice-recipient-email">{detail.email}</span>
                {!plain ? (
                  <span className="muted-text">(not one plain address - fix it on file to use it)</span>
                ) : firmMailbox ? (
                  <span className="muted-text">(the firm&apos;s reply-to mailbox - only as the party&apos;s own address)</span>
                ) : null}
              </label>
            </li>
          )
        })}
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
      {typed || needsName ? (
        <div className="invoice-recipient-add">
          {typed ? (
            <>
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
            </>
          ) : null}
          {needsName && selection ? (
            <>
              <label htmlFor={nameId}>Signer&apos;s name</label>
              <input
                id={nameId}
                className="input"
                type="text"
                value={selection.name}
                disabled={busy}
                maxLength={200}
                placeholder="Full name, as it goes on the signed letter"
                onChange={(event) => onChange({ ...selection, name: event.target.value })}
              />
              {selection.name.trim() === '' ? (
                <p className="muted-text">Type the name of the person who signs: it goes on the signed letter.</p>
              ) : null}
            </>
          ) : null}
          {typed ? <p className="muted-text">Used for this send only; the party&apos;s address is not changed.</p> : null}
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
