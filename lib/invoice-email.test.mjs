import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  BRAND_EMAIL_COPY,
  CARD_PAYMENT_COPY,
  COMBINED_INVOICE_COPY,
  EMAIL_ASSET_ORIGIN_FALLBACK,
  buildInvoiceEmail,
  clientFacingInvoiceLines,
  emailAssetUrl,
  esc,
  invoiceDocumentRenderMode,
  invoiceRenderMode,
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
  sentAt: '2026-08-11T10:00:00.000Z',
  createdAt: '2026-08-01T00:00:00.000Z',
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

  // The summary panel used to say "Invoice" / "Period" and carried no
  // invoice date at all. It now matches the PDF and the print sheet:
  // "Invoice no." / "Invoice Date" / "Billing Period" — the invoice date
  // read off `sentAt ?? createdAt`, formatted the same UTC-calendar-day way
  // the PDF's `stampDate` does.
  it('labels the summary Invoice no. / Invoice Date / Billing Period, like the PDF', () => {
    const { html, text } = buildInvoiceEmail({ invoice: invoice(), client: client() })
    for (const surface of [html, text]) {
      expect(surface).toContain('Invoice no.')
      expect(surface).toContain('Invoice Date')
      expect(surface).toContain('August 11, 2026')
      expect(surface).toContain('Billing Period')
      expect(surface).toContain('August 2026')
    }
  })

  it('reads the invoice date off sentAt, falling back to createdAt before a send', () => {
    const { html, text } = buildInvoiceEmail({
      invoice: invoice({ sentAt: null }),
      client: client(),
    })
    for (const surface of [html, text]) {
      expect(surface).toContain('Invoice Date')
      expect(surface).toContain('August 1, 2026')
    }
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
    expect(html).not.toContain('>Invoice no.<')
  })

  it('leaves the period row out rather than printing an invalid date', () => {
    const { html } = buildInvoiceEmail({
      invoice: invoice({ period: 'whenever' }),
      client: client(),
    })
    expect(html).not.toContain('Invalid Date')
    expect(html).not.toContain('>Billing Period<')
  })
})

/**
 * The three sections (featreq-97ae3214), in BOTH renderings.
 *
 * The HTML part and the plain-text part are built from one `invoiceSections`
 * result, so the pair that lands in a single message cannot describe two
 * differently organized invoices. Every assertion below is made twice for that
 * reason.
 */
