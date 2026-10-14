import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Automatic invoice reminders (featreq-3f1d63b6): the four days, who is
 * reminded, and the runner that sends through the SAME `remindInvoice` the
 * button uses. Nothing here emails anybody: the mail sender is a recording fake,
 * the store is an in-memory fake that behaves like the real one where it
 * matters (a recorded reminder lands on the invoice's log), and Stripe and the
 * network fail the test if touched.
 *
 * Instants are written with an explicit Eastern offset (`-04:00` in October,
 * `-05:00` in winter) and never sliced out of `toISOString()`, so no case flips
 * after 8 pm Eastern.
 */
const stripe = vi.hoisted(() => ({
  createInvoiceCheckoutSession: vi.fn(),
  createInvoiceCardCheckoutSession: vi.fn(),
  ensureStripeCustomer: vi.fn(),
  expireCheckoutSession: vi.fn(),
  stripeClient: vi.fn(),
}))
vi.mock('./stripe-rail.js', async (importOriginal) => ({ ...(await importOriginal()), ...stripe }))

const {
  AUTO_REMINDER_EVENT,
  AUTO_REMINDER_MIN_DAYS_AFTER_SEND,
  autoReminderMode,
  firmHourOf,
  isAutoReminderDay,
  minDaysAfterSend,
  planAutoReminders,
  planAutoRemindersFor,
  resetAutoReminderState,
  runAutoInvoiceReminders,
} = await import('./invoice-auto-reminders.js')
const { unresolvedPaymentFailure } = await import('./invoice-overdue.js')

describe('isAutoReminderDay', () => {
  it.each(['2026-10-15', '2026-10-20', '2026-10-25', '2026-10-31', '2026-01-15', '2026-12-20'])(
    'is a reminder day: %s',
    (day) => expect(isAutoReminderDay(day)).toBe(true),
  )

  it.each(['2026-10-14', '2026-10-16', '2026-10-19', '2026-10-21', '2026-10-24', '2026-10-26', '2026-10-30', '2026-10-01'])(
    'is not a reminder day: %s (the 14th and the 16th are not)',
    (day) => expect(isAutoReminderDay(day)).toBe(false),
  )

  it('takes the LAST day of each month, whatever its length', () => {
    // February: 28 in 2027, 29 in the leap year 2028.
    expect(isAutoReminderDay('2027-02-28')).toBe(true)
    expect(isAutoReminderDay('2027-02-27')).toBe(false)
    expect(isAutoReminderDay('2028-02-29')).toBe(true)
    expect(isAutoReminderDay('2028-02-28')).toBe(false)
    // A 30-day month, and a 31-day one.
    expect(isAutoReminderDay('2026-04-30')).toBe(true)
    expect(isAutoReminderDay('2026-04-29')).toBe(false)
    expect(isAutoReminderDay('2026-12-31')).toBe(true)
    expect(isAutoReminderDay('2026-12-30')).toBe(false)
  })

  it('says no to anything that is not a firm day', () => {
    for (const bad of ['', 'tomorrow', '2026-13-15', '2026-10-5', null, undefined, 15]) {
      expect(isAutoReminderDay(bad)).toBe(false)
    }
  })
})

describe('firmHourOf', () => {
  it('reads the hour on the firm clock, summer and winter', () => {
    expect(firmHourOf(new Date('2026-10-15T09:00:00-04:00'))).toBe(9)
    expect(firmHourOf(new Date('2026-10-15T08:59:59-04:00'))).toBe(8)
    expect(firmHourOf(new Date('2026-12-31T17:59:59-05:00'))).toBe(17)
    expect(firmHourOf(new Date('2026-12-31T18:00:00-05:00'))).toBe(18)
    // 01:00Z on the 16th is 9 pm on the 15th in Eastern.
    expect(firmHourOf(new Date('2026-10-16T01:00:00Z'))).toBe(21)
    expect(firmHourOf(new Date('nope'))).toBe(-1)
  })
})

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const TODAY = '2026-10-15'
const SENT_AT = '2026-10-01T14:00:00.000Z'
const SEND = { at: SENT_AT, to: ['c-acme@client.test'], subject: 'Invoice', ok: true, total: 945 }
const FAILURE = { kind: 'payment', event: 'failed', at: '2026-10-05T12:00:00.000Z', paymentIntentId: 'pi_1' }

const client = (id, name, over = {}) => ({
  id,
  name,
  email: `${id}@client.test`,
  contactIds: [],
  paymentTerms: '',
  ...over,
})

const invoice = (id, over = {}) => ({
  id,
  clientId: 'c-acme',
  period: '2026-09',
  kind: 'monthly',
  number: `INV-2026-09-${id}`,
  status: 'sent',
  lineItems: [{ kind: 'plan', label: 'Monthly service', detail: '', amount: 945 }],
  subtotal: 945,
  total: 945,
  dueDate: '2026-10-31',
  blurb: '',
  sentAt: SENT_AT,
  payToken: `tok_${id}`,
  emailLog: [{ ...SEND, to: [`${over.clientId ?? 'c-acme'}@client.test`] }],
  ...over,
})

describe('planAutoReminders', () => {
  const clients = [
    client('c-acme', 'Acme'),
    client('c-optout', 'Outside Co', { platformInvoicingOptOut: true }),
    client('c-never', 'Never Co', { invoiceNoEmail: true }),
  ]
  const plan = (invoices, extra = {}) => planAutoReminders({ invoices, clients, today: TODAY, ...extra })
  const ids = (list) => list.map((entry) => entry.invoice.id)

  it('reminds a sent invoice that is owed, and an overdue one', () => {
    const result = plan([invoice('a'), invoice('b', { status: 'overdue' })])
    expect(ids(result.remind)).toEqual(['a', 'b'])
    expect(result.skipped).toEqual([])
  })

  it('includes an invoice sitting in Payment failed (a reminder clears it)', () => {
    const failed = invoice('f', { emailLog: [SEND, FAILURE] })
    expect(unresolvedPaymentFailure(failed)).not.toBeNull()
    expect(ids(plan([failed]).remind)).toEqual(['f'])
  })

  it('does not list a draft, reviewed, paid, void or processing invoice at all', () => {
    const result = plan(['draft', 'reviewed', 'paid', 'void', 'processing'].map((status) => invoice(status, { status })))
    expect(result.remind).toEqual([])
    expect(result.skipped).toEqual([])
  })

  it('skips, with the rule\'s own code, what a manual reminder would refuse', () => {
    const result = plan(
      [
        invoice('zero', { total: 0 }),
        invoice('opt', { clientId: 'c-optout' }),
        invoice('never', { clientId: 'c-never' }),
        invoice('auto'),
        invoice('chg'),
        invoice('ghost', { clientId: 'c-gone' }),
      ],
      { autopayInFlight: new Set(['auto']), changedSinceSent: new Set(['chg']) },
    )
    expect(result.remind).toEqual([])
    expect(Object.fromEntries(result.skipped.map((entry) => [entry.invoice.id, entry.code]))).toEqual({
      zero: 'nothing_owed',
      opt: 'client_opted_out',
      never: 'client_not_emailed',
      auto: 'autopay_in_flight',
      chg: 'changed_since_sent',
      ghost: 'invoice_no_client',
    })
  })

  it('skips an invoice reminded earlier today, or sent today; not one reminded yesterday', () => {
    const reminder = (at) => ({ at, to: ['x@y.test'], subject: 'R', ok: true, kind: 'reminder' })
    const result = plan([
      invoice('today', { emailLog: [SEND, reminder('2026-10-15T12:30:00.000Z')] }),
      invoice('sentToday', { emailLog: [{ ...SEND, at: '2026-10-15T13:00:00.000Z' }] }),
      // 9:30 pm Eastern on the 14th is the 15th in UTC: a different FIRM day.
      invoice('yesterday', { emailLog: [SEND, reminder('2026-10-15T01:30:00.000Z')] }),
      invoice('failedToday', { emailLog: [SEND, { ...reminder('2026-10-15T12:30:00.000Z'), ok: false }] }),
    ])
    expect(ids(result.remind)).toEqual(['failedToday', 'yesterday'])
    expect(result.skipped.map((entry) => [entry.invoice.id, entry.code])).toEqual([
      ['sentToday', 'reminded_today'],
      ['today', 'reminded_today'],
    ])
  })

  it('never auto-reminds an invoice the app never emailed (a not-emailed stamp, or a legacy Sent row with no log)', () => {
    const stamp = { at: SENT_AT, to: [], subject: '', ok: true, kind: 'not-emailed' }
    const result = plan([
      invoice('stamp', { emailLog: [stamp] }),
      invoice('legacy', { emailLog: [] }),
      invoice('nolog', { emailLog: undefined }),
      // A reminder alone is not a send either.
      invoice('remindedOnly', {
        emailLog: [{ at: '2026-10-05T12:00:00.000Z', to: ['x@y.test'], subject: 'R', ok: true, kind: 'reminder' }],
      }),
      // A send that failed never reached the client.
      invoice('failedSend', { emailLog: [{ ...SEND, ok: false }] }),
    ])
    expect(result.remind).toEqual([])
    expect(result.skipped.map((entry) => [entry.invoice.id, entry.code])).toEqual([
      ['failedSend', 'never_emailed'],
      ['legacy', 'never_emailed'],
      ['nolog', 'never_emailed'],
      ['remindedOnly', 'never_emailed'],
      ['stamp', 'never_emailed'],
    ])
  })

  it('leaves a freshly sent invoice alone: under 5 firm days since the last real send is skipped, 5 is reminded', () => {
    const sentOn = (at) => invoice('x', { emailLog: [{ ...SEND, at }] })
    // Today is 2026-10-15. 4 firm days ago:
    expect(plan([sentOn('2026-10-11T14:00:00.000Z')]).skipped.map((entry) => entry.code)).toEqual(['sent_recently'])
    // 5 firm days ago:
    expect(ids(plan([sentOn('2026-10-10T14:00:00.000Z')]).remind)).toEqual(['x'])
    // 9 pm Eastern on the 10th is already the 11th in UTC: the FIRM day is the 10th, so 5 days.
    expect(ids(plan([sentOn('2026-10-11T01:00:00.000Z')]).remind)).toEqual(['x'])
    // And 9 pm on the 11th (the 12th in UTC) is 4 firm days ago.
    expect(plan([sentOn('2026-10-12T01:00:00.000Z')]).skipped.map((entry) => entry.code)).toEqual(['sent_recently'])
  })

  it('does not restart the clock on a reminder: only the last REAL send counts', () => {
    const reminder = { at: '2026-10-13T12:00:00.000Z', to: ['x@y.test'], subject: 'R', ok: true, kind: 'reminder' }
    expect(ids(plan([invoice('x', { emailLog: [SEND, reminder] })]).remind)).toEqual(['x'])
  })

  it('takes the minimum from the call, and from INVOICE_AUTO_REMINDER_MIN_DAYS', () => {
    const recent = invoice('x', { emailLog: [{ ...SEND, at: '2026-10-11T14:00:00.000Z' }] })
    expect(ids(plan([recent], { minDaysAfterSend: 4 }).remind)).toEqual(['x'])
    expect(plan([recent], { minDaysAfterSend: 10 }).remind).toEqual([])
    expect(AUTO_REMINDER_MIN_DAYS_AFTER_SEND).toBe(5)
    expect(minDaysAfterSend({})).toBe(5)
    expect(minDaysAfterSend({ INVOICE_AUTO_REMINDER_MIN_DAYS: '2' })).toBe(2)
    expect(minDaysAfterSend({ INVOICE_AUTO_REMINDER_MIN_DAYS: '0' })).toBe(0)
    for (const bad of ['', 'soon', '-1', '1.5']) {
      expect(minDaysAfterSend({ INVOICE_AUTO_REMINDER_MIN_DAYS: bad })).toBe(5)
    }
  })

  it('keeps going month after month: an invoice from an old period is still reminded', () => {
    expect(ids(plan([invoice('old', { period: '2026-03' })]).remind)).toEqual(['old'])
  })
})

/* -------------------------------------------------------------------------- */
/* The runner, against a stateful fake store                                   */
/* -------------------------------------------------------------------------- */

const ENV = { RESEND_API_KEY: 're_test', EMAIL_FROM: 'billing@pbjsa.test' }
const TEN_AM = new Date('2026-10-15T10:00:00-04:00')

function makeWorld({
  invoices,
  clients = [client('c-acme', 'Acme'), client('c-bolt', 'Bolt')],
  contacts = [],
  attempts = [],
  changedIds = [],
}) {
  const state = structuredClone(invoices)
  const store = {
    state,
    listInvoices: vi.fn(async (opts) =>
      structuredClone(state.filter((entry) => !opts?.period || entry.period === opts.period)),
    ),
    read: vi.fn(async () => ({ clients, contacts })),
    withChangedSinceSent: vi.fn(async (list) =>
      list.map((entry) => (changedIds.includes(entry.id) ? { ...entry, changedSinceSent: true } : entry)),
    ),
    listAutopayAttempts: vi.fn(async (opts) =>
      attempts.filter((attempt) => !opts?.invoiceId || attempt.invoiceId === opts.invoiceId),
    ),
    getOrCreateInvoicePayToken: vi.fn(async (id) => state.find((entry) => entry.id === id).payToken),
    getFirmSettings: vi.fn(async () => ({ name: 'PB&J Strategic Accounting' })),
    // What the real store does with a reminder entry: it lands on the log, with
    // the clearing and the automatic mark when the caller says so.
    recordInvoiceSent: vi.fn(async (id, entry) => {
      const row = state.find((candidate) => candidate.id === id)
      row.emailLog.push({
        at: entry.stamp,
        to: entry.to,
        subject: entry.subject,
        ok: entry.ok,
        kind: entry.kind,
        ...(entry.kind === 'reminder' && entry.ok && entry.clearedPaymentFailure
          ? { clearedPaymentFailed: true, clearedFailureAt: entry.clearedPaymentFailure }
          : {}),
        ...(entry.kind === 'reminder' && entry.auto === true ? { auto: true } : {}),
      })
      return structuredClone(row)
    }),
    recordActivity: vi.fn(async () => undefined),
  }
  const sent = []
  const sendEmail = vi.fn(async (message) => {
    sent.push(message)
    return { ok: true, error: null, providerId: `re_${sent.length}`, status: 200 }
  })
  const notified = []
  const notifyOwners = vi.fn(async (message) => {
    notified.push(message)
  })
  const log = { log: vi.fn(), error: vi.fn() }
  const sleep = vi.fn(async () => undefined)
  const run = (over = {}) =>
    runAutoInvoiceReminders({
      store,
      sendEmail,
      notifyOwners,
      env: ENV,
      clock: () => TEN_AM,
      appUrl: 'https://app.pbjsa.test',
      stripeConfigured: true,
      pauseMs: 0,
      sleep,
      log,
      summaryAlreadySent: async () => notified.length > 0,
      ...over,
    })
  return { store, sent, sendEmail, notified, notifyOwners, log, sleep, run }
}

let fetchSpy
beforeEach(() => {
  resetAutoReminderState()
  for (const fn of Object.values(stripe)) fn.mockReset()
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('an auto-reminder test reached the network')
  })
})
afterEach(() => {
  for (const [name, fn] of Object.entries(stripe)) expect(fn, `${name} was called`).not.toHaveBeenCalled()
  expect(fetchSpy).not.toHaveBeenCalled()
  fetchSpy.mockRestore()
})

