import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAppContext } from '../AppContext'
import { listEngagementsRequest } from '../lib/api'
import {
  ENGAGEMENT_KIND_LABELS,
  ENGAGEMENT_STATUSES,
  ENGAGEMENT_STATUS_LABELS,
  engagementInstantLabel,
  engagementMonthlyFee,
  engagementPartyName,
} from '../lib/engagements'
import { ENGAGEMENT_LIST_LIMIT } from '../../lib/engagement-list-limit.js'
import { ApiError, type Engagement, type EngagementKind, type EngagementStatus } from '../lib/types'

/**
 * Engagements (docs/plans/engagements-2026-10.md, stage 2C): every engagement
 * letter, newest first, filtered by status and kind. There is no "New" button: an
 * engagement is drafted when a proposal is accepted, recorded for each Letters send,
 * or started from a client's Billing tab (stage 4). A row opens the editor.
 */
export function EngagementsPage() {
  const { ownerMode, dataRefreshCount } = useAppContext()
  const [engagements, setEngagements] = useState<Engagement[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState<'all' | EngagementStatus>('all')
  // Stage 4: originals, amendments (each Letters send is one) and superseding letters.
  const [kind, setKind] = useState<'all' | EngagementKind>('all')
  const [query, setQuery] = useState('')

  // The list for the chosen status and kind (the server filters, then keeps the newest 500, so
  // a filter reaches letters older than the 500th); again when another tab or session changes data.
  useEffect(() => {
    if (!ownerMode) return
    let cancelled = false
    void listEngagementsRequest({
      ...(status === 'all' ? {} : { status }),
      ...(kind === 'all' ? {} : { kind }),
    })
      .then((rows) => {
        if (cancelled) return
        setEngagements(rows)
        setError('')
        setLoaded(true)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof ApiError ? err.message : 'Could not load the engagements.')
        setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [ownerMode, dataRefreshCount, status, kind])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return engagements
      .filter((engagement) => status === 'all' || engagement.status === status)
      .filter((engagement) => kind === 'all' || engagement.kind === kind)
      .filter(
        (engagement) =>
          !needle ||
          [engagement.party?.company, engagement.party?.contactName, engagement.party?.email].some((value) =>
            String(value ?? '').toLowerCase().includes(needle),
          ),
      )
  }, [engagements, status, kind, query])

  if (!ownerMode) return null

  return (
    <section className="content-grid" id="engagements">
      <div className="panel">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Engagements</p>
            <h2>Engagements</h2>
            <p className="section-subtitle">
              The engagement letter for each Won proposal: edit it, send it to the client, and mark it signed when it
              comes back.
            </p>
          </div>
        </div>

        <div className="form-grid two-col">
          <label className="field">
            <span>Status</span>
            <select
              className="input"
              aria-label="Status filter"
              value={status}
              onChange={(event) => setStatus(event.target.value as 'all' | EngagementStatus)}
            >
              <option value="all">All</option>
              {ENGAGEMENT_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {ENGAGEMENT_STATUS_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Kind</span>
            <select
              className="input"
              aria-label="Kind filter"
              value={kind}
              onChange={(event) => setKind(event.target.value as 'all' | EngagementKind)}
            >
              <option value="all">All</option>
              {(Object.keys(ENGAGEMENT_KIND_LABELS) as EngagementKind[]).map((value) => (
                <option key={value} value={value}>
                  {ENGAGEMENT_KIND_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Search</span>
            <input
              className="input"
              type="search"
              aria-label="Search engagements"
              placeholder="Company, contact or email"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>

        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}

        {engagements.length >= ENGAGEMENT_LIST_LIMIT ? (
          <p className="muted-text" role="status">
            {`Showing the newest ${ENGAGEMENT_LIST_LIMIT} - narrow the filter to see older ones`}
          </p>
        ) : null}

        {loaded && !error && visible.length === 0 ? (
          <p className="empty-state">
            {engagements.length === 0 && status === 'all' && kind === 'all'
              ? "No engagements yet. An engagement letter is drafted for you when you Accept a proposal, each Letters send is recorded as an amendment, and an amendment can be started from a client's Billing tab; open one here to edit and send it."
              : 'No engagements match.'}
          </p>
        ) : null}

        {visible.length > 0 ? (
          <div className="table-wrap">
            <table className="report-table">
              <thead>
                <tr>
                  <th>Party</th>
                  <th>Kind</th>
                  <th>Status</th>
                  <th>Monthly fee</th>
                  <th>Sent</th>
                  <th>Signed</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((engagement) => (
                  <tr key={engagement.id}>
                    <td>
                      <Link to={`/engagements/${engagement.id}`}>{engagementPartyName(engagement)}</Link>
                      {engagement.party?.contactName && engagement.party?.company ? (
                        <div className="muted-text">{engagement.party.contactName}</div>
                      ) : null}
                    </td>
                    <td>{ENGAGEMENT_KIND_LABELS[engagement.kind] ?? engagement.kind}</td>
                    <td>
                      <span className="status-pill">{ENGAGEMENT_STATUS_LABELS[engagement.status] ?? engagement.status}</span>
                    </td>
                    <td>{engagementMonthlyFee(engagement)}</td>
                    <td>{engagementInstantLabel(engagement.sentAt) || '-'}</td>
                    <td>{engagementInstantLabel(engagement.signedAt) || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </section>
  )
}
