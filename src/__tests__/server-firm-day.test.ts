import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { firmToday } from '../../lib/firm-time.js'
import { invoiceAsSent } from '../../lib/invoice-draft.js'
import { pastDueInvoice } from '../../lib/invoice-overdue.js'
import { currentPeriod } from '../../lib/periods.js'
import { weekStartOf } from '../../lib/time-entry.js'

/**
 * featreq-52362eac: the app's "today" is the firm's day (US Eastern) everywhere
 * the server decides one - the weekly time gate, the past-due list, the default
 * report period, the assistant, the month lock.
 *
 * `server.js` listens at module scope and exports nothing, so it cannot be
 * imported here (see invoice-past-due-routes.test.ts). Two halves instead: the
 * source pins below show every server site reads `firmToday()` through
 * `todayIso()`, and the clock cases run the shared rules each site feeds - on
 * the firm day `firmToday()` answers - at a clock where the UTC day and the
 * Eastern day differ.
 */

const serverSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.js'),
  'utf8',
)

afterEach(() => {
  vi.useRealTimers()
})

describe('at 11:30 pm Eastern on September 30th (03:30Z on October 1st)', () => {
  const freeze = () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-30T23:30:00-04:00'))
  }

  it('answers the firm day, not the UTC day', () => {
    freeze()
    expect(new Date().toISOString().slice(0, 10)).toBe('2026-10-01')
    expect(firmToday()).toBe('2026-09-30')
  })

  it('does not call a sent invoice due today past due yet', () => {
    freeze()
    const invoice = { status: 'sent', dueDate: '2026-09-30' }
    expect(pastDueInvoice(invoice, firmToday())).toBeNull()
    // The day this used to read: one evening early.
    expect(pastDueInvoice(invoice, '2026-10-01')).not.toBeNull()
  })

  it('defaults a report to the month the firm is still in', () => {
    freeze()
    expect(currentPeriod('month', firmToday())).toBe('2026-09')
    expect(currentPeriod('quarter', firmToday())).toBe('2026-Q3')
  })

  it('counts a first send’s due date from the firm day of the send', () => {
    freeze()
    const shaped = invoiceAsSent(
      { period: '2026-09', kind: 'monthly', sentAt: null, dueDate: '2026-10-15' },
      { client: { paymentTerms: 'Net 30' }, stamp: new Date().toISOString() },
    )
    expect(shaped.dueDate).toBe('2026-10-30')
  })
})

describe('on a Saturday evening in Eastern time', () => {
  it('anchors the weekly gate on the firm week, not the UTC one', () => {
    // 11:30 pm Eastern on Saturday October 3rd is already Sunday October 4th in UTC.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-03T23:30:00-04:00'))
    expect(weekStartOf(firmToday())).toBe('2026-09-27')
    expect(weekStartOf(new Date().toISOString().slice(0, 10))).toBe('2026-10-04')
  })
})

describe('server.js reads the firm day at every site', () => {
  it('makes todayIso() the firm day', () => {
    expect(serverSource).toMatch(/function todayIso\(\) \{\r?\n\s+return firmToday\(\)\r?\n\}/)
  })

  it('leaves no UTC day or month stamped as the app’s "today"', () => {
    // The weekly digest's weekday and week key come from the same firm day.
    expect(serverSource.match(/new Date\(\)\.toISOString\(\)\.slice\(0, (7|10)\)/g)).toBeNull()
  })

  it('takes the weekly digest’s weekday and week key from the firm day', () => {
    expect(serverSource).toContain('const firmDay = todayIso()')
    expect(serverSource).toContain('const weekKey = weekStartOf(firmDay)')
  })

  it('checks the month lock against the firm month', () => {
    expect(serverSource).toContain('const currentMonth = firmToday().slice(0, 7)')
    expect(serverSource).not.toContain('const currentMonth = new Date()')
  })

  it('feeds the weekly gate and the recaps the same day', () => {
    expect(serverSource.match(/weekStartOf\(todayIso\(\)\)/g)?.length).toBeGreaterThanOrEqual(3)
    expect(serverSource.match(/today: todayIso\(\)/g)?.length).toBeGreaterThanOrEqual(3)
  })

  it('hands the past-due list and the notice scheduler the same day', () => {
    expect(serverSource).toMatch(/const today = todayIso\(\)\r?\n\s+sendJson\(response, 200, \{\r?\n\s+invoices: invoices\r?\n\s+\.filter\(\(invoice\) => pastDueInvoice\(invoice, today\)\)/)
    expect(serverSource).toMatch(/async function maybeNotifyPastDueInvoices[\s\S]*?const today = todayIso\(\)/)
  })
})
