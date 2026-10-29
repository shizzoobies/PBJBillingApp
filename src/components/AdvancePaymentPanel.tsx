import { useEffect, useRef, useState } from 'react'
import { advancePaymentRequest } from '../lib/api'
import { currency } from '../lib/utils'
import { ApiError } from '../lib/types'
import { ClientBillingDefaultsForm, type BillingDefaults } from './ClientBillingDefaultsForm'

type Advance = { id: string; number: string; requestedCents: number; receivedCents: number; outstandingCents: number; canceledAt: string | null; note: string }
type Receipt = { requestId: string; sourceRef: string; cents: number; receivedOn: string; method: string }
type Ledger = { requests: Advance[]; receipts: Receipt[]; reversals: Array<{ sourceRef: string; reason: string }>; settings: BillingDefaults[] }
type PendingReceipt = { requestId: string; amount: string; day: string }
function pendingReceipt(clientId: string): PendingReceipt | null {
  try { return JSON.parse(localStorage.getItem(`pbj-pending-receipt:${clientId}`) || 'null') as PendingReceipt | null } catch { return null }
}
export function AdvancePaymentPanel({ clientId, disabled = false, onChanged }: { clientId: string; disabled?: boolean; onChanged: () => void }) {
  const [ledger, setLedger] = useState<Ledger | null>(null)
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [method, setMethod] = useState('')
  const [allocation, setAllocation] = useState('general')
  const [forPeriod, setForPeriod] = useState('')
  const [pending, setPending] = useState(() => pendingReceipt(clientId))
  const [selected, setSelected] = useState(() => pendingReceipt(clientId)?.requestId || '')
  const [received, setReceived] = useState(() => pendingReceipt(clientId)?.amount || '')
  const [day, setDay] = useState(() => pendingReceipt(clientId)?.day || '')
  const [holdRef, setHoldRef] = useState('')
  const [holdReason, setHoldReason] = useState('')
  const [message, setMessage] = useState('')
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState(false)
  const [reload, setReload] = useState(0)
  // Retain IDs across errors, including an uncertain server response. Each form
  // has its own key so an unrelated action cannot change a pending receipt ID.
  const ids = useRef(new Map<string, string>())
  const requestId = (key: string) => {
    const saved = localStorage.getItem(`pbj-advance-pending:${clientId}:${key}`)
    const id = saved || ids.current.get(key) || crypto.randomUUID()
    localStorage.setItem(`pbj-advance-pending:${clientId}:${key}`, id)
    ids.current.set(key, id)
    return id
  }
  const complete = (key: string) => { ids.current.delete(key); localStorage.removeItem(`pbj-advance-pending:${clientId}:${key}`) }
  useEffect(() => {
    let stale = false
    advancePaymentRequest<Ledger>(`?clientId=${encodeURIComponent(clientId)}`).then((value) => { if (!stale) setLedger(value) }, (error: unknown) => { if (!stale) setMessage(error instanceof Error ? error.message : 'Could not load advance requests.') })
    return () => { stale = true }
  }, [clientId, reload])
  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setMessage(''); setLink('')
    try { await action(); setReload((n) => n + 1); onChanged() }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Could not confirm the action. Entries are retained for retry.') }
    finally { setBusy(false) }
  }
  const moneyValid = (value: string) => value.trim() !== '' && Number(value) >= 0.01 && Number(value) <= 1_000_000
  const create = async () => {
    const key = JSON.stringify(['create', clientId, amount, note, method, allocation, forPeriod])
    await advancePaymentRequest('', { id: requestId(key), clientId, amount: Number(amount), note, collectionMethod: method || null, forPeriod: allocation === 'month' ? forPeriod : null })
    complete(key); setAmount(''); setNote(''); setMessage('Request created. Download the request or create a bank payment link to share with the client. No credit exists until payment arrives.')
  }
  const record = async () => {
    if (pending && (selected !== pending.requestId || Math.round(Number(received) * 100) !== Math.round(Number(pending.amount) * 100) || day !== pending.day)) {
      setSelected(pending.requestId); setReceived(pending.amount); setDay(pending.day)
      throw new Error('The pending receipt must be confirmed first. Its original entries have been restored; retry them to avoid recording the same money twice.')
    }
    const key = JSON.stringify(['receipt', selected, Math.round(Number(received) * 100), day])
    const value = { requestId: selected, amount: received, day }
    localStorage.setItem(`pbj-pending-receipt:${clientId}`, JSON.stringify(value)); setPending(value)
    try {
      const result = await advancePaymentRequest<{ linkWarning?: string }>(`/${selected}/receipt`, { id: requestId(key), amount: Number(received), receivedOn: day })
      complete(key); localStorage.removeItem(`pbj-pending-receipt:${clientId}`); setPending(null); setReceived(''); setDay(''); setMessage(result.linkWarning || 'Payment recorded as reusable credit. Generate the next monthly invoice, or use Apply credit on account on an existing draft.')
    } catch (error) {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) { localStorage.removeItem(`pbj-pending-receipt:${clientId}`); setPending(null) }
      throw error
    }
  }
  return <section aria-label="Advance payments" className="advance-payment-panel">
    <h3>Advance payments</h3>
    {ledger ? <ClientBillingDefaultsForm clientId={clientId} settings={ledger.settings} onSaved={() => setReload((n) => n + 1)} /> : null}
    <p className="muted-text">Request any agreed advance for an hourly or plan client. Record only money actually received. Do not also add it using Add credit or a retainer: that would count the same money twice.</p>
    {!disabled ? <div className="form-grid two-col">
      <label className="field"><span>Advance amount</span><input className="input" type="number" min="0.01" max="1000000" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy} /></label>
      <label className="field"><span>Request note</span><input className="input" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} /></label>
      <label className="field"><span>Request payment method</span><select className="input" value={method} onChange={(e) => setMethod(e.target.value)} disabled={busy}><option value="">Choose when collecting</option><option value="bank">Bank payment link</option><option value="manual">Payment outside the app</option></select></label>
      <label className="field"><span>Apply received credit to</span><select className="input" value={allocation} onChange={(e) => setAllocation(e.target.value)} disabled={busy}><option value="general">General balance for future invoices</option><option value="month">A billing month or later</option></select></label>
      {allocation === 'month' ? <label className="field"><span>Reserved billing month</span><input className="input" type="month" value={forPeriod} onChange={(e) => setForPeriod(e.target.value)} disabled={busy} /></label> : null}
      <button type="button" className="link-button" disabled={busy || !ledger} onClick={() => {
        const current = [...(ledger?.settings ?? [])].filter((row) => row.effectivePeriod <= new Date().toISOString().slice(0, 7)).sort((a, b) => a.effectivePeriod.localeCompare(b.effectivePeriod) || a.createdAt.localeCompare(b.createdAt)).at(-1)
        if (!current) { setMessage('No defaults are effective yet. Enter the request choices.'); return }
        setAmount(current.advanceAmount === null ? '' : String(current.advanceAmount)); setMethod(current.collectionMethod || ''); setAllocation(current.allocation || 'general'); setForPeriod(''); setMessage('Current defaults copied. Review the amount and allocation before creating the request.')
      }}>Use current client defaults</button>
      <button type="button" className="secondary-action" disabled={busy || !moneyValid(amount) || allocation === 'month' && !forPeriod} onClick={() => void run(create)}>Create advance request</button>
      <button type="button" className="link-button" disabled={busy} onClick={() => { setAmount(''); setNote(''); setMethod(''); setAllocation('general'); setForPeriod(''); setMessage('Unsaved request entries cleared. Existing requests are unchanged.') }}>Cancel request edits</button>
    </div> : <p>New advance requests are unavailable for this client.</p>}
    {!ledger ? <p>Loading advance requests…</p> : ledger.requests.length === 0 ? <p>No advance requests.</p> : <>
      <ul className="advance-request-list">{ledger.requests.map((row) => <li key={row.id}>
        <strong>{row.number}</strong><p>Requested {currency.format(row.requestedCents / 100)} · Received {currency.format(row.receivedCents / 100)} · {row.canceledAt ? 'Canceled' : `Still requested ${currency.format(row.outstandingCents / 100)}`}</p>
        <a href={`/api/advance-payments/${row.id}/pdf`} target="_blank" rel="noreferrer">Download request PDF</a>{' '}
        {row.canceledAt ? <button type="button" className="link-button" disabled={busy} onClick={() => void run(async () => { const result = await advancePaymentRequest<{ linkWarning?: string }>(`/${row.id}/cancel`, {}); setMessage(result.linkWarning || 'All open bank links for this canceled request are closed.'); })}>Retry closing bank links</button> : null}
        {!row.canceledAt && row.outstandingCents > 0 ? <>
          <button type="button" className="link-button" disabled={busy} onClick={() => void run(async () => { const value = await advancePaymentRequest<{ url: string }>(`/${row.id}/payment-link`, {}); setLink(value.url); setMessage('Share this bank payment link with the client. It expires; create another when needed.'); })}>Create bank payment link</button>{' '}
          <button type="button" className="link-button" disabled={busy} onClick={() => void run(async () => { const result = await advancePaymentRequest<{ linkWarning?: string }>(`/${row.id}/cancel`, {}); setMessage(result.linkWarning || 'Request canceled. Received payments remain credit; a bank payment already in progress may still arrive.'); })}>Cancel unpaid remainder</button>
        </> : null}
      </li>)}</ul>
      <h4>Record money received outside the app</h4>
      {pending ? <p role="status">A receipt is awaiting confirmation. Its original entries and retry reference are restored. Retry this receipt before recording another payment.</p> : null}
      <p className="muted-text">Use this for a check or bank transfer confirmed received. Stripe bank payments are recorded automatically after settlement. A partial payment creates only that amount of credit.</p>
      <div className="form-grid two-col">
        <label className="field"><span>Advance request</span><select className="input" value={selected} onChange={(e) => setSelected(e.target.value)} disabled={busy}><option value="">Choose a request</option>{ledger.requests.map((row) => <option key={row.id} value={row.id}>{row.number}</option>)}</select></label>
        <label className="field"><span>Actual amount received</span><input className="input" type="number" min="0.01" step="0.01" max="1000000" value={received} onChange={(e) => setReceived(e.target.value)} disabled={busy} /></label>
        <label className="field"><span>Date received</span><input className="input" type="date" value={day} onChange={(e) => setDay(e.target.value)} disabled={busy} /></label>
        <button type="button" className="secondary-action" disabled={busy || !selected || !moneyValid(received) || !day} onClick={() => void run(record)}>Record received payment</button>
      </div>
      <details><summary>Receipt history and reversals</summary>
        <ul>{ledger.receipts.map((row) => <li key={row.sourceRef}>{row.receivedOn} · {currency.format(row.cents / 100)} · {row.method}{ledger.reversals.some((event) => event.sourceRef === row.sourceRef) ? ' · Reversal recorded — see credit ledger' : ''}</li>)}</ul>
        <p>For a returned or refunded manual payment, place its credit on hold. Existing invoices stay unchanged and must be reconciled separately. This records a reversal; it does not send a refund.</p>
        <label className="field"><span>Manual receipt to hold</span><select className="input" value={holdRef} onChange={(e) => setHoldRef(e.target.value)} disabled={busy}><option value="">Choose a receipt</option>{ledger.receipts.filter((row) => row.method === 'manual').map((row) => <option key={row.sourceRef} value={row.sourceRef}>{row.receivedOn} — {currency.format(row.cents / 100)} — {row.sourceRef.slice(-8)}</option>)}</select></label>
        <label className="field"><span>Reversal reason</span><input className="input" value={holdReason} onChange={(e) => setHoldReason(e.target.value)} maxLength={500} disabled={busy} /></label>
        <button type="button" className="secondary-action" disabled={busy || !holdRef || !holdReason.trim()} onClick={() => void run(async () => {
          const receipt = ledger.receipts.find((row) => row.sourceRef === holdRef)!
          const key = JSON.stringify(['hold', holdRef, holdReason])
          await advancePaymentRequest(`/${receipt.requestId}/hold`, { id: requestId(key), sourceRef: holdRef, note: holdReason })
          complete(key); setHoldRef(''); setHoldReason(''); setMessage('Receipt credit is on hold. Review any invoices already using it before sending them.')
        })}>Record reversal and hold credit</button>
      </details>
    </>}
    {message ? <p role="status">{message}</p> : null}
    {link ? <label className="field"><span>Bank payment link</span><input className="input" readOnly value={link} onFocus={(event) => event.target.select()} /></label> : null}
  </section>
}
