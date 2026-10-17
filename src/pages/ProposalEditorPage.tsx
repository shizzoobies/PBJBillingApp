import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useAppContext } from '../AppContext'
import { ActivityTab } from '../components/proposals/ActivityTab'
import { ChatPanel } from '../components/proposals/ChatPanel'
import { EstimateTab } from '../components/proposals/EstimateTab'
import { LetterTab } from '../components/proposals/LetterTab'
import { workableClients } from '../lib/clientLifecycle'
import { partyRecipientDetails } from '../../lib/invoice-recipients.js'
import { engagementInstantLabel, refusedEngagementId } from '../lib/engagements'
import {
  PROPOSAL_NOT_PRICED_MESSAGE,
  defaultProposalPricing,
  formatProposalMoney,
  unpricedProposalLines,
} from '../../lib/proposal-pricing.js'
import {
  acceptProposalRequest,
  copyProposalRequest,
  declineProposalRequest,
  deleteProposalRequest,
  draftProposalEngagementRequest,
  draftProposalLetterRequest,
  fetchFirmSettings,
  getProposalRequest,
  listEngagementsRequest,
  listPackagesRequest,
  listQuestionnairesRequest,
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
  snapshotRatesDiffer,
  type ProposalPatchBuilder,
  type ProposalTab,
} from '../lib/proposals'
import {
  ApiError,
  type Engagement,
  type Package,
  type Proposal,
  type ProposalPricing,
  type ProposalQuestionnaire,
} from '../lib/types'

/** The sentence every Accept confirm carries (engagements stage 2). */
const ENGAGEMENT_DRAFTED = 'An engagement letter will be drafted for you to edit and send.'

