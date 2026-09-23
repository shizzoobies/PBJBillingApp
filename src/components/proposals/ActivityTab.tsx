import { Link } from 'react-router-dom'
import { proposalActivity, proposalDate } from '../../lib/proposals'
import type { Proposal } from '../../lib/types'

/** The Activity tab (spec §5.1): sends, delivery, status changes, and the intake chat. */
export function ActivityTab({ proposal }: { proposal: Proposal }) {
  return (
    <div className="proposal-activity">
      <section className="panel">
        <h3>What happened</h3>
        <ul className="proposal-activity-list">
          {proposalActivity(proposal).map((entry, index) => (
            <li key={`${entry.at}-${index}`}>
              <span className="muted-text">{proposalDate(entry.at)}</span>{' '}
              {entry.href ? <Link to={entry.href}>{entry.text}</Link> : entry.text}
            </li>
          ))}
        </ul>
      </section>
      <section className="panel">
        <h3>Intake conversation</h3>
        {proposal.messages.length === 0 ? (
          <p className="muted-text">No conversation yet.</p>
        ) : (
          <ol className="proposal-transcript">
            {proposal.messages.map((message, index) => (
              <li key={`${message.at}-${index}`} className={`proposal-turn is-${message.role}`}>
                <strong>{message.role === 'user' ? 'You' : 'Assistant'}:</strong> {message.text}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  )
}
