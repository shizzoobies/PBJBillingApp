/**
 * featreq-8b54d117 - the recipe editor says what each step's due date is.
 *
 * Brittany wanted Step 1 to have "the due date assigned at the step level" and
 * Step 2 to follow "with the due date assigned to it". The dates already worked
 * that way (Step 1 from the Next due date, each later step from the step
 * before), but the editor never showed them, and "No specific due date" read
 * as "no due date". Each step now names what its date follows and shows the
 * date it gets this cycle; a fixed calendar date, which suits no repeating
 * recipe, is no longer offered.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  formatCycleDate,
  inheritDueLabel,
  SPECIFIC_DATE_ON_RECURRING_WARNING,
  stageDueDatesForCycle,
} from '../lib/recipeFirstStep'
import type { AppContextValue } from '../AppContext'
import type { Client, Employee, TemplateStage } from '../lib/types'

vi.mock('../AppContext', () => ({
  useAppContext: () => ({ serviceCategories: [] }) as unknown as AppContextValue,
}))

const { NewTaskForm, StageScheduleControl } = await import('../pages/ChecklistsPage')

const stage = (patch: Partial<TemplateStage> = {}): TemplateStage => ({
  id: 'stage',
  name: 'Step',
  assigneeId: 'emp-1',
  offsetDays: 0,
  viewerIds: [],
  editorIds: [],
  items: [],
  ...patch,
})

describe('stageDueDatesForCycle', () => {
  it('dates Step 1 from the Next due date and each later step from the step before', () => {
    // Brittany's quarterly reconciliations: Next due Jan 31, Step 1 on the 5th,
    // the review the same day as Step 1, and a sign-off on the 20th.
    expect(
      stageDueDatesForCycle(
        [stage({ dueDayOfMonth: 5 }), stage(), stage({ dueDayOfMonth: 20 })],
        '2027-01-31',
      ),
    ).toEqual(['2027-01-05', '2027-01-05', '2027-01-20'])
  })

  it('keeps legacy offsets (days before the date it follows)', () => {
    expect(stageDueDatesForCycle([stage(), stage({ offsetDays: 3 })], '2026-10-31')).toEqual([
      '2026-10-31',
      '2026-10-28',
    ])
  })

  it('is empty without a Next due date', () => {
    expect(stageDueDatesForCycle([stage()], '')).toEqual([])
  })
})

describe('inheritDueLabel', () => {
  it('names what a step with no date of its own follows', () => {
    expect(inheritDueLabel(0, 0, false)).toBe('On the Next due date')
    expect(inheritDueLabel(0, 0, true)).toBe("On the month's due day")
    expect(inheritDueLabel(1, 0, false)).toBe('Same day as the step before')
    expect(inheritDueLabel(2, 1, false)).toBe('1 day before the step before')
    expect(inheritDueLabel(0, 4, false)).toBe('4 days before the Next due date')
  })
})

describe('formatCycleDate', () => {
  it('reads the date as a calendar day', () => {
    expect(formatCycleDate('2026-10-10')).toBe('Oct 10, 2026')
  })
})

describe('StageScheduleControl', () => {
  it('shows what the step follows and the date it gets this cycle, without a fixed-date choice', () => {
    render(
      <StageScheduleControl
        inheritLabel="On the Next due date"
        cycleDue="2026-10-10"
        onChange={() => {}}
      />,
    )
    expect(screen.getByText('On the Next due date')).toBeTruthy()
    expect(screen.getByText('This cycle: due Oct 10, 2026')).toBeTruthy()
    expect(screen.queryByText('Specific date')).toBeNull()
    expect(screen.queryByText('No specific due date')).toBeNull()
  })

  it('keeps a fixed date a step already has, with a warning', () => {
    render(
      <StageScheduleControl
        dueDate="2026-11-03"
        inheritLabel="Same day as the step before"
        cycleDue="2026-11-03"
        onChange={() => {}}
      />,
    )
    expect(screen.getByText('Specific date')).toBeTruthy()
    expect(screen.getByText(SPECIFIC_DATE_ON_RECURRING_WARNING)).toBeTruthy()
  })
})

describe('the new repeating task form previews each hand-off step\'s date', () => {
  it('chains a hand-off step from the Due date and follows its day of the month', () => {
    render(
      <NewTaskForm
        mode="repeating"
        activeEmployeeId="emp-1"
        clients={[{ id: 'c1', name: 'Acme' } as Client]}
        employees={[{ id: 'emp-1', name: 'Lisa', role: 'Bookkeeper' } as Employee]}
        role="owner"
        onCancel={() => {}}
        onCreateOneTime={async () => {}}
        onCreateRepeating={() => {}}
      />,
    )
    fireEvent.change(screen.getByLabelText('Due'), { target: { value: '2026-10-31' } })
    fireEvent.click(screen.getByText('+ Add a hand-off step'))
    expect(screen.getByText('Same day as the step before')).toBeTruthy()
    expect(screen.getByText('This cycle: due Oct 31, 2026')).toBeTruthy()

    fireEvent.click(screen.getByText('Day of the month'))
    fireEvent.change(screen.getByDisplayValue('1'), { target: { value: '15' } })
    expect(screen.getByText('This cycle: due Oct 15, 2026')).toBeTruthy()
  })
})
