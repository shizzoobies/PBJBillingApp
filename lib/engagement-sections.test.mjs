import { describe, expect, it } from 'vitest'

import {
  DEFAULT_ENGAGEMENT_SECTIONS,
  ENGAGEMENT_SECTION_BODY_MAX,
  isEmailSection,
  sanitizeEngagementSection,
  sanitizeEngagementSections,
  sectionFires,
  triggeredSections,
} from './engagement-sections.js'
import { DEFAULT_PROPOSAL_PRICING, PROPOSAL_GROUPS } from './proposal-pricing.js'

/**
 * The engagement letter's section library (docs/plans/engagements-2026-10.md, 2A):
 * the seed, the cleaning rules and which sections a Won proposal's lines trigger.
 */

const line = (group, serviceId = `${group}-row`, extra = {}) => ({ group, serviceId, ...extra })

describe('DEFAULT_ENGAGEMENT_SECTIONS', () => {
  it('has the planned keys in letter order, each once', () => {
    expect(DEFAULT_ENGAGEMENT_SECTIONS.map((section) => section.key)).toEqual([
      'email',
      'intro',
      'services_monthly',
      'services_annual',
      'cleanup',
      'payroll',
      'sales_tax',
      'consulting',
      'fees',
      'terms',
      'closing',
    ])
    const orders = DEFAULT_ENGAGEMENT_SECTIONS.map((section) => section.sortOrder)
    expect([...orders].sort((a, b) => a - b)).toEqual(orders)
    expect(new Set(orders).size).toBe(orders.length)
  })

  it('carries the planned triggers and roles', () => {
    const byKey = Object.fromEntries(DEFAULT_ENGAGEMENT_SECTIONS.map((section) => [section.key, section]))
    for (const key of ['email', 'intro', 'fees', 'terms', 'closing']) {
      expect(byKey[key].trigger).toEqual({ always: true })
    }
    expect(byKey.email.role).toBe('email')
    for (const section of DEFAULT_ENGAGEMENT_SECTIONS.filter((entry) => entry.key !== 'email')) {
      expect(section.role, section.key).toBe('letter')
      expect(section.active).toBe(true)
    }
    expect(byKey.services_monthly.trigger).toEqual({
      groups: ['Monthly', 'Reconciliations', 'AR', 'AP', 'Reports', 'Additional reports'],
    })
    expect(byKey.services_annual.trigger).toEqual({ groups: ['Annual and one-time'] })
    expect(byKey.cleanup.trigger).toEqual({ groups: ['Clean-up'] })
    expect(byKey.payroll.trigger).toEqual({ groups: ['Payroll'] })
    expect(byKey.sales_tax.trigger).toEqual({ groups: ['Sales tax'] })
    expect(byKey.consulting.trigger).toEqual({ serviceIds: ['client-call'] })
  })

  it('every trigger names a real proposal group or catalog line', () => {
    const ids = new Set(DEFAULT_PROPOSAL_PRICING.services.map((service) => service.id))
    for (const section of DEFAULT_ENGAGEMENT_SECTIONS) {
      for (const group of section.trigger.groups ?? []) expect(PROPOSAL_GROUPS, section.key).toContain(group)
      for (const id of section.trigger.serviceIds ?? []) expect(ids.has(id), `${section.key}: ${id}`).toBe(true)
    }
    const clientCall = DEFAULT_PROPOSAL_PRICING.services.find((service) => service.id === 'client-call')
    expect(clientCall.name).toBe('Client call')
  })

  it('keeps the title out of the body and the text plain', () => {
    // (Every placeholder a seed body names is a known one: lib/engagement-values.test.mjs.)
    for (const section of DEFAULT_ENGAGEMENT_SECTIONS) {
      expect(section.body.startsWith(`**${section.title}**`)).toBe(false)
      expect(section.body.trim()).toBe(section.body)
      // Plain ASCII: no smart quotes or dashes sneaking into a client letter.
      expect(/^[\x20-\x7e\n]*$/.test(section.body), section.key).toBe(true)
    }
  })

  it('reads in American English and has the signature block the plan names', () => {
    const all = DEFAULT_ENGAGEMENT_SECTIONS.map((section) => `${section.title}\n${section.body}`).join('\n')
    expect(all).not.toMatch(/\b(organis|categoris|recognis|colour|labour|favour|honour|licence|cheque)/i)
    const closing = DEFAULT_ENGAGEMENT_SECTIONS.find((section) => section.key === 'closing').body
    expect(closing).toContain('Agreed and accepted:')
    expect(closing).toContain('Signature: ______________________')
    expect(closing).toContain('Name: {{contact_name}}')
    expect(closing).toContain('Date: ______________')
    expect(closing).toContain('{{sender_name}}, {{firm_name}}')
    const email = DEFAULT_ENGAGEMENT_SECTIONS.find((section) => section.key === 'email').body
    expect(email).toContain('{{contact_first_name}}')
    expect(email).toContain('{{sender_name}}')
    expect(email.toLowerCase()).toContain('attached is our engagement letter')
    expect(email.toLowerCase()).toContain('reply to this email with the signed copy')
  })

  it('is frozen, so no caller can change the seed', () => {
    expect(Object.isFrozen(DEFAULT_ENGAGEMENT_SECTIONS)).toBe(true)
    expect(Object.isFrozen(DEFAULT_ENGAGEMENT_SECTIONS[0].trigger)).toBe(true)
  })

  it('survives its own sanitizer unchanged', () => {
    expect(sanitizeEngagementSections(DEFAULT_ENGAGEMENT_SECTIONS)).toEqual(
      DEFAULT_ENGAGEMENT_SECTIONS.map((section) => ({ ...section })),
    )
  })
})

