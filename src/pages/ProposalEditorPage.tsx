import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useAppContext } from '../AppContext'
import { ActivityTab } from '../components/proposals/ActivityTab'
import { EstimateTab } from '../components/proposals/EstimateTab'
import { LetterTab } from '../components/proposals/LetterTab'
import { defaultProposalPricing } from '../../lib/proposal-pricing.js'
import {
  copyProposalRequest,
  deleteProposalRequest,
  fetchFirmSettings,
  getProposalRequest,
  repriceProposalRequest,
  updateProposalRequest,
} from '../lib/api'
import {
  PROPOSAL_STATUS_LABELS,
  PROPOSAL_TABS,
  proposalTitle,
  resolveProposalTab,
  type ProposalTab,
} from '../lib/proposals'
import { ApiError, type Proposal, type ProposalPatch, type ProposalPricing } from '../lib/types'

/**
 * One proposal (spec §5.1): Estimate, Letter and Activity tabs, the tab in
 * `?tab=` like the client page, and the header actions. The proposal on screen
 * is always the server's latest answer — every save swaps it in whole.
 */
export function ProposalEditorPage() {
  const { proposalId = '' } = useParams()
  const { data } = useAppContext()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [pricing, setPricing] = useState<ProposalPricing | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void Promise.all([getProposalRequest(proposalId), fetchFirmSettings()])
      .then(([loaded, firm]) => {
        if (cancelled) return
        setProposal(loaded)
        setPricing(firm.proposalPricing ?? defaultProposalPricing())
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : 'Could not load this proposal.')
        }
      })
    return () => {
      cancelled = true
    }
  }, [proposalId])

  const run = async (action: () => Promise<Proposal>) => {
    setBusy(true)
    setError('')
    try {
      setProposal(await action())
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That did not save — try again.')
    } finally {
      setBusy(false)
    }
  }
  const save = (patch: ProposalPatch) => {
    void run(() => updateProposalRequest(proposalId, patch))
  }

  const tab = resolveProposalTab(searchParams.get('tab'))
  const setTab = (next: ProposalTab) => {
    const params = new URLSearchParams(searchParams)
    params.set('tab', next)
    setSearchParams(params, { replace: true })
  }

  const copy = async () => {
    setBusy(true)
    setError('')
    try {
      const created = await copyProposalRequest(proposalId)
      navigate(`/proposals/${created.id}`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not copy this proposal.')
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!window.confirm('Delete this draft? This cannot be undone.')) return
    setBusy(true)
    setError('')
    try {
      await deleteProposalRequest(proposalId)
      navigate('/proposals')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete this proposal.')
      setBusy(false)
    }
  }

  if (!proposal || !pricing) {
    return (
      <section className="panel">
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : (
          <p>Loading the proposal…</p>
        )}
      </section>
    )
  }

  return (
    <section className="content-grid proposal-editor">
      <header className="client-detail-header">
        <div>
          <p className="section-kicker">
            <Link to="/proposals">Proposals</Link>
          </p>
          <h1>{proposalTitle(proposal)}</h1>
          <span className="status-pill">{PROPOSAL_STATUS_LABELS[proposal.status]}</span>
        </div>
        <div className="button-row">
          <button type="button" className="secondary-action" disabled={busy} onClick={() => void copy()}>
            Copy to new proposal
          </button>
          {proposal.status === 'draft' ? (
            <button type="button" className="ghost-action" disabled={busy} onClick={() => void remove()}>
              Delete
            </button>
          ) : null}
        </div>
      </header>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="task-area-tabs" role="tablist" aria-label="Proposal sections">
        {PROPOSAL_TABS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={entry.key === tab}
            className={`task-area-tab${entry.key === tab ? ' is-active' : ''}`}
            onClick={() => setTab(entry.key)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tab === 'estimate' ? (
        <EstimateTab
          proposal={proposal}
          pricing={pricing}
          clients={data.clients}
          busy={busy}
          onSave={save}
          onReprice={() => void run(() => repriceProposalRequest(proposalId))}
        />
      ) : null}
      {tab === 'letter' ? <LetterTab proposal={proposal} /> : null}
      {tab === 'activity' ? <ActivityTab proposal={proposal} /> : null}
    </section>
  )
}
