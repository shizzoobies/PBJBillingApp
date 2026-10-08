import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  fillTemplate,
  letterPlaceholders,
  letterTemplateHash,
  letterValues,
  templateWarnings,
} from './letter-template.js'

/**
 * The engagement letter's placeholders (featreq-5e195707): every key filled from
 * a fixture, the typing rules, the missing/unknown reports and the snapshot hash.
 */
const NOW = new Date('2026-10-08T16:00:00Z')

const monthly = {
  id: 'client-1',
  name: 'Acme Books LLC',
  contact: 'Typed Name',
  billingMode: 'subscription',
  monthlyRate: 500,
  hourlyRate: 125,
  annualRate: 0,
  addressLine1: '12 Main St',
  addressLine2: 'Suite 4',
  city: 'Nashville',
  state: 'TN',
  postalCode: '37201',
  contactIds: ['c-archived', 'c-pat', 'c-lee'],
}
const contacts = [
  { id: 'c-archived', name: 'Old Hand', archivedAt: '2026-01-01T00:00:00Z' },
  { id: 'c-pat', name: 'Pat Doe' },
  { id: 'c-lee', name: 'Lee Roe' },
]
const firmSettings = { name: 'PB&J Strategic Accounting', email: 'hello@pbjsa.com', phone: '615-555-0100' }

const valuesFor = (client, extra = {}) =>
  letterValues({ client, contacts, firmSettings, now: NOW, senderName: 'Brittany Ferguson', ...extra })

describe('letterPlaceholders', () => {
  it('lists the documented keys, each once, with the required ones marked', () => {
    expect(letterPlaceholders.map((entry) => entry.key)).toEqual([
      'client_name',
      'contact_first_name',
      'contact_name',
      'fee',
      'monthly_fee',
      'hourly_rate',
      'annual_fee',
      'client_address',
      'year',
      'next_year',
      'today',
      'firm_name',
      'firm_email',
      'firm_phone',
      'sender_name',
    ])
    expect(letterPlaceholders.filter((entry) => entry.required).map((entry) => entry.key)).toEqual([
      'client_name',
      'contact_first_name',
      'contact_name',
      'fee',
      'monthly_fee',
      'hourly_rate',
      'annual_fee',
    ])
  })
})

describe('letterValues', () => {
  it('fills every placeholder for a monthly client', () => {
    expect(valuesFor(monthly)).toEqual({
      client_name: 'Acme Books LLC',
      contact_first_name: 'Pat',
      contact_name: 'Pat Doe',
      fee: '$500.00 per month',
      monthly_fee: '$500.00',
      hourly_rate: '',
      annual_fee: '',
      client_address: '12 Main St\nSuite 4\nNashville, TN 37201',
      year: '2026',
      next_year: '2027',
      today: 'October 8, 2026',
      firm_name: 'PB&J Strategic Accounting',
      firm_email: 'hello@pbjsa.com',
      firm_phone: '615-555-0100',
      sender_name: 'Brittany Ferguson',
    })
  })

  it('makes {{fee}} follow the billing mode', () => {

    const annual = valuesFor({ ...monthly, billingMode: 'annual', annualRate: 1200 })
    expect(annual.fee).toBe('$1,200.00 per year')
    expect(annual.annual_fee).toBe('$1,200.00')
    expect(annual.monthly_fee).toBe('')
  })

  // `client.hourlyRate` is the legacy firm default, not a fee anyone set for the client: an
  // hourly client is billed at each team member's own rate, so there is no single figure to quote.
  it('never quotes a figure for an hourly client, whatever hourlyRate holds', () => {
    for (const hourlyRate of [125, 125.5, 0, undefined]) {
      const hourly = valuesFor({ ...monthly, billingMode: 'hourly', hourlyRate, monthlyRate: 500, annualRate: 1200 })
      expect(hourly.fee).toBe('')
      expect(hourly.hourly_rate).toBe('')
      expect(hourly.monthly_fee).toBe('')
      expect(hourly.annual_fee).toBe('')
    }
  })

  it('reports {{fee}} and {{hourly_rate}} as missing for an hourly client, so Send skips it', () => {
    const hourly = valuesFor({ ...monthly, billingMode: 'hourly', hourlyRate: 125 })
    const result = fillTemplate('Our fee is {{fee}}, or {{hourly_rate}} an hour.', hourly)
    expect(result.text).toBe('Our fee is , or  an hour.')
    expect(result.missing).toEqual(['fee', 'hourly_rate'])
  })

  it('leaves the fee blank for a rate that is zero, absent or not a number', () => {
    expect(valuesFor({ ...monthly, monthlyRate: 0 }).fee).toBe('')
    expect(valuesFor({ ...monthly, monthlyRate: undefined }).fee).toBe('')
    expect(valuesFor({ ...monthly, monthlyRate: 'abc' }).fee).toBe('')
    expect(valuesFor({ ...monthly, billingMode: 'mystery' }).fee).toBe('')
  })

  it('takes the primary contact as the first active linked contact', () => {
    expect(valuesFor(monthly).contact_name).toBe('Pat Doe')
  })

  it('falls back to the name typed on the client record', () => {
    const none = { ...monthly, contactIds: [] }
    expect(valuesFor(none).contact_name).toBe('Typed Name')
    expect(valuesFor(none).contact_first_name).toBe('Typed')
    expect(valuesFor({ ...none, contact: '', contactName: 'Named Field' }).contact_name).toBe('Named Field')
    expect(valuesFor({ ...none, contact: '' }).contact_first_name).toBe('')
  })

  it('works on the firm calendar, not the UTC day', () => {
    // 02:00 UTC on Jan 1 is still Dec 31 in Eastern time.
    const values = valuesFor(monthly, { now: new Date('2027-01-01T02:00:00Z') })
    expect(values.year).toBe('2026')
    expect(values.next_year).toBe('2027')
    expect(values.today).toBe('December 31, 2026')
  })

  it('gives blanks, not throws, for an empty client and no firm', () => {
    const values = letterValues({ client: {}, now: NOW })
    expect(Object.values(values).filter(Boolean)).toEqual(['2026', '2027', 'October 8, 2026'])
  })
})

