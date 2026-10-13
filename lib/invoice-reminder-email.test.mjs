import { describe, expect, it } from 'vitest'

import { BRAND, BRAND_EMAIL_COPY, REMINDER_COPY, buildInvoiceReminderEmail } from './invoice-email.js'
import { cardChargedTotal } from './invoice-lines.js'

/**
 * The payment reminder (featreq-3f1d63b6): a short email that re-sends the
 * invoice's SAME pay link. No invoice document, no breakdown - the client
 * already has the invoice; this only asks again.
 */

const client = { id: 'c1', name: 'Clover Ridge Dental', paymentTerms: '' }

function invoice(overrides = {}) {
  return {
    id: 'inv-1',
    number: 'INV-2026-09-004',
    period: '2026-09',
    status: 'sent',
    lineItems: [{ kind: 'plan', label: 'Monthly service', detail: '', amount: 945 }],
    subtotal: 945,
    total: 945,
    dueDate: '2026-10-31',
    sentAt: '2026-10-01T14:00:00.000Z',
    emailLog: [],
    ...overrides,
  }
}

const PAY_URL = 'https://app.pbjsa.com/pay/tok_abc'
const CARD_URL = 'https://app.pbjsa.com/pay/tok_abc/card'

describe('buildInvoiceReminderEmail', () => {
  it('names the invoice and the firm in the subject', () => {
    const { subject } = buildInvoiceReminderEmail({ invoice: invoice(), client })
    expect(subject).toBe('Reminder: invoice INV-2026-09-004 from PB&J Strategic Accounting')
  })

  it("uses the firm's own name when it has one", () => {
    const { subject, text } = buildInvoiceReminderEmail({
      invoice: invoice(),
      client,
      firmName: 'PB&J Strategic Accounting, LLC',
    })
    expect(subject).toBe('Reminder: invoice INV-2026-09-004 from PB&J Strategic Accounting, LLC')
    expect(text.split('\n')[0]).toBe('PB&J Strategic Accounting, LLC')
  })

  it('carries the three rows: Amount due, Invoice, Client', () => {
    const { html, text } = buildInvoiceReminderEmail({ invoice: invoice(), client })
    expect(text).toContain('Amount due: $945.00')
    expect(text).toContain('Invoice: INV-2026-09-004')
    expect(text).toContain('Client: Clover Ridge Dental')
    for (const label of ['Amount due', 'Invoice', 'Client']) expect(html).toContain(`>${label}</td>`)
    expect(html).toContain('>$945.00</td>')
  })

  it('says "due on receipt" for a client asked to pay on receipt, and prints no date', () => {
    const { text, html } = buildInvoiceReminderEmail({ invoice: invoice(), client })
    expect(text).toContain(REMINDER_COPY.lead('$945.00', 'INV-2026-09-004'))
    expect(text).toContain('It is due on receipt.')
    expect(html).toContain('It is due on receipt.')
    // The stored date is the firm's internal past-due line, never shown to them.
    expect(text).not.toContain('October 31')
  })

  it("prints the client's own date when their terms name a longer window", () => {
    const { text } = buildInvoiceReminderEmail({
      invoice: invoice({ dueDate: '2026-11-15' }),
      client: { ...client, paymentTerms: 'Net 45' },
    })
    expect(text).toContain('Its due date is November 15, 2026.')
    expect(text).not.toContain('due on receipt')
  })

  it('carries the pink Pay button with the SAME durable link when there is one', () => {
    const { html, text } = buildInvoiceReminderEmail({ invoice: invoice(), client, payUrl: PAY_URL })
    expect(html).toContain(`href="${PAY_URL}"`)
    expect(html).toContain(`bgcolor="${BRAND.pink}"`)
    expect(html).toContain('>Pay $945.00</a>')
    expect(text).toContain(`Pay by bank transfer: ${PAY_URL}`)
    expect(text).toContain(REMINDER_COPY.sameLink)
  })

  it('has no button and no link sentence when there is no link', () => {
    const { html, text } = buildInvoiceReminderEmail({ invoice: invoice(), client })
    expect(html).not.toContain('/pay/')
    expect(html).not.toContain(`bgcolor="${BRAND.pink}"`)
    expect(text).not.toContain('Pay by bank transfer')
    expect(text).not.toContain(REMINDER_COPY.sameLink)
  })

  it('adds the card link (with its fee) only when card payments are on', () => {
    const withCard = buildInvoiceReminderEmail({
      invoice: invoice(),
      client,
      payUrl: PAY_URL,
      cardPayUrl: CARD_URL,
    })
    const charged = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
      cardChargedTotal(945),
    )
    expect(withCard.html).toContain(`href="${CARD_URL}"`)
    expect(withCard.html).toContain(`Pay ${charged}`)
    expect(withCard.text).toContain(`Prefer to pay by card? Pay ${charged}: ${CARD_URL}`)
    expect(withCard.text).toMatch(/card processing fee/)

    const without = buildInvoiceReminderEmail({ invoice: invoice(), client, payUrl: PAY_URL })
    expect(without.html).not.toContain('/card')
    expect(without.text).not.toMatch(/card processing fee/)
  })

  it('is short: no line breakdown, no "What\'s included", no attachment sentence', () => {
    const { html, text } = buildInvoiceReminderEmail({ invoice: invoice(), client, payUrl: PAY_URL })
    expect(html).not.toContain("What's included")
    expect(text).not.toContain('Monthly service')
    expect(text).not.toMatch(/attached/i)
  })

  it('escapes the client name', () => {
    const { html } = buildInvoiceReminderEmail({
      invoice: invoice(),
      client: { ...client, name: 'Ann <b>& Co' },
    })
    expect(html).toContain('Ann &lt;b&gt;&amp; Co')
    expect(html).not.toContain('Ann <b>')
  })

  it('reads, in full, as a plain-text email (snapshot)', () => {
    const { text } = buildInvoiceReminderEmail({
      invoice: invoice(),
      client,
      payUrl: PAY_URL,
    })
    expect(text).toBe(
      [
        'PB&J Strategic Accounting',
        'A friendly reminder',
        '',
        'This is a reminder that invoice INV-2026-09-004 for $945.00 has not been paid yet. It is due on receipt.',
        'You can pay with the same secure link as before.',
        'If you have already paid, thank you, and please disregard this email.',
        '',
        'Amount due: $945.00',
        'Invoice: INV-2026-09-004',
        'Client: Clover Ridge Dental',
        '',
        `Pay by bank transfer: ${PAY_URL}`,
        'Bank transfers take about 4 business days to clear.',
        '',
        BRAND_EMAIL_COPY.quoteAlt,
      ].join('\n'),
    )
  })

  it('does not say "as before" when the link is new with this reminder (snapshot)', () => {
    // An invoice whose first send carried no link (an autopay client, say): the
    // token is minted for this reminder, so there was no "before".
    const { text, html } = buildInvoiceReminderEmail({
      invoice: invoice(),
      client,
      payUrl: PAY_URL,
      linkIsNew: true,
    })
    expect(html).toContain(REMINDER_COPY.firstLink)
    expect(html).not.toContain(REMINDER_COPY.sameLink)
    expect(text).toBe(
      [
        'PB&J Strategic Accounting',
        'A friendly reminder',
        '',
        'This is a reminder that invoice INV-2026-09-004 for $945.00 has not been paid yet. It is due on receipt.',
        'You can pay with your secure payment link.',
        'If you have already paid, thank you, and please disregard this email.',
        '',
        'Amount due: $945.00',
        'Invoice: INV-2026-09-004',
        'Client: Clover Ridge Dental',
        '',
        `Pay by bank transfer: ${PAY_URL}`,
        'Bank transfers take about 4 business days to clear.',
        '',
        BRAND_EMAIL_COPY.quoteAlt,
      ].join('\n'),
    )
  })
})
