import { Check, Pause, Pencil, Play, Plus, Trash2, X } from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'
import { useAppContext } from '../AppContext'
import type { RecurringReimbursement, RecurringReimbursementFrequency } from '../lib/types'
import { ApiError } from '../lib/types'
import { currency, localDateOnly } from '../lib/utils'
import {
  COVERAGE_PLACEHOLDERS,
  DEFAULT_COVERAGE_TEMPLATE,
  applyCoverageTemplate,
  formatCoverageRange,
} from '../../lib/expense-coverage.js'

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

/**
 * The window this expense is sitting on right now — the last one actually
 * billed, or the first one she typed if it has never billed yet. Read off the
 * ledger rather than recomputed, so the card and the invoice agree.
 */
function currentWindow(entry: RecurringReimbursement): { start: string; end: string } | null {
  const history = entry.coverageHistory ?? {}
  const periods = Object.keys(history).sort()
  const latest = periods.length > 0 ? history[periods[periods.length - 1]] : null
  if (latest?.start && latest?.end) return { start: latest.start, end: latest.end }
  if (entry.coverageStart && entry.coverageEnd) {
    return { start: entry.coverageStart, end: entry.coverageEnd }
  }
  return null
}

/** The shape the coverage sub-form edits, in both the add and the edit paths. */
type CoverageDraft = {
  enabled: boolean
  template: string
  start: string
  end: string
}

const EMPTY_COVERAGE: CoverageDraft = {
  enabled: false,
  template: DEFAULT_COVERAGE_TEMPLATE,
  start: '',
  end: '',
}

function coverageDraftFrom(entry: RecurringReimbursement): CoverageDraft {
  return {
    enabled: Boolean(entry.coverageEnabled),
    template: entry.coverageTemplate || DEFAULT_COVERAGE_TEMPLATE,
    start: entry.coverageStart ?? '',
    end: entry.coverageEnd ?? '',
  }
}

/**
 * Why this window will not do, in a sentence — or '' when it is fine. Says the
 * same three things the store says; this one just gets to say them before a
 * round trip.
 */
function validateCoverage(draft: CoverageDraft): string {
  if (!draft.enabled) return ''
  if (!draft.start || !draft.end) {
    return 'Enter the first covered period — a start date and an end date.'
  }
  if (draft.end <= draft.start) {
    return 'The covered period must end after it starts.'
  }
  return ''
}

/** What the server is sent. Empty dates clear the window rather than fail. */
function coveragePayload(draft: CoverageDraft) {
  return {
    coverageEnabled: draft.enabled,
    coverageTemplate: draft.template,
    coverageStart: draft.start || null,
    coverageEnd: draft.end || null,
  }
}

/**
 * "Name the dates this covers" — the whole point of the feature, configured
 * ONCE here so it never has to be retyped on an invoice.
 *
 * The first window is typed by hand because only she knows where the cycle
 * currently stands; every window after it is the app's job. The live preview
 * matters more than it looks: a template is only correct if you can see the
 * sentence it produces, and the alternative is generating an invoice to find
 * out.
 */
