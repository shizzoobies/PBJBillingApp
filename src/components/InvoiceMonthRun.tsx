import { AlertTriangle, Download, Plus, Printer, RefreshCw, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  generateInvoicesRequest,
  listInvoicesRequest,
  updateInvoiceRequest,
} from '../lib/api'
import type { Client, PersistedInvoice, PersistedInvoiceLine } from '../lib/types'
import { currency } from '../lib/utils'

/**
 * The month run (I2): every client's stored invoice for a period, in INVOICE
 * NUMBER order, each expanding to an editor.
 *
 * Number order is deliberate even though flagged invoices are the interesting
 * ones — a list that rearranges itself while you work through it is
 * disorienting, and the "needs a look" count above does the surfacing instead
 * (Alex's call).
 *
 * These invoices are fetched directly rather than read off `data`, because they
 * are deliberately not part of the workspace bulk save — see the API module.
 */

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  reviewed: 'Reviewed',
  sent: 'Sent',
  processing: 'Processing',
  paid: 'Paid',
  overdue: 'Overdue',
  void: 'Void',
}

/** The current month as YYYY-MM, in local time. */
function currentPeriod() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

function formatDue(due: string | null) {
  if (!due) return 'no due date'
  const parsed = new Date(`${due}T12:00:00`)
  if (Number.isNaN(parsed.getTime())) return 'no due date'
  return `due ${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(parsed)}`
}

export function InvoiceMonthRun({
  clients,
  onPrint,
}: {
  clients: Client[]
  /** Hand a stored invoice up to the page, which owns the print document. */
  onPrint: (invoice: PersistedInvoice) => void
}) {
  const [period, setPeriod] = useState(currentPeriod)
  const [invoices, setInvoices] = useState<PersistedInvoice[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)

  const clientName = useCallback(
    (clientId: string) => clients.find((c) => c.id === clientId)?.name ?? 'Unknown client',
    [clients],
  )

  // Load whenever the period changes. `cancelled` guards against a slow
  // response for a month she has already navigated away from landing on top
  // of the newer one — same shape as the Client Recap page.
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const rows = await listInvoicesRequest(period)
        if (!cancelled) setInvoices(rows)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load invoices.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [period])

  // Number order. A voided invoice keeps its number and its place, so the run
  // reads the same way before and after something is voided.
  const ordered = useMemo(
    () =>
      [...invoices].sort((a, b) =>
        String(a.number ?? '').localeCompare(String(b.number ?? '')),
      ),
    [invoices],
  )

  const live = ordered.filter((invoice) => invoice.status !== 'void')
  const toReview = live.filter((invoice) => invoice.status === 'draft').length
  const reviewed = live.filter((invoice) => invoice.status === 'reviewed').length
  const needALook = live.filter((invoice) => invoice.scopeFlags.length > 0).length
  const monthTotal = live.reduce((sum, invoice) => sum + invoice.total, 0)

  const generate = async () => {
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const result = await generateInvoicesRequest(period)
      setInvoices(await listInvoicesRequest(period))
      // Say what happened, including the nothing-case: running this and seeing
      // the list unchanged otherwise looks like a broken button.
      setNote(
        result.created.length > 0
          ? `Built ${result.created.length} invoice${result.created.length === 1 ? '' : 's'}.`
          : 'Nothing new to build — every client already has one for this month.',
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not build this month.')
    } finally {
      setBusy(false)
    }
  }

  const patch = async (
    invoiceId: string,
    body: Parameters<typeof updateInvoiceRequest>[1],
  ) => {
    setBusy(true)
    setError(null)
    try {
      const updated = await updateInvoiceRequest(invoiceId, body)
      setInvoices((current) =>
        current.map((invoice) => (invoice.id === updated.id ? updated : invoice)),
      )
      return updated
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that change.')
      return null
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel invoice-month-run">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Monthly run</p>
          <h2>Invoices</h2>
        </div>
        <div className="invoice-run-actions">
          <label className="period-control">
            <span className="sr-only">Billing month</span>
            <input
              type="month"
              className="input"
              value={period}
              onChange={(event) => setPeriod(event.target.value || currentPeriod())}
            />
          </label>
          <button type="button" className="secondary-action" disabled={busy} onClick={generate}>
            <RefreshCw size={15} />
            {busy ? 'Working…' : 'Generate'}
          </button>
          <a
            className="secondary-action"
            href={`/api/invoices/export.csv?period=${encodeURIComponent(period)}`}
          >
            <Download size={15} />
            Download for QBO
          </a>
        </div>
      </div>

      <div className="invoice-run-stats">
        <div className="invoice-run-stat">
          <span>To review</span>
          <strong>{toReview}</strong>
        </div>
        <div className="invoice-run-stat">
          <span>Reviewed</span>
          <strong>{reviewed}</strong>
        </div>
        <div className={needALook > 0 ? 'invoice-run-stat is-flagged' : 'invoice-run-stat'}>
          <span>Need a look</span>
          <strong>{needALook}</strong>
        </div>
        <div className="invoice-run-stat">
          <span>Month total</span>
          <strong>{currency.format(monthTotal)}</strong>
        </div>
      </div>

      {error ? (
        <p className="invoice-run-error" role="alert">
          {error}
        </p>
      ) : null}
      {note ? <p className="invoice-run-note">{note}</p> : null}

      {loading ? <p className="invoice-run-empty">Loading…</p> : null}
      {!loading && ordered.length === 0 ? (
        <p className="invoice-run-empty">
          Nothing for this month yet. Press Generate to build a draft for every client with
          something to bill.
        </p>
      ) : null}

      <ul className="invoice-run-list">
        {ordered.map((invoice) => (
          <InvoiceRow
            key={invoice.id}
            invoice={invoice}
            clientName={clientName(invoice.clientId)}
            open={openId === invoice.id}
            busy={busy}
            onToggle={() => setOpenId(openId === invoice.id ? null : invoice.id)}
            onPatch={(body) => patch(invoice.id, body)}
            onPrint={() => onPrint(invoice)}
          />
        ))}
      </ul>
    </div>
  )
}

