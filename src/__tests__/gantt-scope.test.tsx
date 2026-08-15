import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GanttPage } from '../pages/GanttPage'
import type { AppContextValue } from '../AppContext'
import type { AppData, Checklist } from '../lib/types'

/**
 * "Gantt — shows only the viewing employee and the tasks they are assigned to
 * in that period." — the firm owner, featreq-9b47ab5b.
 *
 * The Gantt draws one swimlane per assignee. Because the server sends staff
 * every task on their assigned clients, a bookkeeper's Gantt used to be a
 * labeled read-out of their colleagues' workloads. Owners are unchanged.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))

const BRITTANY = 'emp-brit'
const LISA = 'emp-lisa'

/** Inside the Gantt's window (current month + next), so a bar is drawn. */
const DUE = (() => {
  const today = new Date()
  const end = new Date(today.getFullYear(), today.getMonth() + 1, 15)
  return `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-15`
})()

const checklist = (over: Partial<Checklist>): Checklist =>
  ({
    clientId: 'client-shared',
    dueDate: DUE,
    items: [{ id: 'it-1', label: 'Step', done: false }],
    ...over,
  }) as Checklist

const data = {
  clients: [{ id: 'client-shared', name: 'Brittany Bookkeeping' }],
  employees: [
    { id: BRITTANY, name: 'Brittany Bookkeepington', role: 'Bookkeeper' },
    { id: LISA, name: 'Lisa Chen', role: 'Bookkeeper' },
  ],
  checklists: [
    checklist({ id: 'cl-brit', title: 'Brittany payroll', assigneeId: BRITTANY }),
    checklist({ id: 'cl-lisa', title: 'Lisa monthly close', assigneeId: LISA }),
  ],
  checklistTemplates: [],
  timeEntries: [],
} as unknown as AppData

let contextValue: AppContextValue

function signInAs(viewerId: string, isOwner: boolean) {
  contextValue = {
    data,
    ownerMode: isOwner,
    activeEmployeeId: viewerId,
  } as unknown as AppContextValue
}

const renderGantt = () =>
  render(
    <MemoryRouter>
      <GanttPage />
    </MemoryRouter>,
  )

beforeEach(() => {
  signInAs(BRITTANY, false)
})

describe('Gantt scoping', () => {
  it('shows a staff viewer only their own lane and tasks', () => {
    renderGantt()
    expect(screen.getAllByText('Brittany payroll').length).toBeGreaterThan(0)
    expect(screen.queryAllByText('Lisa monthly close')).toHaveLength(0)
    expect(screen.queryAllByText('Lisa Chen')).toHaveLength(0)
  })

  it('does not offer a staff viewer other people in the assignee filter', () => {
    renderGantt()
    const options = screen.getAllByRole('option').map((option) => option.textContent)
    expect(options).toContain('Brittany Bookkeepington')
    expect(options).not.toContain('Lisa Chen')
  })

  it('leaves the owner every lane', () => {
    signInAs('emp-patrice', true)
    renderGantt()
    expect(screen.getAllByText('Brittany payroll').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Lisa monthly close').length).toBeGreaterThan(0)
  })
})