describe('buildInvoiceEmail — the sections', () => {
  const SECTIONED_LINES = [
    { kind: 'plan', label: 'Monthly service', detail: 'August', amount: 500 },
    { kind: 'hourly', label: 'Billable hours - unassigned', detail: '1h', amount: 100 },
    { kind: 'hourly', label: 'Billable hours - Brittany', detail: '3.5h', amount: 525, roleTier: 'CFO' },
    { kind: 'hourly', label: 'Billable hours - Kim', detail: '2h', amount: 200, roleTier: 'Accountant' },
    { kind: 'adhoc', label: 'Billable hours - Lisa', detail: '4h', amount: 500, roleTier: 'Bookkeeper' },
    { kind: 'reimbursement', label: 'Recurring: Software', detail: 'monthly', amount: 40 },
    { kind: 'card-fee', label: 'Card processing fee', detail: 'Paid by card', amount: 12 },
  ]

  const built = () =>
    buildInvoiceEmail({
      invoice: invoice({ lineItems: SECTIONED_LINES, subtotal: 1865, total: 1877 }),
      client: client(),
    })

  it('heads each block with her title, in both renderings', () => {
    const { html, text } = built()
    for (const surface of [html, text]) {
      expect(surface).toContain('Subscription Plan')
      expect(surface).toContain('Ad-Hoc / Billable Hours')
      expect(surface).toContain('Client Reimbursed Expenses')
    }
  })

  it('closes each block with a total in her wording, in both renderings', () => {
    const { html, text } = built()
    for (const surface of [html, text]) {
      expect(surface).toContain('Total Subscription Plan')
      expect(surface).toContain('Total Ad-Hoc/Billable Hours')
      expect(surface).toContain('Total Client Reimbursed Expenses')
    }
  })

  // Alex's constraint, read straight off the email: a section total is the sum
  // of its own rows and nothing else.
  it('states a section total that equals the sum of its own rows', () => {
    const { text } = built()
    expect(text).toContain('Total Subscription Plan  $500.00')
    // 100 + 525 + 200 + 500
    expect(text).toContain('Total Ad-Hoc/Billable Hours  $1,325.00')
    expect(text).toContain('Total Client Reimbursed Expenses  $40.00')
  })

  it('sub-heads the hours by role, in the fixed order, in both renderings', () => {
    const { html, text } = built()
    for (const surface of [html, text]) {
      expect(surface).toContain('CFO / Advisory Services')
      expect(surface.indexOf('CFO / Advisory Services')).toBeLessThan(
        surface.indexOf('Accounting Services'),
      )
      expect(surface.indexOf('Accounting Services')).toBeLessThan(
        surface.indexOf('Bookkeeping Services'),
      )
      // A row with no role prints first and untitled, never under a guess.
      expect(surface.indexOf('Billable hours - unassigned')).toBeLessThan(
        surface.indexOf('CFO / Advisory Services'),
      )
    }
  })

  it('leaves the charges block untitled and un-totaled', () => {
    const { html, text } = built()
    for (const surface of [html, text]) {
      expect(surface).toContain('Card processing fee')
      expect(surface).not.toContain('Total Card')
    }
  })

  /**
   * Page 2 has no meaning in an email, so the detailed hours stay inline after
   * the sections — under the same heading the PDF's appendix carries, and with
   * no amount column, because every one of those rows is $0.00 by invariant.
   */
  it('keeps the detailed hours inline, under the same heading, in both renderings', () => {
    const { html, text } = buildInvoiceEmail({
      invoice: invoice({
        lineItems: [
          ...SECTIONED_LINES,
          { kind: 'time_detail', label: 'Lisa', detail: 'Aug 6, 2026 - 2.28 hours', amount: 0 },
        ],
        total: 1877,
      }),
      client: client(),
    })
    for (const surface of [html, text]) {
      expect(surface).toContain('Detailed Hours')
      expect(surface).toContain('Aug 6, 2026 - 2.28 hours')
      expect(surface.indexOf('Total Client Reimbursed Expenses')).toBeLessThan(
        surface.indexOf('Detailed Hours'),
      )
    }
    expect(text).not.toContain('$0.00')
  })

  it('shows no section at all when the invoice has no breakdown rows', () => {
    const { html, text } = buildInvoiceEmail({
      invoice: invoice({ lineItems: [], total: 0 }),
      client: client(),
    })
    for (const surface of [html, text]) {
      expect(surface).not.toContain('Subscription Plan')
      expect(surface).toContain('Total due')
    }
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
/**
 * Two additions made because clients' spam filters — and clients — were
 * treating the invoice as suspicious: one plain sentence saying what is owed
 * and when, and a way to reach the firm in the footer.
 *
 * Both are deliberately said twice, in the HTML and in the plain-text
 * alternative, because the plain-text part is what a filter reads when it will
 * not render the HTML.
 */
describe('buildInvoiceEmail — the plain sentence and the firm contact block', () => {
  const firmSettings = {
    name: 'PB&J Strategic Accounting',
    addressLine1: '123 Main Street',
    addressLine2: 'Suite 4',
    city: 'Sarasota',
    state: 'FL',
    postalCode: '34236',
    phone: '(941) 555-0134',
    email: 'billing@pbjsa.com',
    website: 'pbjsa.com',
    ein: '12-3456789',
  }

  it('says what is owed and when, in words, above the pay button', () => {
    const { html, text } = buildInvoiceEmail({
      invoice: invoice(),
      client: client(),
      payUrl: 'https://checkout.stripe.com/x',
    })
    const sentence = 'Your total of $540.00 is due on September 30, 2026.'
    expect(html).toContain(sentence)
    expect(text).toContain(sentence)
    // Above the button, not below it — the sentence is what the button means.
    expect(html.indexOf(sentence)).toBeLessThan(html.indexOf('checkout.stripe.com'))
  })

  it('drops the date rather than inventing one when the invoice has no due date', () => {
    const { html, text } = buildInvoiceEmail({
      invoice: invoice({ dueDate: null }),
      client: client(),
    })
    expect(html).toContain('Your total for this invoice is $540.00.')
    expect(text).toContain('Your total for this invoice is $540.00.')
    expect(html).not.toContain('is due on')
  })

  it('prints the firm’s address and contact in the footer, in the PDF’s order', () => {
    const { html, text } = buildInvoiceEmail({
      invoice: invoice(),
      client: client(),
      firmSettings,
    })
    for (const line of [
      '123 Main Street',
      'Suite 4',
      'Sarasota, FL, 34236',
      '(941) 555-0134',
      'billing@pbjsa.com',
    ]) {
      expect(html).toContain(line)
      expect(text).toContain(line)
    }
    expect(html.indexOf('123 Main Street')).toBeLessThan(html.indexOf('Suite 4'))
  })

  it('omits the blanks, and the whole block when the firm has no details', () => {
    const { html } = buildInvoiceEmail({
      invoice: invoice(),
      client: client(),
      firmSettings: { name: 'PB&J Strategic Accounting', phone: '(941) 555-0134' },
    })
    expect(html).toContain('(941) 555-0134')
    expect(html).not.toContain(', , ')

    const bare = buildInvoiceEmail({ invoice: invoice(), client: client() })
    // Unconfigured is exactly the footer it has always had.
    expect(bare.html).toContain(BRAND_EMAIL_COPY.signOff)
    expect(bare.text.trimEnd().endsWith(BRAND_EMAIL_COPY.quoteAlt)).toBe(true)
  })

  // The footer is the invoice's letterhead. Saying one thing here and another
  // on the document a client files is the kind of small wrongness that makes a
  // message look forged.
  it('escapes a firm detail rather than emitting raw markup', () => {
    const { html } = buildInvoiceEmail({
      invoice: invoice(),
      client: client(),
      firmSettings: { addressLine1: '<img src=x onerror=alert(1)>' },
    })
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })
})

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

/**
 * The KLC combined document (Brittany's Q3 answer: "2").
 *
 * One combined line, no company names. The assertions that matter here are
 * NEGATIVE — a sub's name must be ABSENT from the bytes that leave the
 * building. This is the one thing that cannot be undone after a send.
 */
const MASTER_LINES = [
  { kind: 'hourly', label: 'Billable hours — Lisa (Chemtrex)', detail: 'Chemtrex · 3.5h', amount: 262.5, sourceClientId: 'client-chemtrex' },
  { kind: 'recurring', label: 'QuickBooks Online — XAct', detail: 'Covers September 1 – September 30', amount: 90, sourceClientId: 'client-xact' },
  { kind: 'plan', label: 'Monthly service — Bright Tower', detail: 'August', amount: 187.5, sourceClientId: 'client-bt' },
]

const masterClient = (over = {}) => client({ id: 'client-master', name: 'KLC Master', isBillingMaster: true, ...over })
const masterInvoice = (over = {}) => invoice({ lineItems: MASTER_LINES, subtotal: 540, total: 540, ...over })

describe('invoiceRenderMode', () => {
  it('leaves every ordinary client on the standard document', () => {
    expect(invoiceRenderMode(client())).toBe('standard')
    expect(invoiceRenderMode(null)).toBe('standard')
    expect(invoiceRenderMode({ invoiceRenderMode: 'combined' })).toBe('standard')
  })

  // A master that has never been given a setting must not fall back to
  // printing its subs' names — the default IS her answer.
  it('defaults a billing master to combined, and ignores an unknown mode', () => {
    expect(invoiceRenderMode(masterClient())).toBe('combined')
    expect(invoiceRenderMode(masterClient({ invoiceRenderMode: 'sections' }))).toBe('combined')
    expect(invoiceRenderMode(masterClient({ invoiceRenderMode: 'standard' }))).toBe('standard')
  })
})

describe('clientFacingInvoiceLines', () => {
  it('replaces a master’s lines with one line carrying the invoice total', () => {
    const lines = clientFacingInvoiceLines(masterInvoice(), masterClient())
    expect(lines).toHaveLength(1)
    expect(lines[0].label).toBe(COMBINED_INVOICE_COPY.label('August 2026'))
    expect(lines[0].label).toBe('Bookkeeping services — August 2026')
    expect(lines[0].amount).toBe(540)
    expect(lines[0].detail).toBe('')
  })

  it('names no month rather than throwing on a junk period', () => {
    const lines = clientFacingInvoiceLines(masterInvoice({ period: 'soon' }), masterClient())
    expect(lines[0].label).toBe('Bookkeeping services')
  })

  it('hands an ordinary client its stored lines, untouched', () => {
    const inv = invoice()
    expect(clientFacingInvoiceLines(inv, client())).toEqual(inv.lineItems)
  })

  /**
   * Two kinds survive the merge because they explain the CHARGE rather than
   * describe the work. Erasing them leaves a client unable to reconcile what
   * they were asked to pay — a receipt at a fee-inclusive total that never
   * mentions a fee, or a smaller number with no stated reason.
   */
  describe('the lines that survive the merge', () => {
    const withKept = (extra, total) =>
      clientFacingInvoiceLines(
        masterInvoice({ lineItems: [...MASTER_LINES, extra], total }),
        masterClient(),
      )

    it('keeps the card processing fee, and states it separately', () => {
      const lines = withKept(
        { kind: 'card-fee', label: 'Card processing fee', detail: 'Paid by card', amount: 16.44 },
        556.44,
      )
      expect(lines).toHaveLength(2)
      expect(lines[0].label).toBe('Bookkeeping services — August 2026')
      expect(lines[0].amount).toBe(540)
      expect(lines[1].label).toBe('Card processing fee')
      expect(lines[1].amount).toBe(16.44)
    })

    it('keeps a retainer credit, which is the one negative line', () => {
      const lines = withKept(
        { kind: 'retainer_credit', label: 'Retainer applied — credit', detail: '', amount: -200 },
        340,
      )
      expect(lines).toHaveLength(2)
      expect(lines[0].amount).toBe(540)
      expect(lines[1].amount).toBe(-200)
    })

    // The invariant: whatever is kept, the column still adds to the amount due.
    it('always sums to exactly the invoice total', () => {
      for (const [extra, total] of [
        [{ kind: 'card-fee', label: 'Card processing fee', amount: 16.44 }, 556.44],
        [{ kind: 'retainer_credit', label: 'Retainer applied — credit', amount: -200 }, 340],
        [{ kind: 'plan', label: 'Monthly service — Bright Tower', amount: 10 }, 550],
      ]) {
        const lines = clientFacingInvoiceLines(
          masterInvoice({ lineItems: [...MASTER_LINES, extra], total }),
          masterClient(),
        )
        const summed = lines.reduce((sum, line) => sum + line.amount, 0)
        expect(Math.round(summed * 100) / 100).toBe(total)
      }
    })

    /**
     * `kind` IS WHAT MAKES THE FEE SURVIVE — a stricter requirement than
     * `renderedInvoiceLines`, which tolerates kind-less lines by design.
     * Characterized here because the degradation is silent and has already bit
     * once: the print sheet mapped `kind` off before calling, `kept` matched
     * nothing, and the fee was folded back into a line printed at the
     * fee-inclusive total. If anyone makes this lenient or makes it throw, this
     * test is where they find out the contract moved.
     */
    it('needs `kind` to keep a line — display-mapped input silently folds it back', () => {
      const stored = { kind: 'card-fee', label: 'Card processing fee', detail: '', amount: 16.44 }
      const { kind, ...displayMapped } = stored

      expect(withKept(stored, 556.44)).toHaveLength(2)

      const folded = clientFacingInvoiceLines(
        masterInvoice({ lineItems: [...MASTER_LINES, displayMapped], total: 556.44 }),
        masterClient(),
      )
      expect(folded).toHaveLength(1)
      expect(folded[0].amount).toBe(556.44)
    })

    it('still names no company on the kept lines', () => {
      const lines = withKept(
        { kind: 'card-fee', label: 'Card processing fee', detail: 'Paid by card', amount: 16.44 },
        556.44,
      )
      const payload = JSON.stringify(lines)
      for (const name of ['Chemtrex', 'XAct', 'Bright Tower', 'Lisa']) {
        expect(payload).not.toContain(name)
      }
    })
  })

  /**
   * A retainer invoice is an engagement-level document with one line reading
   * "Retainer". Rendered combined it would print "Bookkeeping services" over
   * money that is not a month's bookkeeping — the wrong document entirely.
   */
  it('exempts a retainer invoice from combined mode, even on a master', () => {
    const retainer = masterInvoice({
      kind: 'retainer',
      number: 'INV-RET-2026-001',
      lineItems: [{ kind: 'retainer', label: 'Retainer', detail: 'Signed 2026-08-12', amount: 2500 }],
      total: 2500,
    })
    const lines = clientFacingInvoiceLines(retainer, masterClient())
    expect(lines).toHaveLength(1)
    expect(lines[0].label).toBe('Retainer')
    expect(lines[0].amount).toBe(2500)
    expect(invoiceDocumentRenderMode(retainer, masterClient())).toBe('standard')
    // The CLIENT is still a master — it is the document that is exempt.
    expect(invoiceRenderMode(masterClient())).toBe('combined')
  })
})

describe('buildInvoiceEmail — the combined master document', () => {
  const built = () => buildInvoiceEmail({ invoice: masterInvoice(), client: masterClient(), payUrl: 'https://pay.example/x' })

  it('shows one line, named for the month, at the invoice total', () => {
    const { html, text } = built()
    expect(html).toContain('Bookkeeping services — August 2026')
    expect(text).toContain('Bookkeeping services — August 2026')
    // One breakdown row: the combined line. The Total due row is separate.
    expect(html.split('Bookkeeping services').length - 1).toBe(1)
  })

  it('never names a sub company, in either rendering', () => {
    const { html, text, subject } = built()
    for (const surface of [html, text, subject]) {
      expect(surface).not.toContain('Chemtrex')
      expect(surface).not.toContain('XAct')
      expect(surface).not.toContain('Bright Tower')
      expect(surface).not.toContain('Lisa')
    }
  })

  // A recurring reimbursement's coverage window describes ONE company's
  // specific charge, so it goes with the names.
  it('suppresses the coverage-window verbiage the reimbursement lines carry', () => {
    const { html, text } = built()
    expect(html).not.toContain('Covers')
    expect(text).not.toContain('Covers')
    expect(html).not.toContain('September 1')
  })

  it('keeps branding, total, due date, pay button and blurb exactly as they are', () => {
    const { html, text } = buildInvoiceEmail({
      invoice: masterInvoice({ blurb: 'Thanks for a great August.' }),
      client: masterClient(),
      payUrl: 'https://pay.example/x',
    })
    expect(html).toContain(BRAND_EMAIL_COPY.greeting('KLC Master'))
    expect(html).toContain('$540.00')
    expect(html).toContain('Due date: September 30, 2026')
    expect(html).toContain('https://pay.example/x')
    expect(html).toContain('bgcolor="#ff43a4"')
    expect(html).toContain('Thanks for a great August.')
    expect(text).toContain('Total due: $540.00')
  })

  /**
   * The sections are suppressed WHOLESALE here, headings included — a master's
   * one resolved line fits none of her three names, and a per-section total
   * there would restate the split the client chose to hide.
   */
  it('renders no section heading and no section total, in either rendering', () => {
    const { html, text } = built()
    for (const surface of [html, text]) {
      for (const heading of [
        'Subscription Plan',
        'Ad-Hoc / Billable Hours',
        'Client Reimbursed Expenses',
        'Total Subscription Plan',
        'Total Ad-Hoc/Billable Hours',
        'Total Client Reimbursed Expenses',
        'Bookkeeping Services',
        'CFO / Advisory Services',
      ]) {
        expect(surface).not.toContain(heading)
      }
    }
  })

  // `time_detail` does not survive the merge, so there is no appendix to head.
  it('shows no detailed-hours block, even with a breakdown stored', () => {
    const { html, text } = buildInvoiceEmail({
      invoice: masterInvoice({
        lineItems: [
          ...MASTER_LINES,
          { kind: 'time_detail', label: 'Lisa', detail: 'Aug 6 - 2.28 hours', amount: 0 },
        ],
      }),
      client: masterClient(),
    })
    for (const surface of [html, text]) expect(surface).not.toContain('Detailed Hours')
  })

  // The regression that matters: nothing about an ordinary invoice moved.
  it('leaves a non-master invoice byte-for-byte what it was', () => {
    const before = buildInvoiceEmail({ invoice: invoice(), client: client(), payUrl: 'https://pay.example/x' })
    expect(before.html).toContain('Monthly service')
    expect(before.html).toContain('Recurring: Software')
    expect(before.html).not.toContain('Bookkeeping services —')
    expect(before.text).toContain('Monthly service (August)  $500.00')
  })
})
