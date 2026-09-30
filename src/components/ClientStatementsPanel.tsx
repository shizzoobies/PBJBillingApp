import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { useAppContext } from '../AppContext'
import { ApiError } from '../lib/types'
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
 *
 * Two staleness guards, because a whole-list replace is otherwise
 * last-writer-wins across tabs:
 *  - A failed GET used to leave `rows` at its initial `[]` with Save still
 *    armed, so saving replaced the client's real list with nothing. While
 *    `loadFailed` is set, Save, Add account and the chips are all disabled
 *    (same while a load is still `loading` — a row added mid-load would be
 *    overwritten the moment it resolves), and a Retry button re-runs load().
 *  - Every load/save carries a `version` fingerprint of the stored list
 *    (see `statementAccountsVersion` in db/store.js). A save that no longer
 *    matches — another tab changed the list first — is refused with 409
 *    `stale_statement_accounts` instead of overwriting it; the panel shows
 *    the server's message with a Reload button rather than the ordinary
 *    save-failed error. The panel also refetches whenever the app's
 *    data-changed broadcast lands (a fresh `data` reference from
 *    AppContext) AS LONG AS there are no local edits in progress — the same
 *    reusable pattern ClientNotesPanel's pending-notes block uses for the
 *    same signal.
 */
export function ClientStatementsPanel({ clientId }: { clientId: string }) {
  const { data } = useAppContext()
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [error, setError] = useState('')
  const [staleReload, setStaleReload] = useState(false)
  const [saving, setSaving] = useState(false)
  const [version, setVersion] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  // Unsaved local edits, tracked in a ref (not state) so the load effect can
  // read it without depending on it — a data-changed refetch checks it and
  // skips entirely rather than clobbering a row the user is mid-typing.
  const dirtyRef = useRef(false)
  const loadedClientRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const isNewClient = loadedClientRef.current !== clientId
    if (!isNewClient && dirtyRef.current) {
      return
    }
    const load = async () => {
      setLoading(true)
      setError('')
      try {
        const { accounts, version: loadedVersion } =
          await listClientStatementAccountsRequest(clientId)
        if (!cancelled) {
          setRows(
            accounts.map((account) => ({
              id: account.id,
              name: account.name,
              dayOfMonth: account.dayOfMonth,
            })),
          )
          setVersion(loadedVersion)
          setLoadFailed(false)
          setStaleReload(false)
          dirtyRef.current = false
          loadedClientRef.current = clientId
        }
      } catch {
        if (!cancelled) {
          setError('Could not load statement dates.')
          setLoadFailed(true)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [clientId, data, reloadToken])

  // Reconciliation item labels from this client's recurring templates, minus
  // names already in the box. Deduped case-insensitively among themselves too
  // (keeping the first spelling seen) — a template can list the same account
  // under two capitalizations.
  const chipOptions = useMemo(() => {
    const already = new Set(rows.map((row) => row.name.trim().toLowerCase()).filter(Boolean))
    const seen = new Set<string>()
    const labels: string[] = []
    for (const template of data.checklistTemplates) {
      if (template.clientId !== clientId) continue
      if (!template.title.toLowerCase().includes('reconciliation')) continue
      for (const stage of template.stages) {
        for (const item of stage.items) {
          const label = item.label?.trim()
          if (!label) continue
          const key = label.toLowerCase()
          if (already.has(key) || seen.has(key)) continue
          seen.add(key)
          labels.push(label)
        }
      }
    }
    return labels
  }, [data.checklistTemplates, clientId, rows])

  const addRow = (name = '') => {
    dirtyRef.current = true
    setRows((current) => [...current, { name, dayOfMonth: null }])
  }

  const updateRow = (index: number, patch: Partial<Row>) => {
    dirtyRef.current = true
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  const removeRow = (index: number) => {
    dirtyRef.current = true
    setRows((current) => current.filter((_, i) => i !== index))
  }

  /** Retry (after a failed load) and Reload (after a stale-save 409) both mean
   *  the same thing: drop any local edits and re-run the load. */
  const reload = () => {
    dirtyRef.current = false
    setReloadToken((token) => token + 1)
  }

  const save = async () => {
    setError('')
    setStaleReload(false)
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
      const result = await saveClientStatementAccountsRequest(
        clientId,
        candidates.map((row) => ({
          id: row.id,
          name: row.name.trim(),
          dayOfMonth: row.dayOfMonth as number,
        })),
        version,
      )
      setRows(
        result.accounts.map((account) => ({
          id: account.id,
          name: account.name,
          dayOfMonth: account.dayOfMonth,
        })),
      )
      setVersion(result.version)
      dirtyRef.current = false
      loadedClientRef.current = clientId
    } catch (err) {
      if (err instanceof ApiError && err.code === 'stale_statement_accounts') {
        setError(err.message)
        setStaleReload(true)
      } else {
        setError('Could not save statement dates — please try again.')
      }
    } finally {
      setSaving(false)
    }
  }

  const controlsDisabled = loading || loadFailed

  return (
    <div className="statement-accounts-panel">
      <p className="field-helper">Reference only. Nothing else in the app reads these.</p>

      {loadFailed ? (
        <div className="statement-account-load-failed">
          <p className="muted-text">Could not load statement dates.</p>
          <button type="button" className="secondary-action" disabled={loading} onClick={reload}>
            Retry
          </button>
        </div>
      ) : loading && rows.length === 0 ? (
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
        <button
          type="button"
          className="secondary-action"
          disabled={controlsDisabled}
          onClick={() => addRow()}
        >
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
                disabled={controlsDisabled}
                onClick={() => addRow(label)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {error && !loadFailed ? (
        <p className="statement-account-error">
          {error}
          {staleReload ? (
            <button type="button" className="link-button" onClick={reload}>
              Reload
            </button>
          ) : null}
        </p>
      ) : null}

      <div className="button-row">
        <button
          type="button"
          className="primary-action"
          disabled={saving || controlsDisabled}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}
