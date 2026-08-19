import { useState } from 'react'

/**
 * The second button on the blocker's side of a wait: a QUESTION for whoever
 * asked, sent without finishing.
 *
 * Her annotated Delayed screenshot (featreq-8b7d06d7) puts it beside Done —
 * "a question / send back button that opens a message box… sending does not
 * complete the wait." Before it, the only two things the person being waited on
 * could do were finish the work or leave it sitting there; when they did not
 * know what was actually wanted, both were wrong.
 *
 * Deliberately NOT folded into {@link WaitApprovalActions}. That component is
 * the requester's pair of doors out of a resolved wait — approve or reject —
 * and both of them MOVE the wait. This one moves nothing, is pressed by the
 * other person at the other stage, and is the only control here that leaves the
 * row exactly where it was. Sharing a composer between them would tie two
 * different rules to one shape.
 */
export function WaitQuestionAction({
  busy,
  requesterName,
  onAsk,
}: {
  busy: boolean
  /** Who is waiting on you — named in the composer so the row reads on its own. */
  requesterName: string
  /**
   * Called with the (non-empty, trimmed) message. AWAITED: the composer only
   * closes and clears once the send actually lands, so a refusal leaves what was
   * typed on screen beside the reason rather than throwing it away.
   */
  onAsk: (note: string) => Promise<void> | void
}) {
  const [composing, setComposing] = useState(false)
  const [note, setNote] = useState('')
  const [sending, setSending] = useState(false)
  const trimmed = note.trim()

  const send = async () => {
    setSending(true)
    try {
      await onAsk(trimmed)
      setComposing(false)
      setNote('')
    } catch {
      // The caller surfaces the reason (the page's shared error line); keeping
      // the draft is this component's whole job here.
    } finally {
      setSending(false)
    }
  }

  if (composing) {
    return (
      <span className="wait-question-composer">
        <textarea
          className="wait-sendback-note"
          rows={2}
          autoFocus
          placeholder="What do you need to know?"
          aria-label={`Question for ${requesterName}`}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <span className="wait-sendback-composer-actions">
          <button
            type="button"
            className="waiting-blocker-question"
            disabled={busy || sending || trimmed === ''}
            title={
              trimmed === ''
                ? 'Type your question first'
                : `Send this to ${requesterName}. It does not finish the wait — it stays with you.`
            }
            onClick={() => void send()}
          >
            Send
          </button>
          <button
            type="button"
            className="waiting-blocker-cancel-sendback"
            disabled={busy || sending}
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
    <button
      type="button"
      className="waiting-blocker-question"
      disabled={busy}
      title={
        busy
          ? 'Working on it — one moment…'
          : `Ask ${requesterName} something before you finish. This does NOT mark it done — the wait stays with you.`
      }
      onClick={() => setComposing(true)}
    >
      Question
    </button>
  )
}