describe('fillTemplate', () => {
  const values = valuesFor(monthly)

  it('fills tokens regardless of inner spacing and case', () => {
    const result = fillTemplate('Dear {{contact_first_name}}, {{ Client_Name }} pays {{  FEE}}.', values)
    expect(result.text).toBe('Dear Pat, Acme Books LLC pays $500.00 per month.')
    expect(result.missing).toEqual([])
    expect(result.unknown).toEqual([])
  })

  it('fills a multi-line address and repeats of the same token', () => {
    const result = fillTemplate('{{client_address}}\n{{year}} / {{year}}', values)
    expect(result.text).toBe('12 Main St\nSuite 4\nNashville, TN 37201\n2026 / 2026')
  })

  it('reports a required placeholder with no value, once, and prints nothing for it', () => {
    const blank = valuesFor({ ...monthly, billingMode: 'hourly', hourlyRate: 0 })
    const result = fillTemplate('Fee {{fee}} and again {{fee}}, rate {{monthly_fee}}.', blank)
    expect(result.text).toBe('Fee  and again , rate .')
    expect(result.text).not.toContain('{{')
    expect(result.missing).toEqual(['fee', 'monthly_fee'])
  })

  it('leaves an optional placeholder blank without reporting it', () => {
    const result = fillTemplate('At {{client_address}} from {{sender_name}}', {
      ...values,
      client_address: '',
      sender_name: '',
    })
    expect(result.text).toBe('At  from ')
    expect(result.missing).toEqual([])
  })

  it('does not report a required placeholder the text never uses', () => {
    const blank = valuesFor({ ...monthly, monthlyRate: 0 })
    expect(fillTemplate('Hello {{client_name}}', blank).missing).toEqual([])
  })

  it('reports an unknown placeholder and leaves it as typed', () => {
    const result = fillTemplate('Hi {{clientname}} and {{ Client Name }} and {{clientname}} {{}}', values)
    expect(result.text).toBe('Hi {{clientname}} and {{ Client Name }} and {{clientname}} {{}}')
    expect(result.unknown).toEqual(['clientname', 'client name', ''])
  })

  it('passes text with no tokens, and a null, through safely', () => {
    expect(fillTemplate('Plain {text} here', values).text).toBe('Plain {text} here')
    expect(fillTemplate(null, values)).toEqual({ text: '', missing: [], unknown: [] })
  })

  it('does not treat a value that holds a token as a token', () => {
    const result = fillTemplate('{{client_name}}', { ...values, client_name: '{{fee}} Inc' })
    expect(result.text).toBe('{{fee}} Inc')
    expect(result.missing).toEqual([])
  })
})

describe('templateWarnings', () => {
  it('collects unknown placeholders from all three boxes without repeats', () => {
    expect(
      templateWarnings({
        subject: 'For {{clientname}}',
        emailBody: 'Hi {{contact_first_name}} {{oops}}',
        letterBody: '{{clientname}} {{fee}}',
      }),
    ).toEqual({ unknown: ['clientname', 'oops'] })
  })

  it('is empty for a clean or missing template', () => {
    expect(templateWarnings({ subject: 's', emailBody: '{{fee}}', letterBody: '{{year}}' })).toEqual({
      unknown: [],
    })
    expect(templateWarnings(undefined)).toEqual({ unknown: [] })
  })
})

describe('letterTemplateHash', () => {
  const template = {
    subject: 'Your 1099s',
    emailBody: 'Hi {{contact_first_name}}',
    letterBody: 'Dear é {{client_name}}',
  }

  it('is the sha256 of the three boxes as JSON', () => {
    const expected = createHash('sha256')
      .update(JSON.stringify([template.subject, template.emailBody, template.letterBody]))
      .digest('hex')
    expect(letterTemplateHash(template)).toBe(expected)
  })

  it('matches node for long and empty input too', () => {
    for (const letterBody of ['', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'line\n\n'.repeat(5000)]) {
      const input = { subject: 'a', emailBody: 'b', letterBody }
      const expected = createHash('sha256').update(JSON.stringify(['a', 'b', letterBody])).digest('hex')
      expect(letterTemplateHash(input)).toBe(expected)
    }
    expect(letterTemplateHash({})).toBe(createHash('sha256').update('["","",""]').digest('hex'))
  })

  it('is stable, and changes with any one box', () => {
    const base = letterTemplateHash(template)
    expect(letterTemplateHash({ ...template })).toBe(base)
    expect(letterTemplateHash({ ...template, subject: 'Your 1099s.' })).not.toBe(base)
    expect(letterTemplateHash({ ...template, emailBody: 'x' })).not.toBe(base)
    expect(letterTemplateHash({ ...template, letterBody: 'x' })).not.toBe(base)
  })

  it('does not let a boundary slide between boxes', () => {
    expect(letterTemplateHash({ subject: 'ab', emailBody: 'c' })).not.toBe(
      letterTemplateHash({ subject: 'a', emailBody: 'bc' }),
    )
  })
})