describe('runAutoInvoiceReminders', () => {
  const twoInvoices = () => [
    invoice('a'),
    invoice('b', { clientId: 'c-bolt', emailLog: [{ ...SEND, to: ['c-bolt@client.test'] }] }),
  ]

  it('sends each reminder through remindInvoice (same email, same link) and files ONE owner summary', async () => {
    const world = makeWorld({ invoices: twoInvoices() })
    const result = await world.run()

    expect(result).toMatchObject({ ran: true, today: TODAY, attempted: 2, reminded: 2, notified: true })
    expect(world.sent).toHaveLength(2)
    expect(world.sent[0]).toMatchObject({
      to: ['c-acme@client.test'],
      subject: 'Reminder: invoice INV-2026-09-a from PB&J Strategic Accounting',
      kind: 'reminder',
      invoiceId: 'a',
    })
    // The invoice's own durable link, never a new Checkout session.
    expect(world.sent[0].html).toContain('https://app.pbjsa.test/pay/tok_a')
    expect(world.sent[1].to).toEqual(['c-bolt@client.test'])
    // The log entry is the manual button's, marked automatic.
    expect(world.store.state[0].emailLog.at(-1)).toMatchObject({ kind: 'reminder', ok: true, auto: true })
    // ONE notification for the whole run.
    expect(world.notifyOwners).toHaveBeenCalledTimes(1)
    expect(world.notified[0]).toBe('Automatic invoice reminders - 2026-10-15: reminded 2 of 2')
    expect(AUTO_REMINDER_EVENT).toBe('invoice_auto_reminders')
  })

  it('pauses between sends, not before the first', async () => {
    const world = makeWorld({ invoices: twoInvoices() })
    await world.run({ pauseMs: 250 })
    expect(world.sleep.mock.calls).toEqual([[250]])
  })

  it('sends nothing the second time the same day (the once-a-day guard is the reminder rule)', async () => {
    const world = makeWorld({ invoices: twoInvoices() })
    await world.run()
    const again = await world.run({ clock: () => new Date('2026-10-15T11:00:00-04:00') })

    expect(again).toMatchObject({ ran: true, attempted: 0, reminded: 0, notified: false })
    expect(world.sent).toHaveLength(2)
    expect(world.notifyOwners).toHaveBeenCalledTimes(1)
    // ...and a restart late in the afternoon is just as quiet.
    await world.run({ clock: () => new Date('2026-10-15T17:30:00-04:00') })
    expect(world.sent).toHaveLength(2)
  })

  it('goes again on the next reminder day, for an invoice still unpaid', async () => {
    const world = makeWorld({ invoices: twoInvoices() })
    await world.run()
    const twentieth = await world.run({ clock: () => new Date('2026-10-20T09:00:00-04:00') })
    expect(twentieth).toMatchObject({ attempted: 2, reminded: 2 })
    expect(world.sent).toHaveLength(4)
    // Paid since: no longer reminded.
    world.store.state[0].status = 'paid'
    const twentyFifth = await world.run({ clock: () => new Date('2026-10-25T09:00:00-04:00') })
    expect(twentyFifth).toMatchObject({ attempted: 1, reminded: 1 })
  })

  it('clears an invoice out of Payment failed, as the button does', async () => {
    const world = makeWorld({ invoices: [invoice('f', { emailLog: [SEND, FAILURE] })] })
    expect(unresolvedPaymentFailure(world.store.state[0])).not.toBeNull()
    await world.run()
    expect(unresolvedPaymentFailure(world.store.state[0])).toBeNull()
    expect(world.store.state[0].emailLog.at(-1)).toMatchObject({ auto: true, clearedPaymentFailed: true })
  })

  it('does nothing on a day that is not a reminder day', async () => {
    const world = makeWorld({ invoices: twoInvoices() })
    for (const day of ['2026-10-14', '2026-10-16', '2026-10-30']) {
      expect(await world.run({ clock: () => new Date(`${day}T10:00:00-04:00`) })).toEqual({
        ran: false,
        reason: 'not_a_reminder_day',
      })
    }
    expect(world.sent).toHaveLength(0)
  })

  it('runs on the last day of the month, in February too', async () => {
    const world = makeWorld({ invoices: twoInvoices() })
    expect((await world.run({ clock: () => new Date('2027-02-28T10:00:00-05:00') })).reminded).toBe(2)
  })

  it('reads the day on the firm clock: 9 pm Eastern on the 14th is the 15th in UTC and still not a reminder day', async () => {
    const world = makeWorld({ invoices: twoInvoices() })
    const result = await world.run({ clock: () => new Date('2026-10-14T21:00:00-04:00') })
    expect(result).toEqual({ ran: false, reason: 'not_a_reminder_day' })
  })

  it('runs only from 9:00 through 17:59 firm time', async () => {
    const world = makeWorld({ invoices: twoInvoices() })
    for (const instant of ['2026-10-15T08:59:59-04:00', '2026-10-15T18:00:00-04:00', '2026-10-15T23:30:00-04:00', '2026-10-15T03:00:00-04:00']) {
      expect(await world.run({ clock: () => new Date(instant) })).toEqual({ ran: false, reason: 'outside_hours' })
    }
    expect(world.sent).toHaveLength(0)
    expect((await world.run({ clock: () => new Date('2026-10-15T17:59:59-04:00') })).reminded).toBe(2)
  })

  it('is off with INVOICE_AUTO_REMINDERS=off, and a no-op without mail configured', async () => {
    const world = makeWorld({ invoices: twoInvoices() })
    expect(await world.run({ env: { ...ENV, INVOICE_AUTO_REMINDERS: 'off' } })).toEqual({ ran: false, reason: 'off' })
    expect(await world.run({ env: { ...ENV, INVOICE_AUTO_REMINDERS: 'OFF' } })).toEqual({ ran: false, reason: 'off' })
    expect(await world.run({ env: { EMAIL_FROM: ENV.EMAIL_FROM } })).toEqual({ ran: false, reason: 'mail_not_configured' })
    expect(await world.run({ env: { RESEND_API_KEY: 're_test' } })).toEqual({ ran: false, reason: 'mail_not_configured' })
    expect(world.sent).toHaveLength(0)
    // Any other value leaves it on (the default).
    expect((await world.run({ env: { ...ENV, INVOICE_AUTO_REMINDERS: 'on' } })).reminded).toBe(2)
  })

  it('wants a sending address the way the sender does: INVOICE_EMAIL_FROM alone is enough, with the key', async () => {
    const world = makeWorld({ invoices: twoInvoices() })
    const only = await world.run({ env: { RESEND_API_KEY: 're_test', INVOICE_EMAIL_FROM: 'billing@pbjsa.test' } })
    expect(only.reminded).toBe(2)
    resetAutoReminderState()
    const world2 = makeWorld({ invoices: twoInvoices() })
    expect(await world2.run({ env: { INVOICE_EMAIL_FROM: 'billing@pbjsa.test' } })).toEqual({
      ran: false,
      reason: 'mail_not_configured',
    })
  })

  it('checks the public address only on a reminder day inside the hours (no hourly error line the rest of the month)', async () => {
    const world = makeWorld({ invoices: twoInvoices() })
    expect(await world.run({ appUrl: '', clock: () => new Date('2026-10-14T10:00:00-04:00') })).toEqual({
      ran: false,
      reason: 'not_a_reminder_day',
    })
    expect(await world.run({ appUrl: '', clock: () => new Date('2026-10-15T07:00:00-04:00') })).toEqual({
      ran: false,
      reason: 'outside_hours',
    })
    expect(world.log.error).not.toHaveBeenCalled()
    expect(await world.run({ appUrl: '' })).toEqual({ ran: false, reason: 'no_public_url' })
    expect(world.log.error).toHaveBeenCalledTimes(1)
  })

  it('will not send a pay link with no site address to build it from', async () => {
    const world = makeWorld({ invoices: twoInvoices() })
    expect(await world.run({ appUrl: '' })).toEqual({ ran: false, reason: 'no_public_url' })
    expect(world.sent).toHaveLength(0)
  })

  it('a throwing send is caught, logged [auto-remind], reported, and does not stop the loop', async () => {
    const world = makeWorld({ invoices: twoInvoices() })
    world.sendEmail.mockImplementationOnce(async () => {
      throw new Error('socket hang up')
    })
    const result = await world.run()

    expect(result).toMatchObject({ attempted: 2, reminded: 1, notified: true })
    expect(world.sendEmail).toHaveBeenCalledTimes(2)
    expect(world.log.error).toHaveBeenCalledWith('[auto-remind] a failed:', 'socket hang up')
    expect(world.notified[0]).toBe(
      'Automatic invoice reminders - 2026-10-15: reminded 1 of 2; skipped: Acme ($945.00) - socket hang up',
    )
  })

  it('a provider refusal is reported as skipped, and the invoice is retried on the next tick', async () => {
    const world = makeWorld({ invoices: twoInvoices() })
    world.sendEmail.mockImplementationOnce(async () => ({ ok: false, error: 'upstream error', providerId: null, status: 500 }))
    const first = await world.run()
    expect(first).toMatchObject({ reminded: 1 })
    expect(world.notified[0]).toContain('Acme ($945.00) - upstream error')

    // A failed reminder does not count against the day, so the next tick tries it again.
    const second = await world.run({ clock: () => new Date('2026-10-15T11:00:00-04:00') })
    expect(second).toMatchObject({ attempted: 1, reminded: 1 })
    // (The refused first call is not in `sent`: only the calls that went out are.)
    expect(world.sent.map((message) => message.invoiceId)).toEqual(['b', 'a'])
  })

  it('stays quiet about standing skips: never-email, opted-out, already reminded today', async () => {
    const clients = [
      client('c-acme', 'Acme'),
      client('c-never', 'Never Co', { invoiceNoEmail: true }),
      client('c-optout', 'Outside Co', { platformInvoicingOptOut: true }),
    ]
    const world = makeWorld({
      clients,
      invoices: [
        invoice('n', { clientId: 'c-never' }),
        invoice('o', { clientId: 'c-optout' }),
        invoice('t', { emailLog: [{ ...SEND, at: '2026-10-15T13:00:00.000Z' }] }),
      ],
    })
    const result = await world.run()
    expect(result).toMatchObject({ ran: true, attempted: 0, reminded: 0, notified: false })
    expect(result.skipped.map((entry) => entry.code).sort()).toEqual(['client_not_emailed', 'client_opted_out', 'reminded_today'])
    expect(world.notifyOwners).not.toHaveBeenCalled()
  })

  it('tells the owners about a skip worth seeing even when nothing could be sent - once that day', async () => {
    const world = makeWorld({
      invoices: [invoice('a'), invoice('b', { clientId: 'c-bolt' })],
      changedIds: ['a'],
      attempts: [{ invoiceId: 'b', attemptNo: 1, status: 'processing' }],
    })
    const first = await world.run()
    expect(first).toMatchObject({ attempted: 0, reminded: 0, notified: true })
    expect(world.notified).toEqual([
      'Automatic invoice reminders - 2026-10-15: reminded 0 of 0; skipped: Acme ($945.00) - Changed since sent - use Send again; Bolt ($945.00) - Autopay is collecting this one',
    ])
    // The next hourly tick finds today's summary already filed.
    const second = await world.run({ clock: () => new Date('2026-10-15T11:00:00-04:00') })
    expect(second.notified).toBe(false)
    expect(world.notifyOwners).toHaveBeenCalledTimes(1)
  })

  it('does nothing and says nothing when there is no unpaid invoice at all', async () => {
    const world = makeWorld({ invoices: [invoice('p', { status: 'paid' })] })
    expect(await world.run()).toMatchObject({ ran: true, attempted: 0, reminded: 0, notified: false })
    expect(world.notifyOwners).not.toHaveBeenCalled()
  })

  it('never stops for a failed owner summary: the reminders already went', async () => {
    const world = makeWorld({ invoices: twoInvoices() })
    world.notifyOwners.mockRejectedValueOnce(new Error('bell down'))
    const result = await world.run()
    expect(result).toMatchObject({ reminded: 2, notified: false })
    expect(world.log.error).toHaveBeenCalledWith('[auto-remind] the owner summary failed:', 'bell down')
  })

  it('caps a long skip list in the summary', async () => {
    const many = Array.from({ length: 15 }, (_, index) => invoice(`c${index}`))
    const world = makeWorld({ invoices: many, changedIds: many.map((entry) => entry.id) })
    await world.run()
    expect(world.notified[0]).toMatch(/; and 3 more$/)
  })
})

