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
 *    save-failed error.
 *  - Two kinds of load. The FIRST load (and an explicit Retry / Reload) sets
 *    `loading`, which disables the controls. A BACKGROUND refetch, run on
 *    the app's live-sync signal (`dataRefreshCount`, the same one
 *    ClientNotesPanel's pending-notes block uses), never touches `loading`,
 *    so the controls never flicker or lock. Any load is applied only if the
 *    panel is still clean when it RESOLVES (`dirtyRef`), so what she typed
 *    always wins (the version stays what she loaded, so a real conflict still
 *    409s on save), and a failed background refetch is ignored — only a
 *    failed first load or Retry shows the Retry block.
 */
export function ClientStatementsPanel({ clientId }: { clientId: string }) {
  const { data, dataRefreshCount = 0 } = useAppContext()
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [error, setError] = useState('')
  const [staleReload, setStaleReload] = useState(false)
  const [saving, setSaving] = useState(false)
  const [version, setVersion] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  // Unsaved local edits, tracked in a ref (not state) so a load can check it
  // at RESOLVE time without the effects depending on it.
  const dirtyRef = useRef(false)
  const loadedClientRef = useRef<string | null>(null)
  const mountedRef = useRef(true)
  // Newest-wins counters: a load's result is dropped when a newer load of the
  // same kind started after it, or (background) when a save landed after it.
  const foregroundSeqRef = useRef(0)
  const backgroundSeqRef = useRef(0)
  const loadingRef = useRef(true)
  const lastRefreshCountRef = useRef(dataRefreshCount)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const applyLoaded = (
    accounts: Array<{ id: string; name: string; dayOfMonth: number }>,
    loadedVersion: string,
  ) => {
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

  // Foreground load: first mount, a different client, and Retry / Reload. The
  // only load that sets `loading`. It is NOT cancelled by a background refetch
  // (that is what used to leave `loading` stuck); a newer foreground load or
  // unmount is the only thing that supersedes it.
  useEffect(() => {
    const seq = ++foregroundSeqRef.current
    if (loadedClientRef.current !== clientId) {
      // A different client: nothing of the previous one may stay on screen,
      // and its unsaved edits are not this client's.
      dirtyRef.current = false
      setRows([])
      setVersion(null)
      setLoadFailed(false)
    }
    const load = async () => {
      loadingRef.current = true
      setLoading(true)
      setError('')
      try {
        const { accounts, version: loadedVersion } =
          await listClientStatementAccountsRequest(clientId)
        if (!mountedRef.current || seq !== foregroundSeqRef.current) return
        if (!dirtyRef.current) applyLoaded(accounts, loadedVersion)
      } catch {
        if (!mountedRef.current || seq !== foregroundSeqRef.current) return
        setError('Could not load statement dates.')
        setLoadFailed(true)
      } finally {
        if (mountedRef.current && seq === foregroundSeqRef.current) {
          loadingRef.current = false
          setLoading(false)
        }
      }
    }
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- applyLoaded only closes over clientId and setters
  }, [clientId, reloadToken])

  // Background refetch: the live-sync signal landed. Never sets `loading`,
  // never shows an error, and never overwrites local edits.
  useEffect(() => {
    if (lastRefreshCountRef.current === dataRefreshCount) return
    lastRefreshCountRef.current = dataRefreshCount
    if (loadingRef.current) return
    const seq = ++backgroundSeqRef.current
    const load = async () => {
      try {
        const { accounts, version: loadedVersion } =
          await listClientStatementAccountsRequest(clientId)
        if (!mountedRef.current || seq !== backgroundSeqRef.current) return
        if (loadingRef.current || dirtyRef.current) return
        applyLoaded(accounts, loadedVersion)
      } catch {
        // Keep what is on screen; only the first load or a Retry reports.
      }
    }
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- applyLoaded only closes over clientId and setters
  }, [dataRefreshCount, clientId])

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
      // A background refetch still in flight read the list from before this
      // save; it must not land on top of what was just saved.
      backgroundSeqRef.current += 1
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
              Reload (discards your unsaved changes)
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
