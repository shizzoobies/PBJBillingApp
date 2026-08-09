import { describe, expect, it } from 'vitest'

import {
  buildInvoiceEmail,
  esc,
  longDate,
  resolveInvoiceRecipients,
} from './invoice-email.js'

/**
 * The invoice email. This one leaves the building and lands in a client's
 * inbox, so the cases that matter are: does it go to the right person, does it
 * state the right amount, and can a client's own name break the markup.
 */

const invoice = (over = {}) => ({
  id: 'inv-1',
  number: 'INV-2026-08-001',
  period: '2026-08',
  total: 540,
  dueDate: '2026-09-30',
  blurb: '',
  lineItems: [
    { kind: 'plan', label: 'Monthly service', detail: 'August', amount: 500 },
    { kind: 'recurring', label: 'Recurring: Software', detail: 'monthly', amount: 40 },
  ],
  ...over,
})

const client = (over = {}) => ({ id: 'c1', name: 'Acme LLC', contactIds: [], ...over })

describe('esc', () => {
  it('neutralizes markup in free text', () => {
    expect(esc('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    )
  })

  it('escapes ampersands — this book has a "Cooper & Cooper, PA"', () => {
    expect(esc('Cooper & Cooper, PA')).toBe('Cooper &amp; Cooper, PA')
  })
})

describe('longDate', () => {
  it('reads as a person would write it', () => {
    expect(longDate('2026-09-30')).toBe('September 30, 2026')
  })

  it('returns blank rather than an invalid date', () => {
    expect(longDate('')).toBe('')
    expect(longDate('soon')).toBe('')
    expect(longDate(null)).toBe('')
  })
})

describe('resolveInvoiceRecipients', () => {
  const contacts = [
    { id: 'k1', name: 'Ann', email: 'ann@acme.com' },
    { id: 'k2', name: 'Bo', email: 'bo@acme.com' },
    { id: 'k3', name: 'Gone', email: 'gone@acme.com', archivedAt: '2026-01-01T00:00:00Z' },
    {
      id: 'k4',
      name: 'Shared',
      email: 'shared@personal.com',
      companyEmails: [{ clientId: 'c1', email: 'shared@acme.com' }],
    },
  ]

  it('uses the client’s linked contacts, primary first', () => {
    const result = resolveInvoiceRecipients({
      client: client({ contactIds: ['k1', 'k2'] }),
      contacts,
    })
    expect(result.to).toEqual(['ann@acme.com', 'bo@acme.com'])
    expect(result.reason).toBeNull()
  })

  // A contact can sit on several clients with a different address per client.
  it('honors a per-client email override', () => {
    const result = resolveInvoiceRecipients({
      client: client({ contactIds: ['k4'] }),
      contacts,
    })
    expect(result.to).toEqual(['shared@acme.com'])
  })

  it('skips an archived contact', () => {
    const result = resolveInvoiceRecipients({
      client: client({ contactIds: ['k3'] }),
      contacts,
    })
    expect(result.to).toEqual([])
  })

  it('falls back to the address on the client record', () => {
    const result = resolveInvoiceRecipients({
      client: client({ email: 'billing@acme.com' }),
      contacts,
    })
    expect(result.to).toEqual(['billing@acme.com'])
  })

  it('does not send the same person two copies', () => {
    const result = resolveInvoiceRecipients({
      client: client({ contactIds: ['k1'], email: 'ANN@acme.com' }),
      contacts,
    })
    expect(result.to).toEqual(['ann@acme.com'])
  })

  // Silence here would mean an invoice that looks sent and went nowhere.
  it('explains itself when there is nobody to send to', () => {
    const result = resolveInvoiceRecipients({ client: client(), contacts })
    expect(result.to).toEqual([])
    expect(result.reason).toMatch(/no email address/i)
  })

  it('ignores blanks and obvious non-addresses', () => {
    const result = resolveInvoiceRecipients({
      client: client({ contactIds: ['x1', 'x2'], email: '   ' }),
      contacts: [
        { id: 'x1', name: 'Empty', email: '' },
        { id: 'x2', name: 'Junk', email: 'not-an-address' },
      ],
    })
    expect(result.to).toEqual([])
  })
})

describe('buildInvoiceEmail', () => {
  it('names the invoice and the firm in the subject', () => {
    const { subject } = buildInvoiceEmail({ invoice: invoice(), client: client() })
    expect(subject).toBe('Invoice INV-2026-08-001 from PB&J Strategic Accounting')
  })

  it('states every line and the total', () => {
    const { html } = buildInvoiceEmail({ invoice: invoice(), client: client() })
    expect(html).toContain('Monthly service')
    expect(html).toContain('$500.00')
    expect(html).toContain('Recurring: Software')
    expect(html).toContain('$40.00')
    expect(html).toContain('$540.00')
    expect(html).toContain('September 30, 2026')
  })

  it('shows the pay button only when there is a link', () => {
    const withLink = buildInvoiceEmail({
      invoice: invoice(),
      client: client(),
      payUrl: 'https://checkout.stripe.com/x',
    })
    expect(withLink.html).toContain('Pay by bank transfer')
    expect(withLink.html).toContain('https://checkout.stripe.com/x')

    // A dead button is worse than none.
    const without = buildInvoiceEmail({ invoice: invoice(), client: client() })
    expect(without.html).not.toContain('Pay by bank transfer')
  })

  it('warns the client that bank transfers take days to clear', () => {
    const { html, text } = buildInvoiceEmail({
      invoice: invoice(),
      client: client(),
      payUrl: 'https://checkout.stripe.com/x',
    })
    expect(html).toContain('4 business days')
    expect(text).toContain('4 business days')
  })

  it('includes the note to the client when there is one', () => {
    const { html, text } = buildInvoiceEmail({
      invoice: invoice({ blurb: 'Thanks as always!' }),
      client: client(),
    })
    expect(html).toContain('Thanks as always!')
    expect(text).toContain('Thanks as always!')
  })

  // A client name is free text and lands in the markup.
  it('escapes the client name rather than emitting raw markup', () => {
    const { html } = buildInvoiceEmail({
      invoice: invoice(),
      client: client({ name: 'Cooper & Cooper <PA>' }),
    })
    expect(html).toContain('Cooper &amp; Cooper &lt;PA&gt;')
    expect(html).not.toContain('<PA>')
  })

  it('escapes a note the owner typed', () => {
    const { html } = buildInvoiceEmail({
      invoice: invoice({ blurb: '<img src=x onerror=alert(1)>' }),
      client: client(),
    })
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  it('carries a plain-text alternative that stands alone', () => {
    const { text } = buildInvoiceEmail({
      invoice: invoice(),
      client: client(),
      payUrl: 'https://checkout.stripe.com/x',
    })
    expect(text).toContain('Monthly service')
    expect(text).toContain('Total due: $540.00')
    expect(text).toContain('https://checkout.stripe.com/x')
  })

  it('copes with an invoice that has no number or due date', () => {
    const { subject, html } = buildInvoiceEmail({
      invoice: invoice({ number: null, dueDate: null }),
      client: client(),
    })
    expect(subject).toBe('Invoice from PB&J Strategic Accounting')
    expect(html).not.toContain('due ')
  })
})
