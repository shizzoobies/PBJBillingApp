import { describe, expect, it } from 'vitest'

import { buildAutopayInviteEmail } from './autopay-email.js'
import { buildInvoiceEmail, buildPaymentReceiptEmail } from './invoice-email.js'

const args = {
  client: { name: 'Acme <b>LLC</b>' },
  setupUrl: 'https://app.example.com/autopay/tok_abc',
}

describe('the autopay invitation email', () => {
  it('carries the durable setup link in both renderings', () => {
    const email = buildAutopayInviteEmail(args)
    expect(email.html).toContain('href="https://app.example.com/autopay/tok_abc"')
    expect(email.text).toContain('https://app.example.com/autopay/tok_abc')
    expect(email.subject).toBe('Set up automatic payments with PB&J Strategic Accounting')
  })

  it('says what will be charged, when, and that the client can stop it', () => {
    const { text } = buildAutopayInviteEmail(args)
    expect(text).toMatch(/total of each invoice at the moment we email it/)
    expect(text).toMatch(/turn automatic payments off at any time/)
  })

  it('mentions a card and its fee only when cards are offered', () => {
    expect(buildAutopayInviteEmail(args).text).not.toMatch(/card/i)
    const withCard = buildAutopayInviteEmail({ ...args, cardsOffered: true }).text
    expect(withCard).toMatch(/bank account or card/)
    expect(withCard).toMatch(/card processing fee/)
  })

  it('escapes the client’s name in the HTML', () => {
    const { html } = buildAutopayInviteEmail(args)
    expect(html).not.toContain('<b>LLC</b>')
    expect(html).toContain('Acme &lt;b&gt;LLC&lt;/b&gt;')
  })
})

describe('an invoice email that is being charged automatically', () => {
  const invoice = {
    id: 'inv-1',
    number: 'INV-2026-10-001',
    period: '2026-10',
    total: 250,
    status: 'sent',
    lineItems: [{ kind: 'plan', label: 'Monthly service', detail: '', amount: 250 }],
  }
  const client = { name: 'Acme' }
  const autopay = {
    chargedAmount: 250,
    methodWords: 'bank account ending 6789',
    withdrawUrl: 'https://app.example.com/autopay/tok_abc/withdraw',
  }

  it('says what will be debited, from what, and carries the way to turn it off', () => {
    const { html, text } = buildInvoiceEmail({ invoice, client, autopay })
    for (const body of [html, text]) {
      expect(body).toContain('We will charge $250.00 to your saved payment method automatically.')
      expect(body).toContain('bank account ending 6789')
    }
    expect(html).toContain('href="https://app.example.com/autopay/tok_abc/withdraw"')
    expect(text).toContain('https://app.example.com/autopay/tok_abc/withdraw')
  })

  it('has no Pay button and no pay link, even if a caller handed one in by mistake', () => {
    const { html, text } = buildInvoiceEmail({
      invoice,
      client,
      autopay,
      payUrl: 'https://app.example.com/pay/x',
      cardPayUrl: 'https://app.example.com/pay/x/card',
    })
    expect(html).not.toContain('/pay/x')
    expect(text).not.toContain('/pay/x')
    expect(text).not.toMatch(/Pay by bank transfer/)
  })

  it('a card charge quotes the amount that will actually be debited, fee included', () => {
    const { text } = buildInvoiceEmail({ invoice, client, autopay: { ...autopay, chargedAmount: 258.5 } })
    expect(text).toContain('We will charge $258.50')
  })

  it('without autopay the email is exactly what it was', () => {
    const plain = buildInvoiceEmail({ invoice, client, payUrl: 'https://app.example.com/pay/x' })
    const explicitNull = buildInvoiceEmail({ invoice, client, payUrl: 'https://app.example.com/pay/x', autopay: null })
    expect(explicitNull).toEqual(plain)
    expect(plain.text).not.toMatch(/automatically/)
  })
})

describe('the receipt for an autopay invoice', () => {
  const invoice = {
    id: 'inv-1',
    number: 'INV-2026-10-001',
    total: 250,
    status: 'paid',
    paymentMethod: 'us_bank_account',
    paidAt: '2026-10-08T15:00:00.000Z',
  }
  it('carries the withdraw link, and a normal receipt does not', () => {
    const withLink = buildPaymentReceiptEmail({
      invoice,
      client: { name: 'Acme' },
      withdrawUrl: 'https://app.example.com/autopay/tok_abc/withdraw',
    })
    expect(withLink.html).toContain('href="https://app.example.com/autopay/tok_abc/withdraw"')
    expect(withLink.text).toContain('Turn off automatic payments: https://app.example.com/autopay/tok_abc/withdraw')

    const plain = buildPaymentReceiptEmail({ invoice, client: { name: 'Acme' } })
    expect(plain.html).not.toContain('autopay')
    expect(plain.text).not.toContain('automatic')
  })
})
