import { describe, expect, it } from 'vitest'

import { buildQboCsv, csvCell, qboDate, QBO_COLUMNS } from './qbo-export.js'

/**
 * The QBO export. This file lands in Brittany's accounting system, so the cases
 * that matter most are the ones that corrupt an import silently: a client name
 * containing a comma, a voided invoice becoming a real receivable, and amounts
 * losing their cents.
 */

const clients = new Map([
  ['c1', { name: 'Acme LLC' }],
  ['c2', { name: 'Cooper & Cooper, PA' }],
])

const invoice = (over = {}) => ({
  id: 'inv-1',
  clientId: 'c1',
  period: '2026-08',
  number: 'INV-2026-08-001',
  status: 'draft',
  dueDate: '2026-09-30',
  lineItems: [{ kind: 'plan', label: 'Monthly service', detail: 'August', amount: 500 }],
  ...over,
})

describe('csvCell', () => {
  it('leaves ordinary text alone', () => {
    expect(csvCell('Acme LLC')).toBe('Acme LLC')
  })

  // The one that silently splits a column and shifts every field after it.
  it('quotes a value containing a comma', () => {
    expect(csvCell('Cooper & Cooper, PA')).toBe('"Cooper & Cooper, PA"')
  })

  it('doubles embedded quotes', () => {
    expect(csvCell('The "Classic" plan')).toBe('"The ""Classic"" plan"')
  })

  it('quotes newlines', () => {
    expect(csvCell('line one\nline two')).toBe('"line one\nline two"')
  })

  it('renders null and undefined as empty', () => {
    expect(csvCell(null)).toBe('')
    expect(csvCell(undefined)).toBe('')
  })
})

describe('qboDate', () => {
  it('converts ISO to the US format QBO expects', () => {
    expect(qboDate('2026-08-31')).toBe('08/31/2026')
    expect(qboDate('2026-01-05')).toBe('01/05/2026')
  })

  it('returns blank for anything unparseable rather than a wrong date', () => {
    expect(qboDate('')).toBe('')
    expect(qboDate(null)).toBe('')
    expect(qboDate('next tuesday')).toBe('')
  })
})

describe('buildQboCsv', () => {
  it('starts with the header row QBO matches on', () => {
    const csv = buildQboCsv([], clients)
    expect(csv.split('\r\n')[0]).toBe(QBO_COLUMNS.join(','))
  })

  it('writes one row per LINE, repeating the invoice header', () => {
    const csv = buildQboCsv(
      [
        invoice({
          lineItems: [
            { kind: 'plan', label: 'Monthly service', detail: '', amount: 500 },
            { kind: 'reimbursement', label: 'Filing fee', detail: 'Aug 3', amount: 40 },
          ],
        }),
      ],
      clients,
    )
    const rows = csv.split('\r\n')
    expect(rows).toHaveLength(3) // header + 2 lines
    expect(rows[1].startsWith('INV-2026-08-001,Acme LLC,08/31/2026,09/30/2026,Services,')).toBe(true)
    expect(rows[2]).toContain('Reimbursement')
  })

  it('uses the period END as the invoice date', () => {
    const csv = buildQboCsv([invoice({ period: '2026-02' })], clients)
    expect(csv).toContain('02/28/2026')
  })

  // A voided invoice is not owed. Importing it would create a receivable for
  // money nobody owes — the worst possible failure for this file.
  it('excludes voided invoices entirely', () => {
    const csv = buildQboCsv([invoice({ status: 'void' })], clients)
    expect(csv.split('\r\n')).toHaveLength(1)
  })

  it('quotes a client name with a comma so columns do not shift', () => {
    const csv = buildQboCsv([invoice({ clientId: 'c2' })], clients)
    expect(csv).toContain('"Cooper & Cooper, PA"')
    // Header + one line, and the row still has the right column count.
    const row = csv.split('\r\n')[1]
    expect(row.match(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/g)).toHaveLength(QBO_COLUMNS.length - 1)
  })

  it('keeps cents on every amount', () => {
    const csv = buildQboCsv(
      [invoice({ lineItems: [{ kind: 'plan', label: 'x', detail: '', amount: 1234.5 }] })],
      clients,
    )
    expect(csv).toContain('1234.50')
  })

  it('leaves quantity and rate blank so QBO cannot re-multiply the amount', () => {
    const csv = buildQboCsv([invoice()], clients)
    const cells = csv.split('\r\n')[1].split(',')
    expect(cells[6]).toBe('') // ItemQuantity
    expect(cells[7]).toBe('') // ItemRate
    expect(cells[8]).toBe('500.00') // ItemAmount
  })

  it('joins label and detail into one description', () => {
    const csv = buildQboCsv([invoice()], clients)
    expect(csv).toContain('Monthly service — August')
  })

  it('names an unknown client rather than writing a blank customer', () => {
    const csv = buildQboCsv([invoice({ clientId: 'gone' })], clients)
    expect(csv).toContain('Unknown client')
  })

  it('handles an invoice with no lines without emitting a broken row', () => {
    const csv = buildQboCsv([invoice({ lineItems: [] })], clients)
    expect(csv.split('\r\n')).toHaveLength(1)
  })
})
