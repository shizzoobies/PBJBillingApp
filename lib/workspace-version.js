/**
 * Workspace version fingerprint — the staleness guard for the bulk save.
 *
 * WHY THIS EXISTS
 * ---------------
 * `PUT /api/app-data` delete-and-reinserts fifteen tables from whatever
 * snapshot the calling tab holds. A tab that loaded BEFORE some other change
 * landed still holds the old snapshot, so its next autosave silently erases
 * everything created since. That is not hypothetical: it is how the Jan-May
 * 2026 historical import (1,368 entries / 961.8h) was wiped hours after it ran
 * on 2026-06-23 — see docs/HANDOFF.md §5.
 *
 * The guard: `GET /api/app-data` returns a fingerprint of the persisted state,
 * the tab echoes it back on `PUT`, and the server refuses (409) when the
 * fingerprint no longer matches. Stale snapshot in, nothing written.
 *
 * WHY A DERIVED FINGERPRINT AND NOT A BUMPED COUNTER
 * --------------------------------------------------
 * A revision counter has to be incremented at every write site. Miss one and
 * the guard under-fires *silently* — the dangerous direction, and this repo has
 * a history of changes that passed lint + build + tests and were still wrong
 * against real data. A fingerprint derived from the data itself cannot be
 * forgotten, has no restart or multi-instance edge case, and no race window.
 * The whole bulk-save-owned set is only ~3,700 rows, so recomputing is cheap.
 *
 * WHY NOT HASH `store.read()`
 * ---------------------------
 * `read()` is NOT a pure read: when the recurring-checklist materializer spawns
 * work it writes the result back (`db/store.js`, the `materialized.changed`
 * branch). Fingerprinting through `read()` would therefore be re-entrant during
 * a PUT and nondeterministic between two calls. Both branches below read
 * PERSISTED state directly instead.
 *
 * The two backends produce different fingerprint values for the same logical
 * workspace, and that is fine — a fingerprint is only ever compared against
 * another one from the same backend.
 */

import { createHash } from 'node:crypto'

/**
 * The tables `write()` wipes and re-inserts, i.e. everything a stale bulk save
 * can destroy. Kept in sync with the delete list at the top of the Postgres
 * branch of `store.write()`.
 *
 * `invoice_drafts` is deliberately ABSENT. `write()` deletes it but never
 * re-inserts it, and nothing else in the app reads or writes that table (it is
 * empty in production) — it is vestigial from the invoice cron that never
 * shipped. Fingerprinting a permanently-empty table adds a query and no signal.
 *
 * `users` is handled separately (see `USERS_VERSION_SQL`): the bulk save can
 * only ever change a member's NAME, so hashing the whole row would make every
 * unrelated `users` write (login bookkeeping, notification prefs, 2FA)
 * invalidate every open tab.
 */
export const BULK_SAVE_TABLES = [
  'clients',
  'client_assignments',
  'subscription_plans',
  'contacts',
  'time_entries',
  'timesheet_locks',
  'weekly_submissions',
  'checklists',
  'checklist_items',
  'checklist_templates',
  'checklist_template_stages',
  'checklist_template_items',
  'reimbursements',
  'recurring_reimbursements',
]

/**
 * Per-table digest.
 *
 * - `to_jsonb(t)` renders the whole row, so ANY column change is caught without
 *   naming columns here (a new column is covered the day it is added).
 * - `- 'updated_at' - 'created_at'` drops the bookkeeping timestamps. They churn
 *   on writes that change nothing else (and `write()` re-stamps `updated_at` on
 *   every row it re-inserts), which would spuriously invalidate live tabs.
 * - `order by x` over the rendered text makes the digest order-insensitive
 *   without needing to know each table's primary key — `client_assignments` and
 *   `timesheet_locks` have no single `id` column.
 * - `coalesce(..., '')` keeps an empty table hashing to a stable value rather
 *   than NULL.
 */
export function tableVersionSql(table) {
  return `select md5(coalesce(string_agg(x, ',' order by x), '')) as h
            from (select (to_jsonb(t) - 'updated_at' - 'created_at')::text as x
                    from ${table} t) s`
}

/**
 * `users` digest — id + name only, because that is the whole of what a bulk
 * save can overwrite (see the ON CONFLICT in `store.write()`: role, staff_role,
 * email and password_hash are all preserved). Inactive members are included:
 * they are still rows the save re-inserts.
 */
export const USERS_VERSION_SQL = `select md5(coalesce(string_agg(id || ':' || coalesce(name, ''), ',' order by id), '')) as h from users`

