import { useState } from 'react'

/**
 * The two doors out of a RESOLVED wait, from the requester's side.
 *
 * Her words, featreq-b05a2f3a: "if completed then we just need one button to
 * approve and mark completed or a button to not approve and send back with
 * another note." So: exactly two buttons, and the send-back note is required —
 * a bare rejection tells the blocker nothing, which is why the composer opens
 * in place of the pair rather than firing straight away.
 *
 * Shared by the Delayed page and the checklist step's waiting editor. Both show
 * the same wait at the same stage to the same person; two copies of this would
 * be two chances for the pair to drift apart.
 */
export function WaitApprovalActions({
  busy,
  blockerName,
  onApprove,
  onSendBack,
}: {
  busy: boolean
  /** Who did the work — named in the titles so the row reads on its own. */
  blockerName: string
  onApprove: () => void
  /** Called with the (non-empty, trimmed) note. */
  onSendBack: (note: string) => void
}) {
  const [composing, setComposing] = useState(false)
  const [note, setNote] = useState('')
  const trimmed = note.trim()

  if (composing) {
    return (
      <span className="wait-sendback-composer">
        <textarea
          className="wait-sendback-note"
          rows={2}
          autoFocus
          placeholder="What still needs doing?"
          aria-label={`Note for ${blockerName}`}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <span className="wait-sendback-composer-actions">
          <button
            type="button"
            className="waiting-blocker-sendback"
            disabled={busy || trimmed === ''}
            title={
              trimmed === ''
                ? 'Say what still needs doing first'
                : `Send this back to ${blockerName} with your note`
            }
            onClick={() => {
              onSendBack(trimmed)
              setComposing(false)
              setNote('')
            }}
          >
            Send it back
          </button>
          <button
            type="button"
            className="waiting-blocker-cancel-sendback"
            disabled={busy}
            onClick={() => {
              setComposing(false)
              setNote('')
            }}
          >
            Cancel
          </button>
        </span>
      </span>
    )
  }

  return (
    <>
      <button
        type="button"
        className="waiting-blocker-verify"
        disabled={busy}
        title={
          busy
            ? 'Working on it — one moment…'
            : `${blockerName} says this is finished — approve and close it out. It stays on the step, struck through, as the record.`
        }
        onClick={onApprove}
      >
        Approve
      </button>
      <button
        type="button"
        className="waiting-blocker-sendback"
        disabled={busy}
        title={
          busy
            ? 'Working on it — one moment…'
            : `Not right yet — send it back to ${blockerName} with a note saying what's missing`
        }
        onClick={() => setComposing(true)}
      >
        Send back
      </button>
    </>
  )
}
