/**
 * Multi-row INSERT for the bulk save (docs/plans/bulk-save-batching-2026-10.md).
 *
 * The whole-workspace save re-inserts every row of 14 tables while it holds all
 * of them EXCLUSIVE, one statement per row, so the time it holds the locks is
 * the number of rows times one network round trip. This sends the same rows as
 * `insert into <table> (<columns>) values ($1, $2, ...), ($n, ...)` in chunks.
 *
 * It is deliberately a plain VALUES list:
 *   - NOT `unnest($1::text[], ...)`: a ragged `text[]` COLUMN (group_client_ids,
 *     plan_ids, viewer_ids) cannot ride one array parameter per column.
 *   - NOT `jsonb_populate_recordset`: a jsonb value the caller already
 *     stringified would arrive as a jsonb STRING, not the object.
 * Every value is converted by the CALLER exactly as the per-row statement
 * converted it (JSON.stringify for jsonb, arrays for text[], Dates and nulls as
 * they were); this module only lays them out. A cast per column is spelled the
 * way the per-row statement spelled it (`$20::jsonb`) and a column the
 * per-row statement left uncast stays uncast, so the server types every value
 * as it did before.
 *
 * Rows go in payload order, chunk after chunk, on the SAME client (so the same
 * transaction and the table locks it already holds).
 */

/** The wire protocol's ceiling on bound parameters in one statement. */
export const MAX_STATEMENT_PARAMETERS = 65535

/** Rows per statement unless a caller says otherwise: far under the ceiling for any table here. */
export const DEFAULT_INSERT_CHUNK = 500

/**
 * @param {{ query: (text: string, params: unknown[]) => Promise<{ rows?: unknown[], rowCount?: number | null }> }} client
 * @param {object} options
 * @param {string} options.table
 * @param {string[]} options.columns - the columns bound to parameters, in the order each row lists them
 * @param {Record<string, string>} [options.casts] - column -> type, written `$n::type`
 * @param {Record<string, string>} [options.literals] - column -> SQL expression written inline AFTER
 *   the bound columns (`{ updated_at: 'now()' }`); consumes no parameter
 * @param {unknown[][]} options.rows - one array per row, aligned with `columns`
 * @param {number} [options.chunk] - rows per statement; lowered when a row would push a
 *   statement past MAX_STATEMENT_PARAMETERS
 * @param {string} [options.onConflict] - appended verbatim, e.g. `on conflict do nothing`
 * @param {string} [options.returning] - appended as `returning <this>`
 * @returns {Promise<{ rows: unknown[], rowCount: number }>} the `returning` rows of every chunk,
 *   concatenated in order, and the rows the statements reported inserted
 */
export async function insertRowsBatched(
  client,
  { table, columns, casts = {}, literals = {}, rows, chunk = DEFAULT_INSERT_CHUNK, onConflict, returning },
) {
  const returned = []
  let rowCount = 0
  if (rows.length === 0) return { rows: returned, rowCount }
  if (columns.length === 0) throw new Error(`insertRowsBatched(${table}): no columns`)
  if (columns.length > MAX_STATEMENT_PARAMETERS) {
    throw new Error(`insertRowsBatched(${table}): ${columns.length} columns cannot fit in one statement`)
  }

  const rowsPerStatement = Math.max(
    1,
    Math.min(chunk, Math.floor(MAX_STATEMENT_PARAMETERS / columns.length)),
  )
  const columnList = [...columns, ...Object.keys(literals)].join(', ')
  const literalList = Object.values(literals)
  const tail = `${onConflict ? ` ${onConflict}` : ''}${returning ? ` returning ${returning}` : ''}`

  for (let start = 0; start < rows.length; start += rowsPerStatement) {
    const params = []
    const tuples = rows.slice(start, start + rowsPerStatement).map((row) => {
      if (row.length !== columns.length) {
        throw new Error(
          `insertRowsBatched(${table}): row ${start + params.length / columns.length} has ${row.length} values for ${columns.length} columns`,
        )
      }
      const placeholders = columns.map((column, index) => {
        params.push(row[index])
        return `$${params.length}${casts[column] ? `::${casts[column]}` : ''}`
      })
      return `(${[...placeholders, ...literalList].join(', ')})`
    })
    const result = await client.query(
      `insert into ${table} (${columnList}) values ${tuples.join(', ')}${tail}`,
      params,
    )
    if (returning) returned.push(...(result?.rows ?? []))
    rowCount += Number.isInteger(result?.rowCount) ? result.rowCount : tuples.length
  }
  return { rows: returned, rowCount }
}