function InvoiceRow({
  invoice,
  clientName,
  open,
  busy,
  onToggle,
  onPatch,
  onPrint,
}: {
  invoice: PersistedInvoice
  clientName: string
  open: boolean
  busy: boolean
  onToggle: () => void
  onPatch: (body: Parameters<typeof updateInvoiceRequest>[1]) => Promise<PersistedInvoice | null>
  onPrint: () => void
}) {
  const isVoid = invoice.status === 'void'
  const flagged = invoice.scopeFlags.length > 0
  const adjustment = invoice.lineItems.find((line) => line.kind === 'adjustment')

  const rowClass = [
    'invoice-run-row',
    flagged && !isVoid ? 'is-flagged' : '',
    isVoid ? 'is-void' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <li className={rowClass}>
      <button type="button" className="invoice-run-summary" onClick={onToggle}>
        <span className="invoice-run-main">
          <span className="invoice-run-client">{clientName}</span>
          <span className="invoice-run-number">{invoice.number ?? '—'}</span>
          <span className="invoice-run-meta">
            {invoice.lineItems.length} line{invoice.lineItems.length === 1 ? '' : 's'} ·{' '}
            {formatDue(invoice.dueDate)}
            {adjustment
              ? ` · carries ${currency.format(adjustment.amount)} from last month`
              : ''}
          </span>
          {flagged && !isVoid ? (
            <span className="invoice-run-flags">
              {invoice.scopeFlags.map((flag) => (
                <span className="invoice-run-flag" key={flag.kind + flag.label}>
                  <AlertTriangle size={13} />
                  {flag.detail || flag.label}
                </span>
              ))}
            </span>
          ) : null}
        </span>
        <span className="invoice-run-amount">
          <strong>{currency.format(invoice.total)}</strong>
          <span className={`invoice-status is-${invoice.status}`}>
            {STATUS_LABELS[invoice.status] ?? invoice.status}
          </span>
        </span>
      </button>
      {/* Keyed on updatedAt so a fresh server version REMOUNTS the editor
          rather than syncing props into state inside an effect. */}
      {open ? (
        <InvoiceEditor
          key={invoice.updatedAt ?? invoice.id}
          invoice={invoice}
          busy={busy}
          onPatch={onPatch}
          onPrint={onPrint}
        />
      ) : null}
    </li>
  )
}

/**
 * The per-invoice editor. Lines are edited locally and saved in one go, so a
 * half-typed amount never round-trips as a charge; the server recomputes the
 * totals from whatever it is sent.
 */
