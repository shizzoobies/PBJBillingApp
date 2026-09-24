import { useState } from 'react'
import { SavingTextarea } from '../SectionKit'
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
}: {
  proposal: Proposal
  busy: boolean
  onDraft: () => void
  onSaveText: (text: string) => void
  onSend: (to: string) => void
}) {
  const [copied, setCopied] = useState(false)
  const locked = proposal.status === 'accepted' || proposal.status === 'declined'
  const text = proposal.letter?.text ?? ''
  const badge = proposalDeliveryBadge(proposal)
  // Important 1 (final fix wave): the estimate may have changed since this
  // letter was drafted — a quiet heads-up, computed with the same rule the
  // server enforces at send, rather than an alarm before she has even tried.
  const staleCount = staleLetterFigureCount(proposal)

  // The address is confirmed on EVERY send; the prospect's email only fills it in.
  const send = () => {
    const to = window.prompt('Send the proposal to which email address?', proposal.prospect.email)
    if (to === null || !to.trim()) return
    onSend(to.trim())
  }

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
