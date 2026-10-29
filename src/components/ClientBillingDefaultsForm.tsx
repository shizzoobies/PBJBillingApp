import { useState } from 'react'
import { advancePaymentRequest } from '../lib/api'
import { currency } from '../lib/utils'
export type BillingDefaults = { id: string; effectivePeriod: string; advanceAmount: number | null; collectionMethod: string | null; allocation: string | null; balanceDisplay: string | null; createdAt: string }
export function ClientBillingDefaultsForm({ clientId, settings, onSaved }: { clientId: string; settings: BillingDefaults[]; onSaved: () => void }) {
  const [period, setPeriod] = useState('')
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState('')
  const [allocation, setAllocation] = useState('')
  const [display, setDisplay] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const clear = () => { setPeriod(''); setAmount(''); setMethod(''); setAllocation(''); setDisplay('') }
  const save = async () => {
    if (busy) return
    const input = { clientId, effectivePeriod: period, advanceAmount: amount.trim() ? Number(amount) : null, collectionMethod: method || null, allocation: allocation || null, balanceDisplay: display || null }
    const key = `pbj-billing-defaults-pending:${JSON.stringify(input)}`
    setBusy(true); setMessage('')
    try {
      const id = localStorage.getItem(key) || crypto.randomUUID()
      localStorage.setItem(key, id)
      await advancePaymentRequest('/settings', { ...input, id })
      localStorage.removeItem(key); clear(); setMessage('Defaults saved for the selected month onward. Existing requests, receipts, and invoices are unchanged.'); onSaved()
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not confirm the save. Entries are retained for retry.') }
    finally { setBusy(false) }
  }
  const valid = /^\d{4}-(0[1-9]|1[0-2])$/.test(period) && (!amount.trim() || Number(amount) >= 0.01 && Number(amount) <= 1000000)
  return <details><summary>Client billing defaults</summary>
    <p>Optional suggestions for new advance requests and future invoice balance summaries. Leave a value unset to choose it per request. An advance estimate is entered manually; no three-month formula or automatic payment is created. Saving defaults never creates credit or changes an existing draft.</p>
    <div className="form-grid two-col">
      <label className="field"><span>Defaults effective billing month</span><input className="input" type="month" value={period} disabled={busy} onChange={(e) => setPeriod(e.target.value)} /></label>
      <label className="field"><span>Suggested advance amount</span><input className="input" type="number" min="0.01" max="1000000" step="0.01" value={amount} disabled={busy} onChange={(e) => setAmount(e.target.value)} /></label>
      <label className="field"><span>Preferred payment method</span><select className="input" value={method} disabled={busy} onChange={(e) => setMethod(e.target.value)}><option value="">Unset</option><option value="bank">Bank payment link</option><option value="manual">Payment outside the app</option></select></label>
      <label className="field"><span>Preferred credit allocation</span><select className="input" value={allocation} disabled={busy} onChange={(e) => setAllocation(e.target.value)}><option value="">Unset</option><option value="general">General balance for future invoices</option><option value="month">Reserve for a billing month</option></select></label>
      <label className="field"><span>Customer balance display</span><select className="input" value={display} disabled={busy} onChange={(e) => setDisplay(e.target.value)}><option value="">Unset (detailed summary)</option><option value="summary">Compact summary</option><option value="detailed">Dated detailed summary</option></select></label>
    </div>
    <p>Both display choices show opening credit when present, current charges, credit applied, closing credit, and amount due. Held and reserved balances remain visible.</p>
    <button type="button" className="secondary-action" disabled={busy || !valid} onClick={() => void save()}>Save billing defaults</button>{' '}
    <button type="button" className="link-button" disabled={busy} onClick={() => { clear(); setMessage('Unsaved entries cleared. Saved defaults are unchanged.') }}>Cancel default edits</button>
    {message ? <p role="status">{message}</p> : null}
    <h4>Defaults history</h4>
    {settings.length ? <ul>{settings.map((row) => <li key={row.id}>{row.effectivePeriod}: {row.advanceAmount === null ? 'Amount unset' : currency.format(row.advanceAmount)} · {row.collectionMethod || 'Method unset'} · {row.allocation || 'Allocation unset'} · {row.balanceDisplay || 'Display unset'} · saved {row.createdAt.slice(0, 10)}</li>)}</ul> : <p>No client defaults saved.</p>}
  </details>
}
