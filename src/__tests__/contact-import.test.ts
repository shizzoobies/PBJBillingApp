import { describe, expect, it } from 'vitest'
import type { Contact } from '../lib/types'
import {
  applyMerge,
  buildImportPlan,
  detectHeaderMap,
  findMatches,
  parseContactRows,
  type ParsedRow,
} from '../lib/contactImport'

describe('detectHeaderMap', () => {
  it('maps canonical headers to their fields', () => {
    const map = detectHeaderMap(['name', 'email', 'phone', 'title', 'notes'])
    expect(map).toEqual({ 0: 'name', 1: 'email', 2: 'phone', 3: 'title', 4: 'notes' })
  })

  it('recognizes aliases regardless of case and surrounding spaces', () => {
    const map = detectHeaderMap(['  Full Name ', 'E-Mail', 'MOBILE', 'Company', 'Comments'])
    expect(map).toEqual({ 0: 'name', 1: 'email', 2: 'phone', 3: 'title', 4: 'notes' })
  })

  it('ignores unrecognized columns', () => {
    const map = detectHeaderMap(['name', 'favorite color', 'email'])
    expect(map).toEqual({ 0: 'name', 2: 'email' })
  })

  it('keeps the first column when a field is duplicated', () => {
    const map = detectHeaderMap(['name', 'contact name', 'email'])
    expect(map).toEqual({ 0: 'name', 2: 'email' })
  })
})

describe('parseContactRows', () => {
  it('trims fields and only includes non-empty optionals', () => {
    const text = 'Name,Email,Phone\n  Jane  ,  jane@x.com  ,\nBob,,555-1212'
    const result = parseContactRows(text)
    expect(result.skipped).toBe(0)
    expect(result.rows).toEqual([
      { name: 'Jane', email: 'jane@x.com' },
      { name: 'Bob', phone: '555-1212' },
    ])
  })

  it('skips and counts rows whose name is empty', () => {
    const text = 'Name,Email\nJane,jane@x.com\n   ,nobody@x.com\n,still-nobody@x.com'
    const result = parseContactRows(text)
    expect(result.rows).toEqual([{ name: 'Jane', email: 'jane@x.com' }])
    expect(result.skipped).toBe(2)
  })

  it('exposes the detected header map', () => {
    const result = parseContactRows('Full Name,Job Title\nJane,CFO')
    expect(result.headerMap).toEqual({ 0: 'name', 1: 'title' })
    expect(result.rows).toEqual([{ name: 'Jane', title: 'CFO' }])
  })

  it('returns empty results for empty input', () => {
    expect(parseContactRows('')).toEqual({ rows: [], skipped: 0, headerMap: {} })
  })
})

const existing: Contact[] = [
  { id: 'c1', name: 'Jane Doe', email: 'jane@example.com', phone: '111' },
  { id: 'c2', name: 'Bob Smith', email: 'bob@example.com' },
  { id: 'c3', name: 'No Email Person' },
]

describe('findMatches', () => {
  it('matches on email case-insensitively', () => {
    const row: ParsedRow = { name: 'Totally Different', email: 'JANE@EXAMPLE.COM' }
    expect(findMatches(row, existing).map((c) => c.id)).toEqual(['c1'])
  })

  it('matches on name case-insensitively', () => {
    const row: ParsedRow = { name: 'bob smith' }
    expect(findMatches(row, existing).map((c) => c.id)).toEqual(['c2'])
  })

  it('matches on name OR email and returns all matches', () => {
    // name matches c1, email matches c2 → both returned
    const row: ParsedRow = { name: 'Jane Doe', email: 'bob@example.com' }
    expect(findMatches(row, existing).map((c) => c.id)).toEqual(['c1', 'c2'])
  })

  it('does not match on email when either side is empty', () => {
    const row: ParsedRow = { name: 'Brand New', email: '' }
    expect(findMatches(row, existing)).toEqual([])
    // existing c3 has no email; a blank-email row must not match it on email
    const row2: ParsedRow = { name: 'Brand New', email: 'someone@x.com' }
    expect(findMatches(row2, existing)).toEqual([])
  })

  it('returns no match for a genuinely new contact', () => {
    const row: ParsedRow = { name: 'Nobody Here', email: 'nobody@nowhere.com' }
    expect(findMatches(row, existing)).toEqual([])
  })
})

describe('buildImportPlan', () => {
  it('pairs each parsed row with its matches', () => {
    const text = 'Name,Email\nJane Doe,new@x.com\nFresh Face,fresh@x.com'
    const plan = buildImportPlan(text, existing)
    expect(plan).toHaveLength(2)
    expect(plan[0].row).toEqual({ name: 'Jane Doe', email: 'new@x.com' })
    expect(plan[0].matches.map((c) => c.id)).toEqual(['c1'])
    expect(plan[1].matches).toEqual([])
  })
})

describe('applyMerge', () => {
  it('fills only the blank fields from the CSV', () => {
    const target: Contact = { id: 'c2', name: 'Bob Smith', email: 'bob@example.com' }
    const row: ParsedRow = { name: 'Bob Smith', email: 'bob@example.com', phone: '999', title: 'CEO' }
    // phone + title are blank on existing → filled; name + email unchanged.
    expect(applyMerge(target, row, {})).toEqual({ phone: '999', title: 'CEO' })
  })

  it('defaults to keeping the existing value when fields differ', () => {
    const target: Contact = { id: 'c1', name: 'Jane Doe', phone: '111' }
    const row: ParsedRow = { name: 'Jane Doe', phone: '222' }
    expect(applyMerge(target, row, {})).toEqual({})
  })

  it('honors a per-field choice to take the CSV value', () => {
    const target: Contact = { id: 'c1', name: 'Jane Doe', phone: '111' }
    const row: ParsedRow = { name: 'Jane Doe', phone: '222' }
    expect(applyMerge(target, row, { phone: 'csv' })).toEqual({ phone: '222' })
  })

  it('returns a minimal patch — no unchanged or empty-CSV fields', () => {
    const target: Contact = {
      id: 'c1',
      name: 'Jane Doe',
      email: 'jane@example.com',
      phone: '111',
      title: 'CFO',
    }
    // identical name/email, differing phone (keep existing), blank notes/title in CSV
    const row: ParsedRow = { name: 'Jane Doe', email: 'jane@example.com', phone: '111' }
    expect(applyMerge(target, row, {})).toEqual({})
  })

  it('mixes a blank-fill and a chosen override in one patch', () => {
    const target: Contact = { id: 'c1', name: 'Jane Doe', phone: '111' }
    const row: ParsedRow = { name: 'Jane Doe', phone: '222', email: 'jane@new.com' }
    expect(applyMerge(target, row, { phone: 'csv' })).toEqual({
      phone: '222',
      email: 'jane@new.com',
    })
  })
})
