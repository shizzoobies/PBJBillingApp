import { Plus, Trash2 } from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'
import { useAppContext } from '../AppContext'
import type { Reimbursement } from '../lib/types'
import { ApiError } from '../lib/types'
import { currency } from '../lib/utils'

/**
 * Owner-only "Expenses & reimbursements" card. Lists every reimbursement
 * for a single client (or just the current billing period when used on
 * the invoice page), plus an inline add form. Edits aren't surfaced —
 * delete + re-add keeps the UI simple, matches how line items usually
 * get corrected in real bookkeeping workflows.
 *
 * Props:
 *  - `clientId`: required — scopes the list and the add form.
 *  - `periodFilter`: optional YYYY-MM. When set, only reimbursements in
 *    that billing period show up (use on the Invoices page so it mirrors
 *    what's on the current invoice).
 *  - `title` / `subtitle`: section heading copy; defaults included.
 */
export function ReimbursementsCard({
  clientId,
  periodFilter,
  title = 'Expenses & reimbursements',
  subtitle = 'Out-of-pocket expenses to bill back. Each entry shows up as a line on the invoice for the month its date falls in.',
}: {
  clientId: string
  periodFilter?: string
  title?: string
  subtitle?: string
}) {
  const { data, ownerMode, addReimbursement, deleteReimbursement } = useAppContext()

  const today = new Date().toISOString().slice(0, 10)
  const [date, setDate] = useState(today)
  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [removingId, setRemovingId] = useState<string | null>(null)

  // Filter to this client and (optionally) this billing period. Newest
  // date first so the most recent expense reads at the top.
  const rows = useMemo(() => {
    const all: Reimbursement[] = data.reimbursements ?? []
    return all
      .filter((entry) => entry.clientId === clientId)
      // Period filter is just a YYYY-MM prefix match on the entry's date —
      // same convention used by isInBillingPeriod for time entries, but
      // inlined here since Reimbursement isn't a TimeEntry shape.
      .filter((entry) => (periodFilter ? entry.date.startsWith(periodFilter) : true))
      .slice()
      .sort((a, b) => b.date.localeCompare(a.date))
  }, [data.reimbursements, clientId, periodFilter])

  const total = useMemo(() => rows.reduce((sum, entry) => sum + entry.amount, 0), [rows])

  const handleAdd = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submitting) return
    const numericAmount = Number(amount)
    if (!description.trim()) {
      setError('Description is required.')
      return
    }
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      setError('Amount must be a positive number.')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      await addReimbursement({
        clientId,
        date,
        description: description.trim(),
        amount: numericAmount,
      })
      setDescription('')
      setAmount('')
      setDate(today)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add reimbursement.')
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async (id: string, label: string) => {
    if (removingId) return
    const confirmed = window.confirm(`Remove "${label}" from this client's reimbursements?`)
    if (!confirmed) return
    setRemovingId(id)
    try {
      await deleteReimbursement(id)
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : 'Could not remove reimbursement.')
    } finally {
      setRemovingId(null)
    }
  }

  // Non-owners get a read-only list — server already blocks mutations,
  // but we hide the form to avoid suggesting they can edit.
  const canEdit = ownerMode

  return (
    <section className="panel" aria-label="Client reimbursements">
      <div className="section-heading">
        <div>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <p className="muted-text" style={{ margin: '4px 0 0 0' }}>
            {subtitle}
          </p>
        </div>
        {rows.length > 0 ? (
          <span className="status-pill">
            {rows.length} · {currency.format(total)}
          </span>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <p className="checklist-empty-hint">
          {periodFilter
            ? 'No reimbursements for this billing period.'
            : 'No reimbursements yet for this client.'}
        </p>
      ) : (
        <ul
          style={{
            listStyle: 'none',
            padding: 0,
            margin: '12px 0 0 0',
            display: 'grid',
            gap: 8,
          }}
        >
          {rows.map((entry) => (
            <li
              key={entry.id}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                gap: 12,
                paddingBottom: 8,
                borderBottom: '1px solid var(--border-subtle, #eee)',
              }}
            >
              <div>
                <strong>{entry.description}</strong>
                <div className="checklist-meta-line">
                  {new Intl.DateTimeFormat('en-US', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  }).format(new Date(`${entry.date}T12:00:00`))}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <strong>{currency.format(entry.amount)}</strong>
                {canEdit ? (
                  <button
                    type="button"
                    className="item-delete-btn"
                    aria-label={`Delete ${entry.description}`}
                    title="Delete this reimbursement"
                    disabled={removingId === entry.id}
                    onClick={() => void handleDelete(entry.id, entry.description)}
                  >
                    <Trash2 size={14} />
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      {canEdit ? (
        <form
          onSubmit={handleAdd}
          style={{
            display: 'grid',
            gridTemplateColumns: '140px 1fr 120px auto',
            gap: 8,
            alignItems: 'end',
            marginTop: 16,
          }}
        >
          <label className="field">
            <span>Date</span>
            <input
              className="input"
              max={today}
              onChange={(event) => setDate(event.target.value)}
              required
              type="date"
              value={date}
            />
          </label>
          <label className="field">
            <span>Description</span>
            <input
              className="input"
              onChange={(event) => setDescription(event.target.value)}
              placeholder="e.g. Office supplies, mileage, software"
              required
              type="text"
              value={description}
            />
          </label>
          <label className="field">
            <span>Amount ($)</span>
            <input
              className="input"
              inputMode="decimal"
              min="0.01"
              onChange={(event) => setAmount(event.target.value)}
              placeholder="0.00"
              required
              step="0.01"
              type="number"
              value={amount}
            />
          </label>
          <button
            className="primary-action"
            disabled={submitting || !description.trim() || !amount}
            type="submit"
          >
            <Plus size={14} />
            Add
          </button>
        </form>
      ) : null}
      {error ? <p className="auth-error">{error}</p> : null}
    </section>
  )
}
