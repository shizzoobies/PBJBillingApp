import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * "Send reminder" for an unpaid invoice (featreq-3f1d63b6, the manual button):
 * re-send the SAME pay link in a short email, and refuse everything else.
 *
 * Stripe is mocked so that ANY call fails the test: a reminder never creates a
 * Checkout session, a customer, or anything else at Stripe. The pay link it
 * carries is the invoice's durable `/pay/<token>`, which the store hands back
 * without touching Stripe.
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
  REMINDER_KIND,
  REMINDER_REFUSAL_TIPS,
  latestInvoiceReminder,
  lastRemindedOrSentAt,
  reminderRefusalCode,
  reminderRefusalMessage,
} = await import('./invoice-reminder-rule.js')
const { remindInvoice } = await import('./invoice-reminder.js')
const { latestInvoiceSend, unresolvedPaymentFailure } = await import('./invoice-overdue.js')
const { hasPriorOkInvoiceSend } = await import('./stripe-autopay.js')

// 2026-10-13 at 10:00 Eastern.
const NOW = new Date('2026-10-13T14:00:00.000Z')
const TODAY = '2026-10-13'

const SENT_ENTRY = {
  at: '2026-10-01T14:00:00.000Z',
  to: ['ann@acme.test'],
  subject: 'Invoice INV-2026-09-004 from PB&J Strategic Accounting',
  ok: true,
  total: 945,
  providerId: 're_send_1',
}

function makeInvoice(over = {}) {
  return {
    id: 'inv-1',
    clientId: 'client-acme',
    period: '2026-09',
    kind: 'monthly',
    number: 'INV-2026-09-004',
    status: 'sent',
    lineItems: [{ kind: 'plan', label: 'Monthly service', detail: '', amount: 945 }],
    subtotal: 945,
    total: 945,
    dueDate: '2026-10-31',
    blurb: '',
    sentAt: '2026-10-01T14:00:00.000Z',
    payToken: 'tok_same',
    emailLog: [SENT_ENTRY],
    ...over,
  }
}

const acme = { id: 'client-acme', name: 'Acme Co', email: 'ann@acme.test', contactIds: [], paymentTerms: '' }

