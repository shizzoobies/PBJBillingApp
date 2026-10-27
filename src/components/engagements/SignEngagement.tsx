import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { AddModal } from '../AddModal'
import { getEngagementRequest, listEngagementsRequest, signEngagementRequest } from '../../lib/api'
import {
  ENGAGEMENT_STATUS_LABELS,
  engagementDayLabel,
  engagementInstantLabel,
  engagementPartyName,
} from '../../lib/engagements'
import { engagementFeeChoices, signRefusalSentence, signingSentence } from '../../lib/engagementSigning'
import { EsignPanel } from './EsignPanel'
import { engagementIsPureRecord } from '../../../lib/engagement-record.js'
import { firmToday } from '../../../lib/firm-time.js'
import { formatProposalMoney } from '../../../lib/proposal-pricing.js'
import { ApiError, type Engagement, type EngagementSignResult } from '../../lib/types'

/**
 * Mark as signed, shared by the engagement editor and the client's Engagements card
 * (featreq-b2142264) so the two never drift: the form (the day, the note, "signed in
 * person" for a draft, the changed-since-sent warning for a sent letter edited after it went
 * out), the confirm and the call, and the summary of what signing did.
 */

/**
 * The Mark as signed form and its button. It owns what she types; the page around it
 * owns where the outcome is shown (`onStart` / `onSigned` / `onFailed` / `onDone`).
 * `feeLine` is the fee choice the confirm repeats; `disabled` stops the button (unsaved
 * edits, another action running); `actions` sit next to the button (the editor's Void).
 */
