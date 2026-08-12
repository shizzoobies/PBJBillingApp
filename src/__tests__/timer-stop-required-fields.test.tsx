import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { TimeCapture } from '../pages/TimePage'
import type { Client, Employee, TimerState } from '../lib/types'

/**
 * Stop & log with a required field missing must BLOCK the save without losing a
 * second of the tracked time. That is the whole risk in making these fields
 * mandatory: a lockout that eats time is far worse than a missing note, so the
 * timer keeps running (same `startedAt`, same elapsed) while the prompts are
 * answered, and the save goes through the moment they are.
 */

const ME = 'emp-me'
const NOW = new Date('2026-08-12T15:00:00Z').getTime()
// The timer has been running for 42 minutes when the user hits Stop & log.
const STARTED_AT = NOW - 42 * 60_000

const CLIENTS = [
  { id: 'client-1', name: 'Acme Dental' },
  { id: 'client-2', name: 'Bright Books' },
] as Client[]
const EMPLOYEES = [{ id: ME, name: 'Me', role: 'Bookkeeper' }] as Employee[]

/**
 * Owns the timer the way App does: `onUpdateTimer` patches it, so filling a
 * field in the panel really changes the running timer — and the elapsed label
 * is DERIVED from `startedAt`, so it can only stay at 42m if no time was lost.
 */
function Harness({
  timer: initialTimer,
  onStopTimer,
  onCancelTimer = vi.fn(),
}: {
  timer: TimerState
  onStopTimer: () => Promise<void>
  onCancelTimer?: () => void
}) {
  const [timer, setTimer] = useState<TimerState | null>(initialTimer)
  const elapsed = timer ? `${Math.round((NOW - timer.startedAt) / 60_000)}m` : 'no timer'
  return (
    <TimeCapture
      activeEmployeeId={ME}
      clients={CLIENTS}
      checklists={[]}
      templates={[]}
      onGenerateFromTemplate={async () => null}
      employees={EMPLOYEES}
      onStartTimer={vi.fn()}
      onStopTimer={onStopTimer}
      onUpdateTimer={(patch) => setTimer((current) => (current ? { ...current, ...patch } : current))}
      onCancelTimer={onCancelTimer}
      role="employee"
      timer={timer}
      timerElapsed={elapsed}
      locked={false}
      previewMode={false}
      currentPeriod="2026-08"
    />
  )
}

function runningTimer(overrides: Partial<TimerState> = {}): TimerState {
  return {
    employeeId: ME,
    clientId: 'client-1',
    description: '',
    startedAt: STARTED_AT,
    taskId: null,
    taskLabel: 'Monthly close',
    ...overrides,
  }
}

const stopButton = () => screen.getByRole('button', { name: /stop & log/i })
const detailBox = () => screen.getByRole('textbox', { name: /what did you do|notes/i })

describe('Stop & log with a missing field', () => {
  it('blocks the save, prompts for the detail, and keeps the elapsed time', () => {
    const onStopTimer = vi.fn().mockResolvedValue(undefined)
    const onCancelTimer = vi.fn()
    render(<Harness timer={runningTimer()} onStopTimer={onStopTimer} onCancelTimer={onCancelTimer} />)

    expect(screen.getByText('42m')).toBeInTheDocument()

    fireEvent.click(stopButton())

    expect(onStopTimer).not.toHaveBeenCalled()
    expect(onCancelTimer).not.toHaveBeenCalled()
    expect(screen.getByText('Add a detail to log this time.')).toBeInTheDocument()
    // The clock never moved: still running, still 42 minutes of tracked time.
    expect(screen.getByText('42m')).toBeInTheDocument()
    expect(stopButton()).toBeEnabled()
  })

  it('logs the time as soon as the detail is filled in — no time lost', () => {
    const onStopTimer = vi.fn().mockResolvedValue(undefined)
    render(<Harness timer={runningTimer()} onStopTimer={onStopTimer} />)

    fireEvent.click(stopButton())
    expect(onStopTimer).not.toHaveBeenCalled()

    fireEvent.change(detailBox(), { target: { value: 'Reconciled the operating account.' } })
    // The prompt clears itself the moment the field is answered.
    expect(screen.queryByText('Add a detail to log this time.')).not.toBeInTheDocument()
    expect(screen.getByText('42m')).toBeInTheDocument()

    fireEvent.click(stopButton())
    expect(onStopTimer).toHaveBeenCalledTimes(1)
  })

  it('prompts for the task when it is the missing one', () => {
    const onStopTimer = vi.fn().mockResolvedValue(undefined)
    render(
      <Harness
        timer={runningTimer({ taskLabel: '', description: 'Reconciled the account.' })}
        onStopTimer={onStopTimer}
      />,
    )

    fireEvent.click(stopButton())
    expect(onStopTimer).not.toHaveBeenCalled()
    expect(screen.getByText('Pick or type a task to log this time.')).toBeInTheDocument()
    expect(screen.getByText('42m')).toBeInTheDocument()
  })

  it('requires only a detail on administrative time', () => {
    const onStopTimer = vi.fn().mockResolvedValue(undefined)
    render(
      <Harness
        timer={runningTimer({ clientId: '', taskLabel: '', isAdministrative: true })}
        onStopTimer={onStopTimer}
      />,
    )

    fireEvent.click(stopButton())
    expect(onStopTimer).not.toHaveBeenCalled()
    expect(screen.getByText('Add a detail to log this time.')).toBeInTheDocument()

    fireEvent.change(detailBox(), { target: { value: 'Company meeting.' } })
    fireEvent.click(stopButton())
    expect(onStopTimer).toHaveBeenCalledTimes(1)
  })

  /**
   * A group block spans several clients and the panel offers it no task field at
   * all — its slices get their tasks when it is split. So the detail is demanded
   * and the task is not.
   */
  it('logs a group block with a detail and no task', () => {
    const onStopTimer = vi.fn().mockResolvedValue(undefined)
    render(
      <Harness
        timer={runningTimer({
          clientId: '',
          taskLabel: '',
          groupClientIds: ['client-1', 'client-2'],
          description: 'Quarter-end review across the group.',
        })}
        onStopTimer={onStopTimer}
      />,
    )

    fireEvent.click(stopButton())
    expect(onStopTimer).toHaveBeenCalledTimes(1)
  })

  it('still demands a detail on a group block', () => {
    const onStopTimer = vi.fn().mockResolvedValue(undefined)
    render(
      <Harness
        timer={runningTimer({
          clientId: '',
          taskLabel: '',
          groupClientIds: ['client-1', 'client-2'],
        })}
        onStopTimer={onStopTimer}
      />,
    )

    fireEvent.click(stopButton())
    expect(onStopTimer).not.toHaveBeenCalled()
    expect(screen.getByText('Add a detail to log this time.')).toBeInTheDocument()
    expect(screen.getByText('42m')).toBeInTheDocument()
  })

  /**
   * Resuming appends a session to an entry that already exists — stopping never
   * writes these fields, so demanding them would be a dead end on a legacy entry
   * that has none.
   */
  it('does not gate a resumed entry', () => {
    const onStopTimer = vi.fn().mockResolvedValue(undefined)
    render(
      <Harness
        timer={runningTimer({ taskLabel: '', description: '', resumeEntryId: 'time-1' })}
        onStopTimer={onStopTimer}
      />,
    )

    fireEvent.click(stopButton())
    expect(onStopTimer).toHaveBeenCalledTimes(1)
  })
})
