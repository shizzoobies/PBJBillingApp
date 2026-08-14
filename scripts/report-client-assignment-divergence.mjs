#!/usr/bin/env node
/**
 * Read-only report: where do the two representations of "who is assigned to
 * this client" disagree in production?
 *
 *   clients.assigned_bookkeeper_ids  — the one that gates visibility
 *   client_assignments               — the inert second copy (batch 2 drops it)
 *
 * Anyone in the table but NOT in the column currently sees nothing for that
 * client. Merging them in would GRANT access that does not exist today, which
 * is a decision for Alex and Brittany — not for this script. It writes nothing.
 *
 * Usage:  DATABASE_URL=... node scripts/report-client-assignment-divergence.mjs
 */
import pg from 'pg'

const { DATABASE_URL } = process.env
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required (read-only — this script never writes).')
  process.exit(1)
}

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
})

async function main() {
  const { rows } = await pool.query(`
    select c.id,
           c.name,
           coalesce(c.assigned_bookkeeper_ids, '{}') as column_ids,
           coalesce(array_agg(a.user_id) filter (where a.user_id is not null), '{}') as table_ids
      from clients c
      left join client_assignments a on a.client_id = c.id
     group by c.id, c.name, c.assigned_bookkeeper_ids
     order by c.name asc
  `)

  const { rows: userRows } = await pool.query(
    `select id, name, role, inactive_at from users`,
  )
  const users = new Map(userRows.map((u) => [u.id, u]))
  const label = (id) => {
    const user = users.get(id)
    if (!user) return `${id} (NO SUCH USER)`
    const flags = [user.role === 'owner' ? 'owner' : null, user.inactive_at ? 'INACTIVE' : null]
      .filter(Boolean)
      .join(', ')
    return flags ? `${user.name} [${flags}]` : user.name
  }

  let diverged = 0
  for (const row of rows) {
    const column = new Set(row.column_ids)
    const table = new Set(row.table_ids)
    const tableOnly = [...table].filter((id) => !column.has(id))
    const columnOnly = [...column].filter((id) => !table.has(id))
    if (tableOnly.length === 0 && columnOnly.length === 0) continue

    diverged += 1
    console.log(`\n${row.name}  (${row.id})`)
    if (tableOnly.length > 0) {
      console.log(`  in client_assignments only — CANNOT see this client today:`)
      for (const id of tableOnly) console.log(`    - ${label(id)}`)
    }
    if (columnOnly.length > 0) {
      console.log(`  on the assigned team only — can see it, absent from the table:`)
      for (const id of columnOnly) console.log(`    - ${label(id)}`)
    }
  }

  console.log(
    `\n${diverged} of ${rows.length} clients disagree. ` +
      `Nothing was changed — this report is read-only.`,
  )
}

main()
  .catch((error) => {
    console.error(`Report failed: ${error.message}`)
    process.exitCode = 1
  })
  .finally(async () => {
    try {
      await pool.end()
    } catch (error) {
      console.error(`Failed to close database connection: ${error.message}`)
    }
  })
