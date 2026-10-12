import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { AddModal } from '../AddModal'
import { getEngagementRequest, signEngagementRequest } from '../../lib/api'
import { ENGAGEMENT_STATUS_LABELS, engagementDayLabel, engagementPartyName } from '../../lib/engagements'
import { engagementFeeChoices, signRefusalSentence, signingSentence } from '../../lib/engagementSigning'
import { firmToday } from '../../../lib/firm-time.js'
import { formatProposalMoney } from '../../../lib/proposal-pricing.js'
import { ApiError, type Engagement, type EngagementSignResult } from '../../lib/types'

/**
 * Mark as signed, shared by the engagement editor and the client's Engagements card
 * (featreq-b2142264) so the two never drift: the form (the day, the note, "signed in
 * person" for a draft, "signed as edited" for a sent letter changed since it went out),
 * the confirm and the call, and the summary of what signing did.
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
  // "Signed as edited": sign a sent letter that changed after it went out.
  const [signedAsEdited, setSignedAsEdited] = useState(false)

  // The sent-hash guard: a sent letter edited since it went out signs only "as edited".
  const changed = engagement.status === 'sent' && changedSinceSent
  const canSign =
    (engagement.status === 'sent' && (!changed || signedAsEdited)) || (engagement.status === 'draft' && inPerson)

  const sign = async () => {
    if (!canSign || !/^\d{4}-\d{2}-\d{2}$/.test(signedOn)) return
    const ok = window.confirm(
      `Mark the engagement letter for ${engagementPartyName(engagement)} as signed on ${engagementDayLabel(signedOn)}? ${signingSentence(engagement, feeLine)}A signed letter can no longer be edited, sent or voided.`,
    )
    if (!ok) return
    onStart()
    try {
      const result = await signEngagementRequest(engagement.id, {
        signedOn,
        ...(signNote.trim() ? { note: signNote.trim() } : {}),
        ...(engagement.status === 'draft' ? { allowUnsent: true } : {}),
        ...(changed && signedAsEdited ? { confirmChanged: true } : {}),
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
      {changed ? (
        <>
          <p className="form-error" role="status">
            The letter changed since it was sent. Send it again, or tick &quot;Signed as edited&quot; if they signed
            this version.
          </p>
          <label className="check-row">
            <input
              type="checkbox"
              checked={signedAsEdited}
              onChange={(event) => setSignedAsEdited(event.target.checked)}
            />
            <span>Signed as edited (they signed this version, not the one sent)</span>
          </label>
        </>
      ) : null}
      <div className="button-row">
        <button type="button" className="primary-action" disabled={!canSign || disabled} onClick={() => void sign()}>
          Mark as signed
        </button>
        {actions}
      </div>
      {!canSign && !changed ? <p className="muted-text">Send the letter first, or tick &quot;signed in person&quot;.</p> : null}
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
}: {
  result: EngagementSignResult
  partyName: string
  clientName: string
  planName: (planId: string) => string
  retainerAmount: number | null
}) {
  const checklists = result.clonedTemplateIds.length
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
        {checklists > 0 ? (
          <li>{`${checklists} recurring checklist${checklists === 1 ? '' : 's'} copied from the plans and package.`}</li>
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
        <Link className="secondary-action" to={`/clients/${result.clientId}`}>
          Open the client
        </Link>
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
 * "signed as edited" appears when the letter changed since it was sent. An existing
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [summary, setSummary] = useState<EngagementSignResult | null>(null)

  // The stored letter (a failed read keeps the row the card listed).
  const reload = useCallback(async () => {
    try {
      const view = await getEngagementRequest(row.id)
      setEngagement(view.engagement)
      setChangedSinceSent(view.changedSinceSent === true)
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

  return (
    <AddModal title={`Mark as signed: ${partyName}`} onClose={onClose}>
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
          />
          <div className="button-row">
            <button type="button" className="secondary-action" onClick={onClose}>
              Done
            </button>
          </div>
        </>
      ) : signable ? (
        <>
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
              <button type="button" className="ghost-action" disabled={busy} onClick={onClose}>
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
              // The server's own word that the letter changed since it went out shows the
              // "signed as edited" choice even when the read below cannot be made.
              if (failure instanceof ApiError && failure.reason === 'changed_since_sent') setChangedSinceSent(true)
              // Whatever went wrong, read the stored letter again: it may have changed since
              // it was sent (the "signed as edited" choice then appears), or been signed
              // or voided meanwhile.
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
