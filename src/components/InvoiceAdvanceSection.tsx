import { useEffect, useState } from 'react'
import { advanceOfferText, invoiceAdvanceOffer } from '../../lib/invoice-advance-offer.js'
import { advancePaymentRequest } from '../lib/api'
import type { PersistedInvoice } from '../lib/types'
import { currency } from '../lib/utils'
import { AdvancePaymentPanel } from './AdvancePaymentPanel'

type Request = { id: string; number: string; requestedCents: number; canceledAt: string | null; collectionMethod: string | null }
export function InvoiceAdvanceSection({ invoice, disabled, onChanged }: { invoice: PersistedInvoice; disabled: boolean; onChanged: (invoice: PersistedInvoice) => void }) {
  const [open, setOpen] = useState(false)
  const [manage, setManage] = useState(false)
  const [requests, setRequests] = useState<Request[]>([])
  const [selected, setSelected] = useState('')
  const [policy, setPolicy] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [reload, setReload] = useState(0)
  const offer = invoiceAdvanceOffer(invoice)
  useEffect(() => {
    if (!open) return
    let stale = false
    advancePaymentRequest<{ requests: Request[] }>(`?clientId=${encodeURIComponent(invoice.clientId)}`).then((data) => { if (!stale) setRequests(data.requests) }, (error: unknown) => { if (!stale) setMessage(error instanceof Error ? error.message : 'Could not load requests.') })
    return () => { stale = true }
  }, [invoice.clientId, open, reload])
  const change = async (remove = false) => {
    setBusy(true); setMessage('')
    try {
      const result = await advancePaymentRequest<{ invoice: PersistedInvoice }>(remove ? '/detach' : `/${selected}/attach`, { invoiceId: invoice.id, optional: policy === 'optional' })
      onChanged(result.invoice); setSelected(''); setPolicy(''); setMessage(remove ? 'Advance section removed. The request and received payments remain unchanged.' : 'Advance section saved. Review the draft and client preview before sending.')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not save the advance section.') }
    finally { setBusy(false) }
  }
  const editable = !disabled && !invoice.sentAt && ['draft', 'reviewed'].includes(invoice.status) && (invoice.kind ?? 'monthly') === 'monthly'
  return <section aria-label="Invoice advance section">
    {offer ? <div>{advanceOfferText(invoice).map((text) => <p style={{ overflowWrap: 'anywhere' }} key={text}>{text}</p>)}</div> : null}
    {editable ? <>
      <button type="button" className="secondary-action" onClick={() => setOpen(!open)} aria-expanded={open}>Pay in advance section</button>
      {open ? <div>
        <p>Keep normal charges on this invoice and add a separate advance section below them. Service and advance payments are collected separately; there is no automatic split of a single combined payment.</p>
        <button type="button" className="link-button" aria-expanded={manage} onClick={() => setManage(!manage)}>Create or manage advance requests</button>
        {manage ? <AdvancePaymentPanel clientId={invoice.clientId} onChanged={() => setReload((n) => n + 1)} /> : null}
        <label className="field"><span>Advance request to include</span><select className="input" value={selected} onChange={(e) => setSelected(e.target.value)} disabled={busy}><option value="">Choose a request</option>{requests.filter((row) => !row.canceledAt && row.collectionMethod).map((row) => <option key={row.id} value={row.id}>{row.number} — {currency.format(row.requestedCents / 100)}</option>)}</select></label>
        <label className="field"><span>Advance agreement</span><select className="input" value={policy} onChange={(e) => setPolicy(e.target.value)} disabled={busy}><option value="">Confirm with the client</option><option value="optional">Optional advance</option><option value="agreed">Already agreed advance</option></select></label>
        <p className="muted-text">Neither choice adds the advance to service revenue or changes the current amount due. Choose the client's agreement before attaching. A received check covering both must be explicitly allocated and recorded once for each portion.</p>
        <button type="button" className="secondary-action" disabled={busy || !selected || !policy} onClick={() => void change()}>Save advance section</button>{' '}
        {offer ? <button type="button" className="link-button" disabled={busy} onClick={() => void change(true)}>Remove advance section</button> : null}{' '}
        <button type="button" className="link-button" disabled={busy} onClick={() => { setSelected(''); setPolicy(''); setOpen(false); setMessage('Unsaved section choices cleared.') }}>Cancel section edits</button>
      </div> : null}
    </> : null}
    {message ? <p role="status">{message}</p> : null}
  </section>
}
