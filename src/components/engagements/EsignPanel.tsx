import { useCallback, useEffect, useState } from 'react'
import {
  engagementEsignPdfUrl,
  finishEngagementEsignRequest,
  listEngagementEsignRequests,
  remindEngagementEsignRequest,
  sendEngagementEsignRequest,
  esignStatusRequest,
} from '../../lib/api'
import {
  ESIGN_TEST_MODE_NOTE,
  esignBadgeText,
  esignIsActive,
  esignProviderName,
  esignRefusalSentence,
  esignWasMarkedComplete,
} from '../../lib/engagements'
import { ApiError, type EsignStatus, type SignatureRequest } from '../../lib/types'
import { dateOnlyInZone, firmToday } from '../../../lib/firm-time.js'
import { FINISHED_SIGNATURE_STATUSES } from '../../../lib/signature-statuses.js'
import type { InvoiceRecipientDetail } from '../../lib/utils'
import { esignSignerEmail, type EsignSignerPost } from '../../lib/esignSigner'
import { EsignSendConfirm } from './SignerPicker'

/**
 * E-signature for one engagement letter (featreq-56d39567; docs/signwell.md, docs/esignatures.md): the
 * status of its newest request, Send for signature, Send reminder, and Download signed PDF. Mark as signed
 * stays as the manual path beside it. The provider (eSignatures.io when its token is set, else SignWell)
 * emails the signer; the firm mails nothing from here. A request is named by its OWN provider; a new send
 * by the one the server would use now.
 *
 * Hidden when e-signature is not configured on the server AND the letter has no request (a letter that
 * was e-signed keeps showing its status and its download if the key is later removed).
 *
 * Send for signature first asks who signs (Alex, 2026-10-27; SignerPicker.tsx): the party's address chosen,
 * the client's other addresses on file offered, or one address for this send only. The confirm button names
 * the address, and the request (badge, reminders) shows the address it went to.
 */

/** The small "E-sign: sent Oct 21" tag (and "Test mode") for one request. */
export function EsignBadge({ request }: { request: SignatureRequest }) {
  return (
    <>
      <span className="status-pill">{esignBadgeText(request)}</span>
      {request.testMode ? <span className="status-pill">Test mode</span> : null}
      {esignSignerEmail(request) ? <span className="muted-text esign-signer">{` Sent to ${esignSignerEmail(request)}`}</span> : null}
    </>
  )
}