function CoverageFields({
  value,
  description,
  onChange,
}: {
  value: CoverageDraft
  /** Fills `{description}` in the preview, so it reads as the real line will. */
  description: string
  onChange: (next: CoverageDraft) => void
}) {
  const preview =
    value.start && value.end
      ? applyCoverageTemplate(value.template || DEFAULT_COVERAGE_TEMPLATE, {
          start: value.start,
          end: value.end,
          description,
        })
      : ''

  return (
    <div style={{ gridColumn: '1 / -1', display: 'grid', gap: 8 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(event) => onChange({ ...value, enabled: event.target.checked })}
        />
        <span>The invoice wording names the dates this covers</span>
      </label>

      {value.enabled ? (
        <>
          <label className="field">
            <span>Invoice wording</span>
            <input
              className="input"
              type="text"
              value={value.template}
              placeholder={DEFAULT_COVERAGE_TEMPLATE}
              onChange={(event) => onChange({ ...value, template: event.target.value })}
            />
            <span className="muted-text" style={{ fontSize: 12 }}>
              Fill in the dates with {COVERAGE_PLACEHOLDERS.join(', ')}. Written once — every
              invoice from here gets that cycle&rsquo;s dates put in for you.
            </span>
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <label className="field">
              <span>First covered period starts</span>
              <input
                className="input"
                type="date"
                value={value.start}
                onChange={(event) => onChange({ ...value, start: event.target.value })}
              />
            </label>
            <label className="field">
              <span>and ends</span>
              <input
                className="input"
                type="date"
                value={value.end}
                onChange={(event) => onChange({ ...value, end: event.target.value })}
              />
              <span className="muted-text" style={{ fontSize: 12 }}>
                This day of the month is where the cycle turns — a 13th-to-13th expense ends on
                the 13th. Enter it once; it moves forward on its own after that.
              </span>
            </label>
          </div>
          {preview ? (
            <p className="muted-text" style={{ margin: 0 }}>
              First invoice will read: <strong>{preview}</strong>
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  )
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
  const [coverage, setCoverage] = useState<CoverageDraft>(EMPTY_COVERAGE)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [pausingId, setPausingId] = useState<string | null>(null)

  // Inline edit state — only one row is editable at a time.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDescription, setEditDescription] = useState('')
  const [editAmount, setEditAmount] = useState('')
  const [editFrequency, setEditFrequency] = useState<RecurringReimbursementFrequency>('monthly')
  const [editStartDate, setEditStartDate] = useState('')
  const [editCoverage, setEditCoverage] = useState<CoverageDraft>(EMPTY_COVERAGE)
  const [savingEdit, setSavingEdit] = useState(false)
  const [editError, setEditError] = useState('')

  const beginEdit = (entry: RecurringReimbursement) => {
    setEditingId(entry.id)
    setEditDescription(entry.description)
    setEditAmount(String(entry.amount))
    setEditFrequency(entry.frequency)
    setEditStartDate(entry.startDate)
    setEditCoverage(coverageDraftFrom(entry))
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
    const coverageProblem = validateCoverage(editCoverage)
    if (coverageProblem) {
      setEditError(coverageProblem)
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
        ...coveragePayload(editCoverage),
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
    const coverageProblem = validateCoverage(coverage)
    if (coverageProblem) {
      setError(coverageProblem)
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
        ...coveragePayload(coverage),
      })
      setDescription('')
      setAmount('')
      setFrequency('monthly')
      setStartDate(today)
      setCoverage(EMPTY_COVERAGE)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add recurring reimbursement.')
    } finally {
      setSubmitting(false)
    }
  }

  const handleTogglePause = async (entry: RecurringReimbursement) => {
    if (pausingId) return
    setPausingId(entry.id)
    try {
      await updateRecurringReimbursement(entry.id, {
        coveragePaused: !entry.coveragePaused,
      })
    } catch (err) {
      window.alert(
        err instanceof ApiError ? err.message : 'Could not change the pause on that expense.',
      )
    } finally {
      setPausingId(null)
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
                <CoverageFields
                  value={editCoverage}
                  description={editDescription}
                  onChange={setEditCoverage}
                />
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
                    {entry.coveragePaused ? ' · paused' : ''}
                  </div>
                  {/* Where the cycle stands. Without this the only way to see
                      which window the next invoice will name is to generate it. */}
                  {entry.coverageEnabled ? (
                    <div className="checklist-meta-line">
                      {(() => {
                        // Named `covered`, not `window` — shadowing the global
                        // inside a component that also calls window.confirm and
                        // window.alert is a trap waiting for the next edit.
                        const covered = currentWindow(entry)
                        if (!covered) return 'Covered dates not set up yet'
                        return `Covering ${formatCoverageRange(covered.start, covered.end)}`
                      })()}
                    </div>
                  ) : null}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <strong>{currency.format(entry.amount)}</strong>
                  {ownerMode ? (
                    <>
                      {/* Pausing stops it billing. Resuming does NOT quietly
                          stride across the months it sat out — the next invoice
                          asks which window it covers. */}
                      <button
                        type="button"
                        className="item-delete-btn"
                        aria-label={
                          entry.coveragePaused
                            ? `Resume ${entry.description}`
                            : `Pause ${entry.description}`
                        }
                        title={
                          entry.coveragePaused
                            ? 'Start billing this again — the next invoice will ask you to confirm the dates it covers'
                            : 'Stop billing this for now'
                        }
                        disabled={editingId !== null || pausingId === entry.id}
                        onClick={() => void handleTogglePause(entry)}
                      >
                        {entry.coveragePaused ? <Play size={14} /> : <Pause size={14} />}
                      </button>
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
          <CoverageFields value={coverage} description={description} onChange={setCoverage} />
        </form>
      ) : null}
      {error ? <p className="auth-error">{error}</p> : null}
    </section>
  )
}
