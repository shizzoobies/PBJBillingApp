import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ManualEntryModal } from '../pages/TimePage'
import type { ChecklistTemplate, Client, Employee } from '../lib/types'

/**
 * Brittany, 2026-09-23 ("time reports"): rows made by Split across clients
 * exported with no Clock in / Clock out and the task "Unassigned".
 *
 * The manual form's group path saved each client's share as minutes only: no
 * start/stop and no task. Now every share carries the block's start/stop and
 * the group's task name, and each share still bills ONLY its allocation. The
 * start/stop goes over as the envelope alone, with no `sessions`, because the
 * server re-derives an entry's minutes from `sessions` when they are sent. The
 * server half of that contract is pinned in manual-time-entry.test.ts
 * (`resolveCreatedEntryTiming`).
 */

const ME = 'emp-me'
const CLIENTS = [
  { id: 'client-1', name: 'Acme Dental' },
  { id: 'client-2', name: 'Bright Books' },
] as Client[]
const EMPLOYEES = [{ id: ME, name: 'Me', role: 'Bookkeeper' }] as Employee[]
const TEMPLATES = [
  { id: 'std-1', title: 'Bank reconciliation', isStandard: true, active: true },
] as ChecklistTemplate[]

const START = '2026-08-12T09:00'
const STOP = '2026-08-12T09:19'

function openGroupForm(onLog = vi.fn().mockResolvedValue(undefined)) {
  const view = render(
    <ManualEntryModal
      activeEmployeeId={ME}
      clients={CLIENTS}
      checklists={[]}
      templates={TEMPLATES}
      onGenerateFromTemplate={async () => null}
      employees={EMPLOYEES}
      role="employee"
      onLog={onLog}
      onClose={vi.fn()}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: /yes, enter manually/i }))
  const [startBox, stopBox] = Array.from(
    view.container.querySelectorAll<HTMLInputElement>('input[type="datetime-local"]'),
  )
  fireEvent.change(startBox, { target: { value: START } })
  fireEvent.change(stopBox, { target: { value: STOP } })
  fireEvent.change(screen.getByRole('combobox', { name: 'Bill to' }), {
    target: { value: 'group' },
  })
  fireEvent.click(screen.getByRole('checkbox', { name: 'Acme Dental' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Bright Books' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Details' }), {
    target: { value: 'Month-end close for both books.' },
  })
  fireEvent.change(screen.getByRole('textbox', { name: /why are you entering this manually/i }), {
    target: { value: 'Worked offline.' },
  })
  return onLog
}

const submit = () => fireEvent.click(screen.getByRole('button', { name: /submit for approval/i }))

describe('manual Split across clients: every share keeps the task and the clock in/out', () => {
  it('gives every share the group task, the block start/stop, and only its own minutes', async () => {
    const onLog = openGroupForm()
    fireEvent.change(screen.getByPlaceholderText('Pick a standard task or type your own'), {
      target: { value: 'Bank reconciliation' },
    })
    submit()

    await screen.findByText('Manual entry submitted — an owner will review it.')
    expect(onLog).toHaveBeenCalledTimes(2)
    const shares = onLog.mock.calls.map((call) => call[0])
    expect(shares.map((share) => share.clientId)).toEqual(['client-1', 'client-2'])
    for (const share of shares) {
      expect(share.taskId).toBeNull()
      expect(share.taskLabel).toBe('Bank reconciliation')
      expect(share.startAt).toBe(new Date(START).toISOString())
      expect(share.endAt).toBe(new Date(STOP).toISOString())
      // The envelope ONLY: sent sessions would make the server bill the block.
      expect(share.sessions).toBeUndefined()
      // 19 minutes split evenly: each share bills 9.5, not the whole 19.
      expect(share.minutes).toBe(9.5)
    }
    expect(new Set(shares.map((share) => share.groupId)).size).toBe(1)
  })

  it('keeps a typed task name exactly as typed', async () => {
    const onLog = openGroupForm()
    fireEvent.change(screen.getByPlaceholderText('Pick a standard task or type your own'), {
      target: { value: 'Year-end 1099 prep' },
    })
    submit()

    await screen.findByText('Manual entry submitted — an owner will review it.')
    expect(onLog.mock.calls.map((call) => call[0].taskLabel)).toEqual([
      'Year-end 1099 prep',
      'Year-end 1099 prep',
    ])
  })

  it('still saves with no task (the group exemption), just without a name', async () => {
    const onLog = openGroupForm()
    submit()

    await screen.findByText('Manual entry submitted — an owner will review it.')
    expect(onLog).toHaveBeenCalledTimes(2)
    for (const [share] of onLog.mock.calls) {
      expect(share.taskLabel).toBeUndefined()
      expect(share.startAt).toBe(new Date(START).toISOString())
    }
  })

  it('never carries a task picked in single-client mode into the group', async () => {
    const onLog = vi.fn().mockResolvedValue(undefined)
    render(
      <ManualEntryModal
        activeEmployeeId={ME}
        clients={CLIENTS}
        checklists={[]}
        templates={TEMPLATES}
        onGenerateFromTemplate={async () => null}
        employees={EMPLOYEES}
        role="employee"
        onLog={onLog}
        onClose={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /yes, enter manually/i }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Client' }), {
      target: { value: 'client-1' },
    })
    fireEvent.change(screen.getByPlaceholderText('Pick a task or type your own'), {
      target: { value: 'Single-client task' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: 'Bill to' }), {
      target: { value: 'group' },
    })
    expect(screen.getByPlaceholderText('Pick a standard task or type your own')).toHaveValue('')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Acme Dental' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Bright Books' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Details' }), {
      target: { value: 'Month-end close for both books.' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: /why are you entering this manually/i }), {
      target: { value: 'Worked offline.' },
    })
    submit()

    await screen.findByText('Manual entry submitted — an owner will review it.')
    for (const [share] of onLog.mock.calls) expect(share.taskLabel).toBeUndefined()
  })
})
