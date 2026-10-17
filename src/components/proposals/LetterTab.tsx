import { useState } from 'react'
import { SavingTextarea } from '../SectionKit'
import { RecipientPicker } from '../RecipientPicker'
import type { InvoiceRecipientDetail } from '../../lib/utils'
import { proposalDeliveryBadge, staleLetterFigureCount } from '../../lib/proposals'
import type { Proposal } from '../../lib/types'

/**
 * The Letter tab (spec §5.1 / §5.3): "Draft the proposal" asks Opus 5.5 for a
 * letter written around the priced estimate; the text is hers to edit;
 * "Regenerate" replaces it only after a confirm. The AI never prices — the
 * server refuses a draft that quotes a figure the estimate does not have.
 */
export function LetterTab({
  proposal,
  busy,
  onDraft,
  onSaveText,
  onSend,
  recipients,
  picking,
  onPickingChange,
}: {
  proposal: Proposal
  busy: boolean
  onDraft: () => void
  onSaveText: (text: string) => void
  onSend: (to: string[], extra: string[]) => void
  /** The addresses on file the picker lists: the prospect's, then its client's (featreq-34627da1). */
  recipients: InvoiceRecipientDetail[]
  /** Whether the recipient picker is open - held by the page, which reopens it on a 409 recipients_changed. */
  picking: boolean
  onPickingChange: (open: boolean) => void
}) {
  const [copied, setCopied] = useState(false)
  const setPicking = onPickingChange
  const locked = proposal.status === 'accepted' || proposal.status === 'declined'
  const text = proposal.letter?.text ?? ''
  const badge = proposalDeliveryBadge(proposal)
  // Important 1 (final fix wave): the estimate may have changed since this
  // letter was drafted — a quiet heads-up, computed with the same rule the
  // server enforces at send, rather than an alarm before she has even tried.
  const staleCount = staleLetterFigureCount(proposal)

  // Who it goes to is chosen on EVERY send, in the shared recipient picker
  // (featreq-34627da1): the prospect's address ticked, the client's contacts listed
  // when there is a client, and up to three added for this send only.
  const prospectEmail = proposal.prospect.email.trim().toLowerCase()
  const defaultTo = recipients.some((detail) => detail.email.toLowerCase() === prospectEmail)
    ? [proposal.prospect.email.trim()]
    : null
  const send = () => setPicking(true)

  const draft = () => {
    if (
      text &&
      !window.confirm('Replace this letter with a new draft? Your edits to this one will be lost.')
    ) {
      return
    }
    onDraft()
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <section className="panel">
      <div className="section-heading">
        <h3>Letter</h3>
        <div className="button-row">
          <button
            type="button"
            className="primary-action"
            disabled={busy || locked}
            onClick={draft}
          >
            {text ? 'Regenerate' : 'Draft the proposal'}
          </button>
          <button
            type="button"
            className="secondary-action"
            disabled={!text}
            onClick={() => void copy()}
          >
            {copied ? 'Copied' : 'Copy text'}
          </button>
          <a
            className="secondary-action"
            href={`/api/proposals/${encodeURIComponent(proposal.id)}/pdf`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Preview PDF
          </a>
          <button
            type="button"
            className="primary-action"
            disabled={busy || locked || !text}
            onClick={send}
          >
            Send to prospect
          </button>
          {badge ? <span className="status-pill">{badge}</span> : null}
        </div>
      </div>
      {picking ? (
        <RecipientPicker
          label={`The proposal for ${proposal.prospect.company || proposal.prospect.contactName || 'this prospect'}`}
          details={recipients}
          defaultTo={defaultTo}
          emptyNote="There is no email address for this prospect yet. Add one above to send to it."
          onSend={(to, extra) => {
            setPicking(false)
            onSend(to, extra)
          }}
          onCancel={() => setPicking(false)}
        />
      ) : null}
      {proposal.letter?.subject ? (
        <p className="muted-text">Subject: {proposal.letter.subject}</p>
      ) : null}
      {staleCount > 0 ? (
        <p className="muted-text">
          The estimate changed since this letter was drafted; {staleCount} figure(s) no longer
          match.
        </p>
      ) : null}
      {text ? (
        <fieldset className="proposal-fieldset" disabled={locked}>
          <SavingTextarea
            ariaLabel="Letter text"
            rows={24}
            canonical={text}
            onCommit={onSaveText}
          />
        </fieldset>
      ) : (
        <p className="muted-text">
          No letter yet — “Draft the proposal” writes one from this estimate. Every price in it
          comes from the estimate, never from the AI.
        </p>
      )}
    </section>
  )
}
