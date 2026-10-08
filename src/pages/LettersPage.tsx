import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppContext } from '../AppContext'
import { ListSearch } from '../components/ListSearch'
import { LetterPreviewModal } from '../components/LetterPreviewModal'
import { SaveBadge } from '../components/SectionKit'
import {
  fetchLetterTemplate,
  listLetterSendsRequest,
  saveLetterTemplate,
  sendLettersRequest,
} from '../lib/api'
import type { SaveFlashState } from '../lib/useSaveFlash'
import { firmToday } from '../../lib/firm-time.js'
import { invoiceEmailAddressee, resolveInvoiceRecipients } from '../../lib/invoice-recipients.js'
import { templateWarnings } from '../../lib/letter-template.js'
import {
  ApiError,
  type Client,
  type LetterSendRecord,
  type LetterSendResult,
  type LetterTemplateState,
} from '../lib/types'

/** Clients are sent in chunks of this many so the page can show progress. */
const SEND_CHUNK = 10

/**
 * A 1099 engagement letter is what a newly signed (onboarding) client needs as much as
 * an established one, so both are listed by default; inactive and proposal-stage
 * clients sit behind the checkbox.
 */
const SHOWN_BY_DEFAULT = new Set(['active', 'onboarding'])

/** A claim still "sending" after this long was not closed: the send was interrupted. */
const UNFINISHED_AFTER_MS = 10 * 60 * 1000

type Field = 'subject' | 'emailBody' | 'letterBody'

