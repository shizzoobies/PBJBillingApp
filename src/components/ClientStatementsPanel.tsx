import { useEffect, useMemo, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { useAppContext } from '../AppContext'
import { listClientStatementAccountsRequest, saveClientStatementAccountsRequest } from '../lib/api'

type Row = { id?: string; name: string; dayOfMonth: number | null }

const DAYS = Array.from({ length: 31 }, (_, index) => index + 1)

/**
 * Statement dates box: a reference-only list of accounts and the day of the
 * month each one's statement usually appears. Self-contained like
 * ClientNotesPanel — loads on mount, saves the whole box at once. Nothing
 * else in the app reads this data.
 *
 * The chip row below the rows suggests account names pulled from this
 * client's reconciliation checklist templates, so the common case (an
 * account that's already a reconciliation line item) is one click instead of
 * retyping the name.
 */
export function ClientStatementsPanel({ clientId }: { clientId: string }) {
  const { data } = useAppContext()
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError('')
      try {
        const accounts = await listClientStatementAccountsRequest(clientId)
        if (!cancelled) {
          setRows(
            accounts.map((account) => ({
              id: account.id,
              name: account.name,
              dayOfMonth: account.dayOfMonth,
            })),
          )
        }
      } catch {
        if (!cancelled) setError('Could not load statement dates.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [clientId])

  // Reconciliation item labels from this client's recurring templates, minus
  // names already in the box.
  const chipOptions = useMemo(() => {
    const already = new Set(rows.map((row) => row.name.trim().toLowerCase()).filter(Boolean))
    const labels = new Set<string>()
    for (const template of data.checklistTemplates) {
      if (template.clientId !== clientId) continue
      if (!template.title.toLowerCase().includes('reconciliation')) continue
      for (const stage of template.stages) {
        for (const item of stage.items) {
          const label = item.label?.trim()
          if (label && !already.has(label.toLowerCase())) labels.add(label)
        }
      }
    }
    return Array.from(labels)
  }, [data.checklistTemplates, clientId, rows])

  const addRow = (name = '') => {
    setRows((current) => [...current, { name, dayOfMonth: null }])
  }

  const updateRow = (index: number, patch: Partial<Row>) => {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  const removeRow = (index: number) => {
    setRows((current) => current.filter((_, i) => i !== index))
  }

  const save = async () => {
    setError('')
    // Rows with an empty name are silently dropped; a named row with no day
    // is refused rather than saved with a guessed date.
    const candidates = rows.filter((row) => row.name.trim())
    const missingDay = candidates.find((row) => !row.dayOfMonth)
    if (missingDay) {
      setError(`Pick a day for ${missingDay.name.trim()}`)
      return
    }
    setSaving(true)
    try {
      const savedAccounts = await saveClientStatementAccountsRequest(
        clientId,
        candidates.map((row) => ({
          id: row.id,
          name: row.name.trim(),
          dayOfMonth: row.dayOfMonth as number,
        })),
      )
      setRows(
        savedAccounts.map((account) => ({
          id: account.id,
          name: account.name,
          dayOfMonth: account.dayOfMonth,
        })),
      )
    } catch {
      setError('Could not save statement dates — please try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="statement-accounts-panel">
      <p className="field-helper">Reference only. Nothing else in the app reads these.</p>

      {loading ? (
        <p className="muted-text">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted-text">
          No statement dates yet. Add the accounts and the day of the month each statement
          usually appears.
        </p>
      ) : (
        <ul className="statement-accounts-list">
          {rows.map((row, index) => (
            <li className="statement-account-row" key={row.id ?? `new-${index}`}>
              <input
                type="text"
                value={row.name}
                placeholder="Account name"
                onChange={(event) => updateRow(index, { name: event.target.value })}
              />
              <select
                aria-label="Day"
                value={row.dayOfMonth ?? ''}
                onChange={(event) =>
                  updateRow(index, {
                    dayOfMonth: event.target.value ? Number(event.target.value) : null,
                  })
                }
              >
                <option value="">Day</option>
                {DAYS.map((day) => (
                  <option key={day} value={day}>
                    {day}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="statement-account-remove"
                onClick={() => removeRow(index)}
                aria-label={`Remove ${row.name.trim() || 'account'}`}
              >
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="button-row">
        <button type="button" className="secondary-action" onClick={() => addRow()}>
          <Plus size={14} /> Add account
        </button>
      </div>

      {chipOptions.length > 0 ? (
        <div className="sharing-control">
          <span className="sharing-helper">From the reconciliation checklist</span>
          <div className="sharing-chips">
            {chipOptions.map((label) => (
              <button
                key={label}
                type="button"
                className="add-person-pill"
                onClick={() => addRow(label)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {error ? <p className="statement-account-error">{error}</p> : null}

      <div className="button-row">
        <button
          type="button"
          className="primary-action"
          disabled={saving || loading}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}
