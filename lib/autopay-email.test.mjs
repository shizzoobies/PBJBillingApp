import { describe, expect, it } from 'vitest'

import { buildAutopayInviteEmail } from './autopay-email.js'

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
