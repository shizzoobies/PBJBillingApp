import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { createAmendmentRequest, listEngagementsRequest, listLettersRequest, restoreEngagementRequest } from '../lib/api'
import { ENGAGEMENT_KIND_LABELS, ENGAGEMENT_STATUS_LABELS, engagementInstantLabel } from '../lib/engagements'
import { ApiError, type Engagement, type LetterSummary } from '../lib/types'
import { SignEngagementDialog } from './engagements/SignEngagement'

/**
 * The Engagements card on a client's Billing tab (engagements stage 4,
 * docs/plans/engagements-2026-10.md): this client's engagement letters - the
 * original, its amendments (each Letters send is one) and any superseding letter -
 * newest first, each with its kind, status, sent and signed dates and an Open link.
 * "New amendment" starts a draft from one of the saved Letters and opens it in the
 * editor. A sent letter (or a draft signed in person) has **Mark as signed**, the
 * editor's own form in a dialog (featreq-b2142264). An amendment a superseding letter
 * replaced has **Restore** (featreq-e5ae8279). Owner only: the Billing tab is, and the
 * card renders nothing otherwise.
 */
export function ClientEngagementsCard({
  clientId,
  ownerMode,
  refreshKey = 0,
  client = null,
  plans = [],
}: {
  clientId: string
  ownerMode: boolean
  /** Changes when another tab or session changed data (the list is read again). */
  refreshKey?: number
  /** The client as the page has it: its name, and whether signing's fee choice matters. */
  client?: { name?: string; billingMode?: string | null; monthlyRate?: number | null } | null
  /** The workspace plans, to name the ones signing added. */
  plans?: { id: string; name: string }[]
}) {
  const navigate = useNavigate()
  const [engagements, setEngagements] = useState<Engagement[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [letters, setLetters] = useState<LetterSummary[] | null>(null)
  const [picking, setPicking] = useState(false)
  const [letterId, setLetterId] = useState('')
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')
  // The letter Mark as signed is open for, and a bump that reads the list again after it.
  const [signing, setSigning] = useState<Engagement | null>(null)
  const [reloads, setReloads] = useState(0)
  // The replaced amendment being restored (one at a time).
  const [restoringId, setRestoringId] = useState('')

  useEffect(() => {
    if (!ownerMode) return
    let cancelled = false
    listEngagementsRequest({ clientId }).then(
      (rows) => {
        if (cancelled) return
        setEngagements(rows)
        setLoadError('')
      },
      (err) => {
        if (cancelled) return
        setLoadError(err instanceof ApiError ? err.message : 'Could not load the engagements.')
      },
    )
    return () => {
      cancelled = true
    }
  }, [clientId, ownerMode, refreshKey, reloads])

  if (!ownerMode) return null

  const openPicker = () => {
    setPicking(true)
    setError('')
    if (letters !== null) return
    listLettersRequest().then(
      (state) => {
        setLetters(state.letters)
        if (state.letters.length > 0) setLetterId((current) => current || state.letters[0].id)
      },
      (err) => {
        setLetters([])
        setError(err instanceof ApiError ? err.message : 'Could not load the saved letters.')
      },
    )
  }

  const start = async () => {
    if (!letterId) return
    setStarting(true)
    setError('')
    try {
      const created = await createAmendmentRequest(clientId, letterId)
      navigate(`/engagements/${created.id}`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start the amendment.')
      setStarting(false)
    }
  }

  const restore = async (engagement: Engagement) => {
    // The status it goes back to is read off its own dates, like the server does.
    const back = engagement.signedAt ? 'Signed' : engagement.sentAt ? 'Sent' : 'Draft'
    const ok = window.confirm(
      `Restore the amendment "${engagement.subject || engagement.id}"? It goes back to ${back}. A fee or plans the replacing letter changed are not brought back, and a restored draft or sent amendment applies its own fee and plans if it is signed later.`,
    )
    if (!ok) return
    setRestoringId(engagement.id)
    setError('')
    try {
      await restoreEngagementRequest(engagement.id)
      setReloads((count) => count + 1)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not restore the amendment.')
    } finally {
      setRestoringId('')
    }
  }

  return (
    <div className="client-engagements" aria-label="Client engagements">
      {loadError ? (
        <p className="form-error" role="alert">
          {loadError}
        </p>
      ) : null}
      {engagements === null && !loadError ? <p className="muted-text">Loading the engagements…</p> : null}
      {engagements !== null && engagements.length === 0 ? (
        <p className="muted-text">
          No engagement letters for this client yet. A signed proposal&apos;s letter, each Letters send and each
          amendment you start here are listed here.
        </p>
      ) : null}
      {engagements !== null && engagements.length > 0 ? (
        <div className="table-wrap">
          <table className="report-table">
            <thead>
              <tr>
                <th>Kind</th>
                <th>Status</th>
                <th>Subject</th>
                <th>Sent</th>
                <th>Signed</th>
                <th aria-label="Open" />
              </tr>
            </thead>
            <tbody>
              {engagements.map((engagement) => (
                <tr key={engagement.id}>
                  <td>{ENGAGEMENT_KIND_LABELS[engagement.kind] ?? engagement.kind}</td>
                  <td>
                    <span className="status-pill">{ENGAGEMENT_STATUS_LABELS[engagement.status] ?? engagement.status}</span>
                  </td>
                  <td>{engagement.subject || '-'}</td>
                  <td>{engagementInstantLabel(engagement.sentAt) || '-'}</td>
                  <td>{engagementInstantLabel(engagement.signedAt) || '-'}</td>
                  <td>
                    <div className="button-row">
                      <Link to={`/engagements/${engagement.id}`} aria-label={`Open ${ENGAGEMENT_KIND_LABELS[engagement.kind] ?? 'engagement'} ${engagement.id}`}>
                        Open
                      </Link>
                      {engagement.status === 'sent' || engagement.status === 'draft' ? (
                        <button type="button" className="ghost-action" onClick={() => setSigning(engagement)}>
                          Mark as signed
                        </button>
                      ) : null}
                      {engagement.kind === 'amendment' && engagement.status === 'superseded' ? (
                        <button
                          type="button"
                          className="ghost-action"
                          disabled={restoringId !== ''}
                          onClick={() => void restore(engagement)}
                        >
                          Restore
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {picking ? (
        <div className="form-grid two-col">
          <label className="field">
            <span>Start from the saved letter</span>
            <select
              className="input"
              aria-label="Letter for the amendment"
              value={letterId}
              disabled={letters === null || letters.length === 0 || starting}
              onChange={(event) => setLetterId(event.target.value)}
            >
              {letters === null ? <option value="">Loading the letters…</option> : null}
              {letters !== null && letters.length === 0 ? <option value="">No saved letters</option> : null}
              {(letters ?? []).map((letter) => (
                <option key={letter.id} value={letter.id}>
                  {letter.name}
                </option>
              ))}
            </select>
          </label>
          <div className="field">
            <span aria-hidden="true">&nbsp;</span>
            <div className="button-row">
              <button type="button" className="primary-action" disabled={!letterId || starting} onClick={() => void start()}>
                {starting ? 'Starting…' : 'Start the amendment'}
              </button>
              <button type="button" className="ghost-action" disabled={starting} onClick={() => setPicking(false)}>
                Cancel
              </button>
            </div>
          </div>
          {letters !== null && letters.length === 0 && !error ? (
            <p className="muted-text">Write a letter on the Letters page first; an amendment starts from one.</p>
          ) : null}
        </div>
      ) : (
        <div className="button-row">
          <button type="button" className="ghost-action" onClick={openPicker}>
            New amendment
          </button>
        </div>
      )}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {/* After a signing the list reads again; the server's data-changed broadcast refreshes the page. */}
      {signing ? (
        <SignEngagementDialog
          engagement={signing}
          client={client}
          clientName={client?.name || 'The client'}
          planName={(planId) => plans.find((plan) => plan.id === planId)?.name ?? 'a plan'}
          onSigned={() => setReloads((count) => count + 1)}
          onClose={() => setSigning(null)}
        />
      ) : null}
    </div>
  )
}