describe('sanitizeEngagementSection', () => {
  it('keeps a well-formed section, derives the role from the key', () => {
    expect(
      sanitizeEngagementSection({
        key: ' Payroll_Extra ',
        title: '  Payroll   extras ',
        body: 'Line one\r\nLine two\r\n',
        trigger: { always: false, groups: ['Payroll', ' Payroll ', '', 7], serviceIds: 'client-call' },
        sortOrder: '35.8',
        role: 'email',
        extra: 'dropped',
      }),
    ).toEqual({
      key: 'payroll_extra',
      title: 'Payroll extras',
      body: 'Line one\nLine two',
      trigger: { groups: ['Payroll'] },
      sortOrder: 35,
      role: 'letter',
      active: true,
    })
    expect(sanitizeEngagementSection({ key: 'email', body: 'Hi' })?.role).toBe('email')
  })

  it('refuses what cannot be a section', () => {
    for (const bad of [null, undefined, 'email', [], {}, { key: '' }, { key: 'has space' }, { key: 'dash-key' }, { key: 'x'.repeat(41) }, { key: 7 }]) {
      expect(sanitizeEngagementSection(bad)).toBeNull()
    }
    expect(sanitizeEngagementSection({ key: 'x'.repeat(40) })?.key).toBe('x'.repeat(40))
  })

  it('caps the title, the body and each trigger list', () => {
    const section = sanitizeEngagementSection({
      key: 'big',
      title: 't'.repeat(500),
      body: 'b'.repeat(ENGAGEMENT_SECTION_BODY_MAX + 50),
      trigger: { groups: Array.from({ length: 30 }, (_, i) => `g${i}`), serviceIds: ['x'.repeat(300)] },
    })
    expect(section.title).toHaveLength(120)
    expect(section.body).toHaveLength(ENGAGEMENT_SECTION_BODY_MAX)
    expect(section.trigger.groups).toHaveLength(20)
    expect(section.trigger.serviceIds[0]).toHaveLength(120)
  })

  it('defaults: empty title and body, no trigger, sortOrder 0, active unless false', () => {
    expect(sanitizeEngagementSection({ key: 'bare', sortOrder: 'junk', trigger: [1], active: 0 })).toEqual({
      key: 'bare',
      title: '',
      body: '',
      trigger: {},
      sortOrder: 0,
      role: 'letter',
      active: true,
    })
    expect(sanitizeEngagementSection({ key: 'off', active: false }).active).toBe(false)
    expect(sanitizeEngagementSection({ key: 'huge', sortOrder: 1e12 }).sortOrder).toBe(1e6)
    expect(sanitizeEngagementSection({ key: 'yes', trigger: { always: 'true' } }).trigger).toEqual({})
  })
})