describe('the rule (shared by the server and the month run)', () => {
  const base = { invoice: makeInvoice(), client: acme, autopayActive: false, changedSinceSent: false, today: TODAY }
  const code = (over = {}) => reminderRefusalCode({ ...base, ...over })

  it('allows a sent invoice that is owed, emailed, not collecting and not changed', () => {
    expect(code()).toBeNull()
    // `overdue` is in the status union (never written) and means the same thing.
    expect(code({ invoice: makeInvoice({ status: 'overdue' }) })).toBeNull()
  })

  it('refuses draft and reviewed: not sent yet', () => {
    expect(code({ invoice: makeInvoice({ status: 'draft' }) })).toBe('invoice_not_sent')
    expect(code({ invoice: makeInvoice({ status: 'reviewed' }) })).toBe('invoice_not_sent')
  })

  it('refuses processing, paid and void', () => {
    expect(code({ invoice: makeInvoice({ status: 'processing' }) })).toBe('payment_clearing')
    expect(code({ invoice: makeInvoice({ status: 'paid' }) })).toBe('invoice_paid')
    expect(code({ invoice: makeInvoice({ status: 'void' }) })).toBe('invoice_voided')
    expect(code({ invoice: null })).toBe('invoice_voided')
  })

  it('refuses an invoice that owes nothing', () => {
    expect(code({ invoice: makeInvoice({ total: 0 }) })).toBe('nothing_owed')
    expect(code({ invoice: makeInvoice({ total: -5 }) })).toBe('nothing_owed')
  })

  it('refuses an opted-out client and a never-email client', () => {
    expect(code({ client: { ...acme, platformInvoicingOptOut: true } })).toBe('client_opted_out')
    expect(code({ client: { ...acme, invoiceNoEmail: true } })).toBe('client_not_emailed')
  })

  it('refuses while an autopay attempt is in flight, and only then', () => {
    expect(code({ autopayActive: true })).toBe('autopay_in_flight')
    expect(code({ autopayActive: false })).toBeNull()
  })

  it('refuses an invoice changed since it was sent (Send again is the action there)', () => {
    expect(code({ changedSinceSent: true })).toBe('changed_since_sent')
  })

  describe('once per firm day', () => {
    const reminder = (at, ok = true) => ({ at, to: ['ann@acme.test'], subject: 'Reminder', ok, kind: 'reminder' })

    it('refuses a second reminder the same Eastern day as the last ok reminder', () => {
      const invoice = makeInvoice({ emailLog: [SENT_ENTRY, reminder('2026-10-13T12:30:00.000Z')] })
      expect(code({ invoice })).toBe('reminded_today')
    })

    it('refuses on the same day as the last ok SEND', () => {
      const invoice = makeInvoice({ emailLog: [{ ...SENT_ENTRY, at: '2026-10-13T13:00:00.000Z' }] })
      expect(code({ invoice })).toBe('reminded_today')
    })

    it('measures from the NEWER of the two, on the firm day not the UTC day', () => {
      // 9:30 pm Eastern on the 12th is already the 13th in UTC: a different firm day.
      const lateYesterday = makeInvoice({ emailLog: [SENT_ENTRY, reminder('2026-10-13T01:30:00.000Z')] })
      expect(lastRemindedOrSentAt(lateYesterday.emailLog)).toBe('2026-10-13T01:30:00.000Z')
      expect(code({ invoice: lateYesterday })).toBeNull()
      // A reminder yesterday, then Send again this morning: the send is the newer.
      const sentToday = makeInvoice({
        emailLog: [reminder('2026-10-12T15:00:00.000Z'), { ...SENT_ENTRY, at: '2026-10-13T12:00:00.000Z' }],
      })
      expect(lastRemindedOrSentAt(sentToday.emailLog)).toBe('2026-10-13T12:00:00.000Z')
      expect(code({ invoice: sentToday })).toBe('reminded_today')
    })

    it('does not count a failed reminder, a failed send, or any other tagged entry', () => {
      const invoice = makeInvoice({
        emailLog: [
          SENT_ENTRY,
          reminder('2026-10-13T12:00:00.000Z', false),
          { ...SENT_ENTRY, at: '2026-10-13T12:10:00.000Z', ok: false },
          { at: '2026-10-13T12:20:00.000Z', kind: 'link', ok: true, to: [], subject: '' },
          { kind: 'delivery', event: 'delivered', at: '2026-10-13T12:30:00.000Z', providerId: 're_x', to: [] },
        ],
      })
      expect(code({ invoice })).toBeNull()
    })
  })

  it('says each refusal in a plain sentence, and a short reason for the button', () => {
    for (const refusal of [
      'invoice_not_sent',
      'payment_clearing',
      'invoice_paid',
      'invoice_voided',
      'nothing_owed',
      'client_opted_out',
      'client_not_emailed',
      'autopay_in_flight',
      'changed_since_sent',
      'reminded_today',
    ]) {
      expect(reminderRefusalMessage(refusal, 'Acme Co')).toMatch(/\.$/)
    }
    expect(reminderRefusalMessage('client_opted_out', 'Acme Co')).toBe('Acme Co is invoiced outside the app.')
    expect(REMINDER_REFUSAL_TIPS).toMatchObject({
      reminded_today: 'Already reminded today',
      payment_clearing: 'A bank payment is clearing',
      nothing_owed: 'Nothing is owed',
      invoice_paid: 'Nothing is owed',
      invoice_not_sent: 'Not sent yet',
      changed_since_sent: 'Changed since sent - use Send again',
      client_not_emailed: 'Client is not emailed',
      client_opted_out: 'Client is not emailed',
      autopay_in_flight: 'Autopay is collecting this one',
    })
  })

  it('reads the newest ok reminder for "Last reminded"', () => {
    const log = [
      SENT_ENTRY,
      { at: '2026-10-05T14:00:00.000Z', to: ['a@x'], subject: 'R', ok: true, kind: 'reminder' },
      { at: '2026-10-09T14:00:00.000Z', to: ['a@x'], subject: 'R', ok: true, kind: 'reminder' },
      { at: '2026-10-10T14:00:00.000Z', to: ['a@x'], subject: 'R', ok: false, kind: 'reminder' },
    ]
    expect(latestInvoiceReminder(log)?.at).toBe('2026-10-09T14:00:00.000Z')
    expect(latestInvoiceReminder([SENT_ENTRY])).toBeNull()
    expect(REMINDER_KIND).toBe('reminder')
  })
})

