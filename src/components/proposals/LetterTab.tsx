import { useState } from 'react'
import { SavingTextarea } from '../SectionKit'
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
}: {
  proposal: Proposal
  busy: boolean
  onDraft: () => void
  onSaveText: (text: string) => void
}) {
  const [copied, setCopied] = useState(false)
  const locked = proposal.status === 'accepted' || proposal.status === 'declined'
  const text = proposal.letter?.text ?? ''

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
        </div>
      </div>
      {proposal.letter?.subject ? (
        <p className="muted-text">Subject: {proposal.letter.subject}</p>
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
