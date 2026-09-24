import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useAppContext } from '../AppContext'
import { ActivityTab } from '../components/proposals/ActivityTab'
import { ChatPanel } from '../components/proposals/ChatPanel'
import { EstimateTab } from '../components/proposals/EstimateTab'
import { LetterTab } from '../components/proposals/LetterTab'
import { workableClients } from '../lib/clientLifecycle'
import { defaultProposalPricing, formatProposalMoney } from '../../lib/proposal-pricing.js'
import {
  acceptProposalRequest,
  copyProposalRequest,
  declineProposalRequest,
  deleteProposalRequest,
  draftProposalLetterRequest,
  fetchFirmSettings,
  getProposalRequest,
  listPackagesRequest,
  proposalChatRequest,
  repriceProposalRequest,
  sendProposalRequest,
  updateProposalRequest,
  type ProposalChatResult,
} from '../lib/api'
import {
  PROPOSAL_STATUS_LABELS,
  PROPOSAL_TABS,
  changedKeys,
  proposalTitle,
  resolveProposalTab,
  type ProposalPatchBuilder,
  type ProposalTab,
} from '../lib/proposals'
import { ApiError, type Package, type Proposal, type ProposalPricing } from '../lib/types'

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
  // Not a failure — a quiet notice for something Accept did that is still
  // worth a look (a chosen package that could not be applied), held apart
  // from `error` so it never renders in the alarm styling.
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [packages, setPackages] = useState<Package[]>([])
  const [packageId, setPackageId] = useState('')
  const [highlight, setHighlight] = useState<ReadonlySet<string>>(new Set())

  // Packages are endpoint-managed; Accept can apply one. A failed list just
  // means Accept offers none.
  useEffect(() => {
    let cancelled = false
    void listPackagesRequest()
      .then((rows) => {
        if (!cancelled) setPackages(rows)
      })
      .catch(() => {
        if (!cancelled) setPackages([])
      })
    return () => {
      cancelled = true
    }
  }, [])

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

  // Proposals are endpoint-managed — never inside `data` — but a `data`
  // reference change is still this page's one signal that something on the
  // server may have moved (another tab's edit, a delivery webhook landing),
  // the same broadcast every page's `data` read reacts to. Refetch only when
  // the save queue is idle (`pendingRef`, not `busy` — this effect must fire
  // on a `data` change, not merely because `busy` later flips back to false)
  // so a broadcast can never race a save in flight, and apply through the
  // same stale-id guard `enqueue` uses (item 5, final fix wave).
  const skippedFirstBroadcastRef = useRef(false)
  useEffect(() => {
    if (!skippedFirstBroadcastRef.current) {
      skippedFirstBroadcastRef.current = true
      return
    }
    if (pendingRef.current > 0) return
    let cancelled = false
    void getProposalRequest(proposalId)
      .then((loaded) => {
        if (cancelled || loaded.id !== proposalId) return
        latestRef.current = loaded
        setProposal(loaded)
      })
      .catch(() => {
        /* transient — her own next save, or the next broadcast, retries */
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

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
          // `sendChat` swallows its own rejection and hands back `current`
          // UNCHANGED so this try/catch stays quiet (see its own comment) —
          // that is the one case `response` is the very object passed in,
          // and a failed chat turn must not clear an unrelated page error
          // (item 8, final fix wave).
          if (response !== current) setError('')
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
    // Her own edit ends the "what the chat just changed" marking.
    setHighlight(new Set())
    enqueue((latest) => updateProposalRequest(proposalId, build(latest)))
  }
  const reprice = () => {
    // A reprice is her own action ending the "what the chat just changed"
    // marking, same as a manual save.
    setHighlight(new Set())
    enqueue(() => repriceProposalRequest(proposalId))
  }

  /**
   * A chat turn runs through the SAME queue as a manual save (fix batch 3,
   * item 2) — the server applies the patch to whatever it reads at that
   * point, never to a copy this page hands it. ChatPanel gets its own error
   * display (right next to the textarea), so a failed turn is handled here
   * without touching the page-level `error` banner: the action catches its
   * own rejection and hands back `latest` unchanged, keeping `enqueue`'s own
   * try/catch quiet. The promise ChatPanel awaits is separate from that —
   * settled from inside the action — so it can show the error and only clear
   * the textarea on success.
   */
  const sendChat = (text: string) =>
    new Promise<void>((resolve, reject) => {
      enqueue(async (latest) => {
        try {
          const result: ProposalChatResult = await proposalChatRequest(proposalId, text)
          setHighlight(changedKeys(result.applied))
          resolve()
          return result.proposal
        } catch (err) {
          reject(err)
          return latest
        }
      })
    })

  /**
   * Send the letter (Important 1, final fix wave). A `stale_letter_figures`
   * 409 means the estimate changed since this letter was drafted — the
   * message names the figures; a yes on the confirm resends with
   * `confirmStaleFigures: true` so the same send is not asked twice.
   */
  const sendLetter = (to: string) =>
    enqueue(async () => {
      try {
        return await sendProposalRequest(proposalId, to)
      } catch (err) {
        if (err instanceof ApiError && err.code === 'stale_letter_figures' && window.confirm(err.message)) {
          return await sendProposalRequest(proposalId, to, { confirmStaleFigures: true })
        }
        throw err
      }
    })

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

  /** A toast/notice on the accepted result — the package could not be applied. */
  const noticeFromAccept = (chosenPackage: string | null, packageApplied: boolean) =>
    chosenPackage && !packageApplied
      ? "Accepted, but the package could not be applied — add it from the client's page."
      : ''

  // Accept says what it will do before it does it (spec §5.5). A prospect
  // becomes a client; an existing client's fee moves only on a second yes —
  // unless there is no fee to move: a $0 snapshot or a client not on
  // subscription billing skips that second question and sends
  // `updateMonthlyRate: false` outright, rather than asking about a fee the
  // accept would never actually change.
  const accept = () => {
    if (!proposal) return
    const monthly = formatProposalMoney(proposal.pricingSnapshot?.totals.monthly ?? 0)
    const chosenPackage = packageId || null
    if (!proposal.clientId) {
      const ok = window.confirm(
        `Accept this proposal? This adds ${proposalTitle(proposal)} as a client in Onboarding, ` +
          `billed monthly at ${monthly}. Nothing about any invoice changes.`,
      )
      if (!ok) return
      enqueue(async () => {
        const result = await acceptProposalRequest(proposalId, { packageId: chosenPackage })
        setNotice(noticeFromAccept(chosenPackage, result.packageApplied))
        return result.proposal
      })
      return
    }
    const client = data.clients.find((entry) => entry.id === proposal.clientId)
    const clientName = client?.name ?? 'this client'
    if (!window.confirm(`Accept this proposal for ${clientName}?`)) return
    const monthlyTotal = proposal.pricingSnapshot?.totals.monthly ?? 0
    const skipRateQuestion = monthlyTotal === 0 || client?.billingMode !== 'subscription'
    const updateMonthlyRate = skipRateQuestion
      ? false
      : window.confirm(`Also change ${clientName}’s monthly fee to ${monthly}? Cancel keeps their current fee.`)
    enqueue(async () => {
      const result = await acceptProposalRequest(proposalId, { packageId: chosenPackage, updateMonthlyRate })
      setNotice(noticeFromAccept(chosenPackage, result.packageApplied))
      return result.proposal
    })
  }

  const decline = () => {
    const note = window.prompt('Why did they decline? (optional — saved on the proposal)', '')
    if (note === null) return
    enqueue(() => declineProposalRequest(proposalId, note))
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
          {proposal.status === 'draft' || proposal.status === 'sent' ? (
            <>
              <select
                className="input"
                aria-label="Package to apply on accept"
                value={packageId}
                onChange={(event) => setPackageId(event.target.value)}
              >
                <option value="">No package</option>
                {packages.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>
              <button type="button" className="primary-action" disabled={busy} onClick={accept}>
                Accept
              </button>
              <button type="button" className="ghost-action" disabled={busy} onClick={decline}>
                Decline
              </button>
            </>
          ) : null}
          {proposal.status === 'accepted' && proposal.clientId ? (
            <Link className="secondary-action" to={`/clients/${proposal.clientId}`}>
              Open the client
            </Link>
          ) : null}
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
      {notice ? <p className="empty-state">{notice}</p> : null}

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
        <div className="proposal-estimate-layout">
          <ChatPanel proposal={proposal} onSend={sendChat} />
          <EstimateTab
            proposal={proposal}
            pricing={pricing}
            // Never a billing master (no engagement of its own) and never a
            // retired one — the same two exclusions every other client
            // picker makes (item 6, final fix wave). `proposal.clientId`
            // stays offered even if it became one of those after the fact,
            // so the select never renders a value that matches no option.
            clients={workableClients(data.clients, [proposal.clientId])}
            busy={busy}
            highlight={highlight}
            onSave={save}
            onReprice={reprice}
          />
        </div>
      ) : null}
      {tab === 'letter' ? (
        <LetterTab
          proposal={proposal}
          busy={busy}
          onDraft={() => enqueue(() => draftProposalLetterRequest(proposalId))}
          onSaveText={(text) => save(() => ({ letterText: text }))}
          onSend={sendLetter}
        />
      ) : null}
      {tab === 'activity' ? <ActivityTab proposal={proposal} /> : null}
    </section>
  )
}
