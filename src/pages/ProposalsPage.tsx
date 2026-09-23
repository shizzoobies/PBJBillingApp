import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAppContext } from '../AppContext'
import { formatProposalMoney } from '../../lib/proposal-pricing.js'
import { createProposalRequest, listProposalsRequest } from '../lib/api'
import { PROPOSAL_STATUS_LABELS, proposalDate, proposalTitle } from '../lib/proposals'
import { ApiError, type Proposal, type ProposalStatus } from '../lib/types'

const STATUSES = Object.keys(PROPOSAL_STATUS_LABELS) as ProposalStatus[]

/**
 * Proposals (featreq-311473e2) — the list. Replaces the Engagements
 * placeholder in the owner's sidebar. Every prospect's estimate is saved here,
 * declined ones included, so a prospect who comes back next year is reopened
 * as a copy rather than started from zero.
 */
export function ProposalsPage() {
  const { ownerMode } = useAppContext()
  const navigate = useNavigate()
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState<'all' | ProposalStatus>('all')
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    if (!ownerMode) return
    let cancelled = false
    void listProposalsRequest()
      .then((rows) => {
        if (cancelled) return
        setProposals(rows)
        setLoaded(true)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof ApiError ? err.message : 'Could not load proposals.')
        setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [ownerMode])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return proposals
      .filter((proposal) => status === 'all' || proposal.status === status)
      .filter(
        (proposal) =>
          !needle ||
          [proposal.prospect.company, proposal.prospect.contactName, proposal.prospect.email].some(
            (value) => value.toLowerCase().includes(needle),
          ),
      )
  }, [proposals, status, query])

  const startNew = async () => {
    setCreating(true)
    setError('')
    try {
      const created = await createProposalRequest({})
      navigate(`/proposals/${created.id}`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start a proposal.')
      setCreating(false)
    }
  }

  return (
    <section className="content-grid" id="proposals">
      <div className="panel">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Engagements</p>
            <h2>Proposals</h2>
            <p className="section-subtitle">
              Every prospect’s estimate, letter and outcome — saved, so you can reopen it later.
            </p>
          </div>
          <button
            className="primary-action"
            type="button"
            disabled={creating}
            onClick={() => void startNew()}
          >
            New proposal
          </button>
        </div>

        <div className="form-grid two-col">
          <label className="field">
            <span>Status</span>
            <select
              className="input"
              aria-label="Status filter"
              value={status}
              onChange={(event) => setStatus(event.target.value as 'all' | ProposalStatus)}
            >
              <option value="all">All</option>
              {STATUSES.map((value) => (
                <option key={value} value={value}>
                  {PROPOSAL_STATUS_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Search</span>
            <input
              className="input"
              type="search"
              aria-label="Search proposals"
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

        {loaded && visible.length === 0 ? (
          <p className="muted-text">
            {proposals.length === 0
              ? 'No proposals yet — start one with New proposal.'
              : 'No proposals match.'}
          </p>
        ) : null}

        {visible.length > 0 ? (
          <div className="table-wrap">
            <table className="report-table">
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Contact</th>
                  <th>Status</th>
                  <th>Monthly</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((proposal) => (
                  <tr key={proposal.id}>
                    <td>
                      <Link to={`/proposals/${proposal.id}`}>{proposalTitle(proposal)}</Link>
                    </td>
                    <td>{proposal.prospect.contactName}</td>
                    <td>
                      <span className="status-pill">{PROPOSAL_STATUS_LABELS[proposal.status]}</span>
                    </td>
                    <td>{formatProposalMoney(proposal.pricingSnapshot?.totals.monthly ?? 0)}</td>
                    <td>{proposalDate(proposal.updatedAt ?? proposal.createdAt)}</td>
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
