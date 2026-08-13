import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  BRAND_EMAIL_COPY,
  CARD_PAYMENT_COPY,
  EMAIL_ASSET_ORIGIN_FALLBACK,
  buildInvoiceEmail,
  emailAssetUrl,
  esc,
  longDate,
  resolveInvoiceRecipients,
} from './invoice-email.js'
import { cardChargedTotal, cardProcessingFee } from './invoice-lines.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

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
    // Two addresses for the SAME client, plus a personal one. This is the shape
    // that was losing an address before.
    {
      id: 'k5',
      name: 'Anthony Cooper',
      email: 'acooper@gmail.com',
      companyEmails: [
        { clientId: 'c1', email: 'anthony@coopercooperpa.com' },
        { clientId: 'c1', email: 'ap@coopercooperpa.com' },
        { clientId: 'c2', email: 'anthony@othercompany.com' },
      ],
    },
    {
      id: 'k6',
      name: 'Same Both Ways',
      email: 'SAME@acme.com',
      companyEmails: [{ clientId: 'c1', email: 'same@acme.com' }],
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

  /**
   * A contact can sit on several clients with a different address per client —
   * and BOTH that address and their general one are ways to reach them about
   * this client's invoice. Some of Brittany's smaller clients receive mail at
   * the personal address, so attaching the contact to the client is what makes
   * every address on it fair game (Alex, 2026-08-13).
   */
  it('sends to the per-client address AND the contact’s general one', () => {
    const result = resolveInvoiceRecipients({
      client: client({ contactIds: ['k4'] }),
      contacts,
    })
    expect(result.to).toEqual(['shared@acme.com', 'shared@personal.com'])
  })

  it('uses the general address when the contact has no entry for this client', () => {
    const result = resolveInvoiceRecipients({
      client: client({ id: 'c9', contactIds: ['k4'] }),
      contacts,
    })
    expect(result.to).toEqual(['shared@personal.com'])
  })

  /**
   * THE BUG. The lookup was `.find()`, so a contact carrying two addresses for
   * one client had the second silently dropped — indistinguishable from a
   * delivered email right up until the client says it never arrived.
   */
  it('includes EVERY per-client address on one contact, not just the first', () => {
    const result = resolveInvoiceRecipients({
      client: client({ contactIds: ['k5'] }),
      contacts,
    })
    expect(result.to).toEqual([
      'anthony@coopercooperpa.com',
      'ap@coopercooperpa.com',
      'acooper@gmail.com',
    ])
  })

  it('does not send twice when the per-client address IS the general one', () => {
    const result = resolveInvoiceRecipients({
      client: client({ contactIds: ['k6'] }),
      contacts,
    })
    expect(result.to).toEqual(['same@acme.com'])
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

  it('appends the client-record address last, after the contacts', () => {
    const result = resolveInvoiceRecipients({
      client: client({ contactIds: ['k1'], email: 'billing@acme.com' }),
      contacts,
    })
    expect(result.to).toEqual(['ann@acme.com', 'billing@acme.com'])
  })

  /**
   * The list she reads before pressing Send has to say WHOSE each address is —
   * "2 recipients" is a count, not a check.
   */
  it('names who every address belongs to', () => {
    const result = resolveInvoiceRecipients({
      client: client({ contactIds: ['k5'], email: 'billing@acme.com' }),
      contacts,
    })
    expect(result.details).toEqual([
      { email: 'anthony@coopercooperpa.com', source: 'Anthony Cooper' },
      { email: 'ap@coopercooperpa.com', source: 'Anthony Cooper' },
      { email: 'acooper@gmail.com', source: 'Anthony Cooper' },
      { email: 'billing@acme.com', source: 'client record' },
    ])
    // Same addresses, same order — `to` and `details` are one list seen twice.
    expect(result.details.map((detail) => detail.email)).toEqual(result.to)
  })

  it('reports no details at all when there is nobody', () => {
    const result = resolveInvoiceRecipients({ client: client(), contacts })
    expect(result.details).toEqual([])
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

  it('greets the client by name, from the one exported constant', () => {
    const { html } = buildInvoiceEmail({ invoice: invoice(), client: client() })
    expect(html).toContain(BRAND_EMAIL_COPY.greeting('Acme LLC'))
  })

  it('leads with the amount due and the period in the summary', () => {
    const { html } = buildInvoiceEmail({ invoice: invoice(), client: client() })
    expect(html).toContain('Amount due')
    expect(html).toContain('August 2026')
    expect(html).toContain('Due date: September 30, 2026')
  })

  it('shows the pay button only when there is a link', () => {
    const withLink = buildInvoiceEmail({
      invoice: invoice(),
      client: client(),
      payUrl: 'https://checkout.stripe.com/x',
    })
    // The button states the amount, and survives an inbox with images off: it
    // is a bgcolor'd cell wrapping the link, not a background image.
    expect(withLink.html).toContain('Pay $540.00')
    expect(withLink.html).toContain('bgcolor="#ff43a4"')
    expect(withLink.html).toContain('https://checkout.stripe.com/x')

    // A dead button is worse than none — and a statement re-send (paid or
    // still-clearing invoice, so no payUrl) must not invite a second payment.
    const without = buildInvoiceEmail({ invoice: invoice(), client: client() })
    expect(without.html).not.toContain('Pay $540.00')
    expect(without.html).not.toContain('bgcolor="#ff43a4"')
    expect(without.html).not.toContain('checkout.stripe.com')
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
    // The shell has <img> tags of its own (logo, quote) — what must never
    // appear is the tag the owner typed.
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
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
    expect(html).not.toContain('Due date')
    expect(html).not.toContain('>Invoice<')
  })

  it('leaves the period row out rather than printing an invalid date', () => {
    const { html } = buildInvoiceEmail({
      invoice: invoice({ period: 'whenever' }),
      client: client(),
    })
    expect(html).not.toContain('Invalid Date')
    expect(html).not.toContain('>Period<')
  })
})

/**
 * The branded shell: the logo, Brittany's quote and the sign-off that wrap all
 * three emails.
 *
 * The asset URLs are the part that can silently break. An email is opened
 * elsewhere, days later — a relative src resolves against the mail client and a
 * localhost one against the READER's machine, so both must be impossible.
 */
describe('the branded shell', () => {
  const built = () => buildInvoiceEmail({ invoice: invoice(), client: client() })

  it('points at the assets absolutely, on the configured origin', () => {
    vi.stubEnv('APP_PUBLIC_URL', 'https://billing.pbjsa.com')
    const { html } = built()
    expect(html).toContain('src="https://billing.pbjsa.com/email/pbj-logo.png"')
    expect(html).toContain('src="https://billing.pbjsa.com/email/brittany-quote.png"')
  })

  it('tolerates a trailing slash on the configured origin', () => {
    vi.stubEnv('APP_PUBLIC_URL', 'https://billing.pbjsa.com/')
    expect(emailAssetUrl('/email/pbj-logo.png')).toBe(
      'https://billing.pbjsa.com/email/pbj-logo.png',
    )
  })

  // There is no safe "unset" behavior, so unset is the production origin.
  it('falls back to the production origin when nothing is configured', () => {
    vi.stubEnv('APP_PUBLIC_URL', '')
    expect(emailAssetUrl('/email/pbj-logo.png')).toBe(
      `${EMAIL_ASSET_ORIGIN_FALLBACK}/email/pbj-logo.png`,
    )
    expect(built().html).toContain(`src="${EMAIL_ASSET_ORIGIN_FALLBACK}/email/pbj-logo.png"`)
  })

  it('never emits a relative or localhost asset URL', () => {
    vi.stubEnv('APP_PUBLIC_URL', '')
    const { html } = built()
    expect(html).not.toContain('src="/email/')
    expect(html).not.toContain('localhost')
  })

  // Images are blocked by default in most inboxes. The quote has to read.
  it('carries the quote, with its exact alt text, and the sign-off', () => {
    const { html, text } = built()
    expect(html).toContain(`alt="${esc(BRAND_EMAIL_COPY.quoteAlt)}"`)
    expect(html).toContain(`alt="${esc(BRAND_EMAIL_COPY.logoAlt)}"`)
    expect(html).toContain(esc(BRAND_EMAIL_COPY.signOff))
    expect(text).toContain(BRAND_EMAIL_COPY.quoteAlt)
  })

  // Her site's own system: pink is the call to action and nothing else, teal
  // carries the headings, ice-blue washes the page. An email that reassigns
  // those roles stops looking like the firm the client already knows.
  it('uses the site palette in the site’s roles', () => {
    const { html } = buildInvoiceEmail({
      invoice: invoice(),
      client: client(),
      payUrl: 'https://checkout.stripe.com/x',
    })
    expect(html).toContain('background:#e8f5fa')
    expect(html).toContain(`color:#0e7490;">${esc(BRAND_EMAIL_COPY.greeting('Acme LLC'))}`)
    expect(html).toContain('bgcolor="#ff43a4"')
  })

  it('states the quote verbatim, because the image is the only other copy of it', () => {
    expect(BRAND_EMAIL_COPY.quoteAlt).toBe(
      'Spread success, not stress, thanks for choosing PB&J Strategic Accounting.',
    )
  })
})

/**
 * The card option. Two rules: it must never appear for a client who did not opt
 * in, and when it does appear it must state the charged total and the fee — a
 * client who clicks through to a bigger number than the invoice said, with no
 * explanation, is a phone call at best.
 */
describe('the card payment option', () => {
  const cardUrl = 'https://checkout.stripe.com/card'
  const withCard = () =>
    buildInvoiceEmail({
      invoice: invoice(),
      client: client(),
      payUrl: 'https://checkout.stripe.com/ach',
      cardPayUrl: cardUrl,
    })

  /**
   * The one that protects everybody else. Card is a per-client opt-in, and the
   * emails the other ~44 clients get must be exactly what they were before this
   * feature existed — not merely "close enough", byte for byte.
   */
  it('leaves an ACH-only email byte-identical', () => {
    const args = {
      invoice: invoice(),
      client: client(),
      payUrl: 'https://checkout.stripe.com/ach',
      footerNote: 'Thanks for your business.',
    }
    const withoutCardArg = buildInvoiceEmail(args)
    const withEmptyCardArg = buildInvoiceEmail({ ...args, cardPayUrl: '' })

    expect(withEmptyCardArg).toEqual(withoutCardArg)
    expect(withoutCardArg.html).not.toContain('card')
    expect(withoutCardArg.text).not.toContain('card')
  })

  it('offers the card link with the charged total and the fee spelled out', () => {
    const { html } = withCard()
    // $540.00 invoice -> $556.44 charged, $16.44 of it fee.
    expect(cardChargedTotal(540)).toBe(556.44)
    expect(cardProcessingFee(540)).toBe(16.44)
    expect(html).toContain(cardUrl)
    expect(html).toContain('Prefer to pay by card?')
    expect(html).toContain('Pay $556.44')
    expect(html).toContain('Includes a $16.44 card processing fee')
    expect(html).toContain('bank transfer has no fee')
  })

  // Bank transfer is the default and the free one. It keeps the button; card
  // gets a text link underneath it, and only underneath it.
  it('keeps the bank-transfer button primary and above the card option', () => {
    const { html } = withCard()
    // The bank channel gets the big pink button; card gets a text link, below.
    expect(html).toContain('Pay $540.00')
    expect(html).toContain('bgcolor="#ff43a4"')
    expect(html.indexOf('Pay $540.00')).toBeLessThan(html.indexOf('Prefer to pay by card?'))
    expect(html.indexOf('bgcolor="#ff43a4"')).toBeLessThan(html.indexOf('Pay $556.44'))
  })

  it('says the same thing in the plain-text alternative', () => {
    const { text } = withCard()
    expect(text).toContain(`${CARD_PAYMENT_COPY.lead} Pay $556.44: ${cardUrl}`)
    expect(text).toContain(CARD_PAYMENT_COPY.note(16.44))
  })

  // Every word of it comes from the one exported constant, so revising the
  // wording after Brittany reads it is a one-place change.
  it('is built entirely from the exported copy constant', () => {
    const { html } = withCard()
    expect(html).toContain(CARD_PAYMENT_COPY.lead)
    expect(html).toContain(CARD_PAYMENT_COPY.button(556.44))
    expect(html).toContain(CARD_PAYMENT_COPY.note(16.44))
  })
})