function InvoiceEditor({
  invoice,
  busy,
  onPatch,
  onPrint,
}: {
  invoice: PersistedInvoice
  busy: boolean
  onPatch: (body: Parameters<typeof updateInvoiceRequest>[1]) => Promise<PersistedInvoice | null>
  onPrint: () => void
}) {
  const [lines, setLines] = useState<PersistedInvoiceLine[]>(invoice.lineItems)
  const [blurb, setBlurb] = useState(invoice.blurb)
  const [saved, setSaved] = useState(false)


  const dirty =
    JSON.stringify(lines) !== JSON.stringify(invoice.lineItems) || blurb !== invoice.blurb
  const localTotal = lines.reduce((sum, line) => sum + (Number(line.amount) || 0), 0)

  const setLine = (index: number, patch: Partial<PersistedInvoiceLine>) => {
    setLines((current) =>
      current.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    )
    setSaved(false)
  }

  const save = async () => {
    const updated = await onPatch({ lineItems: lines, blurb })
    if (updated) setSaved(true)
  }

  return (
    <div className="invoice-run-editor">
      <table className="invoice-run-lines">
        <tbody>
          {lines.map((line, index) => (
            <tr key={`${line.kind}-${index}`}>
              <td>
                <input
                  className="input"
                  value={line.label}
                  aria-label="Line description"
                  onChange={(event) => setLine(index, { label: event.target.value })}
                />
                <input
                  className="input invoice-run-detail"
                  value={line.detail}
                  aria-label="Line detail"
                  placeholder="Detail (optional)"
                  onChange={(event) => setLine(index, { detail: event.target.value })}
                />
              </td>
              <td className="invoice-run-amount-cell">
                <input
                  className="input"
                  type="number"
                  step="0.01"
                  value={line.amount}
                  aria-label="Amount"
                  onChange={(event) =>
                    setLine(index, { amount: Number(event.target.value) })
                  }
                />
              </td>
              <td>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remove ${line.label || 'line'}`}
                  onClick={() => {
                    setLines((current) => current.filter((_, i) => i !== index))
                    setSaved(false)
                  }}
                >
                  <Trash2 size={15} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <button
        type="button"
        className="secondary-action"
        onClick={() => {
          setLines((current) => [
            ...current,
            { kind: 'custom', label: '', detail: '', amount: 0 },
          ])
          setSaved(false)
        }}
      >
        <Plus size={15} />
        Add a line
      </button>

      <label className="field invoice-run-blurb">
        <span>Note to the client</span>
        <textarea
          className="input"
          rows={2}
          value={blurb}
          placeholder="Carried over from last month once you've written one."
          onChange={(event) => {
            setBlurb(event.target.value)
            setSaved(false)
          }}
        />
      </label>

      <div className="invoice-run-editor-footer">
        <span className="invoice-run-running-total">
          Total {currency.format(localTotal)}
          {dirty ? ' · unsaved' : ''}
        </span>
        <div className="invoice-run-editor-actions">
          {/* Prints through the SAME document the per-client view uses, so
              there is one printed format rather than two that drift. */}
          <button
            type="button"
            className="secondary-action"
            disabled={dirty}
            title={dirty ? 'Save your changes first' : 'Print this invoice'}
            onClick={onPrint}
          >
            <Printer size={15} />
            Print
          </button>
          <button type="button" className="secondary-action" disabled={busy || !dirty} onClick={save}>
            {saved && !dirty ? 'Saved' : 'Save changes'}
          </button>
          {invoice.status === 'draft' ? (
            <button
              type="button"
              className="primary-action"
              disabled={busy || dirty}
              title={dirty ? 'Save your changes first' : 'Mark this invoice reviewed'}
              onClick={() => void onPatch({ status: 'reviewed' })}
            >
              Mark reviewed
            </button>
          ) : null}
          {invoice.status === 'reviewed' ? (
            <button
              type="button"
              className="secondary-action"
              disabled={busy}
              onClick={() => void onPatch({ status: 'draft' })}
            >
              Back to draft
            </button>
          ) : null}
          {invoice.status !== 'void' ? (
            <button
              type="button"
              className="secondary-action"
              disabled={busy}
              title="Void this invoice — it stays on the record and can be rebuilt by generating again"
              onClick={() => void onPatch({ status: 'void' })}
            >
              Void
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
