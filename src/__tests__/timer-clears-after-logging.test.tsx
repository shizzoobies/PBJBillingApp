import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { TimeCapture } from '../pages/TimePage'
import { ApiError, type Client, type Employee, type TimerState } from '../lib/types'

/**
 * A logged entry leaves a BLANK slate. The panel's own fields are what seed the
 * next capture, so a description (or task, or client) left sitting there after a
 * save is one keystroke away from being logged twice — "it does not remove the
 * description once you log the time".
 *
 * The clearing is strictly earned: it happens only when the save actually went
 * through. A blocked stop keeps everything (that guarantee lives in
 * timer-stop-required-fields.test.tsx) and so does a refused one, because the
 * time is still un-logged and the user needs what they typed.
 */

const ME = 'emp-me'
const MATE = 'emp-mate'

const CLIENTS = [
  { id: 'client-1', name: 'Acme Dental' },
  { id: 'client-2', name: 'Bright Books' },
] as Client[]
const EMPLOYEES = [
  { id: ME, name: 'Me', role: 'Bookkeeper' },
  { id: MATE, name: 'Sam', role: 'Bookkeeper' },
] as Employee[]

/**
 * Owns the timer the way App does: Start installs it, Stop clears it — but only
 * when the save resolves, exactly like `stopTimer` in App.tsx, which leaves the
 * timer running when `logTime` throws.
 */
function Harness({
  onStop,
  starts = [],
}: {
  onStop?: () => Promise<void>
  starts?: TimerState[]
}) {
  const [timer, setTimer] = useState<TimerState | null>(null)
  return (
    <>
      <TimeCapture
        activeEmployeeId={ME}
        clients={CLIENTS}
        checklists={[]}
        templates={[]}
        onGenerateFromTemplate={async () => null}
        employees={EMPLOYEES}
        onStartTimer={(next) => {
          starts.push(next)
          setTimer(next)
        }}
        onStopTimer={async () => {
          if (onStop) await onStop()
          setTimer(null)
        }}
        onUpdateTimer={(patch) =>
          setTimer((current) => (current ? { ...current, ...patch } : current))
        }
        onCancelTimer={vi.fn()}
        role="owner"
        timer={timer}
        timerElapsed="42m"
        locked={false}
        previewMode={false}
        currentPeriod="2026-08"
      />
      {/* Resuming is started from the entry list, not this panel — this stands in
          for that button so the resume stop can be driven through the panel. */}
      <button
        type="button"
        onClick={() =>
          setTimer({
            employeeId: ME,
            clientId: 'client-1',
            description: '',
            startedAt: Date.now() - 60_000,
            taskId: null,
            resumeEntryId: 'time-1',
          })
        }
      >
        resume an entry
      </button>
    </>
  )
}

const startButton = () => screen.getByRole('button', { name: /start timer/i })
const stopButton = () => screen.getByRole('button', { name: /stop & log/i })
const clientSelect = () => screen.getByRole('combobox', { name: 'Client' })
const employeeSelect = () => screen.getByRole('combobox', { name: 'Employee' })
const billToSelect = () => screen.getByRole('combobox', { name: 'Track time for' })
const adminCheckbox = () => screen.getByRole('checkbox', { name: /administrative work/i })
const taskBox = () => screen.getByPlaceholderText('Pick a task or type your own')
const detailBox = () => screen.getByRole('textbox', { name: /what did you do|notes/i })

/** Fill the panel in, start the clock, and hand back the running timer. */
function fillAndStart() {
  fireEvent.change(employeeSelect(), { target: { value: MATE } })
  fireEvent.change(clientSelect(), { target: { value: 'client-2' } })
  fireEvent.change(taskBox(), { target: { value: 'Quarter-end tidy-up' } })
  fireEvent.change(detailBox(), { target: { value: 'Reconciled the operating account.' } })
  fireEvent.click(startButton())
}

describe('The capture form after a log', () => {
  it('clears every field once the time is actually saved', async () => {
    render(<Harness />)

    fillAndStart()
    expect(stopButton()).toBeInTheDocument()

    fireEvent.click(stopButton())
    await screen.findByRole('button', { name: /start timer/i })

    // Blank slate: nothing from the entry that was just logged is left behind.
    expect(detailBox()).toHaveValue('')
    expect(taskBox()).toHaveValue('')
    expect(clientSelect()).toHaveValue('client-1')
    expect(employeeSelect()).toHaveValue(ME)
    expect(billToSelect()).toHaveValue('single')
    expect(adminCheckbox()).not.toBeChecked()
  })

  it('starts the next timer with nothing carried over', async () => {
    const starts: TimerState[] = []
    render(<Harness starts={starts} />)

    fillAndStart()
    fireEvent.click(stopButton())
    await screen.findByRole('button', { name: /start timer/i })

    fireEvent.click(startButton())

    expect(starts).toHaveLength(2)
    expect(starts[0].description).toBe('Reconciled the operating account.')
    expect(starts[1]).toMatchObject({
      employeeId: ME,
      clientId: 'client-1',
      description: '',
      taskId: null,
    })
    expect(starts[1].taskLabel).toBeUndefined()
  })

  it('keeps every field when the save is refused', async () => {
    const onStop = vi.fn().mockRejectedValue(new ApiError(409, 'Submit last week first.'))
    render(<Harness onStop={onStop} />)

    fillAndStart()
    fireEvent.click(stopButton())
    await screen.findByText('Submit last week first.')

    // Nothing was logged, so nothing may be thrown away — and the timer is
    // still running with the work on it.
    expect(stopButton()).toBeInTheDocument()
    expect(detailBox()).toHaveValue('Reconciled the operating account.')
    expect(taskBox()).toHaveValue('Quarter-end tidy-up')
    expect(clientSelect()).toHaveValue('client-2')
  })

  it('clears a group block too', async () => {
    render(<Harness />)

    fireEvent.change(billToSelect(), { target: { value: 'group' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Acme Dental' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Bright Books' }))
    fireEvent.change(detailBox(), { target: { value: 'Quarter-end review across the group.' } })
    fireEvent.click(startButton())

    fireEvent.click(stopButton())
    await screen.findByRole('button', { name: /start timer/i })

    expect(billToSelect()).toHaveValue('single')
    expect(detailBox()).toHaveValue('')
    // Back to the single-client form, with no client still ticked behind it.
    expect(screen.queryByRole('checkbox', { name: 'Acme Dental' })).not.toBeInTheDocument()
    expect(clientSelect()).toHaveValue('client-1')
  })

  it('clears after a resumed session is appended', async () => {
    render(<Harness />)

    // Typed in the panel, then a pending entry was resumed instead — stopping
    // that resume still has to leave the panel blank.
    fireEvent.change(taskBox(), { target: { value: 'Quarter-end tidy-up' } })
    fireEvent.change(detailBox(), { target: { value: 'Reconciled the operating account.' } })
    fireEvent.click(screen.getByRole('button', { name: /resume an entry/i }))

    fireEvent.click(stopButton())
    await screen.findByRole('button', { name: /start timer/i })

    expect(detailBox()).toHaveValue('')
    expect(taskBox()).toHaveValue('')
  })
})