/** "A", "A and B", "A, B and C". */
function listWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

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
  const { data, dataRefreshCount } = useAppContext()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [pricing, setPricing] = useState<ProposalPricing | null>(null)
  const [error, setError] = useState('')
  // Not a failure — a quiet notice for something Accept did that is still
  // worth a look (a chosen package that could not be applied), held apart
  // from `error` so it never renders in the alarm styling.
  const [notice, setNotice] = useState('')
  // The engagement Accept drafted, linked from the notice when there is one to read first.
  const [noticeEngagementId, setNoticeEngagementId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [packages, setPackages] = useState<Package[]>([])
  const [packageId, setPackageId] = useState('')
  // Individual plans for the engagement (applied when it is signed), on top of any package (featreq-98527217).
  const [planPickIds, setPlanPickIds] = useState<string[]>([])
  const [plansOpen, setPlansOpen] = useState(false)
  const plansMenuRef = useRef<HTMLDivElement | null>(null)

  // Close the Plans picker on a click outside it or on Escape.
  useEffect(() => {
    if (!plansOpen) return
    const onPointerDown = (event: MouseEvent) => {
      if (plansMenuRef.current?.contains(event.target as Node)) return
      setPlansOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPlansOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [plansOpen])
  const [highlight, setHighlight] = useState<ReadonlySet<string>>(new Set())
  // The questionnaire this draft was started from, shown read-only on the
  // Estimate tab (featreq-8f139178). A failed read just means no panel.
  const [questionnaire, setQuestionnaire] = useState<ProposalQuestionnaire | null>(null)

  // Packages are endpoint-managed; Accept puts one on the engagement. A failed list just
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

  useEffect(() => {
    let cancelled = false
    void listQuestionnairesRequest(proposalId)
      .then((rows) => {
        if (!cancelled) setQuestionnaire(rows.find((row) => row.status === 'submitted') ?? null)
      })
      .catch(() => {
        if (!cancelled) setQuestionnaire(null)
      })
    return () => {
      cancelled = true
    }
  }, [proposalId])

  // A Won proposal's engagement letter (docs/plans/engagements-2026-10.md): the
  // newest one that is not void, or null when it has none (then the page offers
  // to draft one). `undefined` = not looked up yet.
  const [engagement, setEngagement] = useState<Engagement | null | undefined>(undefined)
  const [draftingEngagement, setDraftingEngagement] = useState(false)
  const won = proposal?.status === 'accepted'
  // "Open the client" on a Won proposal: the client its signed engagement created
  // or updated (engagements stage 3), or the client the proposal is linked to (an
  // upsell's, one signing linked, or one a proposal Won before engagements created).
  const clientLinkId = !won
    ? null
    : (engagement?.status === 'signed' ? engagement.clientId : null) || (proposal?.clientId ?? null)
  useEffect(() => {
    if (!won) return
    let cancelled = false
    void listEngagementsRequest({ proposalId })
      .then((rows) => {
        if (!cancelled) setEngagement(rows.find((row) => row.status !== 'void') ?? null)
      })
      .catch(() => {
        // Unknown is not "none": offer nothing rather than a second draft.
        if (!cancelled) setEngagement(undefined)
      })
    return () => {
      cancelled = true
    }
    // dataRefreshCount: read again whenever another tab or session changes data (the letter
    // was drafted, sent or signed there), so the links here never show a stale answer.
  }, [won, proposalId, dataRefreshCount])

  // An upsell (engagements stage 4): the client's CURRENT signed engagement - its newest
  // signed original or superseding letter - which Accept can amend or supersede. Null
  // when it has none (or it could not be read: Accept then simply amends).
  const upsellClientId = proposal && !won && proposal.status !== 'declined' ? (proposal.clientId ?? null) : null
  const [currentSigned, setCurrentSigned] = useState<Engagement | null>(null)
  const [acceptMode, setAcceptMode] = useState<'amend' | 'supersede'>('amend')
  useEffect(() => {
    // No upsell: nothing to read (the choice only shows beside a client's proposal).
    if (!upsellClientId) return
    let cancelled = false
    void listEngagementsRequest({ clientId: upsellClientId, status: 'signed' })
      .then((rows) => {
        if (cancelled) return
        const current =
          rows
            .filter((row) => row.kind === 'original' || row.kind === 'superseding')
            .sort(
              // The server's order (currentSignedEngagement): newest signed, then newest created.
              (a, b) =>
                String(b.signedAt ?? '').localeCompare(String(a.signedAt ?? '')) ||
                String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')),
            )[0] ?? null
        setCurrentSigned(current)
        if (!current) setAcceptMode('amend')
      })
      .catch(() => {
        if (!cancelled) setCurrentSigned(null)
      })
    return () => {
      cancelled = true
    }
  }, [upsellClientId])

  /** "Draft the engagement" on a Won proposal that has none; one that exists already is opened. */
  const draftEngagement = async () => {
    setDraftingEngagement(true)
    setError('')
    try {
      const created = await draftProposalEngagementRequest(proposalId)
      navigate(`/engagements/${created.id}`)
    } catch (err) {
      const existing = refusedEngagementId(err)
      if (existing) {
        navigate(`/engagements/${existing}`)
        return
      }
      setError(err instanceof ApiError ? err.message : 'Could not draft the engagement letter.')
    } finally {
      setDraftingEngagement(false)
    }
  }

  // The last server-CONFIRMED proposal. A queued save's patch is built from
  // this, not from `proposal` as it stood when the save was requested.
  const latestRef = useRef<Proposal | null>(null)
  // Every save (and reprice) chains onto this so they run — and their
  // responses apply — strictly in the order they were requested.
  const queueRef = useRef<Promise<unknown>>(Promise.resolve())
  const pendingRef = useRef(0)
  // Bumped by every `beginBusy` (N1, final fix wave round 2): the broadcast
  // refetch below records this at the moment its GET is SENT and compares
  // again when the GET LANDS — a save that starts and finishes while that
  // GET is in flight must still drop the now-stale answer, even though
  // `pendingRef` is back to 0 by the time it arrives.
  const saveGenRef = useRef(0)

  const beginBusy = () => {
    pendingRef.current += 1
    saveGenRef.current += 1
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
  //
  // N1 (final fix wave round 2): idle is checked again when the GET LANDS,
  // not only when it was sent — `saveGenRef` (bumped by every `beginBusy`)
  // pins the generation at send time, so a save that starts and finishes
  // entirely while this GET is in flight still drops the now-stale answer,
  // rather than putting an older copy back over what that save just wrote.
  const skippedFirstBroadcastRef = useRef(false)
  useEffect(() => {
    if (!skippedFirstBroadcastRef.current) {
      skippedFirstBroadcastRef.current = true
      return
    }
    if (pendingRef.current > 0) return
    let cancelled = false
    const issuedGen = saveGenRef.current
    void getProposalRequest(proposalId)
      .then((loaded) => {
        if (
          cancelled ||
          loaded.id !== proposalId ||
          pendingRef.current !== 0 ||
          saveGenRef.current !== issuedGen
        ) {
          return
        }
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

  // Opening a DRAFT whose snapshot was priced at other rates than the
  // catalog's today (e.g. all $0, before the rates were set) reprices it
  // once, through the same path as "Reprice at today's catalog". Opening is
  // her action; a sent / accepted / declined proposal keeps its snapshot, and
  // a catalog change alone never touches one.
  const openCheckDoneRef = useRef(false)
  useEffect(() => {
    if (openCheckDoneRef.current || !proposal || !pricing) return
    openCheckDoneRef.current = true
    if (
      proposal.status === 'draft' &&
      proposal.pricingSnapshot?.rates &&
      snapshotRatesDiffer(
        proposal.pricingSnapshot.rates,
        pricing.rates,
        proposal.pricingSnapshot.lines,
        pricing.services,
      )
    ) {
      // Deferred a tick: `enqueue` sets state, which an effect body must not do
      // synchronously.
      queueMicrotask(() =>
        enqueue(async () => {
          const repriced = await repriceProposalRequest(proposalId)
          if (repriced.id === proposalId) setNotice('Repriced at today’s rates')
          return repriced
        }),
      )
    }
    // Once per open: the ref above, not the dependencies, is the guard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposal, pricing])

  const save = (build: ProposalPatchBuilder) => {
    // Her own edit ends the "what the chat just changed" marking.
    setHighlight(new Set())
    setNotice('')
    enqueue((latest) => updateProposalRequest(proposalId, build(latest)))
  }
  const reprice = () => {
    // A reprice is her own action ending the "what the chat just changed"
    // marking, same as a manual save.
    setHighlight(new Set())
    setNotice('')
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
   * `confirmStaleFigures: true` so the same send is not asked twice. An
   * `unpriced_lines` 409 (a line not yet priced would be left out of the
   * quote) is asked the same way and resent with `confirmUnpriced: true`;
   * each question is asked at most once per send.
   */
  const sendLetter = (to: string[], extra: string[]) =>
    enqueue(async () => {
      const confirmed: { confirmStaleFigures?: boolean; confirmUnpriced?: boolean } = {}
      // The recipient picker's choice; `extra` only when she added some (featreq-34627da1).
      const recipients = extra.length > 0 ? { to, extra } : { to }
      for (;;) {
        try {
          return Object.keys(confirmed).length === 0
            ? await sendProposalRequest(proposalId, recipients)
            : await sendProposalRequest(proposalId, recipients, { ...confirmed })
        } catch (err) {
          if (!(err instanceof ApiError)) throw err
          if (err.code === 'stale_letter_figures' && !confirmed.confirmStaleFigures && window.confirm(err.message)) {
            confirmed.confirmStaleFigures = true
            continue
          }
          if (err.code === 'unpriced_lines' && !confirmed.confirmUnpriced && window.confirm(err.message)) {
            confirmed.confirmUnpriced = true
            continue
          }
          throw err
        }
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

  /**
   * After Accept: straight to the engagement letter it drafted, carrying a notice
   * that says when the client side happens (engagements stage 3: at signing). With
   * no engagement drafted, the page stays and says so ("Draft the engagement").
   */
  const afterAccept = (result: { engagementId?: string | null; engagementError?: string | null }, signingNotice: string) => {
    if (result.engagementId) {
      navigate(`/engagements/${result.engagementId}`, { state: { notice: `Marked Won. ${signingNotice}` } })
      return
    }
    // The proposal is Won either way; say plainly that the letter is missing and why.
    const reason = (result.engagementError ?? '').trim().replace(/[.\s]+$/, '') || 'it could not be saved'
    setNotice(
      `Accepted - the engagement could not be drafted: ${reason}. Use Draft the engagement at the top of the page. The package and plans you picked are kept. ${signingNotice}`,
    )
    setNoticeEngagementId(null)
  }

  // Accept says what it will do before it does it (spec §5.5). Since engagements
  // stage 3 it writes nothing to any client: a prospect becomes a client, and an
  // existing client gets the fee, plans and software, only when the engagement
  // letter is marked signed. One question, then.
  const accept = () => {
    if (!proposal) return
    // A line not yet priced (a count only asked on a call, a rate at zero) would
    // make the client's fee a partial total: price it first (the server refuses too).
    if (unpricedProposalLines(proposal.pricingSnapshot).length > 0) {
      setError(PROPOSAL_NOT_PRICED_MESSAGE)
      return
    }
    const totals = proposal.pricingSnapshot?.totals
    const monthlyTotal = totals?.monthly ?? 0
    const annualTotal = totals?.annual ?? 0
    const monthly = formatProposalMoney(monthlyTotal)
    const chosenPackage = packageId || null
    // Ticked plans, in the order the firm lists them; ids that no longer exist drop out.
    const chosenPlans = (data.plans ?? []).filter((plan) => planPickIds.includes(plan.id))
    const planIds = chosenPlans.map((plan) => plan.id)
    const planWords =
      chosenPlans.length === 0
        ? ''
        : `, with the plan${chosenPlans.length === 1 ? '' : 's'} ${
            chosenPlans.length === 1
              ? chosenPlans[0].name
              : `${chosenPlans
                  .slice(0, -1)
                  .map((plan) => plan.name)
                  .join(', ')} and ${chosenPlans[chosenPlans.length - 1].name}`
          }`
    // Software is billed at cost and is not part of the monthly fee; signing adds
    // each priced line to the client as a monthly expense marked Software.
    const softwareNames = (proposal.pricingSnapshot?.lines ?? [])
      .filter((line) => line.group === 'Software' && !line.flag && line.amount > 0)
      .map((line) => line.name)
    const softwareList = listWords(softwareNames)
    const superseding = Boolean(proposal.clientId && currentSigned && acceptMode === 'supersede')
    const send = (signingNotice: string) =>
      enqueue(async () => {
        const result = await acceptProposalRequest(proposalId, {
          packageId: chosenPackage,
          ...(planIds.length > 0 ? { planIds } : {}),
          ...(superseding ? { mode: 'supersede' as const } : {}),
        })
        afterAccept(result, signingNotice)
        return result.proposal
      })
    if (!proposal.clientId) {
      const title = proposalTitle(proposal)
      // A proposal with only annual fees makes an annually billed client at signing.
      const billing =
        monthlyTotal === 0 && annualTotal > 0
          ? `billed annually at ${formatProposalMoney(annualTotal)}`
          : `billed monthly at ${monthly}`
      const ok = window.confirm(
        `Accept this proposal? This proposal is marked Won. ${ENGAGEMENT_DRAFTED} ` +
          `${title} becomes a client in Onboarding, ${billing}` +
          planWords +
          (softwareNames.length > 0
            ? `${planWords ? ', and' : ','} with ${softwareList} as monthly Software expenses billed at cost`
            : '') +
          `, when the letter is marked signed - not before. Nothing about any invoice changes now.`,
      )
      if (!ok) return
      send(`${title} becomes a client when this letter is marked signed.`)
      return
    }
    const client = data.clients.find((entry) => entry.id === proposal.clientId)
    const clientName = client?.name ?? 'this client'
    if (superseding && currentSigned) {
      // Supersede (stage 4): the letter REPLACES the current engagement when signed.
      const signedDay = engagementInstantLabel(currentSigned.signedAt) || 'earlier'
      // Plans are SET only when the letter names some (its own or its package's).
      const packagePlans = packages.find((entry) => entry.id === chosenPackage)?.planIds ?? []
      const namesPlans = chosenPlans.length > 0 || packagePlans.length > 0
      const currentFee = Number(client?.monthlyRate ?? 0)
      const replaced = [
        ...(client?.billingMode === 'subscription' && monthlyTotal > 0 ? [`the letter's ${monthly} replaces their monthly fee`] : []),
        // A letter with no monthly fee leaves theirs (signing says so too).
        ...(client?.billingMode === 'subscription' && monthlyTotal === 0 && currentFee > 0
          ? [`their monthly fee stays at ${formatProposalMoney(currentFee)} (the letter has none)`]
          : []),
        namesPlans ? "their plans become exactly the letter's plans" : 'their plans stay as they are (the letter names none)',
        ...(softwareNames.length > 0
          ? [`${softwareList} ${softwareNames.length === 1 ? 'is' : 'are'} added as monthly Software expenses billed at cost`]
          : []),
        `the engagement signed ${signedDay} is marked Superseded`,
      ]
      const ok = window.confirm(
        `Accept this proposal for ${clientName}${planWords}? This proposal is marked Won. ` +
          `A superseding engagement letter will be drafted to replace the one signed ${signedDay}, for you to edit and send. ` +
          `Nothing changes for ${clientName} until the letter is marked signed: then ${listWords(replaced)}.`,
      )
      if (!ok) return
      send(`Nothing changes for ${clientName} until this letter is marked signed; then it replaces the engagement signed ${signedDay}.`)
      return
    }
    // What signing will change for an existing client, named now so nothing surprises her later.
    const changes = [
      ...(client?.billingMode === 'subscription' && monthlyTotal > 0 ? [`the letter's ${monthly} is added to their monthly fee (you can choose replace or keep on the letter)`] : []),
      ...(chosenPlans.length > 0 ? [`the plan${chosenPlans.length === 1 ? ' is' : 's are'} added`] : []),
      ...(softwareNames.length > 0
        ? [`${softwareList} ${softwareNames.length === 1 ? 'is' : 'are'} added as monthly Software expenses billed at cost`]
        : []),
    ]
    const ok = window.confirm(
      `Accept this proposal for ${clientName}${planWords}? This proposal is marked Won. ${ENGAGEMENT_DRAFTED} ` +
        `Nothing changes for ${clientName} until the letter is marked signed` +
        (changes.length > 0 ? `: then ${listWords(changes)}.` : '.'),
    )
    if (!ok) return
    send(`Nothing changes for ${clientName} until this letter is marked signed.`)
  }

  // Close as lost: the note is optional (a prospect who simply went quiet has
  // none). Cancel closes nothing; OK with the box blank closes it with no note.
  const decline = () => {
    const note = window.prompt(
      'Close this proposal as lost? Add a note if you like (optional — saved on the proposal).',
      '',
    )
    if (note === null) return
    enqueue(() => declineProposalRequest(proposalId, note.trim() ? note : ''))
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
                aria-label="Package to apply when signed"
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
              <div className="new-task-menu" ref={plansMenuRef}>
                <button
                  type="button"
                  className="secondary-action"
                  aria-expanded={plansOpen}
                  onClick={() => setPlansOpen((open) => !open)}
                >
                  {planPickIds.length > 0 ? `Plans · ${planPickIds.length}` : 'Plans'}
                </button>
                {plansOpen ? (
                  <div
                    className="new-task-menu-popover plans-menu-popover"
                    role="group"
                    aria-label="Plans to apply when signed"
                  >
                    {(data.plans ?? []).length === 0 ? (
                      <p className="muted-text">No plans yet.</p>
                    ) : (
                      (data.plans ?? []).map((plan) => (
                        <label key={plan.id} className="check-row">
                          <input
                            type="checkbox"
                            checked={planPickIds.includes(plan.id)}
                            onChange={(event) =>
                              setPlanPickIds((ids) =>
                                event.target.checked
                                  ? [...ids, plan.id]
                                  : ids.filter((id) => id !== plan.id),
                              )
                            }
                          />
                          <span>{plan.name}</span>
                        </label>
                      ))
                    )}
                  </div>
                ) : null}
              </div>
              {proposal.clientId && currentSigned ? (
                <select
                  className="input"
                  aria-label="What the letter does to the current engagement"
                  value={acceptMode}
                  onChange={(event) => setAcceptMode(event.target.value === 'supersede' ? 'supersede' : 'amend')}
                >
                  <option value="amend">Amend the current engagement</option>
                  <option value="supersede">Supersede it</option>
                </select>
              ) : null}
              <button type="button" className="primary-action" disabled={busy} onClick={accept}>
                Accept
              </button>
              <button type="button" className="ghost-action" disabled={busy} onClick={decline}>
                Close as lost
              </button>
            </>
          ) : null}
          {clientLinkId ? (
            <Link className="secondary-action" to={`/clients/${clientLinkId}`}>
              Open the client
            </Link>
          ) : null}
          {won && engagement ? (
            <Link className="secondary-action" to={`/engagements/${engagement.id}`}>
              Open the engagement
            </Link>
          ) : null}
          {won && engagement === null ? (
            <button
              type="button"
              className="secondary-action"
              disabled={busy || draftingEngagement}
              onClick={() => void draftEngagement()}
            >
              Draft the engagement
            </button>
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
      {notice ? (
        <p className="empty-state">
          {notice}
          {noticeEngagementId ? (
            <>
              {' '}
              <Link to={`/engagements/${noticeEngagementId}`}>Open the engagement</Link>
            </>
          ) : null}
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
            questionnaire={questionnaire}
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
          recipients={partyRecipientDetails({
            email: proposal.prospect.email,
            source: proposal.prospect.contactName || proposal.prospect.company || 'Prospect',
            client: proposal.clientId ? (data.clients.find((entry) => entry.id === proposal.clientId) ?? null) : null,
            clients: data.clients,
            contacts: data.contacts ?? [],
          })}
        />
      ) : null}
      {tab === 'activity' ? <ActivityTab proposal={proposal} /> : null}
    </section>
  )
}