describe('runAutoInvoiceReminders - never twice, and the switch', () => {
  const twoInvoices = () => [
    invoice('a'),
    invoice('b', { clientId: 'c-bolt', emailLog: [{ ...SEND, to: ['c-bolt@client.test'] }] }),
  ]
  const tick = (hour) => ({ clock: () => new Date(`2026-10-15T${hour}:00:00-04:00`) })

  it('hands the provider an idempotency key per invoice and firm day', async () => {
    const world = makeWorld({ invoices: twoInvoices() })
    await world.run()
    expect(world.sent.map((message) => message.idempotencyKey)).toEqual([
      'reminder/a/2026-10-15',
      'reminder/b/2026-10-15',
    ])
  })

  it('does not send again after a reminder that left but could not be logged (logged: false), on the next tick', async () => {
    const world = makeWorld({ invoices: [invoice('a')] })
    // The email goes out; the log write answers nothing, twice (the retry too).
    world.store.recordInvoiceSent.mockResolvedValue(null)
    const first = await world.run()
    expect(first).toMatchObject({ reminded: 1 })
    expect(world.sent).toHaveLength(1)
    expect(world.log.error).toHaveBeenCalledWith('[auto-remind] a was emailed but could not be logged')

    // Nothing on the log says it was reminded, so the once-a-day RULE would send again.
    const second = await world.run(tick('11'))
    expect(second).toMatchObject({ attempted: 0, reminded: 0 })
    expect(world.sent).toHaveLength(1)
  })

  it('does not send again after a send the provider never answered (status null: it may have gone)', async () => {
    const world = makeWorld({ invoices: [invoice('a')] })
    world.sendEmail.mockImplementationOnce(async () => ({
      ok: false,
      error: 'Could not reach the email provider.',
      providerId: null,
      status: null,
    }))
    const first = await world.run()
    expect(first).toMatchObject({ attempted: 1, reminded: 0 })
    expect(world.sendEmail).toHaveBeenCalledTimes(1)

    // The failed attempt is on the log as ok:false, which the once-a-day rule ignores.
    const second = await world.run(tick('11'))
    expect(second).toMatchObject({ attempted: 0 })
    expect(world.sendEmail).toHaveBeenCalledTimes(1)
  })

  it('does not send again after a send that threw once it had reached the mail sender', async () => {
    const world = makeWorld({ invoices: [invoice('a')] })
    world.sendEmail.mockImplementationOnce(async () => {
      throw new Error('socket hang up')
    })
    await world.run()
    await world.run(tick('11'))
    expect(world.sendEmail).toHaveBeenCalledTimes(1)
  })

  it('tries again after a failure that happened BEFORE the mail sender was reached', async () => {
    const world = makeWorld({ invoices: [invoice('a')] })
    world.store.getOrCreateInvoicePayToken.mockRejectedValueOnce(new Error('db hiccup'))
    const first = await world.run()
    expect(first).toMatchObject({ reminded: 0 })
    expect(world.sendEmail).not.toHaveBeenCalled()
    const second = await world.run(tick('11'))
    expect(second).toMatchObject({ reminded: 1 })
  })

  it('stops the whole run at a key or domain answer (401, 403) from the provider: one log line, one summary line', async () => {
    for (const status of [401, 403]) {
      resetAutoReminderState()
      const world = makeWorld({ invoices: twoInvoices() })
      world.sendEmail.mockImplementation(async () => ({ ok: false, error: 'domain is not verified', providerId: null, status }))
      const result = await world.run()

      expect(world.sendEmail).toHaveBeenCalledTimes(1)
      expect(result).toMatchObject({ reminded: 0, stopped: status, notified: true })
      expect(world.notified).toHaveLength(1)
      expect(world.notified[0]).toContain(`stopped: ${status} from the email provider`)
      expect(world.log.error.mock.calls.filter(([line]) => String(line).includes('stopped:'))).toHaveLength(1)

      // Nothing more is tried for the rest of the day.
      expect(await world.run(tick('11'))).toEqual({ ran: false, reason: 'halted' })
      expect(world.sendEmail).toHaveBeenCalledTimes(1)
    }
  })

  it('treats a 422 as that one invoice\'s problem: named with the provider\'s error name, counted against its attempts, the next invoice still sent', async () => {
    const world = makeWorld({ invoices: twoInvoices() })
    world.sendEmail.mockImplementationOnce(async () => ({
      ok: false,
      error: 'Invalid `to` field',
      errorName: 'validation_error',
      providerId: null,
      status: 422,
    }))
    const result = await world.run()

    expect(world.sendEmail).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ attempted: 2, reminded: 1, stopped: null, notified: true })
    expect(world.notified[0]).toContain('Acme ($945.00) - validation_error: Invalid `to` field')
    // Not a halt: the next tick tries the failed one again (attempt 2 of 3).
    const second = await world.run(tick('11'))
    expect(second).toMatchObject({ attempted: 1 })
    expect(world.sendEmail).toHaveBeenCalledTimes(3)
  })

  it('does not stop for an ordinary provider failure (500, 429): the next invoice is still tried', async () => {
    const world = makeWorld({ invoices: twoInvoices() })
    world.sendEmail.mockImplementationOnce(async () => ({ ok: false, error: 'busy', providerId: null, status: 429 }))
    const result = await world.run()
    expect(result).toMatchObject({ attempted: 2, reminded: 1 })
    expect(result.stopped).toBeNull()
  })

  it('caps automatic attempts at 3 per invoice per firm day', async () => {
    const world = makeWorld({ invoices: twoInvoices() })
    world.sendEmail.mockImplementation(async () => ({ ok: false, error: 'upstream error', providerId: null, status: 500 }))
    await world.run(tick('09'))
    await world.run(tick('10'))
    await world.run(tick('11'))
    expect(world.sendEmail).toHaveBeenCalledTimes(6)
    const fourth = await world.run(tick('12'))
    expect(world.sendEmail).toHaveBeenCalledTimes(6)
    expect(fourth).toMatchObject({ attempted: 0 })
    // A new firm day starts fresh.
    const twentieth = await world.run({ clock: () => new Date('2026-10-20T09:00:00-04:00') })
    expect(twentieth.attempted).toBe(2)
  })

  it('names a Payment failed it cleared in the summary, and always files that summary', async () => {
    const world = makeWorld({ invoices: [invoice('f', { emailLog: [SEND, FAILURE] })] })
    // Even though a summary is already on file for the day:
    const result = await world.run({ summaryAlreadySent: async () => true })

    expect(result).toMatchObject({ reminded: 1, cleared: 1, notified: true })
    expect(world.notified[0]).toBe(
      'Automatic invoice reminders - 2026-10-15: reminded 1 of 1; Cleared Payment failed: Acme (INV-2026-09-f, failed 2026-10-05)',
    )
    // And the activity log keeps it under the system actor.
    expect(world.store.recordActivity).toHaveBeenCalledWith(
      'system',
      'invoice_reminded',
      'INV-2026-09-f (cleared Payment failed)',
    )
  })

  it('does not call a failure cleared when the reminder left but was not logged', async () => {
    const world = makeWorld({ invoices: [invoice('f', { emailLog: [SEND, FAILURE] })] })
    world.store.recordInvoiceSent.mockResolvedValue(null)
    const result = await world.run()
    expect(result).toMatchObject({ reminded: 1, cleared: 0 })
    expect(world.notified[0]).not.toContain('Cleared Payment failed')
  })

  it.each(['off', 'OFF', 'false', 'False', '0', 'no', 'No', 'disabled', ' disabled '])(
    'INVOICE_AUTO_REMINDERS=%j is off',
    async (value) => {
      const world = makeWorld({ invoices: twoInvoices() })
      expect(await world.run({ env: { ...ENV, INVOICE_AUTO_REMINDERS: value } })).toEqual({ ran: false, reason: 'off' })
      expect(world.sent).toHaveLength(0)
      expect(autoReminderMode({ INVOICE_AUTO_REMINDERS: value })).toBe('off')
    },
  )

  it('any other value (on, 1, yes, empty, unset) leaves it on', () => {
    for (const value of ['on', '1', 'yes', 'true', '', undefined]) {
      expect(autoReminderMode({ INVOICE_AUTO_REMINDERS: value })).toBe('on')
    }
    expect(autoReminderMode({ INVOICE_AUTO_REMINDERS: 'Preview' })).toBe('preview')
  })

  it('preview plans the day and files ONLY the owner summary: no client email, no memory of sending', async () => {
    const world = makeWorld({ invoices: twoInvoices() })
    const result = await world.run({ env: { ...ENV, INVOICE_AUTO_REMINDERS: 'preview' } })

    expect(world.sendEmail).not.toHaveBeenCalled()
    expect(world.store.recordInvoiceSent).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ran: true, preview: true, notified: true })
    expect(world.notified).toEqual([
      'Automatic invoice reminders - 2026-10-15: Would remind 2 (preview, nothing was emailed): Acme ($945.00); Bolt ($945.00)',
    ])
    // Once a day, not every hour.
    const again = await world.run({ env: { ...ENV, INVOICE_AUTO_REMINDERS: 'preview' }, ...tick('11') })
    expect(again.notified).toBe(false)
    expect(world.notified).toHaveLength(1)
    // Switching to on afterwards still sends: the preview spent nothing.
    expect((await world.run(tick('12'))).reminded).toBe(2)
  })

  it('preview says nothing when there is nothing to remind and nothing worth seeing', async () => {
    const world = makeWorld({ invoices: [invoice('p', { status: 'paid' })] })
    const result = await world.run({ env: { ...ENV, INVOICE_AUTO_REMINDERS: 'preview' } })
    expect(result.notified).toBe(false)
    expect(world.notifyOwners).not.toHaveBeenCalled()
  })

  it("keeps its own memory of today's summary, and asks every owner (summaryAlreadySent) before filing a second", async () => {
    const world = makeWorld({ invoices: [invoice('a')], changedIds: ['a'] })
    // The notifications check always says no: the process's own memory holds.
    const first = await world.run({ summaryAlreadySent: async () => false })
    expect(first.notified).toBe(true)
    const second = await world.run({ summaryAlreadySent: async () => false, ...tick('11') })
    expect(second.notified).toBe(false)
    expect(world.notifyOwners).toHaveBeenCalledTimes(1)

    // After a restart the process forgets; another owner's notification still holds it back.
    resetAutoReminderState()
    const checked = vi.fn(async () => true)
    const third = await world.run({ summaryAlreadySent: checked, ...tick('12') })
    expect(checked).toHaveBeenCalledWith('2026-10-15')
    expect(third.notified).toBe(false)
    expect(world.notifyOwners).toHaveBeenCalledTimes(1)
  })

  it('shows a never-emailed invoice in the summary (the reason is worth seeing) and a freshly sent one quietly', async () => {
    const world = makeWorld({
      invoices: [
        invoice('a', { emailLog: [] }),
        invoice('b', { clientId: 'c-bolt', emailLog: [{ ...SEND, at: '2026-10-13T14:00:00.000Z' }] }),
      ],
    })
    const result = await world.run()
    expect(world.sent).toHaveLength(0)
    expect(result.skipped.map((entry) => entry.code).sort()).toEqual(['never_emailed', 'sent_recently'])
    expect(world.notified).toEqual([
      'Automatic invoice reminders - 2026-10-15: reminded 0 of 0; 1 invoice was never emailed from the app and was not reminded',
    ])
  })

  it('counts the never-emailed ones in a single line instead of naming each', async () => {
    const many = Array.from({ length: 14 }, (_, index) => invoice(`n${index}`, { emailLog: [] }))
    const world = makeWorld({ invoices: [...many, invoice('c', { clientId: 'c-bolt' })], changedIds: ['c'] })
    await world.run()
    expect(world.notified).toHaveLength(1)
    expect(world.notified[0]).toBe(
      'Automatic invoice reminders - 2026-10-15: reminded 0 of 0; skipped: Bolt ($945.00) - Changed since sent - use Send again; 14 invoices were never emailed from the app and were not reminded',
    )
  })

  it('INVOICE_AUTO_REMINDER_MIN_DAYS changes how long a fresh invoice is left alone', async () => {
    const recent = [invoice('a', { emailLog: [{ ...SEND, at: '2026-10-13T14:00:00.000Z' }] })]
    const left = makeWorld({ invoices: recent })
    expect((await left.run()).reminded).toBe(0)
    resetAutoReminderState()
    const chased = makeWorld({ invoices: recent })
    expect((await chased.run({ env: { ...ENV, INVOICE_AUTO_REMINDER_MIN_DAYS: '1' } })).reminded).toBe(1)
  })
})

