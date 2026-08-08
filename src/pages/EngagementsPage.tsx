import { Handshake } from 'lucide-react'
import { Link } from 'react-router-dom'

/**
 * Engagements — placeholder.
 *
 * The section exists in the sidebar before anything lives in it, deliberately:
 * Brittany asked to see that it is coming rather than have a new heading appear
 * one day without warning. It fills up in P2 (public intake form → Proposals
 * inbox) and P3 (proposal builder; accepting auto-fills the Client + Contacts),
 * per docs/plans/billing-and-engagements-2026-08.md.
 *
 * Written to be honest about what is and is not built — an empty page that
 * implies a broken feature is worse than one that says "not yet".
 */
export function EngagementsPage() {
  return (
    <section className="content-grid" id="engagements">
      <div className="panel">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Coming soon</p>
            <h2>Engagements</h2>
            <p className="section-subtitle">
              This is where winning new work will live — before a client becomes a client.
            </p>
          </div>
        </div>

        <div className="under-construction">
          <Handshake size={40} aria-hidden="true" />
          <h3>We&apos;re building this now</h3>
          <p>
            Nothing here yet — this section is visible so you know it&apos;s on the way rather
            than appearing out of nowhere. Two pieces are planned:
          </p>
          <ul>
            <li>
              <strong>Intake form</strong> — a link you can send a prospect. What they fill in
              comes straight back here, so nobody re-types it.
            </li>
            <li>
              <strong>Proposals</strong> — build the proposal from that intake, and when they
              accept it creates the client and contacts for you, already filled in.
            </li>
          </ul>
          <p>
            In-app invoicing is being built first. Until this is ready, keep adding clients
            on the <Link to="/clients">Clients</Link> page as you do today — nothing about
            that changes.
          </p>
          <p className="under-construction-note">
            Got a thought on how you&apos;d want intake to work? Put it on{' '}
            <Link to="/updates">Updates</Link> and it&apos;ll be waiting when this gets built.
          </p>
        </div>
      </div>
    </section>
  )
}