/** "2026-10-08" -> "Oct 8, 2026" (the firm's calendar day, not the browser's). */
function dayLabel(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return day
  return new Date(`${day}T12:00:00`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function unknownSentence(unknown: string[]): string {
  const tokens = unknown.map((key) => `{{${key}}}`)
  return tokens.length > 1
    ? `${tokens.join(', ')} are not placeholders the app fills in. Send will refuse until they are changed.`
    : `${tokens[0]} is not a placeholder the app fills in. Send will refuse until it is changed.`
}

type PickerRow = {
  client: Client
  contactName: string
  to: string[]
  /** Why this client cannot be picked, or null when it can. */
  blocked: string | null
  pills: string[]
  lastSent: string
}

/**
 * Letters (featreq-5e195707) - the engagement letter. One email and one letter
 * written once with {{placeholders}}; pick the clients; Send gives each of them
 * the email with the letter attached as a PDF. Replies go to the invoice mailbox.
 * Everything a letter says about a client is filled in by the server, from the
 * SAVED letter, with the same code Preview shows - so Preview and Send are
 * disabled while the editor holds unsaved text.
 */
export function LettersPage() {
  const { ownerMode, data, dataRefreshCount } = useAppContext()

  const [state, setState] = useState<LetterTemplateState | null>(null)
  const [loadError, setLoadError] = useState('')
  const [subject, setSubject] = useState('')
  const [emailBody, setEmailBody] = useState('')
  const [letterBody, setLetterBody] = useState('')
  const [saveState, setSaveState] = useState<SaveFlashState>('idle')
  const [saveError, setSaveError] = useState('')

  const [sends, setSends] = useState<LetterSendRecord[]>([])
  // The clock a "still sending" row is judged against: read when the log arrives and once a minute.
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  const [query, setQuery] = useState('')
  const [includeInactive, setIncludeInactive] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [previewId, setPreviewId] = useState<string | null>(null)

  const [sending, setSending] = useState(false)
  const [progress, setProgress] = useState('')
  const [sendError, setSendError] = useState('')
  const [results, setResults] = useState<LetterSendResult[]>([])

  const subjectRef = useRef<HTMLInputElement>(null)
  const emailBodyRef = useRef<HTMLTextAreaElement>(null)
  const letterBodyRef = useRef<HTMLTextAreaElement>(null)

  const saved = state?.template
  const dirty =
    saved !== undefined &&
    (subject !== saved.subject || emailBody !== saved.emailBody || letterBody !== saved.letterBody)
  const dirtyRef = useRef(false)
  useEffect(() => {
    dirtyRef.current = dirty
  }, [dirty])

  const adopt = useCallback((next: LetterTemplateState, { overwriteText }: { overwriteText: boolean }) => {
    setState(next)
    if (overwriteText) {
      setSubject(next.template.subject)
      setEmailBody(next.template.emailBody)
      setLetterBody(next.template.letterBody)
    }
  }, [])

  const refreshSends = useCallback(async () => {
    try {
      setSends(await listLetterSendsRequest())
    } catch {
      // The log is context for the table; a failed read leaves what was on screen.
    }
  }, [])

  // Load the letter and the log; again when another tab or session changes data.
  useEffect(() => {
    if (!ownerMode) return
    let cancelled = false
    void fetchLetterTemplate()
      .then((next) => {
        if (cancelled) return
        setLoadError('')
        adopt(next, { overwriteText: !dirtyRef.current })
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof ApiError ? err.message : 'Could not load the letter.')
      })
    void listLetterSendsRequest()
      .then((rows) => {
        if (!cancelled) setSends(rows)
      })
      .catch(() => {
        if (!cancelled) setSends([])
      })
    return () => {
      cancelled = true
    }
  }, [ownerMode, dataRefreshCount, adopt])

  const warnings = useMemo(
    () => templateWarnings({ subject, emailBody, letterBody }).unknown,
    [subject, emailBody, letterBody],
  )

  const save = async () => {
    setSaveState('saving')
    setSaveError('')
    try {
      const next = await saveLetterTemplate({ subject, emailBody, letterBody })
      adopt(next, { overwriteText: true })
      setSaveState('saved')
      window.setTimeout(() => setSaveState('idle'), 1800)
    } catch (err) {
      setSaveState('error')
      setSaveError(err instanceof ApiError ? err.message : 'Could not save the letter.')
    }
  }

  const insertToken = (field: Field, key: string) => {
    const token = `{{${key}}}`
    const values = { subject, emailBody, letterBody }
    const setters = { subject: setSubject, emailBody: setEmailBody, letterBody: setLetterBody }
    const refs = { subject: subjectRef, emailBody: emailBodyRef, letterBody: letterBodyRef }
    const element = refs[field].current
    const current = values[field]
    const start = element?.selectionStart ?? current.length
    const end = element?.selectionEnd ?? start
    setters[field](current.slice(0, start) + token + current.slice(end))
    window.requestAnimationFrame(() => {
      const target = refs[field].current
      if (!target) return
      target.focus()
      target.setSelectionRange(start + token.length, start + token.length)
    })
  }

  /* ---- the picker -------------------------------------------------------- */

  const clients = useMemo(() => data.clients ?? [], [data.clients])
  const contacts = useMemo(() => data.contacts ?? [], [data.contacts])
  const today = firmToday()

  const rows = useMemo<PickerRow[]>(() => {
    const byId = new Map(contacts.map((contact) => [contact.id, contact]))
    const latest = new Map<string, LetterSendRecord>()
    const lastSentRow = new Map<string, LetterSendRecord>()
    // `sends` is newest first: the first row seen per client is its newest.
    for (const send of sends) {
      if (!latest.has(send.clientId)) latest.set(send.clientId, send)
      if (send.status === 'sent' && !lastSentRow.has(send.clientId)) lastSentRow.set(send.clientId, send)
    }
    return clients.map((client): PickerRow => {
      const { addressee, refusal } = invoiceEmailAddressee(client, clients)
      const to = refusal ? [] : resolveInvoiceRecipients({ client: addressee, contacts }).to
      const linked = (client.contactIds ?? [])
        .map((id) => byId.get(id))
        .find((contact) => contact && !contact.archivedAt && contact.name?.trim())
      const master = client.billToClientId ? clients.find((entry) => entry.id === client.billToClientId) : null
      const stage = client.lifecycleStage ?? 'active'

      const pills: string[] = []
      if (client.invoiceNoEmail) pills.push('Invoices never emailed')
      if (client.platformInvoicingOptOut) pills.push('Billed outside the app')
      if (stage === 'inactive') pills.push('Inactive')
      if (stage === 'proposal') pills.push('Proposal stage')
      if (master) pills.push(`Billed through ${master.name}`)
      if (refusal) pills.push('No receiving company set')

      let blocked: string | null = null
      if (refusal) blocked = refusal.message
      else if (to.length === 0) blocked = 'No email on file'

      const sent = lastSentRow.get(client.id)
      const newest = latest.get(client.id)
      let lastSent = '-'
      if (sent) {
        lastSent = `${dayLabel(sent.firmDay)}${sent.delivery ? ` - ${sent.delivery}` : ''}`
      } else if (newest?.status === 'failed') {
        lastSent = `Failed: ${newest.error ?? 'not sent'}`
      } else if (newest?.status === 'sending') {
        const startedAt = Date.parse(newest.createdAt ?? '')
        lastSent =
          Number.isFinite(startedAt) && nowMs - startedAt > UNFINISHED_AFTER_MS
            ? 'Did not finish - check before sending again'
            : 'Sending...'
      }

      return {
        client,
        contactName: linked?.name?.trim() || client.contact || '',
        to,
        blocked,
        pills,
        lastSent,
      }
    })
  }, [clients, contacts, sends, nowMs])

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return rows
      .filter((row) => includeInactive || SHOWN_BY_DEFAULT.has(row.client.lifecycleStage ?? 'active'))
      .filter(
        (row) =>
          !needle ||
          [row.client.name, row.contactName, ...row.to].some((value) =>
            String(value ?? '').toLowerCase().includes(needle),
          ),
      )
      .slice()
      .sort((a, b) => a.client.name.localeCompare(b.client.name))
  }, [rows, includeInactive, query])

  const selectableIds = useMemo(
    () => new Set(rows.filter((row) => row.blocked === null).map((row) => row.client.id)),
    [rows],
  )
  const chosen = [...selected].filter((id) => selectableIds.has(id))

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  /* ---- sending ------------------------------------------------------------ */

  const sendBatch = async (ids: string[], { resend }: { resend: boolean }) => {
    if (!state || ids.length === 0) return
    setSending(true)
    setSendError('')
    setResults((current) => current.filter((result) => !ids.includes(result.clientId)))
    let done = 0
    try {
      for (let at = 0; at < ids.length; at += SEND_CHUNK) {
        const chunk = ids.slice(at, at + SEND_CHUNK)
        setProgress(`Sending ${Math.min(done + 1, ids.length)} to ${Math.min(done + chunk.length, ids.length)} of ${ids.length}...`)
        const answer = await sendLettersRequest({
          clientIds: chunk,
          templateHash: state.hash,
          ...(resend ? { resendToday: true } : {}),
        })
        done += chunk.length
        setResults((current) => [
          ...current.filter((result) => !chunk.includes(result.clientId)),
          ...answer.results,
        ])
        await refreshSends()
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'letter_changed') {
        // Someone saved a different letter: show it, and stop before sending more.
        try {
          adopt(await fetchLetterTemplate(), { overwriteText: !dirtyRef.current })
        } catch {
          // The sentence below still tells her to reload.
        }
      }
      setSendError(err instanceof ApiError ? err.message : 'Could not send the letters.')
    } finally {
      setSending(false)
      setProgress('')
    }
  }

  const sendSelected = async () => {
    if (chosen.length === 0) return
    const replyTo = state?.sender.replyTo || 'the reply address'
    const count = chosen.length
    const ok = window.confirm(
      `Send the engagement letter to ${count} client${count === 1 ? '' : 's'}? Each gets your email with the letter attached as a PDF. Replies go to ${replyTo}.`,
    )
    if (!ok) return
    await sendBatch(chosen, { resend: false })
  }

  const nameOf = (id: string, fallback: string | null) =>
    clients.find((client) => client.id === id)?.name ?? fallback ?? 'This client'

  const failedIds = results.filter((result) => result.status === 'failed').map((result) => result.clientId)

  const sendAnyway = async (id: string, why: 'sent' | 'unfinished' = 'sent') => {
    const name = nameOf(id, null)
    const ok = window.confirm(
      why === 'unfinished'
        ? `Send the letter to ${name} again? An earlier send to them never finished, so check that it did not go out first.`
        : `Send the letter to ${name} again? It was already sent today.`,
    )
    if (!ok) return
    await sendBatch([id], { resend: true })
  }

  const sentToday = (id: string) =>
    sends.some(
      (send) =>
        send.clientId === id &&
        send.status === 'sent' &&
        send.firmDay === today &&
        send.templateHash === state?.hash,
    )

  if (!ownerMode) return null

  const editorLocked = !state
  const blockedReason = dirty ? 'Save the letter to preview or send it.' : ''
  const previewClient = previewId ? clients.find((client) => client.id === previewId) : null
  const fieldHint = (field: Field) => {
    if (field === 'subject') return ''
    return field === 'emailBody'
      ? 'This is the email. The letter rides along as a PDF.'
      : "Blank lines start a new paragraph. The firm letterhead, the date and the client's address are added above it."
  }

  const chips = (field: Field) => (
    <div className="letters-chips" role="group" aria-label={`Insert a placeholder into the ${field === 'subject' ? 'subject' : field === 'emailBody' ? 'email' : 'letter'}`}>
      {(state?.placeholders ?? []).map((placeholder) => (
        <button
          key={placeholder.key}
          type="button"
          className="letters-chip"
          title={placeholder.description}
          onClick={() => insertToken(field, placeholder.key)}
        >
          {`{{${placeholder.key}}}`}
        </button>
      ))}
    </div>
  )

  return (
    <section className="content-grid" id="letters">
      <div className="panel letters-editor">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Engagements</p>
            <h2>Letters</h2>
            <p className="section-subtitle">
              Write the engagement letter once with placeholders, then send it to the clients you choose.
            </p>
          </div>
        </div>

        {loadError ? (
          <p className="form-error" role="alert">
            {loadError}
          </p>
        ) : null}

        <h3>The letter</h3>
        <label className="field">
          <span>Subject</span>
          <input
            ref={subjectRef}
            className="input"
            type="text"
            maxLength={200}
            disabled={editorLocked}
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
          />
        </label>
        {chips('subject')}

        <label className="field">
          <span>Email body</span>
          <textarea
            ref={emailBodyRef}
            className="input"
            rows={8}
            maxLength={20000}
            disabled={editorLocked}
            value={emailBody}
            onChange={(event) => setEmailBody(event.target.value)}
          />
        </label>
        <p className="muted-text">{fieldHint('emailBody')}</p>
        {chips('emailBody')}

        <label className="field">
          <span>Letter body</span>
          <textarea
            ref={letterBodyRef}
            className="input"
            rows={18}
            maxLength={20000}
            disabled={editorLocked}
            value={letterBody}
            onChange={(event) => setLetterBody(event.target.value)}
          />
        </label>
        <p className="muted-text">{fieldHint('letterBody')}</p>
        {chips('letterBody')}

        {warnings.length > 0 ? (
          <p className="form-error" role="status">
            {unknownSentence(warnings)}
          </p>
        ) : null}
        {saveError ? (
          <p className="form-error" role="alert">
            {saveError}
          </p>
        ) : null}

        <div className="button-row">
          <button
            type="button"
            className="primary-action"
            disabled={editorLocked || !dirty || saveState === 'saving'}
            onClick={() => void save()}
          >
            Save
          </button>
          <SaveBadge state={saveState} />
          {saved?.updatedAt ? (
            <span className="muted-text">
              Last saved {new Date(saved.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              {saved.updatedByName ? ` by ${saved.updatedByName}` : ''}
            </span>
          ) : null}
        </div>
        {state ? (
          <p className="muted-text">
            Letters come from {state.sender.from || 'the invoice address (not set)'} and replies go to{' '}
            {state.sender.replyTo || 'no one (no reply address is set)'}. Nothing is copied to anyone else.
          </p>
        ) : null}
      </div>

      <div className="panel">
        <div className="section-heading">
          <div>
            <h3>Send to</h3>
            <p className="section-subtitle">
              Each client gets your email with the letter attached as a PDF, filled in for them.
            </p>
          </div>
        </div>

        <div className="button-row">
          <ListSearch
            value={query}
            onChange={setQuery}
            placeholder="Search clients"
            resultCount={shown.length}
            total={rows.length}
          />
          <label className="check-row">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(event) => setIncludeInactive(event.target.checked)}
            />
            <span>Include inactive and proposal-stage clients</span>
          </label>
          <button
            type="button"
            className="ghost-action"
            onClick={() =>
              setSelected((current) => {
                const next = new Set(current)
                for (const row of shown) if (row.blocked === null) next.add(row.client.id)
                return next
              })
            }
          >
            Select all shown
          </button>
          <button type="button" className="ghost-action" onClick={() => setSelected(new Set())}>
            Clear
          </button>
          <span className="muted-text">{chosen.length} selected</span>
        </div>

        <div className="table-scroll">
          <table className="report-table">
            <thead>
              <tr>
                <th aria-label="Select" />
                <th>Client</th>
                <th>Email</th>
                <th>Flags</th>
                <th>Last sent</th>
                <th aria-label="Preview" />
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 ? (
                <tr>
                  <td colSpan={6}>
                    <p className="empty-state">No clients match.</p>
                  </td>
                </tr>
              ) : null}
              {shown.map((row) => (
                <tr key={row.client.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${row.client.name}`}
                      checked={row.blocked === null && selected.has(row.client.id)}
                      disabled={row.blocked !== null || sending}
                      onChange={() => toggle(row.client.id)}
                    />
                  </td>
                  <td>
                    <strong>{row.client.name}</strong>
                    {row.contactName ? <div className="muted-text">{row.contactName}</div> : null}
                  </td>
                  <td>{row.to.length > 0 ? row.to.join(', ') : <span className="muted-text">No email on file</span>}</td>
                  <td>
                    <div className="button-row">
                      {row.pills.map((pill) => (
                        <span key={pill} className="status-pill">
                          {pill}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td>
                    {row.lastSent}
                    {sentToday(row.client.id) ? (
                      <button
                        type="button"
                        className="ghost-action"
                        disabled={sending || dirty}
                        onClick={() => void sendAnyway(row.client.id)}
                      >
                        Send again
                      </button>
                    ) : null}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="ghost-action"
                      disabled={dirty || !state}
                      title={blockedReason || undefined}
                      onClick={() => setPreviewId(row.client.id)}
                    >
                      Preview
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {blockedReason ? <p className="muted-text">{blockedReason}</p> : null}
        {sendError ? (
          <p className="form-error" role="alert">
            {sendError}
          </p>
        ) : null}

        <div className="button-row">
          <button
            type="button"
            className="primary-action"
            disabled={sending || dirty || chosen.length === 0 || !state}
            onClick={() => void sendSelected()}
          >
            {`Send to ${chosen.length} client${chosen.length === 1 ? '' : 's'}`}
          </button>
          {progress ? <span className="muted-text">{progress}</span> : null}
        </div>

        {results.length > 0 ? (
          <div aria-label="Send results">
            <h3>Results</h3>
            <p className="muted-text">
              {results.filter((result) => result.status === 'sent').length} sent,{' '}
              {results.filter((result) => result.status === 'skipped').length} skipped,{' '}
              {failedIds.length} failed.
            </p>
            <ul className="letters-results">
              {results.map((result) => (
                <li key={result.clientId}>
                  <strong>{nameOf(result.clientId, result.clientName)}</strong>:{' '}
                  {result.status === 'sent' ? (
                    <span>Sent to {(result.to ?? []).join(', ')}</span>
                  ) : result.code === 'already_sent' ? (
                    <span>
                      Already sent today.{' '}
                      <button
                        type="button"
                        className="ghost-action"
                        disabled={sending}
                        onClick={() => void sendAnyway(result.clientId)}
                      >
                        Send again anyway
                      </button>
                    </span>
                  ) : result.code === 'unfinished' ? (
                    <span>
                      Not sent: {result.message}{' '}
                      <button
                        type="button"
                        className="ghost-action"
                        disabled={sending}
                        onClick={() => void sendAnyway(result.clientId, 'unfinished')}
                      >
                        Send again anyway
                      </button>
                    </span>
                  ) : (
                    <span>
                      {result.status === 'failed' ? 'Failed: ' : 'Not sent: '}
                      {result.message}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            {failedIds.length > 0 ? (
              <button
                type="button"
                className="secondary-action"
                disabled={sending || dirty}
                onClick={() => void sendBatch(failedIds, { resend: false })}
              >
                {`Send again to the ${failedIds.length} that failed`}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {previewId && previewClient ? (
        <LetterPreviewModal
          clientId={previewId}
          clientName={previewClient.name}
          onClose={() => setPreviewId(null)}
        />
      ) : null}
    </section>
  )
}