describe('a reminder entry is never a send', () => {
  const withReminder = makeInvoice({
    emailLog: [
      SENT_ENTRY,
      { kind: 'payment', event: 'failed', at: '2026-10-05T00:00:00.000Z', paymentIntentId: 'pi_1' },
      { at: '2026-10-09T14:00:00.000Z', to: ['ann@acme.test'], subject: 'Reminder', ok: true, kind: 'reminder' },
    ],
  })

  it('is not the "Sent ..." line, and leaves a Payment failed invoice where it is', () => {
    expect(latestInvoiceSend(withReminder.emailLog)).toEqual(SENT_ENTRY)
    expect(unresolvedPaymentFailure(withReminder)).not.toBeNull()
  })

  it("never counts as autopay's first send", () => {
    const remindedOnly = makeInvoice({
      emailLog: [{ at: '2026-10-09T14:00:00.000Z', to: ['a@x'], subject: 'R', ok: true, kind: 'reminder' }],
    })
    expect(hasPriorOkInvoiceSend(remindedOnly)).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/* The orchestration, against a fake store                                     */
/* -------------------------------------------------------------------------- */

function harness({
  invoice = makeInvoice(),
  clients = [acme],
  contacts = [],
  attempts = [],
  changed = false,
  lastLook,
  attemptsAtLastLook,
  anchorInvoices = [],
  token = 'tok_same',
  firm = { name: 'PB&J Strategic Accounting' },
  sendResult = { ok: true, error: null, providerId: 're_rem_1', status: 200 },
} = {}) {
  let listCalls = 0
  let attemptCalls = 0
  const recorded = []
  const store = {
    listInvoices: vi.fn(async (opts) => {
      // Another month's list: the billing-period anchor's, for the prepaid guard.
      if (opts?.period && opts.period !== invoice.period) return anchorInvoices
      listCalls += 1
      if (listCalls > 1 && lastLook !== undefined) return lastLook ? [lastLook] : []
      return [invoice]
    }),
    read: vi.fn(async () => ({ clients, contacts })),
    withChangedSinceSent: vi.fn(async (list) =>
      list.map((entry) => (changed ? { ...entry, changedSinceSent: true } : entry)),
    ),
    listAutopayAttempts: vi.fn(async () => {
      attemptCalls += 1
      return attemptCalls > 1 && attemptsAtLastLook ? attemptsAtLastLook : attempts
    }),
    getOrCreateInvoicePayToken: vi.fn(async () => token),
    getFirmSettings: vi.fn(async () => firm),
    recordInvoiceSent: vi.fn(async (id, entry) => {
      recorded.push(entry)
      return { ...invoice, emailLog: [...invoice.emailLog, { ...entry, at: entry.stamp }] }
    }),
    recordActivity: vi.fn(async () => undefined),
  }
  const sendEmail = vi.fn(async () => sendResult)
  const run = (over = {}) =>
    remindInvoice(
      {
        invoiceId: 'inv-1',
        now: NOW,
        appUrl: 'https://app.pbjsa.com',
        stripeConfigured: true,
        userId: 'user-owner',
        ...over,
      },
      { store, sendEmail },
    )
  return { store, sendEmail, recorded, run }
}

let fetchSpy
beforeEach(() => {
  for (const fn of Object.values(stripe)) fn.mockReset()
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('a reminder test reached the network')
  })
})
afterEach(() => {
  // Stripe was never asked for anything, whatever the test did.
  for (const [name, fn] of Object.entries(stripe)) expect(fn, `${name} was called`).not.toHaveBeenCalled()
  expect(fetchSpy).not.toHaveBeenCalled()
  fetchSpy.mockRestore()
})

describe('remindInvoice - the happy path', () => {
  it('emails the same durable link, logs a reminder entry, and answers the recorded invoice', async () => {
    const h = harness()
    const result = await h.run()

    expect(result.status).toBe(200)
    expect(h.sendEmail).toHaveBeenCalledTimes(1)
    const message = h.sendEmail.mock.calls[0][0]
    expect(message).toMatchObject({
      to: ['ann@acme.test'],
      subject: 'Reminder: invoice INV-2026-09-004 from PB&J Strategic Accounting',
      fromName: 'PB&J Strategic Accounting',
      invoiceId: 'inv-1',
      kind: 'reminder',
    })
    // No document: the client already has the invoice.
    expect(message.attachments ?? []).toEqual([])
    expect(message.html).toContain('href="https://app.pbjsa.com/pay/tok_same"')
    expect(message.html).not.toContain('/card')

    // The SAME token: asked for (it coalesces), never re-minted.
    expect(h.store.getOrCreateInvoicePayToken).toHaveBeenCalledWith('inv-1')

    expect(h.store.recordInvoiceSent).toHaveBeenCalledTimes(1)
    expect(h.store.recordInvoiceSent.mock.calls[0][0]).toBe('inv-1')
    expect(h.recorded[0]).toMatchObject({
      kind: 'reminder',
      to: ['ann@acme.test'],
      subject: message.subject,
      ok: true,
      error: null,
      providerId: 're_rem_1',
      stamp: NOW.toISOString(),
    })
    expect(h.store.recordActivity).toHaveBeenCalledWith('user-owner', 'invoice_reminded', 'INV-2026-09-004')
    expect(result.body.invoice.emailLog.at(-1)).toMatchObject({ kind: 'reminder', ok: true })
  })

  it('adds the card link for a client with card payments on', async () => {
    const h = harness({ clients: [{ ...acme, cardPaymentsEnabled: true }] })
    await h.run()
    expect(h.sendEmail.mock.calls[0][0].html).toContain('href="https://app.pbjsa.com/pay/tok_same/card"')
  })

  it('sends with no button and mints nothing when Stripe is not connected', async () => {
    const h = harness()
    expect((await h.run({ stripeConfigured: false })).status).toBe(200)
    expect(h.store.getOrCreateInvoicePayToken).not.toHaveBeenCalled()
    expect(h.sendEmail.mock.calls[0][0].html).not.toContain('/pay/')
  })

  it('mints a first token on an invoice that predates tokens (the store coalesces)', async () => {
    const h = harness({ invoice: makeInvoice({ payToken: null }), token: 'tok_new' })
    expect((await h.run()).status).toBe(200)
    expect(h.sendEmail.mock.calls[0][0].html).toContain('/pay/tok_new')
  })

  it('goes to the receiving company of a billing master, by the send route resolver', async () => {
    const master = { id: 'client-acme', name: 'Acme Group', isBillingMaster: true, invoiceRecipientClientId: 'client-sub', contactIds: [] }
    const sub = { id: 'client-sub', name: 'Acme Sub', email: 'sub@acme.test', contactIds: [], billToClientId: 'client-acme' }
    const h = harness({ clients: [master, sub] })
    expect((await h.run()).status).toBe(200)
    expect(h.sendEmail.mock.calls[0][0].to).toEqual(['sub@acme.test'])
  })

  it('refuses a billing master that names no receiving company, as Send does', async () => {
    const master = { id: 'client-acme', name: 'Acme Group', isBillingMaster: true, contactIds: [] }
    const h = harness({ clients: [master] })
    const result = await h.run()
    expect(result.status).toBe(409)
    expect(h.sendEmail).not.toHaveBeenCalled()
  })

  it('does not need the invoice email to have been the last thing sent: an autopay client with a FAILED attempt is reminded', async () => {
    const h = harness({ attempts: [{ invoiceId: 'inv-1', status: 'failed' }] })
    expect((await h.run()).status).toBe(200)
  })
})

describe('remindInvoice - every refusal sends nothing and writes nothing', () => {
  const refused = async (h, status, error) => {
    const result = await h.run()
    expect(result.status).toBe(status)
    expect(result.body.error).toBe(error)
    expect(typeof result.body.message).toBe('string')
    expect(h.sendEmail).not.toHaveBeenCalled()
    expect(h.store.recordInvoiceSent).not.toHaveBeenCalled()
    expect(h.store.getOrCreateInvoicePayToken).not.toHaveBeenCalled()
    return result
  }

  it('404 for an invoice that does not exist', async () => {
    const h = harness()
    h.store.listInvoices.mockResolvedValue([])
    await refused(h, 404, 'invoice_not_found')
  })

  it.each([
    ['draft', 'invoice_not_sent'],
    ['reviewed', 'invoice_not_sent'],
    ['processing', 'payment_clearing'],
    ['paid', 'invoice_paid'],
    ['void', 'invoice_voided'],
  ])('409 for a %s invoice', async (status, error) => {
    await refused(harness({ invoice: makeInvoice({ status }) }), 409, error)
  })

  it('409 when nothing is owed', async () => {
    await refused(harness({ invoice: makeInvoice({ total: 0 }) }), 409, 'nothing_owed')
  })

  it('409 for a client with no record', async () => {
    await refused(harness({ clients: [] }), 409, 'invoice_no_client')
  })

  it('409 for an opted-out client, with the send route sentence', async () => {
    const result = await refused(
      harness({ clients: [{ ...acme, platformInvoicingOptOut: true }] }),
      409,
      'client_opted_out',
    )
    expect(result.body.message).toBe('Acme Co is invoiced outside the app.')
  })

  it('409 for a never-email client', async () => {
    await refused(harness({ clients: [{ ...acme, invoiceNoEmail: true }] }), 409, 'client_not_emailed')
  })

  it('409 for a client with no address on file (the send route resolver)', async () => {
    await refused(harness({ clients: [{ ...acme, email: '' }] }), 409, 'invoice_no_recipient')
  })

  it.each(['claimed', 'processing', 'succeeded'])('409 while an autopay attempt is %s', async (status) => {
    await refused(harness({ attempts: [{ invoiceId: 'inv-1', status }] }), 409, 'autopay_in_flight')
  })

  it('409 while the invoice is Changed since sent', async () => {
    await refused(harness({ changed: true }), 409, 'changed_since_sent')
  })

  it('409 when it was already reminded today', async () => {
    const invoice = makeInvoice({
      emailLog: [SENT_ENTRY, { at: '2026-10-13T13:00:00.000Z', to: ['a@x'], subject: 'R', ok: true, kind: 'reminder' }],
    })
    await refused(harness({ invoice }), 409, 'reminded_today')
  })

  it('409 when the invoice itself was sent today', async () => {
    const invoice = makeInvoice({ emailLog: [{ ...SENT_ENTRY, at: '2026-10-13T13:00:00.000Z' }] })
    await refused(harness({ invoice }), 409, 'reminded_today')
  })
})

describe('remindInvoice - the last look before the email leaves', () => {
  const stopped = async (h, error) => {
    const result = await h.run()
    expect(result.status).toBe(409)
    expect(result.body.error).toBe(error)
    expect(result.body.message).toMatch(/Nothing was emailed\./)
    expect(h.sendEmail).not.toHaveBeenCalled()
    expect(h.store.recordInvoiceSent).not.toHaveBeenCalled()
  }

  it('stops on a void that landed while it was being built', async () => {
    await stopped(harness({ lastLook: makeInvoice({ status: 'void' }) }), 'invoice_voided')
    await stopped(harness({ lastLook: null }), 'invoice_voided')
  })

  it('stops on a payment that started while it was being built', async () => {
    await stopped(harness({ lastLook: makeInvoice({ status: 'processing' }) }), 'payment_clearing')
  })

  it('stops on an edit that changed what the client sees', async () => {
    await stopped(harness({ lastLook: makeInvoice({ total: 1200 }) }), 'invoice_changed')
  })

  it('stops on an autopay attempt claimed in the meantime', async () => {
    await stopped(
      harness({ attemptsAtLastLook: [{ invoiceId: 'inv-1', status: 'claimed' }] }),
      'autopay_in_flight',
    )
  })

  it('stops on a reminder another tab sent in the meantime', async () => {
    const lastLook = makeInvoice({
      emailLog: [SENT_ENTRY, { at: '2026-10-13T13:59:00.000Z', to: ['a@x'], subject: 'R', ok: true, kind: 'reminder' }],
    })
    await stopped(harness({ lastLook }), 'reminded_today')
  })
})

describe('remindInvoice - a provider that refuses', () => {
  it('logs the failed attempt with its error, changes nothing else, and says the provider sentence', async () => {
    const h = harness({
      sendResult: { ok: false, error: 'domain is not verified', providerId: null, status: 403 },
    })
    const result = await h.run()

    expect(result).toEqual({
      status: 502,
      body: { error: 'reminder_send_failed', message: 'domain is not verified' },
    })
    expect(h.recorded).toEqual([
      expect.objectContaining({ kind: 'reminder', ok: false, error: 'domain is not verified', providerId: null }),
    ])
    expect(h.store.recordActivity).not.toHaveBeenCalled()
  })

  it('retries the log write once after delivery, and a retry that lands answers as usual', async () => {
    const h = harness()
    const real = h.store.recordInvoiceSent.getMockImplementation()
    h.store.recordInvoiceSent.mockRejectedValueOnce(new Error('db blip')).mockImplementation(real)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const result = await h.run()
    errors.mockRestore()

    expect(h.sendEmail).toHaveBeenCalledTimes(1)
    expect(h.store.recordInvoiceSent).toHaveBeenCalledTimes(2)
    expect(h.store.recordInvoiceSent.mock.calls[1][1]).toEqual(h.store.recordInvoiceSent.mock.calls[0][1])
    expect(result.status).toBe(200)
    expect(result.body).not.toHaveProperty('logged')
    expect(result.body.invoice.emailLog.at(-1)).toMatchObject({ kind: 'reminder', ok: true })
    expect(h.store.recordActivity).toHaveBeenCalledTimes(1)
  })

  it('retries a log write that answered null (no row written), too', async () => {
    const h = harness()
    const real = h.store.recordInvoiceSent.getMockImplementation()
    h.store.recordInvoiceSent.mockResolvedValueOnce(null).mockImplementation(real)
    const result = await h.run()
    expect(h.store.recordInvoiceSent).toHaveBeenCalledTimes(2)
    expect(result.status).toBe(200)
    expect(result.body).not.toHaveProperty('logged')
  })

  it('never reports a delivered reminder as failed when both log writes fail: 200 with logged false', async () => {
    const h = harness()
    h.store.recordInvoiceSent.mockRejectedValue(new Error('db down'))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const result = await h.run()
    expect(errors).toHaveBeenCalled()
    errors.mockRestore()

    expect(h.sendEmail).toHaveBeenCalledTimes(1)
    expect(h.store.recordInvoiceSent).toHaveBeenCalledTimes(2)
    expect(result.status).toBe(200)
    expect(result.body.logged).toBe(false)
    expect(result.body.invoice.id).toBe('inv-1')
    // Nothing on record to say it happened, so no activity claims it either.
    expect(h.store.recordActivity).not.toHaveBeenCalled()
  })

  it('answers logged false when both writes answer null', async () => {
    const h = harness()
    h.store.recordInvoiceSent.mockResolvedValue(null)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const result = await h.run()
    errors.mockRestore()
    expect(h.store.recordInvoiceSent).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ status: 200, body: { logged: false } })
  })

  it('an activity write that fails does not re-log the reminder or change the answer', async () => {
    const h = harness()
    h.store.recordActivity.mockRejectedValue(new Error('auth-state locked'))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const result = await h.run()
    errors.mockRestore()
    expect(h.store.recordInvoiceSent).toHaveBeenCalledTimes(1)
    expect(result.status).toBe(200)
    expect(result.body).not.toHaveProperty('logged')
  })

  it('refuses rather than send a link-less reminder when the pay token cannot be had', async () => {
    const h = harness({ token: null })
    const result = await h.run()
    expect(result.status).toBe(502)
    expect(result.body.error).toBe('pay_link_failed')
    expect(h.sendEmail).not.toHaveBeenCalled()
  })
})