describe('who an automatic reminder goes to', () => {
  const people = [
    { id: 'p-ann', name: 'Ann', email: 'ann@acme.test' },
    { id: 'p-bo', name: 'Bo', email: 'bo@acme.test' },
    { id: 'p-cy', name: 'Cy', email: 'cy@acme.test' },
  ]
  const acme = client('c-acme', 'Acme', { email: '', contactIds: ['p-ann', 'p-bo', 'p-cy'] })
  const sentTo = (to, extra = {}) => invoice('x', { emailLog: [{ ...SEND, to, ...extra }] })
  const world = (inv, over = {}) => makeWorld({ invoices: [inv], clients: [acme], contacts: people, ...over })

  it('uses only the subset the invoice was actually sent to, not everyone on file', async () => {
    const w = world(sentTo(['ann@acme.test']))
    await w.run()
    expect(w.sent).toHaveLength(1)
    expect(w.sent[0].to).toEqual(['ann@acme.test'])
  })

  it('does not email an address that has since been removed from the client', async () => {
    const w = world(sentTo(['ann@acme.test', 'bo@acme.test']), {
      contacts: people.filter((person) => person.id !== 'p-bo'),
    })
    await w.run()
    expect(w.sent[0].to).toEqual(['ann@acme.test'])
  })

  it('matches addresses without regard to case', async () => {
    const w = world(sentTo(['ANN@Acme.TEST']))
    await w.run()
    expect(w.sent[0].to).toEqual(['ann@acme.test'])
  })

  it('leaves out an address typed for that one send only, even if it is on file now', async () => {
    const w = world(sentTo(['ann@acme.test', 'cy@acme.test'], { oneTime: ['cy@acme.test'] }))
    await w.run()
    expect(w.sent[0].to).toEqual(['ann@acme.test'])
  })

  it('skips, with a shown code, an invoice whose sent-to addresses are all gone', async () => {
    const w = world(sentTo(['old@acme.test']))
    const result = await w.run()

    expect(w.sent).toHaveLength(0)
    expect(result.skipped.map((entry) => entry.code)).toEqual(['recipients_changed'])
    expect(w.notified).toEqual([
      'Automatic invoice reminders - 2026-10-15: reminded 0 of 0; skipped: Acme ($945.00) - the addresses on file changed since it was sent - remind it by hand',
    ])
  })

  it('the plan names the resolved addresses, and the dry run shows them', () => {
    const invoices = [sentTo(['ann@acme.test', 'gone@acme.test']), { ...sentTo(['old@acme.test']), id: 'y', number: 'INV-Y' }]
    const plan = planAutoReminders({ invoices, clients: [acme], contacts: people, today: TODAY })
    expect(plan.remind.map((entry) => [entry.invoice.id, entry.to])).toEqual([['x', ['ann@acme.test']]])
    expect(plan.skipped.map((entry) => [entry.invoice.id, entry.code, entry.sentTo])).toEqual([
      ['y', 'recipients_changed', ['old@acme.test']],
    ])

    const dry = planAutoRemindersFor({ invoices, clients: [acme], contacts: people, today: TODAY })
    expect(dry.remind[0]).toMatchObject({ invoiceId: 'x', to: ['ann@acme.test'] })
    expect(dry.skipped[0]).toMatchObject({ invoiceId: 'y', code: 'recipients_changed', sentTo: ['old@acme.test'], quiet: false })
  })

  it('without contacts only the client\'s own address is on file', () => {
    const own = client('c-acme', 'Acme', { email: 'ann@acme.test' })
    const plan = planAutoReminders({ invoices: [sentTo(['ann@acme.test', 'bo@acme.test'])], clients: [own], today: TODAY })
    expect(plan.remind[0].to).toEqual(['ann@acme.test'])
  })

  it('a billing master that has no receiving company chosen is skipped as having no one to email', () => {
    const master = client('c-acme', 'Acme', { isBillingMaster: true })
    const plan = planAutoReminders({ invoices: [sentTo(['ann@acme.test'])], clients: [master], today: TODAY })
    expect(plan.skipped.map((entry) => entry.code)).toEqual(['no_recipients'])
  })
})

