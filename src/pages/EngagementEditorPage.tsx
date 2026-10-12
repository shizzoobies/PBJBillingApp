import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAppContext } from '../AppContext'
import { BoldBar, PlaceholderChipsToggle } from '../components/letters/LetterEditorKit'
import { DocumentPreviewModal } from '../components/letters/DocumentPreviewModal'
import { insertPlaceholder, isBoldShortcut, toggleBold, unknownPlaceholderSentence } from '../components/letters/letterEditing'
import { SaveBadge } from '../components/SectionKit'
import {
  engagementPreviewPdfUrl,
  getEngagementRequest,
  listEngagementSectionsRequest,
  listPackagesRequest,
  previewEngagementRequest,
  reassembleEngagementRequest,
  sendEngagementRequest,
  signEngagementRequest,
  updateEngagementRequest,
  voidEngagementRequest,
} from '../lib/api'
import {
  ENGAGEMENT_KIND_LABELS,
  ENGAGEMENT_STATUS_LABELS,
  engagementDayLabel,
  engagementInstantLabel,
  engagementPartyName,
  engagementSendRefusalSentence,
} from '../lib/engagements'
import type { SaveFlashState } from '../lib/useSaveFlash'
import { skippedEngagementLines } from '../../lib/engagement-values.js'
import { firmToday } from '../../lib/firm-time.js'
import { retiredSentence, templateWarnings } from '../../lib/letter-template.js'
import { formatProposalMoney } from '../../lib/proposal-pricing.js'
import {
  ApiError,
  type Engagement,
  type EngagementPreview,
  type EngagementView,
  type Package,
} from '../lib/types'

type Field = 'subject' | 'emailBody' | 'letterBody'
type BodyField = 'emailBody' | 'letterBody'

/** The statuses whose text and signing details can still change. */
const EDITABLE = new Set(['draft', 'sent'])

/** "630" -> 630; '' -> null (no retainer); anything else -> undefined (not a number she can save). */
function parseRetainer(text: string): number | null | undefined {
  const trimmed = text.trim().replace(/[$,]/g, '')
  if (!trimmed) return null
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value < 0) return undefined
  return Math.round(value * 100) / 100
}

const retainerText = (amount: number | null | undefined) =>
  amount === null || amount === undefined || !(amount > 0) ? '' : String(amount)

const DELIVERY_LABELS: Record<string, string> = {
  sent: 'Accepted by the email provider',
  delivered: 'Delivered',
  delivery_delayed: 'Delivery delayed',
  bounced: 'Bounced',
  complained: 'Marked as spam',
  opened: 'Opened',
  clicked: 'Link clicked',
}

/** One Activity line; `dayOnly` = show the day, not the time (signing is stored at the firm's noon). */
type ActivityRow = { at: string; text: string; dayOnly?: boolean }

/** Hours by role as the figures name them (the hours_cfo placeholder is "Controller / CFO hours"). */
const HOURS_LABELS = { bookkeeper: 'Bookkeeper', accountant: 'Accountant', controller: 'Controller / CFO' } as const

/** The Activity list: the email log plus the drafted / sent / signed / voided stamps, oldest first. */
function activityRows(engagement: Engagement, nameOf: (userId: string | null) => string): ActivityRow[] {
  const rows: ActivityRow[] = []
  if (engagement.createdAt) {
    rows.push({ at: engagement.createdAt, text: engagement.proposalId ? 'Drafted from the proposal' : 'Drafted' })
  }
  for (const entry of engagement.emailLog ?? []) {
    if (!entry || !entry.at) continue
    const to = (entry.to ?? []).join(', ')
    if (entry.kind === 'send') {
      rows.push({
        at: entry.at,
        text: entry.ok ? `Sent to ${to}` : `Send to ${to || 'the party'} failed: ${entry.error ?? 'not sent'}`,
      })
    } else if (entry.kind === 'delivery') {
      const label = DELIVERY_LABELS[entry.event] ?? entry.event
      rows.push({ at: entry.at, text: `${label}${to ? ` (${to})` : ''}${entry.detail ? `: ${entry.detail}` : ''}` })
    }
  }
  // The sent stamp, when the log holds no successful send (a row written before the log).
  if (engagement.sentAt && !(engagement.emailLog ?? []).some((entry) => entry?.kind === 'send' && entry.ok)) {
    rows.push({ at: engagement.sentAt, text: 'Sent' })
  }
  if (engagement.signedAt) {
    const who = nameOf(engagement.signedBy)
    rows.push({
      at: engagement.signedAt,
      dayOnly: true,
      text: `Marked signed for ${engagementInstantLabel(engagement.signedAt)}${who ? ` by ${who}` : ''}${
        engagement.signedNote ? `: ${engagement.signedNote}` : ''
      }`,
    })
  }
  if (engagement.voidedAt) rows.push({ at: engagement.voidedAt, text: 'Voided' })
  return rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
}