/**
 * All of the above as ONE statement.
 *
 * This runs on every `GET /api/app-data` (i.e. every page load) and every bulk
 * PUT, so it is deliberately a single round trip on a single pooled connection.
 * Firing the fifteen digests as separate concurrent queries measured ~1.3s
 * against production and would grab most of the connection pool on each page
 * load — enough to starve real traffic.
 *
 * Rows come back labelled, and the caller folds them in a fixed order so the
 * final digest never depends on row arrival order.
 */
export function workspaceVersionSql() {
  const parts = BULK_SAVE_TABLES.map(
    (table) => `select '${table}' as t, h from (${tableVersionSql(table)}) q_${table}`,
  )
  parts.push(`select 'users' as t, h from (${USERS_VERSION_SQL}) q_users`)
  return parts.join('\nunion all\n')
}

/** Fixed fold order for `workspaceVersionSql()` rows. */
export const VERSION_PART_ORDER = [...BULK_SAVE_TABLES, 'users']

/**
 * Fold `workspaceVersionSql()` rows into the final digest.
 *
 * `union all` makes no ordering promise, so rows are folded in
 * `VERSION_PART_ORDER` rather than arrival order — otherwise the same data
 * could hash differently between two runs.
 */
export function foldVersionRows(rows) {
  const byTable = new Map((rows ?? []).map((row) => [row.t, row.h || '']))
  const parts = VERSION_PART_ORDER.map((table) => `${table}=${byTable.get(table) ?? ''}`)
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32)
}

/**
 * Compute the fingerprint from any pg queryable — a Pool for the plain read, or
 * a checked-out client so the check can run INSIDE the bulk-save transaction.
 */
export async function postgresWorkspaceVersion(queryable) {
  const { rows } = await queryable.query(workspaceVersionSql())
  return foldVersionRows(rows)
}

/**
 * Thrown when a bulk save arrives carrying a fingerprint that no longer matches
 * the persisted workspace — i.e. the caller's snapshot is stale and writing it
 * would erase whatever landed in between. The endpoint maps this to a 409.
 */
export class StaleWorkspaceError extends Error {
  constructor(currentVersion) {
    super('stale_workspace')
    this.name = 'StaleWorkspaceError'
    this.currentVersion = currentVersion
  }
}

/**
 * The app-data slices the file backend persists, mirroring the table list
 * above. `checklists` carries its own `items`, and `recycledChecklists` is the
 * soft-deleted half of the same table, so both are listed.
 */
export const BULK_SAVE_SLICES = [
  'clients',
  'plans',
  'contacts',
  'timeEntries',
  'timesheetLocks',
  'weeklySubmissions',
  'checklists',
  'recycledChecklists',
  'checklistTemplates',
  'reimbursements',
  'recurringReimbursements',
]

/**
 * Stable stringify: object keys sorted at every depth so two structurally equal
 * records hash identically regardless of key insertion order (which differs
 * between a freshly-parsed JSON file and an in-memory object).
 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null)
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  const keys = Object.keys(value).sort()
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`
}

/** Drop the churn-only timestamps, matching the Postgres branch. */
function withoutTimestamps(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return record
  const { updatedAt: _updatedAt, createdAt: _createdAt, ...rest } = record
  return rest
}

/**
 * File-backend fingerprint. Takes the RAW persisted app-data object (not
 * `read()`'s materialized output) and hashes the same logical set the Postgres
 * branch does. Each slice is sorted by its rendered text so the digest is
 * order-insensitive, matching `order by x` above.
 *
 * @param {object} data - parsed contents of the app-data JSON file.
 * @returns {string} hex digest.
 */
export function fileWorkspaceVersion(data) {
  const source = data && typeof data === 'object' ? data : {}
  const hash = createHash('sha256')

  for (const slice of BULK_SAVE_SLICES) {
    const rows = Array.isArray(source[slice]) ? source[slice] : []
    const rendered = rows.map((row) => stableStringify(withoutTimestamps(row))).sort()
    hash.update(`${slice}:${rendered.join(',')}\n`)
  }

  // Employees mirror USERS_VERSION_SQL — id + name only.
  const employees = Array.isArray(source.employees) ? source.employees : []
  const names = employees
    .filter((employee) => employee && typeof employee.id === 'string')
    .map((employee) => `${employee.id}:${employee.name ?? ''}`)
    .sort()
  hash.update(`employees:${names.join(',')}\n`)

  return hash.digest('hex').slice(0, 32)
}
