import { describe, expect, it } from 'vitest'

import {
  DEFAULT_INSERT_CHUNK,
  MAX_STATEMENT_PARAMETERS,
  insertRowsBatched,
} from './insert-rows-batched.js'

/** A client that records every statement and answers with whatever `answer` builds. */
function recorder(answer = () => ({ rows: [], rowCount: undefined })) {
  const statements = []
  return {
    statements,
    async query(text, params) {
      statements.push({ text, params })
      return answer(text, params, statements.length)
    },
  }
}

const rowsOf = (count, width = 3) =>
  Array.from({ length: count }, (_, index) => Array.from({ length: width }, (_, column) => `r${index}c${column}`))

const tuplesIn = (text) => text.split(/\)\s*,\s*\(/).length

describe('insertRowsBatched', () => {
  it('is a no-op for no rows: no statement, nothing returned', async () => {
    const client = recorder()
    const result = await insertRowsBatched(client, { table: 't', columns: ['a', 'b', 'c'], rows: [] })

    expect(client.statements).toEqual([])
    expect(result).toEqual({ rows: [], rowCount: 0 })
  })

  it.each([
    [1, [1]],
    [500, [500]],
    [501, [500, 1]],
    [1000, [500, 500]],
    [1001, [500, 500, 1]],
  ])('sends %i rows as statements of %j rows', async (count, sizes) => {
    const client = recorder()
    const rows = rowsOf(count)
    await insertRowsBatched(client, { table: 't', columns: ['a', 'b', 'c'], rows })

    expect(client.statements.map((statement) => statement.params.length / 3)).toEqual(sizes)
    expect(client.statements.map((statement) => tuplesIn(statement.text))).toEqual(sizes)
    // Payload order, chunk after chunk, nothing dropped or repeated.
    expect(client.statements.flatMap((statement) => statement.params)).toEqual(rows.flat())
  })

  it('writes a plain VALUES list with numbered placeholders that restart at $1 in each statement', async () => {
    const client = recorder()
    await insertRowsBatched(client, { table: 'things', columns: ['a', 'b'], rows: [['x', 1], ['y', 2], ['z', 3]], chunk: 2 })

    expect(client.statements.map((statement) => statement.text)).toEqual([
      'insert into things (a, b) values ($1, $2), ($3, $4)',
      'insert into things (a, b) values ($1, $2)',
    ])
    expect(client.statements.map((statement) => statement.params)).toEqual([['x', 1, 'y', 2], ['z', 3]])
  })

  it('casts a column the way the caller named it, leaves the others bare, and adds literals last', async () => {
    const client = recorder()
    await insertRowsBatched(client, {
      table: 'time_entries',
      columns: ['id', 'sessions', 'tags'],
      casts: { sessions: 'jsonb', tags: 'text[]' },
      literals: { updated_at: 'now()' },
      rows: [
        ['a', '[]', ['x']],
        ['b', '[{}]', []],
      ],
    })

    expect(client.statements).toHaveLength(1)
    expect(client.statements[0].text).toBe(
      'insert into time_entries (id, sessions, tags, updated_at) values ' +
        '($1, $2::jsonb, $3::text[], now()), ($4, $5::jsonb, $6::text[], now())',
    )
  })

  it('appends on conflict and returning, and hands the returned rows back in order', async () => {
    const client = recorder((_text, params) => ({
      rows: params.filter((_value, index) => index % 2 === 0).map((id) => ({ id })),
      rowCount: params.length / 2,
    }))
    const result = await insertRowsBatched(client, {
      table: 'checklists',
      columns: ['id', 'title'],
      rows: [['c1', 'a'], ['c2', 'b'], ['c3', 'c']],
      chunk: 2,
      onConflict: 'on conflict do nothing',
      returning: 'id',
    })

    for (const statement of client.statements) {
      expect(statement.text).toMatch(/\) on conflict do nothing returning id$/)
    }
    expect(result.rows).toEqual([{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }])
    expect(result.rowCount).toBe(3)
  })

  it('counts what the statements report, and the tuples when a pool reports nothing', async () => {
    const reported = await insertRowsBatched(recorder(() => ({ rows: [], rowCount: 1 })), {
      table: 't',
      columns: ['a'],
      rows: [['x'], ['y']],
    })
    expect(reported.rowCount).toBe(1)

    const silent = await insertRowsBatched(recorder(() => ({ rows: [] })), {
      table: 't',
      columns: ['a'],
      rows: [['x'], ['y']],
    })
    expect(silent.rowCount).toBe(2)
  })

  it('passes every value through untouched: Dates, nulls, arrays and JSON strings', async () => {
    const client = recorder()
    const when = new Date('2026-03-05T16:00:00.000Z')
    const row = [when, null, ['a', 'b'], '{"k":[1,2]}', 0, false, '']
    await insertRowsBatched(client, { table: 't', columns: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], rows: [row] })

    const [{ params }] = client.statements
    expect(params).toEqual(row)
    expect(params[0]).toBe(when)
    expect(params[2]).toBe(row[2])
  })

  describe('the parameter ceiling', () => {
    it('never puts more than 65,535 parameters in a statement, however wide the table', async () => {
      const columns = Array.from({ length: 200 }, (_, index) => `c${index}`)
      const client = recorder()
      const rows = rowsOf(1000, columns.length)
      await insertRowsBatched(client, { table: 'wide', columns, rows })

      // 65,535 / 200 = 327 rows fit; the default 500 would not.
      expect(DEFAULT_INSERT_CHUNK * columns.length).toBeGreaterThan(MAX_STATEMENT_PARAMETERS)
      expect(client.statements.map((statement) => statement.params.length / columns.length)).toEqual([327, 327, 327, 19])
      for (const statement of client.statements) {
        expect(statement.params.length).toBeLessThanOrEqual(MAX_STATEMENT_PARAMETERS)
        const highest = Math.max(...[...statement.text.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])))
        expect(highest).toBe(statement.params.length)
      }
      expect(client.statements.flatMap((statement) => statement.params)).toEqual(rows.flat())
    })

    it('keeps the chunk a caller asks for when it already fits', async () => {
      const client = recorder()
      await insertRowsBatched(client, { table: 't', columns: ['a'], rows: rowsOf(10, 1), chunk: 4 })
      expect(client.statements.map((statement) => statement.params.length)).toEqual([4, 4, 2])
    })

    it('refuses a table that cannot fit one row in a statement', async () => {
      const columns = Array.from({ length: MAX_STATEMENT_PARAMETERS + 1 }, (_, index) => `c${index}`)
      const client = recorder()
      await expect(
        insertRowsBatched(client, { table: 'absurd', columns, rows: [columns.map(() => 1)] }),
      ).rejects.toThrow(/cannot fit in one statement/)
      expect(client.statements).toEqual([])
    })
  })

  it('refuses a row whose width is not the column count, before sending that chunk', async () => {
    const client = recorder()
    await expect(
      insertRowsBatched(client, { table: 't', columns: ['a', 'b'], rows: [['x', 1], ['y']] }),
    ).rejects.toThrow(/row 1 has 1 values for 2 columns/)
    expect(client.statements).toEqual([])
  })

  it('stops at the first failing statement: later chunks are never sent, and the error is the caller’s', async () => {
    const boom = Object.assign(new Error('violates foreign key constraint'), { code: '23503' })
    const client = recorder((_text, _params, count) => {
      if (count === 2) throw boom
      return { rows: [], rowCount: 2 }
    })

    await expect(
      insertRowsBatched(client, { table: 't', columns: ['a'], rows: rowsOf(6, 1), chunk: 2 }),
    ).rejects.toBe(boom)
    expect(client.statements).toHaveLength(2)
  })

  it('issues every statement through the one client it was handed (same connection, same transaction)', async () => {
    const seen = []
    const client = {
      async query(text) {
        seen.push(this === client)
        return { rows: [], rowCount: 0 }
      },
    }
    await insertRowsBatched(client, { table: 't', columns: ['a'], rows: rowsOf(3, 1), chunk: 1 })
    expect(seen).toEqual([true, true, true])
  })
})
