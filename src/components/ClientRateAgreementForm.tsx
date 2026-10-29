import { useRef, useState } from 'react'
import { addClientRateAgreementRequest } from '../lib/api'
import type { ClientRateAgreement } from '../../lib/client-rate-agreement.js'
import { currency } from '../lib/utils'

export function ClientRateAgreementForm({ clientId, employees, agreements, onSaved }: {
  clientId: string
  employees: Array<{ id: string; name: string }>
  agreements: ClientRateAgreement[]
  onSaved: (rows: ClientRateAgreement[]) => void
}) {
  const [person, setPerson] = useState('')
  const [period, setPeriod] = useState('')
  const [amount, setAmount] = useState('')
  const [inherit, setInherit] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const retry = useRef<{ key: string; id: string } | null>(null)
  const valid = /^\d{4}-(0[1-9]|1[0-2])$/.test(period) && period >= '2026-06' &&
    (inherit || (amount.trim() !== '' && Number.isFinite(Number(amount)) && Number(amount) >= 0 && Number(amount) <= 10000))
  const save = async () => {
    if (busy || !valid) return
    const role = person.startsWith('role:') ? person.slice(5) as 'CFO' | 'Accountant' | 'Bookkeeper' : null
    const value = { userId: role ? null : person || null, role, effectivePeriod: period, rate: inherit ? null : Number(amount), note }
    const key = JSON.stringify(value)
    setBusy(true)
    setMessage('')
    try {
      if (retry.current?.key !== key) retry.current = { key, id: localStorage.getItem(`pbj-rate-pending:${clientId}:${key}`) || crypto.randomUUID() }
      localStorage.setItem(`pbj-rate-pending:${clientId}:${key}`, retry.current.id)
      const { agreements: rows } = await addClientRateAgreementRequest(clientId, { ...value, id: retry.current.id })
      onSaved(rows)
      localStorage.removeItem(`pbj-rate-pending:${clientId}:${key}`)
      retry.current = null
      setAmount('')
      setPeriod('')
      setNote('')
      setMessage('Rate agreement saved. Existing invoices keep their saved rates; review any drafts already generated.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not save. Your entries are still here; retry uses the same request.')
    } finally { setBusy(false) }
  }
  return <section aria-label="Client rate agreements" className="full-row">
    <h3>Client rate agreements</h3>
    <p className="muted-text">Set an agreed rate for this client only. Person rates take precedence over role rates, then the client default, then historical team rates. Inherited rates fall back through that order. Changes start in the selected billing month and never rewrite saved invoices. Existing drafts keep their saved rates.</p>
    <div className="form-grid two-col">
      <label className="field"><span>Applies to</span><select className="input" value={person} onChange={(event) => setPerson(event.target.value)} disabled={busy}>
        <option value="">All team members (client default)</option>
        {(['CFO', 'Accountant', 'Bookkeeper'] as const).map((role) => <option key={role} value={`role:${role}`}>{role} role</option>)}
        {employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}
      </select></label>
      <label className="field"><span>Effective billing month</span><input className="input" type="month" min="2026-06" value={period} onChange={(event) => setPeriod(event.target.value)} disabled={busy} /></label>
      <label className="field"><span>Agreed hourly rate</span><input className="input" type="number" min="0" max="10000" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} disabled={busy || inherit} /></label>
      <label className="field"><span>Agreement note</span><input className="input" maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} disabled={busy} /></label>
      <label><input type="checkbox" checked={inherit} onChange={(event) => setInherit(event.target.checked)} disabled={busy} /> Use inherited rates from this month</label>
    </div>
    <button type="button" className="secondary-action" disabled={busy || !valid} onClick={() => void save()}>{busy ? 'Saving…' : 'Save rate agreement'}</button>
    <button type="button" className="link-button" disabled={busy} onClick={() => { setPerson(''); setPeriod(''); setAmount(''); setInherit(false); setNote(''); setMessage('Unsaved entries cleared. Saved agreements are unchanged.'); }}>Cancel edits</button>
    {message ? <p role="status">{message}</p> : null}
    {agreements.length ? <details><summary>Agreement history ({agreements.length})</summary><ul className="recap-list">
      {agreements.map((row) => <li key={row.id}><span>{row.effectivePeriod} · {row.userId ? employees.find((person) => person.id === row.userId)?.name ?? 'Former team member' : row.role ? `${row.role} role` : 'Client default'} · {row.rate === null ? 'Inherited' : `${currency.format(row.rate)}/hr`}{row.note ? ` · ${row.note}` : ''}</span></li>)}
    </ul></details> : <p className="muted-text">No client-specific agreements. Team rate history applies.</p>}
  </section>
}
