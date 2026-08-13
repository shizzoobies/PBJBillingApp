import { fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ManualEntryModal, TimeCapture } from '../pages/TimePage'
import type { Client, Employee, TimerState } from '../lib/types'

/**
 * "Can you have the client field default to choose client, so it is not
 * accidentally left on the default 1st client option?" — the firm owner,
 * featreq-a4dc9cb3.
 *
 * Every surface that LOGS time opens on a non-selectable "Choose client"
 * placeholder. The danger being designed out is silent: a pre-picked client
 * means a distracted person bills Acme for work they did for Bright Books and
 * nothing on screen ever looked wrong.
 *
 * The placeholder is `disabled`, so it is a starting state and not a choice —
 * once a real client is picked you cannot go back to "nobody".
 */

const ME = 'emp-me'
const NOW = new Date('2026-08-12T15:00:00Z').getTime()

const CLIENTS = [
  { id: 'client-1', name: 'Acme Dental' },
  { id: 'client-2', name: 'Bright Books' },
] as Client[]
const EMPLOYEES = [{ id: ME, name: 'Me', role: 'Bookkeeper' }] as Employee[]

const clientSelect = () => screen.getByRole('combobox', { name: 'Client' })
const startButton = () => screen.getByRole('button', { name: /start timer/i })
const stopButton = () => screen.getByRole('button', { name: /stop & log/i })
const detailBox = () => screen.getByRole('textbox', { name: /what did you do|notes/i })

/** The panel, with whatever timer state the test needs (usually none). */
function CaptureHarness({
  timer: initialTimer = null,
  onStopTimer = vi.fn().mockResolvedValue(undefined),
  onStartTimer = vi.fn(),
}: {
  timer?: TimerState | null
  onStopTimer?: () => Promise<void>
  onStartTimer?: (timer: TimerState) => void
}) {
  const [timer, setTimer] = useState<TimerState | null>(initialTimer)
  return (
    <TimeCapture
      activeEmployeeId={ME}
      clients={CLIENTS}
      checklists={[]}
      templates={[]}
      onGenerateFromTemplate={async () => null}
      employees={EMPLOYEES}
      onStartTimer={(next) => {
        onStartTimer(next)
        setTimer(next)
      }}
      onStopTimer={onStopTimer}
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
  )
}

describe('The timer panel client picker', () => {
  it('opens on "Choose client" rather than the first client', () => {
    render(<CaptureHarness />)

    expect(clientSelect()).toHaveValue('')
    const placeholder = within(clientSelect()).getByRole('option', { name: 'Choose client' })
    expect(placeholder).toBeInTheDocument()
    // Acme Dental is first in the list and must NOT be what's selected.
    expect(clientSelect()).not.toHaveValue('client-1')
  })

  it('will not let you re-pick the placeholder once a client is chosen', () => {
    render(<CaptureHarness />)

    const placeholder = within(clientSelect()).getByRole('option', { name: 'Choose client' })
    expect(placeholder).toBeDisabled()
  })

  it('keeps the client you pick', () => {
    render(<CaptureHarness />)

    fireEvent.change(clientSelect(), { target: { value: 'client-2' } })
    expect(clientSelect()).toHaveValue('client-2')
  })

  /**
   * The client gate on Start predates this change; the placeholder is what makes
   * it reachable. Starting stays deliberately cheap — no task, no detail — but
   * it does need to know who it is for, and the button says so instead of
   * looking broken.
   */
  it('disables Start until a client is picked, then enables it', () => {
    const onStartTimer = vi.fn()
    render(<CaptureHarness onStartTimer={onStartTimer} />)

    expect(startButton()).toBeDisabled()
    expect(startButton()).toHaveAttribute(
      'title',
      'Pick a client first — the field starts on "Choose client".',
    )

    fireEvent.change(clientSelect(), { target: { value: 'client-2' } })
    expect(startButton()).toBeEnabled()

    fireEvent.click(startButton())
    // Started with nothing but the client — no task, no detail. Still free.
    expect(onStartTimer).toHaveBeenCalledTimes(1)
    expect(onStartTimer.mock.calls[0][0]).toMatchObject({
      clientId: 'client-2',
      description: '',
      taskId: null,
    })
  })

  /**
   * Administrative time has no client by definition, so the placeholder can
   * never stand in its way: the picker is not even rendered, and Start works.
   */
  it('is unaffected by the administrative path', () => {
    const onStartTimer = vi.fn()
    render(<CaptureHarness onStartTimer={onStartTimer} />)

    fireEvent.click(screen.getByRole('checkbox', { name: /administrative work/i }))

    expect(screen.queryByRole('combobox', { name: 'Client' })).not.toBeInTheDocument()
    expect(startButton()).toBeEnabled()

    fireEvent.click(startButton())
    expect(onStartTimer.mock.calls[0][0]).toMatchObject({
      clientId: '',
      isAdministrative: true,
    })
  })

  /** Group time bills several clients, so the single picker is irrelevant to it. */
  it('is unaffected by the "bill to multiple clients" path', () => {
    const onStartTimer = vi.fn()
    render(<CaptureHarness onStartTimer={onStartTimer} />)

    fireEvent.change(screen.getByRole('combobox', { name: 'Track time for' }), {
      target: { value: 'group' },
    })
    expect(screen.queryByRole('combobox', { name: 'Client' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Acme Dental' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Bright Books' }))
    expect(startButton()).toBeEnabled()

    fireEvent.click(startButton())
    expect(onStartTimer.mock.calls[0][0]).toMatchObject({
      clientId: '',
      groupClientIds: ['client-1', 'client-2'],
    })
  })

  /**
   * A clientless timer can still arrive here (a resumed group block, an admin
   * timer un-ticked mid-run). Stopping it must read like a prompt, not a stack
   * trace — the required-fields rule shipped in d5ca19c owns the wording.
   */
  it('answers a clientless Stop & log with the friendly prompt, not a raw error', () => {
    const onStopTimer = vi.fn().mockResolvedValue(undefined)
    render(
      <CaptureHarness
        onStopTimer={onStopTimer}
        timer={{
          employeeId: ME,
          clientId: '',
          description: 'Reconciled the operating account.',
          startedAt: NOW - 42 * 60_000,
          taskId: null,
          taskLabel: 'Monthly close',
        }}
      />,
    )

    fireEvent.click(stopButton())

    expect(onStopTimer).not.toHaveBeenCalled()
    expect(screen.getByText('Pick a client to log this time.')).toBeInTheDocument()
    // Nothing was saved, so nothing was lost: the timer is still running.
    expect(stopButton()).toBeEnabled()
    expect(detailBox()).toHaveValue('Reconciled the operating account.')
  })
})

