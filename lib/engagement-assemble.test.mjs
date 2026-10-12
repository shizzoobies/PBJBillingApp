import { describe, expect, it } from 'vitest'

import { assembleEngagement, ENGAGEMENT_SUBJECTS } from './engagement-assemble.js'
import { DEFAULT_ENGAGEMENT_SECTIONS } from './engagement-sections.js'

/**
 * Assembling an engagement letter from the section library
 * (docs/plans/engagements-2026-10.md, 2A): subject by kind, the email section as
 * the email, the triggered sections as `**Title**` blocks, placeholders untouched.
 */

const snapshot = {
  lines: [
    { serviceId: 'reconciliations', group: 'Reconciliations', amount: 375 },
    { serviceId: 'payroll', group: 'Payroll', amount: 0, flag: 'no-rate' },
  ],
}

const assemble = (over = {}) =>
  assembleEngagement({
    sections: DEFAULT_ENGAGEMENT_SECTIONS,
    snapshot,
    kind: 'original',
    party: { company: 'Acme Books' },
    firmName: 'PB&J Strategic Accounting',
    ...over,
  })

describe('assembleEngagement', () => {
  it('picks the subject by kind, placeholders left for the filler', () => {
    expect(assemble().subject).toBe('Engagement letter - {{client_name}}')
    expect(assemble({ kind: 'superseding' }).subject).toBe('Updated engagement letter - {{client_name}}')
    expect(assemble({ kind: 'amendment' }).subject).toBe('Engagement amendment - {{client_name}}')
    expect(assemble({ kind: 'junk' }).subject).toBe(ENGAGEMENT_SUBJECTS.original)
    expect(Object.isFrozen(ENGAGEMENT_SUBJECTS)).toBe(true)
  })

  it('uses the email section as the email body, and never puts it in the letter', () => {
    const result = assemble()
    const email = DEFAULT_ENGAGEMENT_SECTIONS.find((section) => section.key === 'email')
    expect(result.emailBody).toBe(email.body)
    expect(result.letterBody).not.toContain(email.body)
    expect(result.sectionKeys).not.toContain('email')
  })

  it('joins the triggered sections as **Title** blocks, the intro without a title', () => {
    const result = assemble()
    expect(result.sectionKeys).toEqual(['intro', 'services_monthly', 'payroll', 'fees', 'terms', 'closing'])
    const byKey = Object.fromEntries(DEFAULT_ENGAGEMENT_SECTIONS.map((section) => [section.key, section]))
    expect(result.letterBody).toBe(
      [
        byKey.intro.body,
        `**Monthly services**\n\n${byKey.services_monthly.body}`,
        `**Payroll**\n\n${byKey.payroll.body}`,
        `**Fees and payment**\n\n${byKey.fees.body}`,
        `**Terms of our engagement**\n\n${byKey.terms.body}`,
        `**Agreement**\n\n${byKey.closing.body}`,
      ].join('\n\n'),
    )
    expect(result.letterBody.startsWith('Dear {{contact_name}},')).toBe(true)
    expect(result.letterBody).not.toContain('**Introduction**')
    expect(result.letterBody).toContain('{{monthly_fee}}')
  })

  it('with no snapshot, only the always sections', () => {
    expect(assemble({ snapshot: null }).sectionKeys).toEqual(['intro', 'fees', 'terms', 'closing'])
    expect(assemble({ snapshot: { lines: 'junk' } }).sectionKeys).toEqual(['intro', 'fees', 'terms', 'closing'])
  })

  it('leaves out a blank section, skips an inactive email, cleans titles, normalizes line endings', () => {
    const result = assembleEngagement({
      sections: [
        { key: 'email', body: 'old email', trigger: { always: true }, active: false },
        { key: 'a', title: ' First\n**part** ', body: 'One\r\nTwo', trigger: { always: true }, sortOrder: 2 },
        { key: 'blank', title: 'Blank', body: '   ', trigger: { always: true }, sortOrder: 3 },
        { key: 'untitled', title: '', body: 'No title here', trigger: { always: true }, sortOrder: 4 },
        { key: 'intro', title: 'Hidden', body: 'Hello', trigger: { always: true }, sortOrder: 1 },
      ],
      snapshot: { lines: [] },
    })
    expect(result).toEqual({
      subject: ENGAGEMENT_SUBJECTS.original,
      emailBody: '',
      letterBody: 'Hello\n\n**First part**\n\nOne\nTwo\n\nNo title here',
      sectionKeys: ['intro', 'a', 'untitled'],
    })
  })

  it('never throws on junk', () => {
    expect(assembleEngagement()).toEqual({
      subject: ENGAGEMENT_SUBJECTS.original,
      emailBody: '',
      letterBody: '',
      sectionKeys: [],
    })
    expect(assembleEngagement({ sections: 'x', snapshot: 7 }).sectionKeys).toEqual([])
  })
})