const stamp = (instant: string) => {
  const date = new Date(instant)
  return Number.isNaN(date.getTime())
    ? instant
    : date.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

/**
 * Keyed on the engagement id, so another engagement starts from a clean page.
 */
export function EngagementEditorPage() {
  const { engagementId = '' } = useParams()
  return <EngagementEditor key={engagementId} engagementId={engagementId} />
}

/**
 * One engagement letter (docs/plans/engagements-2026-10.md, stage 2C): the subject,
 * the email and the letter with {{placeholders}} and **bold**, the signing details
 * (retainer, package, plans), the proposal's figures, and the Preview / Send / Mark
 * as signed / Void actions. The server fills the letter in from the STORED engagement,
 * so Preview and Send wait until the page is saved.
 */
function EngagementEditor({ engagementId }: { engagementId: string }) {
  const { ownerMode, data, dataRefreshCount } = useAppContext()
  const [view, setView] = useState<EngagementView | null>(null)
  const [loadError, setLoadError] = useState('')

  const [subject, setSubject] = useState('')
  const [emailBody, setEmailBody] = useState('')
  const [letterBody, setLetterBody] = useState('')
  const [retainer, setRetainer] = useState('')
  const [packageId, setPackageId] = useState('')
  const [planIds, setPlanIds] = useState<string[]>([])
  const [saveState, setSaveState] = useState<SaveFlashState>('idle')
  const [saveError, setSaveError] = useState('')

  const [packages, setPackages] = useState<Package[]>([])
  const [sectionTitles, setSectionTitles] = useState<Record<string, string>>({})
  const [plansOpen, setPlansOpen] = useState(false)
  const plansMenuRef = useRef<HTMLDivElement | null>(null)

  const [previewOpen, setPreviewOpen] = useState(false)
  // The address Send uses: the party's own until she types another (null = not typed).
  const [typedTo, setTypedTo] = useState<string | null>(null)
  const [busy, setBusy] = useState<'' | 'reassemble' | 'send' | 'sign' | 'void'>('')
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')

  const [signedOn, setSignedOn] = useState(() => firmToday())
  const [signNote, setSignNote] = useState('')
  const [inPerson, setInPerson] = useState(false)

  const subjectRef = useRef<HTMLInputElement>(null)
  const emailBodyRef = useRef<HTMLTextAreaElement>(null)
  const letterBodyRef = useRef<HTMLTextAreaElement>(null)

  const engagement = view?.engagement ?? null
  const parsedRetainer = parseRetainer(retainer)
  const savedPlanIds = engagement?.planIds ?? []
  const dirty =
    engagement !== null &&
    (subject !== (engagement.subject ?? '') ||
      emailBody !== (engagement.emailBody ?? '') ||
      letterBody !== (engagement.letterBody ?? '') ||
      parsedRetainer !== (engagement.retainerAmount && engagement.retainerAmount > 0 ? engagement.retainerAmount : null) ||
      packageId !== (engagement.packageId ?? '') ||
      planIds.length !== savedPlanIds.length ||
      planIds.some((id) => !savedPlanIds.includes(id)))
  const dirtyRef = useRef(false)
  useEffect(() => {
    dirtyRef.current = dirty
  }, [dirty])

  /** Take the server's answer; the boxes follow it unless she has unsaved edits (or `overwrite`). */
  const adopt = useCallback((next: EngagementView, { overwrite }: { overwrite: boolean }) => {
    setView(next)
    if (overwrite || !dirtyRef.current) {
      const row = next.engagement
      setSubject(row.subject ?? '')
      setEmailBody(row.emailBody ?? '')
      setLetterBody(row.letterBody ?? '')
      setRetainer(retainerText(row.retainerAmount))
      setPackageId(row.packageId ?? '')
      setPlanIds(row.planIds ?? [])
    }
  }, [])

  const refresh = useCallback(
    async ({ overwrite }: { overwrite: boolean }) => {
      try {
        adopt(await getEngagementRequest(engagementId), { overwrite })
        setLoadError('')
      } catch (err) {
        setLoadError(err instanceof ApiError ? err.message : 'Could not load the engagement.')
      }
    },
    [adopt, engagementId],
  )

  // The engagement; again when another tab or session changes data.
  useEffect(() => {
    if (!ownerMode) return
    let cancelled = false
    void getEngagementRequest(engagementId)
      .then((next) => {
        if (cancelled) return
        setLoadError('')
        adopt(next, { overwrite: false })
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof ApiError ? err.message : 'Could not load the engagement.')
      })
    return () => {
      cancelled = true
    }
  }, [ownerMode, engagementId, dataRefreshCount, adopt])

  // Packages and the section titles are context; a failed read offers none / shows keys.
  useEffect(() => {
    if (!ownerMode) return
    let cancelled = false
    void listPackagesRequest()
      .then((rows) => {
        if (!cancelled) setPackages(rows)
      })
      .catch(() => {
        if (!cancelled) setPackages([])
      })
    void listEngagementSectionsRequest()
      .then((rows) => {
        if (!cancelled) setSectionTitles(Object.fromEntries(rows.map((row) => [row.key, row.title])))
      })
      .catch(() => {
        if (!cancelled) setSectionTitles({})
      })
    return () => {
      cancelled = true
    }
  }, [ownerMode])

  const partyEmail = engagement?.party?.email ?? ''
  const sendTo = typedTo ?? partyEmail

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

  const placeholders = useMemo(() => view?.placeholders ?? [], [view])
  // The same check Send makes, against the engagement placeholder list the GET returned.
  const warnings = useMemo(
    () => templateWarnings({ subject, emailBody, letterBody }, placeholders),
    [placeholders, subject, emailBody, letterBody],
  )

  if (!ownerMode) return null

  if (!engagement || !view) {
    return (
      <section className="panel">
        {loadError ? (
          <>
            <p className="form-error" role="alert">
              {loadError}
            </p>
            <p>
              <Link to="/engagements">Back to engagements</Link>
            </p>
          </>
        ) : (
          <p>Loading the engagement...</p>
        )}
      </section>
    )
  }

  const editable = EDITABLE.has(engagement.status)
  const partyName = engagementPartyName(engagement)
  const replyTo = view.sender.replyTo || 'the reply address'
  const figures = engagement.figures ?? {}
  const totals = figures.totals ?? {}
  const monthly = Number(totals.monthly ?? 0)
  const hours = figures.hoursByRole ?? {}
  const skipped = skippedEngagementLines(figures)

  /* ---- the editor ---------------------------------------------------------- */

  const values = { subject, emailBody, letterBody }
  const setters = { subject: setSubject, emailBody: setEmailBody, letterBody: setLetterBody }
  const refs = { subject: subjectRef, emailBody: emailBodyRef, letterBody: letterBodyRef }
  const fieldWord = (field: Field) => (field === 'subject' ? 'subject' : field === 'emailBody' ? 'email' : 'letter')
  const chips = (field: Field) =>
    editable ? (
      <PlaceholderChipsToggle
        placeholders={placeholders}
        fieldWord={fieldWord(field)}
        onInsert={(key) => insertPlaceholder(() => refs[field].current, values[field], key, setters[field])}
      />
    ) : null
  const bold = (field: BodyField) => toggleBold(() => refs[field].current, values[field], setters[field])

  const save = async () => {
    if (parsedRetainer === undefined) return
    setSaveState('saving')
    setSaveError('')
    setNotice('')
    try {
      // The package only when she changed it: a package deleted since must not block a text edit.
      const packageChanged = packageId !== (engagement.packageId ?? '')
      const next = await updateEngagementRequest(engagementId, {
        subject,
        emailBody,
        letterBody,
        retainerAmount: parsedRetainer,
        ...(packageChanged ? { packageId: packageId || null } : {}),
        planIds,
      })
      adopt(next, { overwrite: true })
      setSaveState('saved')
      window.setTimeout(() => setSaveState('idle'), 1800)
    } catch (err) {
      setSaveState('error')
      setSaveError(err instanceof ApiError ? err.message : 'Could not save the engagement.')
    }
  }

  /* ---- actions ------------------------------------------------------------- */

  const reassemble = async () => {
    const ok = window.confirm(
      `Re-assemble the letter for ${partyName} from the proposal? The subject, the email and the letter are rebuilt from your engagement sections and the proposal's figures. Your edits to them, saved or not, are replaced.`,
    )
    if (!ok) return
    setBusy('reassemble')
    setActionError('')
    setNotice('')
    try {
      adopt(await reassembleEngagementRequest(engagementId), { overwrite: true })
      setNotice('Re-assembled from the proposal.')
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not re-assemble the letter.')
    } finally {
      setBusy('')
    }
  }

  const send = async () => {
    const to = sendTo.trim()
    if (!to) return
    const again = engagement.status === 'sent' ? ' again' : ''
    const ok = window.confirm(
      `Send the engagement letter to ${partyName} at ${to}${again}? They get your email with the letter attached as a PDF. Replies go to ${replyTo}.`,
    )
    if (!ok) return
    setBusy('send')
    setActionError('')
    setNotice('')
    try {
      // Always the address she just confirmed, never one the server picks.
      const result = await sendEngagementRequest(engagementId, { templateHash: view.hash, to })
      if (result.ok) setNotice(`Sent to ${to}.`)
      else setActionError(`Not sent: ${result.error ?? 'the email provider refused the message.'}`)
      await refresh({ overwrite: false })
    } catch (err) {
      setActionError(engagementSendRefusalSentence(err))
      // The engagement changed under the page (or went out a moment ago): show the stored one.
      if (
        err instanceof ApiError &&
        (err.code === 'engagement_changed' || err.code === 'engagement_refused' || err.status === 404)
      ) {
        await refresh({ overwrite: !dirtyRef.current })
      }
    } finally {
      setBusy('')
    }
  }

  const canSign = engagement.status === 'sent' || (engagement.status === 'draft' && inPerson)
  const sign = async () => {
    if (!canSign || !/^\d{4}-\d{2}-\d{2}$/.test(signedOn)) return
    const ok = window.confirm(
      `Mark the engagement letter for ${partyName} as signed on ${engagementDayLabel(signedOn)}? A signed letter can no longer be edited, sent or voided.`,
    )
    if (!ok) return
    setBusy('sign')
    setActionError('')
    setNotice('')
    try {
      await signEngagementRequest(engagementId, {
        signedOn,
        ...(signNote.trim() ? { note: signNote.trim() } : {}),
        ...(engagement.status === 'draft' ? { allowUnsent: true } : {}),
      })
      setNotice(`Marked signed on ${engagementDayLabel(signedOn)}.`)
      await refresh({ overwrite: true })
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not mark the engagement as signed.')
    } finally {
      setBusy('')
    }
  }

  const voidIt = async () => {
    const ok = window.confirm(
      `Void the engagement letter for ${partyName}? It stays in the list marked Void and can no longer be edited, sent or signed.`,
    )
    if (!ok) return
    setBusy('void')
    setActionError('')
    setNotice('')
    try {
      await voidEngagementRequest(engagementId)
      setNotice('Voided.')
      await refresh({ overwrite: true })
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not void the engagement.')
    } finally {
      setBusy('')
    }
  }

  const blockedReason = dirty ? 'Save the engagement to preview or send it.' : ''
  const previewTo = sendTo.trim() && sendTo.trim() !== partyEmail ? sendTo.trim() : undefined
  const activity = activityRows(
    engagement,
    (userId) => (userId ? ((data.employees ?? []).find((employee) => employee.id === userId)?.name ?? '') : ''),
  )
  const chosenPlans = (data.plans ?? []).filter((plan) => planIds.includes(plan.id))
  const hoursRows = (['bookkeeper', 'accountant', 'controller'] as const)
    .map((role) => ({ role, value: Number(hours[role] ?? 0) }))
    .filter((row) => row.value > 0)

  return (
    <section className="engagement-editor">
      <header className="client-detail-header engagement-editor-header">
        <div>
          <p className="section-kicker">
            <Link className="engagement-breadcrumb" to="/engagements">
              Engagements
            </Link>
          </p>
          <h1>{partyName}</h1>
          <div className="engagement-header-meta">
            <span className="status-pill">{ENGAGEMENT_KIND_LABELS[engagement.kind] ?? engagement.kind}</span>
            <span className="status-pill">{ENGAGEMENT_STATUS_LABELS[engagement.status] ?? engagement.status}</span>
            {engagement.proposalId ? (
              <Link to={`/proposals/${engagement.proposalId}`}>{`From proposal ${partyName}`}</Link>
            ) : null}
            {engagement.clientId ? <Link to={`/clients/${engagement.clientId}`}>Client</Link> : null}
          </div>
        </div>
        <div className="engagement-header-actions">
          {editable ? (
            <button
              type="button"
              className="primary-action"
              disabled={!dirty || saveState === 'saving' || parsedRetainer === undefined}
              onClick={() => void save()}
            >
              Save
            </button>
          ) : null}
          <SaveBadge state={saveState} />
          {engagement.updatedAt ? (
            <span className="muted-text">{`Last saved ${stamp(engagement.updatedAt)}`}</span>
          ) : null}
        </div>
      </header>

      {loadError ? (
        <p className="form-error" role="alert">
          {loadError}
        </p>
      ) : null}
      {saveError ? (
        <p className="form-error" role="alert">
          {saveError}
        </p>
      ) : null}

      <div className="engagement-layout">
        <div className="engagement-main">
          <div className="panel letters-editor">
            <h3>The letter</h3>
            {!editable ? (
              <p className="muted-text">
                {`This engagement is ${ENGAGEMENT_STATUS_LABELS[engagement.status].toLowerCase()}, so it can no longer be edited.`}
              </p>
            ) : null}
            <label className="field">
              <span>Subject</span>
              <input
                ref={subjectRef}
                className="input"
                type="text"
                maxLength={200}
                disabled={!editable}
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
              />
            </label>
            {chips('subject')}

            <div className="field">
              <label htmlFor="engagement-email-body">
                <span>Email body</span>
              </label>
              {editable ? <BoldBar fieldWord="email" disabled={false} onBold={() => bold('emailBody')} /> : null}
              <textarea
                id="engagement-email-body"
                ref={emailBodyRef}
                className="input"
                rows={8}
                maxLength={20000}
                disabled={!editable}
                value={emailBody}
                onChange={(event) => setEmailBody(event.target.value)}
                onKeyDown={(event) => {
                  if (isBoldShortcut(event)) {
                    event.preventDefault()
                    bold('emailBody')
                  }
                }}
              />
            </div>
            <p className="muted-text">This is the email. The letter rides along as a PDF.</p>
            {chips('emailBody')}

            <div className="field">
              <label htmlFor="engagement-letter-body">
                <span>Letter body</span>
              </label>
              {editable ? <BoldBar fieldWord="letter" disabled={false} onBold={() => bold('letterBody')} /> : null}
              <textarea
                id="engagement-letter-body"
                ref={letterBodyRef}
                className="input"
                rows={24}
                maxLength={20000}
                disabled={!editable}
                value={letterBody}
                onChange={(event) => setLetterBody(event.target.value)}
                onKeyDown={(event) => {
                  if (isBoldShortcut(event)) {
                    event.preventDefault()
                    bold('letterBody')
                  }
                }}
              />
            </div>
            <p className="muted-text">
              Blank lines start a new paragraph. The firm letterhead, the date and the party&apos;s address are added
              above it. For bold, select words and press B (or Ctrl+B): they are wrapped in **double asterisks** and come
              out bold in the email and the PDF.
            </p>
            {chips('letterBody')}

            {warnings.unknown.length > 0 ? (
              <p className="form-error" role="status">
                {unknownPlaceholderSentence(warnings.unknown)}
              </p>
            ) : null}
            {warnings.retired.length > 0 ? (
              <p className="form-error" role="status">
                {`${retiredSentence(warnings.retired)}.`}
              </p>
            ) : null}
          </div>

          <div className="panel">
            <h3>Send and sign</h3>
            {actionError ? (
              <p className="form-error" role="alert">
                {actionError}
              </p>
            ) : null}
            {notice ? (
              <p className="muted-text" role="status">
                {notice}
              </p>
            ) : null}
            {blockedReason ? <p className="muted-text">{blockedReason}</p> : null}

            {editable ? (
              <>
                <label className="field">
                  <span>Send to</span>
                  <input
                    className="input"
                    type="email"
                    aria-label="Send to"
                    value={sendTo}
                    onChange={(event) => setTypedTo(event.target.value)}
                  />
                </label>
                <p className="muted-text">
                  {sendTo.trim() && sendTo.trim() !== partyEmail
                    ? `For this send only: the party's address on file is ${partyEmail || 'blank'}.`
                    : `The party's address. Replies go to ${replyTo}; nothing is copied to anyone else.`}
                </p>
                <div className="button-row">
                  <button
                    type="button"
                    className="secondary-action"
                    disabled={dirty}
                    title={blockedReason || undefined}
                    onClick={() => setPreviewOpen(true)}
                  >
                    Preview
                  </button>
                  <button
                    type="button"
                    className="primary-action"
                    disabled={dirty || busy !== '' || !sendTo.trim()}
                    onClick={() => void send()}
                  >
                    {busy === 'send' ? 'Sending...' : engagement.status === 'sent' ? 'Send again' : 'Send'}
                  </button>
                </div>

                <h3>Mark as signed</h3>
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
                    <input
                      type="checkbox"
                      checked={inPerson}
                      onChange={(event) => setInPerson(event.target.checked)}
                    />
                    <span>This letter was signed in person (it was never sent from here)</span>
                  </label>
                ) : null}
                <div className="button-row">
                  <button
                    type="button"
                    className="primary-action"
                    disabled={!canSign || busy !== ''}
                    onClick={() => void sign()}
                  >
                    Mark as signed
                  </button>
                  <button type="button" className="ghost-action" disabled={busy !== ''} onClick={() => void voidIt()}>
                    Void
                  </button>
                </div>
                {!canSign ? (
                  <p className="muted-text">Send the letter first, or tick &quot;signed in person&quot;.</p>
                ) : null}
              </>
            ) : (
              <>
                <p className="muted-text">
                  {`This engagement is ${ENGAGEMENT_STATUS_LABELS[engagement.status].toLowerCase()}. Preview shows the letter as it was.`}
                </p>
                <button type="button" className="secondary-action" onClick={() => setPreviewOpen(true)}>
                  Preview
                </button>
              </>
            )}
          </div>
        </div>

        <aside className="engagement-rail">
          <div className="panel">
            <h3>Signing details</h3>
            <p className="muted-text">Kept on the engagement for when it is signed.</p>
            <label className="field">
              <span>Retainer amount</span>
              <input
                className="input"
                type="text"
                inputMode="decimal"
                aria-label="Retainer amount"
                placeholder="None"
                disabled={!editable}
                value={retainer}
                onChange={(event) => setRetainer(event.target.value)}
              />
            </label>
            <p className="muted-text">
              {monthly > 0
                ? `The default is one month's fee, ${formatProposalMoney(monthly)}. Blank means no retainer.`
                : 'Blank means no retainer.'}
            </p>
            {parsedRetainer === undefined ? (
              <p className="form-error" role="alert">
                Type the retainer as an amount, like 630 or 630.00, or leave it blank for none.
              </p>
            ) : null}
            <label className="field">
              <span>Package</span>
              <select
                className="input"
                aria-label="Package"
                disabled={!editable}
                value={packageId}
                onChange={(event) => setPackageId(event.target.value)}
              >
                <option value="">No package</option>
                {packages.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
                {packageId && !packages.some((entry) => entry.id === packageId) ? (
                  <option value={packageId}>A package that no longer exists</option>
                ) : null}
              </select>
            </label>
            <div className="new-task-menu" ref={plansMenuRef}>
              <button
                type="button"
                className="secondary-action"
                aria-expanded={plansOpen}
                disabled={!editable}
                onClick={() => setPlansOpen((open) => !open)}
              >
                {planIds.length > 0 ? `Plans · ${planIds.length}` : 'Plans'}
              </button>
              {plansOpen ? (
                <div
                  className="new-task-menu-popover plans-menu-popover"
                  role="group"
                  aria-label="Plans on this engagement"
                >
                  {(data.plans ?? []).length === 0 ? (
                    <p className="muted-text">No plans yet.</p>
                  ) : (
                    (data.plans ?? []).map((plan) => (
                      <label key={plan.id} className="check-row">
                        <input
                          type="checkbox"
                          checked={planIds.includes(plan.id)}
                          onChange={(event) =>
                            setPlanIds((ids) =>
                              event.target.checked ? [...ids, plan.id] : ids.filter((id) => id !== plan.id),
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
            {chosenPlans.length > 0 ? (
              <p className="muted-text">{`Plans: ${chosenPlans.map((plan) => plan.name).join(', ')}`}</p>
            ) : null}
          </div>

          <div className="panel">
            <h3>From the proposal</h3>
            <dl className="engagement-figures">
              <div>
                <dt>Monthly</dt>
                <dd>{formatProposalMoney(monthly)}</dd>
              </div>
              <div>
                <dt>Annual</dt>
                <dd>{formatProposalMoney(Number(totals.annual ?? 0))}</dd>
              </div>
              <div>
                <dt>One-time</dt>
                <dd>{formatProposalMoney(Number(totals.oneTime ?? 0))}</dd>
              </div>
              <div>
                <dt>Clean-up</dt>
                <dd>{formatProposalMoney(Number(totals.cleanup ?? 0))}</dd>
              </div>
            </dl>
            {hoursRows.length > 0 ? (
              <p className="engagement-hours" aria-label="Estimated monthly hours">
                <span className="muted-text">Estimated monthly hours:</span>
                {hoursRows.map((row) => (
                  <span key={row.role} className="engagement-hours-item">
                    {`${HOURS_LABELS[row.role]} ${row.value.toFixed(1)}`}
                  </span>
                ))}
              </p>
            ) : (
              <p className="muted-text">No estimated hours on the proposal.</p>
            )}
            {skipped.length > 0 ? (
              <p className="muted-text">
                {`Not in the letter: ${skipped.map((line) => `${line.name} (${line.reason})`).join(', ')}`}
              </p>
            ) : null}
          </div>

          <div className="panel">
            <h3>Sections</h3>
            {engagement.sectionKeys.length > 0 ? (
              <ol className="engagement-sections-used" aria-label="Sections used">
                {engagement.sectionKeys.map((key) => (
                  <li key={key}>{sectionTitles[key] || key}</li>
                ))}
              </ol>
            ) : (
              <p className="muted-text">No sections recorded.</p>
            )}
            {engagement.status === 'draft' ? (
              <button
                type="button"
                className="secondary-action"
                disabled={busy !== ''}
                onClick={() => void reassemble()}
              >
                Re-assemble from the proposal
              </button>
            ) : null}
          </div>

          <div className="panel">
            <h3>Activity</h3>
            {activity.length === 0 ? (
              <p className="muted-text">Nothing yet.</p>
            ) : (
              <ul className="engagement-activity" aria-label="Activity">
                {activity.map((row, index) => (
                  <li key={`${row.at}-${index}`}>
                    <span className="engagement-activity-when">{row.dayOnly ? engagementInstantLabel(row.at) : stamp(row.at)}</span>
                    <span>{row.text}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>

      {previewOpen ? (
        <DocumentPreviewModal<EngagementPreview>
          loadKey={`${engagementId}|${view.hash}|${previewTo ?? ''}`}
          load={() => previewEngagementRequest(engagementId, previewTo)}
          pdfUrl={engagementPreviewPdfUrl(engagementId, previewTo)}
          title={`What ${partyName} receives`}
          ariaLabel={`Preview of the engagement letter for ${partyName}`}
          notes={engagementPreviewNotes}
          onClose={() => setPreviewOpen(false)}
        />
      ) : null}
    </section>
  )
}

/** The sentences under the preview's title: who it goes to and what would stop Send. */
function engagementPreviewNotes(preview: EngagementPreview): string[] {
  const notes: string[] = []
  if (preview.to.length > 0) notes.push(`To: ${preview.to.join(', ')}`)
  else notes.push(preview.recipientNote ?? 'There is no email address to send to.')
  if (preview.missing.length > 0) {
    notes.push(preview.missingNote ?? `No value for ${preview.missing.map((key) => `{{${key}}}`).join(', ')}.`)
  }
  if (preview.unknown.length > 0) {
    notes.push(
      `Not a placeholder the app fills in: ${preview.unknown.map((key) => `{{${key}}}`).join(', ')}. Send refuses until it is fixed.`,
    )
  }
  if (preview.retired.length > 0) notes.push(`${retiredSentence(preview.retired)}. Send refuses until it is taken out.`)
  if (!preview.pdfAvailable) notes.push('The PDF could not be built, so Send would not send it.')
  if (preview.refusal && !notes.includes(preview.refusal)) notes.push(`Send would refuse: ${preview.refusal}`)
  return notes
}