describe('planAutoRemindersFor (the read-only dry run)', () => {
  const clients = [client('c-acme', 'Acme'), client('c-never', 'Never Co', { invoiceNoEmail: true })]

  it('plans a day from invoices and clients alone and answers plain data', () => {
    const plan = planAutoRemindersFor({
      invoices: [
        invoice('a'),
        invoice('f', { emailLog: [SEND, FAILURE] }),
        invoice('n', { clientId: 'c-never' }),
        invoice('legacy', { emailLog: [] }),
      ],
      clients,
      now: new Date('2026-10-15T10:00:00-04:00'),
    })

    expect(plan).toMatchObject({ today: '2026-10-15', isReminderDay: true, hour: 10, minDaysAfterSend: 5 })
    expect(plan.remind).toEqual([
      expect.objectContaining({ invoiceId: 'a', number: 'INV-2026-09-a', clientName: 'Acme', total: 945, paymentFailed: false }),
      expect.objectContaining({ invoiceId: 'f', paymentFailed: true }),
    ])
    expect(plan.skipped).toEqual([
      expect.objectContaining({ invoiceId: 'legacy', code: 'never_emailed', quiet: false, reason: 'never emailed from the app' }),
      expect.objectContaining({ invoiceId: 'n', code: 'client_not_emailed', quiet: true }),
    ])
    // Plain data: it survives JSON.
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan)
  })

  it('takes the day from "today" when given, and the minimum from env, and touches no store', () => {
    const plan = planAutoRemindersFor({
      invoices: [invoice('a', { emailLog: [{ ...SEND, at: '2026-10-12T14:00:00.000Z' }] })],
      clients,
      today: '2026-10-14',
      env: { INVOICE_AUTO_REMINDER_MIN_DAYS: '2' },
      autopayInFlight: ['zzz'],
      changedSinceSent: [],
    })
    expect(plan.today).toBe('2026-10-14')
    expect(plan.isReminderDay).toBe(false)
    expect(plan.remind.map((entry) => entry.invoiceId)).toEqual(['a'])
  })

  it('knows the autopay and changed-since-sent ids it is given', () => {
    const plan = planAutoRemindersFor({
      invoices: [invoice('a'), invoice('b')],
      clients,
      today: TODAY,
      autopayInFlight: ['a'],
      changedSinceSent: new Set(['b']),
    })
    expect(plan.skipped.map((entry) => [entry.invoiceId, entry.code])).toEqual([
      ['a', 'autopay_in_flight'],
      ['b', 'changed_since_sent'],
    ])
  })
})

/* -------------------------------------------------------------------------- */
/* server.js wiring (it listens at module scope, so it is pinned by source)    */
/* -------------------------------------------------------------------------- */

describe('server.js wiring', () => {
  const source = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../server.js'),
    'utf8',
  )

  it('runs the runner on an hourly timer and shortly after boot, through the real mail sender', () => {
    expect(source).toContain("import { AUTO_REMINDER_EVENT, runAutoInvoiceReminders } from './lib/invoice-auto-reminders.js'")
    expect(source).toMatch(/setInterval\(maybeSendAutoInvoiceReminders, 60 \* 60 \* 1000\)/)
    expect(source).toMatch(/setTimeout\(\(\) => void maybeSendAutoInvoiceReminders\(\), 30 \* 1000\)/)
    expect(source).toMatch(/runAutoInvoiceReminders\(\{[\s\S]*?sendEmail: sendInvoiceEmail,[\s\S]*?env: process\.env,/)
    expect(source).toContain('INVOICE_AUTO_REMINDERS=off')
  })

  it('files the owner summary as an ordinary notification, one per owner', () => {
    expect(source).toMatch(/notify\(appDataStore, owner\.id, AUTO_REMINDER_EVENT, \{/)
  })
})
