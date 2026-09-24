import { useState, type FormEvent } from 'react'
import { ApiError, type Proposal } from '../../lib/types'

/**
 * The intake chat (spec §5.2), beside the estimate. Each turn goes through
 * `onSend`, which the page runs in its own save queue (the same one a manual
 * edit uses) so a turn and a save can never race each other or clobber the
 * proposal the other one just wrote. The textarea clears, and the turn shows
 * up in the transcript below, only once that promise resolves — a rejection
 * leaves the draft text in place so nothing typed is lost. Prices come from
 * the estimate, never from the AI.
 */
export function ChatPanel({
  proposal,
  onSend,
}: {
  proposal: Proposal
  onSend: (text: string) => Promise<void>
}) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const locked = proposal.status === 'accepted' || proposal.status === 'declined'

  const send = async (event: FormEvent) => {
    event.preventDefault()
    const message = text.trim()
    if (!message) return
    setSending(true)
    setError('')
    try {
      await onSend(message)
      setText('')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The AI could not answer right now.')
    } finally {
      setSending(false)
    }
  }

  return (
    <section className="panel proposal-chat">
      <h3>Intake chat</h3>
      <p className="muted-text">
        Tell it about the prospect; it asks for the counts and fills in the estimate as you go.
        Prices come from the estimate, never from the AI.
      </p>
      <ol className="proposal-transcript">
        {proposal.messages.map((message, index) => (
          <li key={`${message.at}-${index}`} className={`proposal-turn is-${message.role}`}>
            <strong>{message.role === 'user' ? 'You' : 'Assistant'}:</strong> {message.text}
          </li>
        ))}
      </ol>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <form className="proposal-chat-form" onSubmit={(event) => void send(event)}>
        <textarea
          className="input"
          aria-label="Message to the intake assistant"
          rows={3}
          value={text}
          disabled={locked || sending}
          onChange={(event) => setText(event.target.value)}
        />
        <button
          type="submit"
          className="primary-action"
          disabled={locked || sending || !text.trim()}
        >
          {sending ? 'Thinking…' : 'Send'}
        </button>
      </form>
    </section>
  )
}