export function EsignPanel({
  engagementId,
  partyName,
  partyEmail,
  partyContactName = '',
  templateHash,
  canSend,
  disabled = false,
  refreshKey = 0,
  engagementSigned = false,
  engagementStatus,
  onRequests,
  onChanged,
}: {
  engagementId: string
  partyName: string
  partyEmail: string
  /** The party's contact, the name a one-time signer is given unless one is typed (else the party name). */
  partyContactName?: string
  /** The hash the page loaded: the server refuses a send from a stale page. */
  templateHash: string
  /** The letter can be sent (a draft or sent letter, saved). Signed and void ones only show their status. */
  canSend: boolean
  /** Something else on the page is running, or there are unsaved edits. */
  disabled?: boolean
  /** Changes when another tab or session changed data (the requests are read again). */
  refreshKey?: number
  /** The letter is marked signed: a leftover "needs attention" note is no longer shown. */
  engagementSigned?: boolean
  /**
   * The stored letter's status. A signed, void or superseded letter offers no reminder and no "when the client
   * signs" sentence; a void or superseded one offers no Finish (signing it is refused; its PDF is kept).
   */
  engagementStatus?: string
  /** Told the requests whenever they are read (a stable callback), so the page can warn while one is open. */
  onRequests?: (requests: SignatureRequest[]) => void
  /** After a send or a reminder: the page reads the engagement again. */
  onChanged?: () => void | Promise<void>
}) {
  const [status, setStatus] = useState<EsignStatus | null>(null)
  const [requests, setRequests] = useState<SignatureRequest[] | null>(null)
  const [busy, setBusy] = useState<'' | 'send' | 'remind' | 'finish'>('')
  const [confirming, setConfirming] = useState(false)
  // A refusal's list of who may sign as it is now (the confirm reopens on it), and a key that remounts the confirm.
  const [freshSigners, setFreshSigners] = useState<InvoiceRecipientDetail[] | null>(null)
  const [confirmKey, setConfirmKey] = useState(0)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [reloads, setReloads] = useState(0)

  useEffect(() => {
    let cancelled = false
    void esignStatusRequest().then(
      (next) => {
        if (!cancelled) setStatus(next)
      },
      () => {
        if (!cancelled) setStatus({ configured: false, provider: null, testMode: true })
      },
    )
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void listEngagementEsignRequests(engagementId).then(
      (rows) => {
        if (!cancelled) setRequests(rows)
      },
      () => {
        if (!cancelled) setRequests((current) => current ?? [])
      },
    )
    return () => {
      cancelled = true
    }
  }, [engagementId, refreshKey, reloads])

  const reload = useCallback(() => setReloads((count) => count + 1), [])

  useEffect(() => {
    if (requests) onRequests?.(requests)
  }, [requests, onRequests])

  if (status === null || requests === null) return null
  const latest = requests[0] ?? null
  const active = requests.find((request) => esignIsActive(request)) ?? null
  if (!status.configured && !latest) return null

  const remindedToday = Boolean(
    active?.lastRemindedAt && dateOnlyInZone(new Date(active.lastRemindedAt)) === firmToday(),
  )
  const canStart = canSend && status.configured && !active
  // The letter no longer stands: nothing to remind about, nothing to finish into it.
  const letterGone = engagementStatus === 'void' || engagementStatus === 'superseded'
  const letterClosed = engagementSigned || engagementStatus === 'signed' || letterGone
  // Completed at SignWell but not finished here (no signed PDF kept, or the letter not marked signed):
  // "Finish e-signature". Any other request that has not ended: "Check SignWell" re-reads its document.
  const canFinish =
    latest?.status === 'completed' &&
    !esignWasMarkedComplete(latest) &&
    (!latest.signedDocumentId || !engagementSigned) &&
    !letterGone
  const canCheck = Boolean(latest) && !FINISHED_SIGNATURE_STATUSES.includes(latest?.status ?? '')
  const target = partyEmail || 'the party'
  const party = { email: partyEmail, contactName: partyContactName, company: partyName }

  // Send for signature, step one: the confirm (EsignSendConfirm) reads who may sign and asks.
  const openConfirm = (fresh: InvoiceRecipientDetail[] | null = null) => {
    setFreshSigners(fresh)
    setConfirmKey((count) => count + 1)
    setConfirming(true)
  }
  const closeConfirm = () => {
    setConfirming(false)
    setFreshSigners(null)
  }
  // A new send goes through the server's provider now; a request is named by the provider it went to.
  const sendProvider = esignProviderName(status.provider)
  const latestProvider = esignProviderName(latest?.provider)
  const activeProvider = esignProviderName(active?.provider)

  const send = async (chosen: EsignSignerPost) => {
    closeConfirm()
    setBusy('send')
    setError('')
    setNotice('')
    try {
      // Always the signer she just confirmed, never one the server picks.
      const result = await sendEngagementEsignRequest(engagementId, {
        templateHash,
        signer: chosen,
      })
      setNotice(
        `Sent for signature to ${esignSignerEmail(result.request) || chosen.email}.${result.request.testMode ? ` ${ESIGN_TEST_MODE_NOTE}` : ''}`,
      )
      reload()
      await onChanged?.()
    } catch (err) {
      setError(esignRefusalSentence(err, 'send'))
      // The address she chose is no longer on file: ask again, on the list as it is now.
      if (err instanceof ApiError && err.code === 'recipients_changed') openConfirm(err.recipients ?? null)
      // Another tab got there first, or the stored letter moved: show what is stored now.
      if (err instanceof ApiError && ['signature_active', 'engagement_changed', 'engagement_refused'].includes(err.code ?? '')) {
        reload()
        await onChanged?.()
      }
    } finally {
      setBusy('')
    }
  }

  const finish = async () => {
    if (!latest) return
    setBusy('finish')
    setError('')
    setNotice('')
    try {
      const result = await finishEngagementEsignRequest(engagementId, latest.id)
      // The sentence follows what the press DID (signed / left with a reason / only re-synced), never the
      // request's status alone: a re-sync that signed nothing must not say it finished.
      if (result.issues.length > 0) {
        setNotice(`Finished what could be: ${result.issues.join('; ')}.`)
      } else if (result.signed) {
        setNotice('Finished: the signed PDF is kept and the letter is marked signed.')
      } else {
        setNotice(`Checked ${latestProvider}: still ${esignBadgeText(result.request).replace(/^E-sign: /, '')}.`)
      }
      reload()
      await onChanged?.()
    } catch (err) {
      setError(esignRefusalSentence(err, 'finish'))
      reload()
    } finally {
      setBusy('')
    }
  }

  const remind = async () => {
    setBusy('remind')
    setError('')
    setNotice('')
    try {
      await remindEngagementEsignRequest(engagementId)
      setNotice(`Reminder sent to ${esignSignerEmail(active) || target}.`)
      reload()
      await onChanged?.()
    } catch (err) {
      setError(esignRefusalSentence(err, 'remind'))
      reload()
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="esign-panel" aria-label="E-signature">
      <h3>E-signature</h3>
      {latest ? (
        <p className="esign-status">
          <EsignBadge request={latest} />
        </p>
      ) : (
        <p className="muted-text">
          {`${sendProvider} emails the signer a link to read and sign the letter, and marks it signed here when they do. You confirm who signs first: ${target}, another of the client's contacts, or an address for this send only. Mark as signed below stays as the manual way.`}
        </p>
      )}
      {/* A request still open always shows its note (e.g. a withdrawal eSignatures.io refused on a letter marked
          signed); a finished one's leftover note is dropped once the letter is signed. */}
      {latest?.lastError && (!FINISHED_SIGNATURE_STATUSES.includes(latest.status) || !engagementSigned) ? (
        <p className="form-error" role="status">
          {`Needs attention: ${latest.lastError}.`}
        </p>
      ) : null}
      {latest?.finishingAt && latest.status === 'completed' && (!latest.signedDocumentId || !engagementSigned) ? (
        <p className="muted-text">Finishing this signature (keeping the signed PDF and marking the letter signed)...</p>
      ) : null}
      {active && !letterClosed ? (
        <p className="muted-text">
          {`When the client signs, the letter is marked signed here for you. ${
            active.provider === 'esignatures'
              ? `Marking it signed by hand or voiding it withdraws the request at ${activeProvider}.`
              : `Voiding it withdraws the request here only - cancel it at ${activeProvider} yourself; marking it signed by hand leaves it as it is.`
          }`}
        </p>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="muted-text" role="status">
          {notice}
        </p>
      ) : null}

      {confirming ? (
        <EsignSendConfirm
          key={confirmKey}
          engagementId={engagementId}
          partyName={partyName}
          party={party}
          provider={status.provider}
          testMode={status.testMode}
          fresh={freshSigners}
          busy={busy !== ''}
          onSend={(chosen) => void send(chosen)}
          onCancel={closeConfirm}
        />
      ) : (
        <div className="button-row">
          {canStart ? (
            <button
              type="button"
              className="secondary-action"
              disabled={disabled || busy !== ''}
              onClick={() => {
                setError('')
                setNotice('')
                openConfirm()
              }}
            >
              {busy === 'send' ? 'Sending...' : 'Send for signature'}
            </button>
          ) : null}
          {active && !letterClosed ? (
            <button
              type="button"
              className="secondary-action"
              disabled={disabled || busy !== '' || remindedToday}
              title={remindedToday ? 'A reminder already went out today.' : undefined}
              onClick={() => void remind()}
            >
              {busy === 'remind' ? 'Sending...' : 'Send reminder'}
            </button>
          ) : null}
          {canFinish || canCheck ? (
            <button type="button" className="secondary-action" disabled={disabled || busy !== ''} onClick={() => void finish()}>
              {busy === 'finish' ? (canFinish ? 'Finishing...' : 'Checking...') : canFinish ? 'Finish e-signature' : `Check ${latestProvider}`}
            </button>
          ) : null}
          {latest?.status === 'completed' && latest.signedDocumentId ? (
            <a className="secondary-action" href={engagementEsignPdfUrl(engagementId, latest.id)} download>
              Download signed PDF
            </a>
          ) : null}
        </div>
      )}
      {remindedToday ? <p className="muted-text">A reminder already went out today.</p> : null}
    </div>
  )
}