describe('sanitizeEngagementSections', () => {
  it('drops junk, keeps the first of a repeated key, orders by sortOrder (ties stay put)', () => {
    const cleaned = sanitizeEngagementSections([
      { key: 'b', sortOrder: 20, body: 'first b' },
      null,
      { key: 'a', sortOrder: 10 },
      { key: 'B', sortOrder: 1, body: 'second b' },
      { key: 'c', sortOrder: 20 },
      { key: 'bad key' },
    ])
    expect(cleaned.map((section) => section.key)).toEqual(['a', 'b', 'c'])
    expect(cleaned[1].body).toBe('first b')
  })

  it('is [] for anything that is not a list, and caps the library', () => {
    expect(sanitizeEngagementSections(null)).toEqual([])
    expect(sanitizeEngagementSections({ key: 'a' })).toEqual([])
    const many = Array.from({ length: 80 }, (_, i) => ({ key: `k${i}`, sortOrder: i }))
    expect(sanitizeEngagementSections(many)).toHaveLength(60)
  })
})

describe('triggeredSections', () => {
  const keys = (lines, sections = DEFAULT_ENGAGEMENT_SECTIONS) =>
    triggeredSections(sections, lines).map((section) => section.key)

  it('with no lines, only the always sections - and never the email', () => {
    expect(keys([])).toEqual(['intro', 'fees', 'terms', 'closing'])
    expect(keys(undefined)).toEqual(['intro', 'fees', 'terms', 'closing'])
  })

  it('fires each group section from a line in one of its groups', () => {
    expect(keys([line('Reconciliations')])).toEqual(['intro', 'services_monthly', 'fees', 'terms', 'closing'])
    expect(keys([line('Annual and one-time')])).toContain('services_annual')
    expect(keys([line('Clean-up')])).toContain('cleanup')
    expect(keys([line('Payroll')])).toEqual(['intro', 'payroll', 'fees', 'terms', 'closing'])
    expect(keys([line('Sales tax')])).toEqual(['intro', 'sales_tax', 'fees', 'terms', 'closing'])
    expect(keys([line('Software')])).toEqual(['intro', 'fees', 'terms', 'closing'])
  })

  it('fires consulting from the Client call line itself, alongside monthly services', () => {
    expect(keys([line('Additional reports', 'client-call')])).toEqual([
      'intro',
      'services_monthly',
      'consulting',
      'fees',
      'terms',
      'closing',
    ])
    expect(keys([line('Additional reports', 'kpi-reports')])).not.toContain('consulting')
  })

  it('counts a flagged line: the service was still chosen', () => {
    expect(keys([line('Payroll', 'payroll', { flag: 'no-rate', amount: 0 })])).toContain('payroll')
    expect(keys([line('Clean-up', 'cleanup-reconciliations', { flag: 'retired' })])).toContain('cleanup')
  })

  it('a full proposal fires every letter section, in sortOrder', () => {
    const all = keys([
      line('Monthly'),
      line('Annual and one-time'),
      line('Clean-up'),
      line('Payroll'),
      line('Sales tax'),
      line('Additional reports', 'client-call'),
    ])
    expect(all).toEqual(DEFAULT_ENGAGEMENT_SECTIONS.filter((s) => s.key !== 'email').map((s) => s.key))
  })

  it('skips inactive sections, orders by sortOrder whatever order they arrive in', () => {
    const sections = [
      { key: 'z', sortOrder: 5, trigger: { always: true } },
      { key: 'off', sortOrder: 1, trigger: { always: true }, active: false },
      { key: 'a', sortOrder: 2, trigger: { groups: ['AR'] } },
      { key: 'never', sortOrder: 3, trigger: {} },
      { key: 'email', sortOrder: 0, trigger: { always: true } },
      null,
    ]
    expect(keys([line('AR')], sections)).toEqual(['a', 'z'])
  })

  it('reads lines defensively', () => {
    const section = { key: 'x', trigger: { groups: ['AR'], serviceIds: ['client-call'] } }
    expect(sectionFires(section, [null, 7, { group: null, serviceId: null }])).toBe(false)
    expect(sectionFires(section, 'AR')).toBe(false)
    expect(sectionFires({ key: 'y' }, [line('AR')])).toBe(false)
    expect(isEmailSection({ key: 'email' })).toBe(true)
    expect(isEmailSection({ key: 'intro', role: 'letter' })).toBe(false)
  })
})