/** Walk the two-step manual modal to its form. */
function openManualForm(onLog = vi.fn().mockResolvedValue(undefined)) {
  render(
    <ManualEntryModal
      activeEmployeeId={ME}
      clients={CLIENTS}
      checklists={[]}
      templates={[]}
      onGenerateFromTemplate={async () => null}
      employees={EMPLOYEES}
      role="employee"
      onLog={onLog}
      onClose={vi.fn()}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: /yes, enter manually/i }))
  return onLog
}

const submitManual = () =>
  fireEvent.click(screen.getByRole('button', { name: /submit for approval/i }))

describe('The manual entry modal client picker', () => {
  it('opens on "Choose client" rather than the first client', () => {
    openManualForm()

    expect(clientSelect()).toHaveValue('')
    expect(
      within(clientSelect()).getByRole('option', { name: 'Choose client' }),
    ).toBeDisabled()
  })

  it('refuses a save with no client, in words a person can act on', () => {
    const onLog = openManualForm()

    fireEvent.change(screen.getByRole('textbox', { name: 'Details' }), {
      target: { value: 'Reconciled the operating account.' },
    })
    submitManual()

    expect(onLog).not.toHaveBeenCalled()
    expect(
      screen.getByText('Select a client, or check "Administrative work".'),
    ).toBeInTheDocument()
  })

  it('saves once a client is picked', async () => {
    const onLog = openManualForm()

    fireEvent.change(clientSelect(), { target: { value: 'client-2' } })
    fireEvent.change(screen.getByPlaceholderText('Pick a task or type your own'), {
      target: { value: 'Monthly close' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Details' }), {
      target: { value: 'Reconciled the operating account.' },
    })
    fireEvent.change(
      screen.getByRole('textbox', {
        name: /why are you entering this manually/i,
      }),
      { target: { value: 'Forgot to start the timer.' } },
    )
    submitManual()

    await screen.findByText('Manual entry submitted — an owner will review it.')
    expect(onLog).toHaveBeenCalledTimes(1)
    expect(onLog.mock.calls[0][0]).toMatchObject({
      clientId: 'client-2',
      taskLabel: 'Monthly close',
    })
  })

  it('is unaffected by the administrative path', async () => {
    const onLog = openManualForm()

    fireEvent.click(screen.getByRole('checkbox', { name: /administrative/i }))
    expect(screen.queryByRole('combobox', { name: 'Client' })).not.toBeInTheDocument()

    fireEvent.change(screen.getByRole('textbox', { name: /notes/i }), {
      target: { value: 'Company meeting.' },
    })
    fireEvent.change(
      screen.getByRole('textbox', {
        name: /why are you entering this manually/i,
      }),
      { target: { value: 'Forgot to start the timer.' } },
    )
    submitManual()

    await screen.findByText('Manual entry submitted — an owner will review it.')
    expect(onLog.mock.calls[0][0]).toMatchObject({ clientId: '', isAdministrative: true })
  })
})
