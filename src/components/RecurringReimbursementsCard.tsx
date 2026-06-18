import { Check, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'
import { useAppContext } from '../AppContext'
import type { RecurringReimbursement, RecurringReimbursementFrequency } from '../lib/types'
import { ApiError } from '../lib/types'
import { currency, localDateOnly } from '../lib/utils'

/**
 * Owner-only "Recurring reimbursements" card. Each row auto-populates the
 * matching invoice based on its frequency (monthly / quarterly / annual),
 * anchored on the month of `startDate`. No row is generated per period —
 * `getInvoice` synthesizes a "Recurring: <description>" line whenever the
 * cadence lands on the billing period.
 *
 * Pairs with `ReimbursementsCard` (the one-off flavor). Both live on the
 * client detail page so an owner manages everything in one spot; the
 * invoice page only surfaces the one-off card because recurring entries
 * are configured up-front and apply automatically.
 */
const FREQUENCY_OPTIONS: RecurringReimbursementFrequency[] = [
  'monthly',
  'quarterly',
  'annually',
]

function formatFrequency(value: RecurringReimbursementFrequency): string {
  switch (value) {
    case 'monthly':
      return 'Every month'
    case 'quarterly':
      return 'Every 3 months'
    case 'annually':
      return 'Every year'
  }
}

function formatStartLabel(startDate: string): string {
  const parsed = new Date(`${startDate}T12:00:00`)
  if (Number.isNaN(parsed.getTime())) return startDate
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    year: 'numeric',
  }).format(parsed)
}