export function SignEngagementForm({
  engagement,
  changedSinceSent,
  feeLine = null,
  disabled = false,
  actions = null,
  onStart,
  onSigned,
  onFailed,
  onDone,
}: {
  engagement: Engagement
  changedSinceSent: boolean
  feeLine?: string | null
  disabled?: boolean
  actions?: ReactNode
  onStart: () => void
  onSigned: (result: EngagementSignResult, signedOn: string) => void | Promise<void>
  onFailed: (message: string, error: unknown) => void | Promise<void>
  onDone: () => void
}) {
  const [signedOn, setSignedOn] = useState(() => firmToday())
  const [signNote, setSignNote] = useState('')
  const [inPerson, setInPerson] = useState(false)
  // The warning shown when a sent letter changed after it went out (a warning, not a refusal).
  const [warnChanged, setWarnChanged] = useState(false)

  // A superseding letter also replaces the client's open amendments (featreq-e5ae8279):
  // the live ones are listed once, here, each with a "Keep in force" box that starts OFF.
  // What is sent is the ids SHOWN minus the kept ones, so an amendment made after this
  // list was read is never replaced unseen.
  const supersedes = engagement.kind === 'superseding' && Boolean(engagement.supersedesId) && Boolean(engagement.clientId)
  const clientId = engagement.clientId
  const [amendments, setAmendments] = useState<Engagement[] | null>(null)
  const [amendmentsFailed, setAmendmentsFailed] = useState(false)
  // A failed read is retried, never signed past: replacing too few has no undo.
  const [amendmentsAttempt, setAmendmentsAttempt] = useState(0)
  const [kept, setKept] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    if (!supersedes || !clientId) return
    let cancelled = false
    void listEngagementsRequest({ clientId }).then(
      (rows) => {
        if (cancelled) return
        setAmendments(
          rows.filter(
            (row) =>
              row.kind === 'amendment' && (row.status === 'draft' || row.status === 'sent' || row.status === 'signed'),
          ),
        )
      },
      () => {
        if (!cancelled) setAmendmentsFailed(true)
      },
    )
    return () => {
      cancelled = true
    }
  }, [supersedes, clientId, amendmentsAttempt])
  // Only a SUCCESSFUL read enables signing a superseding letter.
  const amendmentsReady = !supersedes || amendments !== null

  // The sent-hash guard: a sent letter edited since it went out warns first. She may have
  // fixed a typo, so it is a warning she can sign past ("Mark signed anyway"), not a refusal.
  const changed = engagement.status === 'sent' && changedSinceSent
  const canSign = amendmentsReady && (engagement.status === 'sent' || (engagement.status === 'draft' && inPerson))
  const lastSent = [...(engagement.emailLog ?? [])]
    .reverse()
    .find((entry) => (entry?.kind === 'send' || entry?.kind === 'esign') && entry.ok)
  const lastSentDay = engagementInstantLabel(lastSent?.at ?? engagement.sentAt)

  const sign = async ({ anyway = false } = {}) => {
    if (!canSign || !/^\d{4}-\d{2}-\d{2}$/.test(signedOn)) return
    if (changed && !anyway) {
      setWarnChanged(true)
      return
    }
    setWarnChanged(false)
    const replaceIds = supersedes ? (amendments ?? []).filter((row) => !kept.has(row.id)).map((row) => row.id) : []
    const replacing =
      replaceIds.length > 0
        ? `${replaceIds.length} open amendment${replaceIds.length === 1 ? ' is' : 's are'} replaced too (marked Superseded; each can be restored from the client's Engagements list). `
        : ''
    const ok = window.confirm(
      `Mark the engagement letter for ${engagementPartyName(engagement)} as signed on ${engagementDayLabel(signedOn)}? ${signingSentence(engagement, feeLine)}${replacing}A signed letter can no longer be edited, sent or voided.`,
    )
    if (!ok) return
    onStart()
    try {
      const result = await signEngagementRequest(engagement.id, {
        signedOn,
        ...(signNote.trim() ? { note: signNote.trim() } : {}),
        ...(engagement.status === 'draft' ? { allowUnsent: true } : {}),
        ...(changed ? { confirmChanged: true } : {}),
        ...(replaceIds.length > 0 ? { replaceAmendmentIds: replaceIds } : {}),
      })
      await onSigned(result, signedOn)
    } catch (err) {
      await onFailed(signRefusalSentence(err), err)
    } finally {
      onDone()
    }
  }

  return (
    <>
      <div className="form-grid two-col">
        <label className="field">
          <span>Signed on</span>
          <input
            className="input"
            type="date"
            aria-label="Signed on"
            value={signedOn}
            onChange={(event) => setSignedOn(event.target.value)}
          />
        </label>
        <label className="field">
          <span>Note (optional)</span>
          <textarea
            className="input"
            rows={2}
            maxLength={2000}
            aria-label="Signing note"
            value={signNote}
            onChange={(event) => setSignNote(event.target.value)}
          />
        </label>
      </div>
      {engagement.status === 'draft' ? (
        <label className="check-row">
          <input type="checkbox" checked={inPerson} onChange={(event) => setInPerson(event.target.checked)} />
          <span>This letter was signed in person (it was never sent from here)</span>
        </label>
      ) : null}
      {changed && warnChanged ? (
        <div className="engagement-changed-warning">
          <p className="form-error" role="alert">
            {'This letter changed after it was last sent' +
              (lastSentDay ? ' on ' + lastSentDay : '') +
              '. The client signed the earlier version. Send it again first, or mark it signed anyway.'}
          </p>
          <div className="button-row">
            <button type="button" className="primary-action" disabled={disabled} onClick={() => void sign({ anyway: true })}>
              Mark signed anyway
            </button>
            <button type="button" className="ghost-action" onClick={() => setWarnChanged(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {supersedes && amendments === null && !amendmentsFailed ? (
        <p className="muted-text" role="status">
          {"Reading the client's amendments..."}
        </p>
      ) : null}
      {supersedes && amendments === null && amendmentsFailed ? (
        <div className="button-row">
          <p className="form-error" role="alert">
            {"Could not read this client's amendments."}
          </p>
          <button
            type="button"
            className="ghost-action"
            onClick={() => {
              setAmendmentsFailed(false)
              setAmendmentsAttempt((count) => count + 1)
            }}
          >
            Retry
          </button>
        </div>
      ) : null}
      {supersedes && amendments !== null && amendments.length > 0 ? (
        <fieldset className="engagement-replaced-amendments">
          <legend>Open amendments this letter replaces</legend>
          <p className="muted-text">
            Signing this letter replaces these amendments along with the engagement it supersedes. Tick Keep in force
            on any that should stay in effect.
          </p>
          {amendments.map((row) => {
            const label = row.subject || 'Amendment'
            const state = ENGAGEMENT_STATUS_LABELS[row.status] ?? row.status
            const day = engagementInstantLabel(row.signedAt || row.sentAt || row.createdAt)
            return (
              <div key={row.id} className="engagement-replaced-amendment">
                <label className="check-row">
                  <input
                    type="checkbox"
                    aria-label={`Keep in force: ${label}`}
                    checked={kept.has(row.id)}
                    onChange={(event) =>
                      setKept((current) => {
                        const next = new Set(current)
                        if (event.target.checked) next.add(row.id)
                        else next.delete(row.id)
                        return next
                      })
                    }
                  />
                  <span>{`Keep in force - ${label} (${state}${day ? `, ${day}` : ''})`}</span>
                </label>
                {engagementIsPureRecord(row) ? null : (
                  <p className="muted-text" role="note">
                    {"Keeping or replacing it does not change the client's fee or plans; signing this letter does, as set in Signing details."}
                  </p>
                )}
              </div>
            )
          })}
        </fieldset>
      ) : null}
      <div className="button-row">
        <button type="button" className="primary-action" disabled={!canSign || disabled} onClick={() => void sign()}>
          Mark as signed
        </button>
        {actions}
      </div>
      {!canSign && amendmentsReady ? <p className="muted-text">Send the letter first, or tick &quot;signed in person&quot;.</p> : null}
    </>
  )
}

/** The summary after Mark as signed: what it did, what it skipped, and links. */
export function SigningSummary({
  result,
  partyName,
  clientName,
  planName,
  retainerAmount,
  showClientLink = true,
}: {
  result: EngagementSignResult
  partyName: string
  clientName: string
  planName: (planId: string) => string
  retainerAmount: number | null
  /** Off on the client's own page (the card's dialog): she is already there. */
  showClientLink?: boolean
}) {
  const checklists = result.clonedTemplateIds.length
  // Rows left for her to choose: a differing schedule, or more than one match.
  const scheduleLeft = (result.scheduleDiffersTemplateIds ?? []).length
  const severalLeft = (result.ambiguousTemplateIds ?? []).length - scheduleLeft
  const onboardingChecklistId = result.onboardingChecklistId ?? null
  const onboardingOpened =
    Boolean(result.onboardingCaseId) && !result.skipped.some((entry) => entry.what === 'Onboarding checklist')
  return (
    <div className="engagement-sign-summary" role="status" aria-label="What signing did">
      <p>
        {result.createdClient
          ? `${partyName} is now a client, in Onboarding, with its contact.`
          : `Finished signing for ${clientName}.`}
      </p>
      <ul>
        {result.monthlyRate !== null ? (
          <li>{`Monthly fee set to ${formatProposalMoney(result.monthlyRate)}.`}</li>
        ) : null}
        {result.addedPlanIds.length > 0 ? (
          <li>{`Plans added: ${result.addedPlanIds.map(planName).join(', ')}.`}</li>
        ) : null}
        {(result.removedPlanIds ?? []).length > 0 ? (
          <li>{`Plans taken off: ${(result.removedPlanIds ?? []).map(planName).join(', ')}.`}</li>
        ) : null}
        {result.supersededId ? (
          <li>
            {'The engagement this letter replaces is now marked Superseded ('}
            <Link to={`/engagements/${result.supersededId}`}>open it</Link>
            {').'}
          </li>
        ) : null}
        {(result.supersededAmendmentIds ?? []).length > 0 ? (
          <li>
            {`${(result.supersededAmendmentIds ?? []).length} open amendment${(result.supersededAmendmentIds ?? []).length === 1 ? ' was' : 's were'} replaced too. Restore one from the client's Engagements list if it should stay in force.`}
          </li>
        ) : null}
        {checklists > 0 ? (
          <li>{`${checklists} recurring checklist${checklists === 1 ? '' : 's'} copied from the plans and package.`}</li>
        ) : null}
        {(result.linkedTemplateIds ?? []).length > 0 ? (
          <li>{`${(result.linkedTemplateIds ?? []).length} checklist${(result.linkedTemplateIds ?? []).length === 1 ? '' : 's'} the client already had ${(result.linkedTemplateIds ?? []).length === 1 ? 'was' : 'were'} linked instead of copied.`}</li>
        ) : null}
        {severalLeft > 0 ? (
          <li>{`${severalLeft} left for you to choose on the client page: more than one existing checklist matches.`}</li>
        ) : null}
        {scheduleLeft > 0 ? (
          <li>{`${scheduleLeft} left for you to choose on the client page: the existing ${scheduleLeft === 1 ? 'checklist runs' : 'checklists run'} on a different schedule than the plan's "How often".`}</li>
        ) : null}
        {onboardingOpened ? (
          <li>Onboarding checklist opened at the Onboarding stage - the Proposal stage is marked done.</li>
        ) : null}
        {result.softwareAdded.length > 0 ? (
          <li>{`Software added as monthly expenses: ${result.softwareAdded.join(', ')}.`}</li>
        ) : null}
        {result.retainerInvoiceId ? (
          <li>{`Retainer invoice of ${formatProposalMoney(Number(retainerAmount ?? 0))} drafted - it is in To review in the month run.`}</li>
        ) : null}
        {result.skipped.map((entry) => (
          <li key={`${entry.what}-${entry.why}`}>{`Skipped - ${entry.what}: ${entry.why}`}</li>
        ))}
      </ul>
      <div className="button-row">
        {showClientLink ? (
          <Link className="secondary-action" to={`/clients/${result.clientId}`}>
            Open the client
          </Link>
        ) : null}
        {onboardingChecklistId ? (
          <Link className="secondary-action" to={`/checklists?focus=${encodeURIComponent(onboardingChecklistId)}`}>
            Open the onboarding checklist
          </Link>
        ) : null}
        {result.retainerInvoiceId ? (
          <Link
            className="secondary-action"
            to={result.retainerPeriod ? `/invoices?period=${result.retainerPeriod}` : '/invoices'}
          >
            Open the retainer
          </Link>
        ) : null}
      </div>
    </div>
  )
}

/**
 * Mark as signed from the client's Engagements card: the editor's form in a dialog. It
 * reads the stored letter first (and again after ANY failed try, like the editor) so
 * the changed-since-sent warning appears when the letter changed since it was sent. An existing
 * monthly client's fee choice is shown as it is saved on the letter, read-only, with a
 * link to the letter to change it. On success it shows the editor's summary and calls
 * `onSigned` (the card reads its list again; the server tells every tab the data changed).
 */
export function SignEngagementDialog({
  engagement: row,
  client,
  clientName,
  planName,
  onSigned,
  onClose,
}: {
  engagement: Engagement
  client: { billingMode?: string | null; monthlyRate?: number | null } | null
  clientName: string
  planName: (planId: string) => string
  onSigned: (result: EngagementSignResult) => void
  onClose: () => void
}) {
  const [engagement, setEngagement] = useState<Engagement>(row)
  const [changedSinceSent, setChangedSinceSent] = useState(false)
  const [hash, setHash] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [summary, setSummary] = useState<EngagementSignResult | null>(null)

  // The stored letter (a failed read keeps the row the card listed).
  const reload = useCallback(async () => {
    try {
      const view = await getEngagementRequest(row.id)
      setEngagement(view.engagement)
      setChangedSinceSent(view.changedSinceSent === true)
      setHash(view.hash)
    } catch {
      /* the listed row stands; a refusal still says why */
    }
  }, [row.id])
  useEffect(() => {
    let cancelled = false
    void getEngagementRequest(row.id).then(
      (view) => {
        if (cancelled) return
        setEngagement(view.engagement)
        setChangedSinceSent(view.changedSinceSent === true)
        setHash(view.hash)
      },
      () => {},
    )
    return () => {
      cancelled = true
    }
  }, [row.id])

  const partyName = engagementPartyName(engagement)
  const feeChoices = engagement.clientId ? engagementFeeChoices(engagement, client) : null
  const feeLine = feeChoices ? feeChoices[engagement.feeMode ?? 'replace'] : null
  const signable = engagement.status === 'sent' || engagement.status === 'draft'
  // Closing mid-signing would hide the outcome of a signing that is still running: every way
  // out (the X, a click outside, Escape) waits until it answers.
  const close = useCallback(() => {
    if (!busy) onClose()
  }, [busy, onClose])

  return (
    <AddModal title={`Mark as signed: ${partyName}`} onClose={close}>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {summary ? (
        <>
          <SigningSummary
            result={summary}
            partyName={partyName}
            clientName={clientName}
            planName={planName}
            retainerAmount={engagement.retainerAmount}
            showClientLink={false}
          />
          <div className="button-row">
            <button type="button" className="secondary-action" onClick={close}>
              Done
            </button>
          </div>
        </>
      ) : signable ? (
        <>
          {/* Where the letter stands at SignWell, and a reminder: sending is from the letter's own page. */}
          <EsignPanel
            engagementId={engagement.id}
            partyName={partyName}
            partyEmail={engagement.party.email}
            templateHash={hash}
            canSend={false}
            engagementStatus={engagement.status}
          />
          {feeLine ? (
            <p className="muted-text" aria-label="Monthly fee when signed">
              {`${clientName}'s monthly fee, when signed: ${feeLine}. `}
              <Link to={`/engagements/${engagement.id}`}>Open the letter to change</Link>
            </p>
          ) : null}
          <SignEngagementForm
            engagement={engagement}
            changedSinceSent={changedSinceSent}
            feeLine={feeLine}
            disabled={busy}
            actions={
              <button type="button" className="ghost-action" disabled={busy} onClick={close}>
                Cancel
              </button>
            }
            onStart={() => {
              setBusy(true)
              setError('')
            }}
            onSigned={(result) => {
              setSummary(result)
              onSigned(result)
            }}
            onFailed={async (message, failure) => {
              setError(message)
              // The server's own word that the letter changed since it went out brings up the
              // changed-since-sent warning even when the read below cannot be made.
              if (failure instanceof ApiError && failure.reason === 'changed_since_sent') setChangedSinceSent(true)
              // Whatever went wrong, read the stored letter again: it may have changed since
              // it was sent (the warning then appears), or been signed or voided meanwhile.
              await reload()
            }}
            onDone={() => setBusy(false)}
          />
        </>
      ) : (
        <p className="muted-text">{`This letter is ${ENGAGEMENT_STATUS_LABELS[engagement.status]?.toLowerCase() ?? engagement.status} now, so it cannot be marked signed.`}</p>
      )}
    </AddModal>
  )
}
