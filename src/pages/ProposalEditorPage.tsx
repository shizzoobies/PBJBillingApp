import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useAppContext } from '../AppContext'
import { ActivityTab } from '../components/proposals/ActivityTab'
import { EstimateTab } from '../components/proposals/EstimateTab'
import { LetterTab } from '../components/proposals/LetterTab'
import { defaultProposalPricing } from '../../lib/proposal-pricing.js'
import {
  copyProposalRequest,
  deleteProposalRequest,
  draftProposalLetterRequest,
  fetchFirmSettings,
  getProposalRequest,
  repriceProposalRequest,
  sendProposalRequest,
  updateProposalRequest,
} from '../lib/api'
import {
  PROPOSAL_STATUS_LABELS,
  PROPOSAL_TABS,
  proposalTitle,
  resolveProposalTab,
  type ProposalPatchBuilder,
  type ProposalTab,
} from '../lib/proposals'
import { ApiError, type Proposal, type ProposalPricing } from '../lib/types'

/**
 * Keyed on the proposal id (review M1): a Copy navigation swaps the URL to a
 * new proposal without unmounting the route, and every bit of state below —
 * the loaded proposal, the save queue, the latest-known snapshot — belongs to
 * ONE proposal. Remounting on a new id is simpler and safer than resetting
 * each ref and state variable by hand.
 */
export function ProposalEditorPage() {
  const { proposalId = '' } = useParams()
  return <ProposalEditor key={proposalId} proposalId={proposalId} />
}

/**
 * One proposal (spec §5.1): Estimate, Letter and Activity tabs, the tab in
 * `?tab=` like the client page, and the header actions. The proposal on screen
 * is always the server's latest CONFIRMED answer — every save swaps it in
 * whole, and saves are serialized through one queue (review C1) so a save
 * queued behind another is always built from what that one produced, never
 * from a stale render.
 */
function ProposalEditor({ proposalId }: { proposalId: string }) {
  const { data } = useAppContext()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [pricing, setPricing] = useState<ProposalPricing | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // The last server-CONFIRMED proposal. A queued save's patch is built from
  // this, not from `proposal` as it stood when the save was requested.
  const latestRef = useRef<Proposal | null>(null)
  // Every save (and reprice) chains onto this so they run — and their
  // responses apply — strictly in the order they were requested.
  const queueRef = useRef<Promise<unknown>>(Promise.resolve())
  const pendingRef = useRef(0)

  const beginBusy = () => {
    pendingRef.current += 1
    setBusy(true)
  }
  const endBusy = () => {
    pendingRef.current = Math.max(0, pendingRef.current - 1)
    if (pendingRef.current === 0) setBusy(false)
  }

  useEffect(() => {
    let cancelled = false
    void Promise.all([getProposalRequest(proposalId), fetchFirmSettings()])
      .then(([loaded, firm]) => {
        if (cancelled) return
        latestRef.current = loaded
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

  /**
   * Queue one server round trip. `action` is called with the latest
   * CONFIRMED proposal only once every save ahead of it has applied its
   * response, and its own response is ignored if it names a different
   * proposal (a stale request landing after a navigation).
   */
  const enqueue = (action: (latest: Proposal) => Promise<Proposal>) => {
    beginBusy()
    const previous = queueRef.current
    // Wrap the WHOLE body in try/finally, including the `current` guard —
    // an early return there used to skip endBusy() and leave busy stuck on
    // (fix batch 2, E-b).
    const run = previous.then(async () => {
      try {
        const current = latestRef.current
        if (!current) return
        const response = await action(current)
        // Drop a response for a proposal that is no longer the one on
        // screen — a Copy navigated away while this save was still in
        // flight (fix batch 2, E-c).
        if (response.id === proposalId) {
          latestRef.current = response
          setProposal(response)
          setError('')
        }
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'That did not save — try again.')
      } finally {
        endBusy()
      }
    })
    queueRef.current = run
  }

  const save = (build: ProposalPatchBuilder) => {
    enqueue((latest) => updateProposalRequest(proposalId, build(latest)))
  }
  const reprice = () => {
    enqueue(() => repriceProposalRequest(proposalId))
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
      // Wait for any save already in flight so the copy carries what it
      // produced, rather than the state as it stood before that save landed
      // (fix batch 2, E-a).
      await queueRef.current
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
      // Wait for any save already in flight so it cannot land after the
      // delete (fix batch 2, E-a).
      await queueRef.current
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
          <>
            <p className="form-error" role="alert">
              {error}
            </p>
            <p>
              <Link to="/proposals">Back to proposals</Link>
            </p>
          </>
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
          onReprice={reprice}
        />
      ) : null}
      {tab === 'letter' ? (
        <LetterTab
          proposal={proposal}
          busy={busy}
          onDraft={() => enqueue(() => draftProposalLetterRequest(proposalId))}
          onSaveText={(text) => save(() => ({ letterText: text }))}
          onSend={(to) => enqueue(() => sendProposalRequest(proposalId, to))}
        />
      ) : null}
      {tab === 'activity' ? <ActivityTab proposal={proposal} /> : null}
    </section>
  )
}