export function RecurringReimbursementsCard({
  clientId,
  bare = false,
}: {
  clientId: string
  /** When embedded in a section that already renders its own panel + title. */
  bare?: boolean
}) {
  const {
    data,
    ownerMode,
    addRecurringReimbursement,
    updateRecurringReimbursement,
    deleteRecurringReimbursement,
  } = useAppContext()

  const today = localDateOnly()
  const [startDate, setStartDate] = useState(today)
  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [frequency, setFrequency] = useState<RecurringReimbursementFrequency>('monthly')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [removingId, setRemovingId] = useState<string | null>(null)

  // Inline edit state — only one row is editable at a time.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDescription, setEditDescription] = useState('')
  const [editAmount, setEditAmount] = useState('')
  const [editFrequency, setEditFrequency] = useState<RecurringReimbursementFrequency>('monthly')
  const [editStartDate, setEditStartDate] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)
  const [editError, setEditError] = useState('')

  const beginEdit = (entry: RecurringReimbursement) => {
    setEditingId(entry.id)
    setEditDescription(entry.description)
    setEditAmount(String(entry.amount))
    setEditFrequency(entry.frequency)
    setEditStartDate(entry.startDate)
    setEditError('')
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditError('')
  }

  const handleSaveEdit = async (id: string) => {
    if (savingEdit) return
    const numericAmount = Number(editAmount)
    if (!editDescription.trim()) {
      setEditError('Description is required.')
      return
    }
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      setEditError('Amount must be a positive number.')
      return
    }
    setSavingEdit(true)
    setEditError('')
    try {
      await updateRecurringReimbursement(id, {
        description: editDescription.trim(),
        amount: numericAmount,
        frequency: editFrequency,
        startDate: editStartDate,
      })
      setEditingId(null)
    } catch (err) {
      setEditError(
        err instanceof ApiError ? err.message : 'Could not update recurring reimbursement.',
      )
    } finally {
      setSavingEdit(false)
    }
  }

  const rows = useMemo(() => {
    const all: RecurringReimbursement[] = data.recurringReimbursements ?? []
    return all
      .filter((entry) => entry.clientId === clientId)
      .slice()
      .sort((a, b) => b.startDate.localeCompare(a.startDate))
  }, [data.recurringReimbursements, clientId])

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
      await addRecurringReimbursement({
        clientId,
        description: description.trim(),
        amount: numericAmount,
        frequency,
        startDate,
      })
      setDescription('')
      setAmount('')
      setFrequency('monthly')
      setStartDate(today)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add recurring reimbursement.')
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async (id: string, label: string) => {
    if (removingId) return
    const confirmed = window.confirm(
      `Stop billing "${label}" on this client's invoices going forward? Past invoices already sent are unaffected.`,
    )
    if (!confirmed) return
    setRemovingId(id)
    try {
      await deleteRecurringReimbursement(id)
    } catch (err) {
      window.alert(
        err instanceof ApiError ? err.message : 'Could not stop the recurring reimbursement.',
      )
    } finally {
      setRemovingId(null)
    }
  }

  const subtitle =
    'Expenses that bill on a schedule (software subscriptions, annual filings, etc.). Each one auto-populates the invoice for every matching period — no need to re-enter it each month.'

  return (
    <section className={bare ? 'reimbursements-body' : 'panel'} aria-label="Recurring reimbursements">
      {bare ? (
        <div className="reimbursements-bare-head">
          <p className="muted-text" style={{ margin: 0 }}>
            {subtitle}
          </p>
          {rows.length > 0 ? <span className="status-pill">{rows.length}</span> : null}
        </div>
      ) : (
        <div className="section-heading">
          <div>
            <h2 style={{ margin: 0 }}>Recurring reimbursements</h2>
            <p className="muted-text" style={{ margin: '4px 0 0 0' }}>
              {subtitle}
            </p>
          </div>
          {rows.length > 0 ? <span className="status-pill">{rows.length}</span> : null}
        </div>
      )}

      {rows.length === 0 ? (
        <p className="checklist-empty-hint">No recurring reimbursements set up yet.</p>
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
          {rows.map((entry) =>
            editingId === entry.id ? (
              <li
                key={entry.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 120px 140px 140px auto',
                  gap: 8,
                  alignItems: 'end',
                  paddingBottom: 8,
                  borderBottom: '1px solid var(--border-subtle, #eee)',
                }}
              >
                <label className="field">
                  <span>Description</span>
                  <input
                    className="input"
                    onChange={(event) => setEditDescription(event.target.value)}
                    type="text"
                    value={editDescription}
                  />
                </label>
                <label className="field">
                  <span>Amount ($)</span>
                  <input
                    className="input"
                    inputMode="decimal"
                    min="0.01"
                    onChange={(event) => setEditAmount(event.target.value)}
                    step="0.01"
                    type="number"
                    value={editAmount}
                  />
                </label>
                <label className="field">
                  <span>Frequency</span>
                  <select
                    className="input"
                    onChange={(event) =>
                      setEditFrequency(event.target.value as RecurringReimbursementFrequency)
                    }
                    value={editFrequency}
                  >
                    {FREQUENCY_OPTIONS.map((option) => (
                      <option key={option} value={option}>
                        {option.charAt(0).toUpperCase() + option.slice(1)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Start date</span>
                  <input
                    className="input"
                    onChange={(event) => setEditStartDate(event.target.value)}
                    type="date"
                    value={editStartDate}
                  />
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button
                    type="button"
                    className="item-delete-btn"
                    aria-label="Save changes"
                    title="Save changes"
                    disabled={savingEdit}
                    onClick={() => void handleSaveEdit(entry.id)}
                  >
                    <Check size={14} />
                  </button>
                  <button
                    type="button"
                    className="item-delete-btn"
                    aria-label="Cancel edit"
                    title="Cancel edit"
                    disabled={savingEdit}
                    onClick={cancelEdit}
                  >
                    <X size={14} />
                  </button>
                </div>
                {editError ? (
                  <p className="auth-error" style={{ gridColumn: '1 / -1', margin: 0 }}>
                    {editError}
                  </p>
                ) : null}
              </li>
            ) : (
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
                    {formatFrequency(entry.frequency)} · starting{' '}
                    {formatStartLabel(entry.startDate)}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <strong>{currency.format(entry.amount)}</strong>
                  {ownerMode ? (
                    <>
                      <button
                        type="button"
                        className="item-delete-btn"
                        aria-label={`Edit ${entry.description}`}
                        title="Edit this recurring reimbursement"
                        disabled={editingId !== null || removingId === entry.id}
                        onClick={() => beginEdit(entry)}
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        type="button"
                        className="item-delete-btn"
                        aria-label={`Stop billing ${entry.description}`}
                        title="Stop this recurring reimbursement"
                        disabled={removingId === entry.id}
                        onClick={() => void handleDelete(entry.id, entry.description)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </>
                  ) : null}
                </div>
              </li>
            ),
          )}
        </ul>
      )}

      {ownerMode ? (
        <form
          onSubmit={handleAdd}
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 120px 140px 140px auto',
            gap: 8,
            alignItems: 'end',
            marginTop: 16,
          }}
        >
          <label className="field">
            <span>Description</span>
            <input
              className="input"
              onChange={(event) => setDescription(event.target.value)}
              placeholder="e.g. QuickBooks subscription"
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
          <label className="field">
            <span>Frequency</span>
            <select
              className="input"
              onChange={(event) =>
                setFrequency(event.target.value as RecurringReimbursementFrequency)
              }
              value={frequency}
            >
              {FREQUENCY_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option.charAt(0).toUpperCase() + option.slice(1)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Start date</span>
            <input
              className="input"
              onChange={(event) => setStartDate(event.target.value)}
              required
              type="date"
              value={startDate}
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
