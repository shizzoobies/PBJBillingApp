import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { TimeCapture } from '../pages/TimePage'
import type { Client, Employee, TimerState } from '../lib/types'

/**
 * The "Ad hoc" tick on the timer panel.
 *
 * This flag decides how the time BILLS — its own invoice line at the person's
 * rate, instead of inside the client's monthly hours — so the answer has to
 * reach the running timer, not sit in a local box that a refresh throws away.
 * These pin that ticking it mid-run patches the timer itself (which is what
 * persists it and what the stop reads), and that administrative time, which has
 * no client to be outside the scope of, never offers the choice at all.
 */

const ME = 'emp-me'
const NOW = new Date('2026-08-12T15:00:00Z').getTime()

const CLIENTS = [{ id: 'client-1', name: 'Acme Dental' }] as Client[]
const EMPLOYEES = [{ id: ME, name: 'Me', role: 'Bookkeeper' }] as Employee[]

/** Owns the timer the way App does, so a patch really changes it. */
function Harness({ timer: initialTimer }: { timer: TimerState | null }) {
  const [timer, setTimer] = useState<TimerState | null>(initialTimer)
  return (
    <>
      <TimeCapture
        activeEmployeeId={ME}
        clients={CLIENTS}
        checklists={[]}
        templates={[]}
        onGenerateFromTemplate={async () => null}
        employees={EMPLOYEES}
        onStartTimer={vi.fn()}
        onStopTimer={vi.fn()}
        onUpdateTimer={(patch) =>
          setTimer((current) => (current ? { ...current, ...patch } : current))
        }
        onCancelTimer={vi.fn()}
        role="employee"
        timer={timer}
        timerElapsed="42m"
        locked={false}
        previewMode={false}
        currentPeriod="2026-08"
      />
      {/* What the timer actually holds — the thing the stop will read. */}
      <output data-testid="timer-adhoc">{String(Boolean(timer?.isAdhoc))}</output>
    </>
  )
}

function runningTimer(overrides: Partial<TimerState> = {}): TimerState {
  return {
    employeeId: ME,
    clientId: 'client-1',
    description: 'Reconciled the operating account',
    startedAt: NOW - 42 * 60_000,
    taskId: null,
    taskLabel: 'Monthly close',
    ...overrides,
  }
}

const adhocBox = () => screen.getByRole('checkbox', { name: /ad hoc \(outside scoped work\)/i })
const adminBox = () => screen.getByRole('checkbox', { name: /administrative work/i })

describe('the Ad hoc tick on the timer panel', () => {
  it('is offered, and off, before anything is timed', () => {
    render(<Harness timer={null} />)
    expect(adhocBox()).not.toBeChecked()
  })

  it('patches the RUNNING timer when ticked mid-run', () => {
    render(<Harness timer={runningTimer()} />)

    fireEvent.click(adhocBox())

    expect(screen.getByTestId('timer-adhoc')).toHaveTextContent('true')
    expect(adhocBox()).toBeChecked()
  })

  it('reads its state back off a timer that was already flagged', () => {
    render(<Harness timer={runningTimer({ isAdhoc: true })} />)
    expect(adhocBox()).toBeChecked()
  })

  it('can be taken back off mid-run', () => {
    render(<Harness timer={runningTimer({ isAdhoc: true })} />)

    fireEvent.click(adhocBox())

    expect(screen.getByTestId('timer-adhoc')).toHaveTextContent('false')
  })

  // Administrative time has no client, so there is no scope for it to be
  // outside of — the same rule the server enforces on create and edit.
  it('disappears once the work is marked administrative', () => {
    render(<Harness timer={null} />)
    expect(adhocBox()).toBeInTheDocument()

    fireEvent.click(adminBox())

    expect(
      screen.queryByRole('checkbox', { name: /ad hoc \(outside scoped work\)/i }),
    ).not.toBeInTheDocument()
  })
})
