import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { GroupSplitModal, ManualEntryModal } from '../pages/TimePage'
import type { Client, Employee, TimeEntry } from '../lib/types'

/**
 * The Time page says what will actually happen to the entry (featreq-5ad33ce9).
 *
 * An owner's own time is saved approved, so the manual-entry and split dialogs
 * must not tell her it "will be submitted for owner approval" or "goes back
 * through approval". Time she enters for someone else, and everything a team
 * member does, still queues, and the words still say so.
 */

const OWNER = 'emp-owner'
const STAFF = 'emp-staff'

const CLIENTS = [
  { id: 'client-1', name: 'Acme Dental' },
  { id: 'client-2', name: 'Bright Books' },
] as Client[]
const EMPLOYEES = [
  { id: OWNER, name: 'Brittany', role: 'Owner' },
  { id: STAFF, name: 'Lisa', role: 'Bookkeeper' },
] as Employee[]

function openManual(role: 'owner' | 'employee', activeEmployeeId: string) {
  render(
    <ManualEntryModal
      activeEmployeeId={activeEmployeeId}
      clients={CLIENTS}
      checklists={[]}
      templates={[]}
      onGenerateFromTemplate={async () => null}
      employees={EMPLOYEES}
      role={role}
      onLog={vi.fn().mockResolvedValue(undefined)}
      onClose={vi.fn()}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: /yes, enter manually/i }))
}

const OWN_INTRO = 'This is your own time, so it is saved as approved. Nobody needs to review it.'
const QUEUE_INTRO = 'This entry will be submitted for owner approval, like all time entries.'

describe('Manual time entry: what it says about approval', () => {
  it('tells an owner her own time is saved approved, and the button just saves', () => {
    openManual('owner', OWNER)
    expect(screen.getByText(OWN_INTRO)).toBeInTheDocument()
    expect(screen.queryByText(QUEUE_INTRO)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save time' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /submit for approval/i })).not.toBeInTheDocument()
  })

  it('goes back to the approval wording when the owner picks someone else', () => {
    openManual('owner', OWNER)
    fireEvent.change(screen.getByRole('combobox', { name: 'Employee' }), { target: { value: STAFF } })
    expect(screen.getByText(QUEUE_INTRO)).toBeInTheDocument()
    expect(screen.queryByText(OWN_INTRO)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /submit for approval/i })).toBeInTheDocument()

    // And back to her own.
    fireEvent.change(screen.getByRole('combobox', { name: 'Employee' }), { target: { value: OWNER } })
    expect(screen.getByText(OWN_INTRO)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save time' })).toBeInTheDocument()
  })

  it('keeps the approval wording for a team member on their own time', () => {
    openManual('employee', STAFF)
    expect(screen.getByText(QUEUE_INTRO)).toBeInTheDocument()
    expect(screen.queryByText(OWN_INTRO)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /submit for approval/i })).toBeInTheDocument()
  })
})

const ENTRY = {
  id: 'time-1',
  employeeId: OWNER,
  clientId: 'client-1',
  date: '2026-08-12',
  minutes: 60,
  description: 'Quarter-end review.',
  billable: true,
} as TimeEntry

const SLICES = [
  { ...ENTRY, id: 'slice-1', minutes: 30, groupId: 'grp-1', groupAllocation: 'custom' },
  { ...ENTRY, id: 'slice-2', clientId: 'client-2', minutes: 30, groupId: 'grp-1', groupAllocation: 'custom' },
] as TimeEntry[]

function renderSplit(props: { ownTime?: boolean; adjust?: boolean }) {
  render(
    <GroupSplitModal
      entry={props.adjust ? SLICES[0] : ENTRY}
      groupSlices={props.adjust ? SLICES : []}
      clients={CLIENTS}
      billableClients={CLIENTS}
      onSplit={vi.fn().mockResolvedValue(undefined)}
      onAdjust={vi.fn().mockResolvedValue(undefined)}
      onClose={vi.fn()}
      {...(props.ownTime === undefined ? {} : { ownTime: props.ownTime })}
    />,
  )
}

describe('Splitting time: what it says about approval', () => {
  it('a new split of an owner’s own time does not say it goes back through approval', () => {
    renderSplit({ ownTime: true })
    expect(screen.getByText(/this replaces the entry with one per client/i)).toBeInTheDocument()
    expect(screen.queryByText(/go back through approval/i)).not.toBeInTheDocument()
  })

  it('adjusting an owner’s own split does not say it either', () => {
    renderSplit({ ownTime: true, adjust: true })
    expect(screen.getByText(/stays exactly as it was recorded/i)).toBeInTheDocument()
    expect(screen.queryByText(/go back through approval/i)).not.toBeInTheDocument()
  })

  it('everyone else is still told the shares go back through approval', () => {
    renderSplit({ ownTime: false })
    expect(screen.getByText(/they go back through approval/i)).toBeInTheDocument()
  })

  it('and so is an adjustment, including when the dialog is not told whose time it is', () => {
    renderSplit({ adjust: true })
    expect(screen.getByText(/the entries go back through approval/i)).toBeInTheDocument()
  })
})
