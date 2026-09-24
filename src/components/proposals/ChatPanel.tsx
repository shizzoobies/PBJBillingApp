import { useState, type FormEvent } from 'react'
import { proposalChatRequest, type ProposalChatResult } from '../../lib/api'
import { ApiError, type Proposal } from '../../lib/types'

/**
 * The intake chat (spec §5.2), beside the estimate. Each turn goes to the
 * server, which applies only the validated patch and re-prices — the page
 * swaps in the proposal it answers with. Prices come from the estimate, never
 * from the AI.
 */
export function ChatPanel({
  proposal,
  onReply,
}: {
  proposal: Proposal
  onReply: (result: ProposalChatResult) => void
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
      const result = await proposalChatRequest(proposal.id, message)
      setText('')
      onReply(result)
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
