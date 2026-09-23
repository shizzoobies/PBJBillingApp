import type { Proposal } from '../../lib/types'

/** The Letter tab: the saved letter text, read-only. */
export function LetterTab({ proposal }: { proposal: Proposal }) {
  return (
    <section className="panel">
      <h3>Letter</h3>
      {proposal.letter?.text ? (
        <pre className="proposal-letter-text">{proposal.letter.text}</pre>
      ) : (
        <p className="muted-text">No letter yet — it is drafted from this estimate.</p>
      )}
    </section>
  )
}