describe('remindInvoice - round 2: bound recipients, first-link wording, prepaid months', () => {
  const twoOnFile = [{ ...acme, contactIds: ['ct-ann', 'ct-bo'], email: '' }]
  const twoContacts = [
    { id: 'ct-ann', name: 'Ann', email: 'ann@acme.test' },
    { id: 'ct-bo', name: 'Bo', email: 'bo@acme.test' },
  ]

  it('sends to exactly the posted list the confirm showed', async () => {
    const h = harness({ clients: twoOnFile, contacts: twoContacts })
    expect((await h.run({ to: ['ann@acme.test'] })).status).toBe(200)
    expect(h.sendEmail.mock.calls[0][0].to).toEqual(['ann@acme.test'])
    expect(h.recorded[0].to).toEqual(['ann@acme.test'])
  })

  it('refuses a posted address that is not on file (a contact changed after the confirm)', async () => {
    const h = harness({ clients: twoOnFile, contacts: twoContacts })
    const result = await h.run({ to: ['ann@acme.test', 'new@acme.test'] })
    expect(result.status).toBe(409)
    expect(result.body.error).toBe('recipients_changed')
    expect(h.sendEmail).not.toHaveBeenCalled()
    expect(h.store.recordInvoiceSent).not.toHaveBeenCalled()
  })

  it('refuses a posted list that is not a list of addresses, and an empty one', async () => {
    for (const to of ['ann@acme.test', [42], []]) {
      const h = harness({ clients: twoOnFile, contacts: twoContacts })
      const result = await h.run({ to })
      expect(result.status).toBeGreaterThanOrEqual(400)
      expect(result.status).toBeLessThan(500)
      expect(h.sendEmail).not.toHaveBeenCalled()
    }
  })

  it('says "the same secure link as before" only when the invoice already had its link', async () => {
    const before = harness()
    await before.run()
    expect(before.sendEmail.mock.calls[0][0].text).toContain('the same secure link as before')

    const firstLink = harness({ invoice: makeInvoice({ payToken: null }), token: 'tok_new' })
    await firstLink.run()
    const text = firstLink.sendEmail.mock.calls[0][0].text
    expect(text).toContain('You can pay with your secure payment link.')
    expect(text).not.toContain('as before')
  })

  describe('a month a paid prepayment already covers', () => {
    const periodClient = {
      ...acme,
      billingMode: 'subscription',
      monthlyRate: 945,
      billingPeriodMonths: 3,
      periodAnchorMonth: '2026-08',
    }
    const paidAnchor = (over = {}) => ({
      id: 'inv-aug',
      clientId: 'client-acme',
      kind: 'monthly',
      period: '2026-08',
      number: 'INV-2026-08-001',
      status: 'paid',
      lineItems: [
        { kind: 'plan', amount: 945 },
        { kind: 'prepayment', amount: 945, period: '2026-09' },
      ],
      ...over,
    })

    it('is refused: "This month is covered by a prepayment"', async () => {
      const h = harness({ clients: [periodClient], anchorInvoices: [paidAnchor()] })
      const result = await h.run()
      expect(result.status).toBe(409)
      expect(result.body.error).toBe('month_prepaid')
      expect(result.body.message).toMatch(/^This month is covered by a prepayment/)
      expect(result.body.message).toContain('INV-2026-08-001')
      expect(h.sendEmail).not.toHaveBeenCalled()
      expect(h.store.getOrCreateInvoicePayToken).not.toHaveBeenCalled()
    })

    it('goes ahead when the paid anchor covers a different month, or a month it cannot read', async () => {
      const otherMonth = harness({
        clients: [periodClient],
        anchorInvoices: [
          paidAnchor({
            lineItems: [
              { kind: 'plan', amount: 945 },
              { kind: 'prepayment', amount: 945, period: '2026-10' },
            ],
          }),
        ],
      })
      expect((await otherMonth.run()).status).toBe(200)
      const unreadable = harness({
        clients: [periodClient],
        anchorInvoices: [
          paidAnchor({ lineItems: [{ kind: 'plan', amount: 945 }, { kind: 'prepayment', amount: 945 }] }),
        ],
      })
      expect((await unreadable.run()).status).toBe(200)
    })

    it('goes ahead while the anchor is unpaid, and once this invoice draws the prepayment', async () => {
      const unpaid = harness({ clients: [periodClient], anchorInvoices: [paidAnchor({ status: 'sent' })] })
      expect((await unpaid.run()).status).toBe(200)
      const drawing = harness({
        clients: [periodClient],
        anchorInvoices: [paidAnchor()],
        invoice: makeInvoice({
          lineItems: [
            { kind: 'plan', label: 'Monthly service', detail: '', amount: 1100 },
            { kind: 'account_credit', label: 'Credit', detail: '', amount: -945, draws: [{ creditId: 'prepay:inv-aug:2026-09', amount: 945 }] },
          ],
          total: 155,
        }),
      })
      expect((await drawing.run()).status).toBe(200)
    })

    it('never reads another month for a client with no billing period', async () => {
      const h = harness()
      await h.run()
      expect(h.store.listInvoices.mock.calls.every(([opts]) => !opts?.period || opts.period === '2026-09')).toBe(true)
    })
  })
})
