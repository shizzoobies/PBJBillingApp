import { describe, expect, it } from 'vitest'
import { detectUsagePatterns, normalizeLabel } from './usage-patterns.js'

const TODAY = '2026-06-10'

const base = {
  clients: [{ id: 'client-a', name: 'Clover Ridge Dental' }],
  checklists: [],
  checklistTemplates: [],
  timeEntries: [],
}

describe('normalizeLabel', () => {
  it('groups periodic variants of the same title', () => {
    expect(normalizeLabel('Payroll June 2026')).toBe(normalizeLabel('Payroll - July 2026'))
    expect(normalizeLabel('Payroll June 2026')).toBe('payroll')
  })

  it('keeps distinct work distinct', () => {
    expect(normalizeLabel('Payroll')).not.toBe(normalizeLabel('Monthly close'))
  })
})

describe('detectUsagePatterns', () => {
  it('suggests a recurring template for hand-created tasks across 2+ months', () => {
    const data = {
      ...base,
      checklists: [
        { id: 'c1', templateId: null, clientId: 'client-a', title: 'Payroll May', dueDate: '2026-05-15', items: [] },
        { id: 'c2', templateId: null, clientId: 'client-a', title: 'Payroll June', dueDate: '2026-06-15', items: [] },
      ],
    }
    const result = detectUsagePatterns(data, { today: TODAY })
    const hit = result.find((s) => s.kind === 'recurring_template')
    expect(hit).toBeTruthy()
    expect(hit?.key).toBe('recurring_template:client-a:payroll')
    expect(hit?.body).toContain('Clover Ridge Dental')
  })

  it('stays quiet when an active template already covers the task', () => {
    const data = {
      ...base,
      checklists: [
        { id: 'c1', templateId: null, clientId: 'client-a', title: 'Payroll May', dueDate: '2026-05-15', items: [] },
        { id: 'c2', templateId: null, clientId: 'client-a', title: 'Payroll June', dueDate: '2026-06-15', items: [] },
      ],
      checklistTemplates: [
        { id: 't1', clientId: 'client-a', title: 'Payroll', frequency: 'monthly', active: true, nextDueDate: '2026-07-15' },
      ],
    }
    expect(
      detectUsagePatterns(data, { today: TODAY }).filter((s) => s.kind === 'recurring_template'),
    ).toHaveLength(0)
  })

  it('ignores template-generated checklists and single months', () => {
    const data = {
      ...base,
      checklists: [
        { id: 'c1', templateId: 'tmpl', clientId: 'client-a', title: 'Close May', dueDate: '2026-05-15', items: [] },
        { id: 'c2', templateId: 'tmpl', clientId: 'client-a', title: 'Close June', dueDate: '2026-06-15', items: [] },
        { id: 'c3', templateId: null, clientId: 'client-a', title: 'One-off cleanup', dueDate: '2026-06-01', items: [] },
      ],
    }
    expect(detectUsagePatterns(data, { today: TODAY })).toHaveLength(0)
  })

  it('flags the same manual time description logged 3+ times in 90 days', () => {
    const entry = (id, date) => ({
      id,
      clientId: 'client-a',
      date,
      entryMethod: 'manual',
      description: 'Sales tax filing prep',
    })
    const data = {
      ...base,
      timeEntries: [
        entry('e1', '2026-04-12'),
        entry('e2', '2026-05-12'),
        entry('e3', '2026-06-09'),
        // Too old — outside the 90-day window, must not count.
        entry('e0', '2025-12-01'),
      ],
    }
    const result = detectUsagePatterns(data, { today: TODAY })
    const hit = result.find((s) => s.kind === 'repeated_manual_time')
    expect(hit).toBeTruthy()
    expect(hit?.body).toContain('3 times')
  })

  it('does not flag timer entries', () => {
    const data = {
      ...base,
      timeEntries: ['2026-05-01', '2026-05-08', '2026-05-15'].map((date, i) => ({
        id: `e${i}`,
        clientId: 'client-a',
        date,
        entryMethod: 'timer',
        description: 'Weekly reconciliation',
      })),
    }
    expect(detectUsagePatterns(data, { today: TODAY })).toHaveLength(0)
  })

  it('flags an active template whose next due date stalled in the past', () => {
    const data = {
      ...base,
      checklistTemplates: [
        { id: 't1', clientId: 'client-a', title: 'Monthly close', active: true, nextDueDate: '2026-04-01' },
        { id: 't2', clientId: 'client-a', title: 'Fresh one', active: true, nextDueDate: '2026-06-20' },
        { id: 't3', clientId: 'client-a', title: 'Inactive old', active: false, nextDueDate: '2026-01-01' },
      ],
    }
    const result = detectUsagePatterns(data, { today: TODAY })
    expect(result.map((s) => s.kind)).toEqual(['stale_template'])
    expect(result[0].key).toBe('stale_template:t1')
    // Names the client and deep-links to the specific template so same-titled
    // cards on different clients stay distinguishable + actionable.
    expect(result[0].title).toContain('Clover Ridge Dental')
    expect(result[0].link).toBe('/checklists?focusTemplate=t1')
  })

  it('does NOT flag a stale STANDARD blueprint (blueprints never generate)', () => {
    const data = {
      ...base,
      checklistTemplates: [
        { id: 'b1', clientId: '', title: 'Standard recon', isStandard: true, active: true, nextDueDate: '2026-01-01' },
      ],
    }
    expect(detectUsagePatterns(data, { today: TODAY })).toEqual([])
  })

  it('does NOT flag a stale-dated template that is still generating instances', () => {
    // The real-world false alarm: nextDueDate never advanced (stuck at 2026-04-01)
    // but the template keeps generating — a recent instance due 2026-05-31 proves
    // it's healthy, so no "stalled" card.
    const data = {
      ...base,
      checklists: [
        { id: 'i1', templateId: 't1', clientId: 'client-a', title: 'Monthly close', dueDate: '2026-05-31', items: [] },
      ],
      checklistTemplates: [
        { id: 't1', clientId: 'client-a', title: 'Monthly close', active: true, nextDueDate: '2026-04-01' },
      ],
    }
    expect(
      detectUsagePatterns(data, { today: TODAY }).filter((s) => s.kind === 'stale_template'),
    ).toEqual([])
  })
})
