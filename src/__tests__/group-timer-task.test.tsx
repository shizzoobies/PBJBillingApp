import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { TimeCapture } from '../pages/TimePage'
import { createSeedData } from '../lib/seed'
import {
  ApiError,
  type ChecklistTemplate,
  type Client,
  type Employee,
  type TimerState,
} from '../lib/types'
import { installFetchMock, OWNER_SESSION } from './helpers'

/**
 * A GROUP timer ("Track time for: A group (split for billing later)") carries a
 * task, and Stop & log asks for it exactly as it does for a single-client timer
 * (the owner's decision, featreq-c11c63ea). Starting stays instant: the task box
 * can be filled in before or after Start, and only the stop is gated.
 *
 * The first half drives the Time page's panel directly. The second half boots
 * the real `<App>` to pin what only it owns: the stop payload sent to the
 * server, and the running timer surviving a reload through localStorage.
 */

const ME = 'emp-me'
const NOW = new Date('2026-08-12T15:00:00Z').getTime()
const STARTED_AT = NOW - 42 * 60_000
const TASK_SENTENCE = 'Pick or type a task to log this time.'

const CLIENTS = [
  { id: 'client-1', name: 'Acme Dental' },
  { id: 'client-2', name: 'Bright Books' },
] as Client[]
const EMPLOYEES = [{ id: ME, name: 'Me', role: 'Bookkeeper' }] as Employee[]
const TEMPLATES = [
  { id: 'tpl-payroll', title: 'Payroll', isStandard: true },
  { id: 'tpl-close', title: 'Month-end close', isStandard: true },
  { id: 'tpl-client-only', title: 'Acme only blueprint', isStandard: false, clientId: 'client-1' },
] as unknown as ChecklistTemplate[]

function groupTimer(overrides: Partial<TimerState> = {}): TimerState {
  return {
    employeeId: ME,
    clientId: '',
    description: 'Quarter-end review across the group.',
    startedAt: STARTED_AT,
    taskId: null,
    groupClientIds: ['client-1', 'client-2'],
    ...overrides,
  }
}

/** Owns the timer the way App does: Start installs it, `onUpdateTimer` patches it. */
function Harness({
  initial = null,
  onStopTimer = vi.fn().mockResolvedValue(undefined),
  starts = [],
}: {
  initial?: TimerState | null
  onStopTimer?: () => Promise<void>
  starts?: TimerState[]
}) {
  const [timer, setTimer] = useState<TimerState | null>(initial)
  const elapsed = timer ? `${Math.round((NOW - timer.startedAt) / 60_000)}m` : '0:00'
  return (
    <TimeCapture
      activeEmployeeId={ME}
      clients={CLIENTS}
      checklists={[]}
      templates={TEMPLATES}
      onGenerateFromTemplate={async () => null}
      employees={EMPLOYEES}
      onStartTimer={(next) => {
        starts.push(next)
        setTimer({ ...next, startedAt: STARTED_AT })
      }}
      onStopTimer={async () => {
        await onStopTimer()
        setTimer(null)
      }}
      onUpdateTimer={(patch) => setTimer((current) => (current ? { ...current, ...patch } : current))}
      onCancelTimer={vi.fn()}
      role="employee"
      timer={timer}
      timerElapsed={elapsed}
      locked={false}
      previewMode={false}
      currentPeriod="2026-08"
    />
  )
}

const stopButton = () => screen.getByRole('button', { name: /stop & log/i })
const startButton = () => screen.getByRole('button', { name: /start timer/i })
const taskBox = () => screen.getByPlaceholderText('Pick a task or type your own')
const billToSelect = () => screen.getByRole('combobox', { name: 'Track time for' })

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

describe('the group timer task box', () => {
  function pickGroup() {
    fireEvent.change(billToSelect(), { target: { value: 'group' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Acme Dental' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Bright Books' }))
  }

  it('shows a pick-or-type task box in group mode, offering the standard tasks only', () => {
    render(<Harness />)
    pickGroup()

    const box = taskBox()
    const listId = box.getAttribute('list') ?? ''
    const offered = Array.from(document.querySelectorAll(`datalist#${listId} option`)).map(
      (option) => option.getAttribute('value'),
    )
    // One client's own blueprint is not a task for a block spanning several.
    expect(offered).toEqual(['Month-end close', 'Payroll'])
  })

  it('starts instantly with no task, and nothing is nagged before a stop', () => {
    const starts: TimerState[] = []
    render(<Harness starts={starts} />)
    pickGroup()

    fireEvent.click(startButton())
    expect(starts).toHaveLength(1)
    expect(starts[0].groupClientIds).toEqual(['client-1', 'client-2'])
    expect(starts[0].taskLabel).toBeUndefined()
    expect(screen.queryByText(TASK_SENTENCE)).not.toBeInTheDocument()
  })

  it('carries a task typed before Start onto the running timer', () => {
    const starts: TimerState[] = []
    render(<Harness starts={starts} />)
    pickGroup()

    fireEvent.change(taskBox(), { target: { value: 'Payroll' } })
    fireEvent.click(startButton())
    expect(starts[0].taskLabel).toBe('Payroll')
    expect(starts[0].taskId).toBeNull()
    expect(taskBox()).toHaveValue('Payroll')
  })

  it('blocks Stop & log without a task, with the single-client sentence, and loses no time', () => {
    const onStopTimer = vi.fn().mockResolvedValue(undefined)
    render(<Harness initial={groupTimer()} onStopTimer={onStopTimer} />)

    fireEvent.click(stopButton())
    expect(onStopTimer).not.toHaveBeenCalled()
    expect(screen.getByText(TASK_SENTENCE)).toBeInTheDocument()
    expect(screen.getByText('42m')).toBeInTheDocument()
  })

  it('treats a blank-looking task as no task', () => {
    const onStopTimer = vi.fn().mockResolvedValue(undefined)
    render(<Harness initial={groupTimer({ taskLabel: '   ' })} onStopTimer={onStopTimer} />)

    fireEvent.click(stopButton())
    expect(onStopTimer).not.toHaveBeenCalled()
    expect(screen.getByText(TASK_SENTENCE)).toBeInTheDocument()
  })

  it('lets the stop through the moment a task is typed while the timer runs', () => {
    const onStopTimer = vi.fn().mockResolvedValue(undefined)
    render(<Harness initial={groupTimer()} onStopTimer={onStopTimer} />)

    fireEvent.click(stopButton())
    expect(onStopTimer).not.toHaveBeenCalled()

    fireEvent.change(taskBox(), { target: { value: 'Payroll' } })
    expect(screen.queryByText(TASK_SENTENCE)).not.toBeInTheDocument()
    fireEvent.click(stopButton())
    expect(onStopTimer).toHaveBeenCalledTimes(1)
  })

  it('shows the server refusal of a stale page inline, never in an alert', async () => {
    const alert = vi.fn()
    vi.stubGlobal('alert', alert)
    // What a page loaded before the Task box existed is told by the server.
    const refusal =
      "Time can't be logged without a task. Add it and log it again. " +
      "If you don't see a Task box, refresh the page. Your timer is kept."
    const onStopTimer = vi.fn().mockRejectedValue(new ApiError(400, refusal))
    render(<Harness initial={groupTimer({ taskLabel: 'Payroll' })} onStopTimer={onStopTimer} />)

    fireEvent.click(stopButton())
    expect(await screen.findByText(refusal)).toBeInTheDocument()
    expect(alert).not.toHaveBeenCalled()
    // The timer is still running: nothing was lost.
    expect(screen.getByText('42m')).toBeInTheDocument()
  })

  it('does not carry a checklist from a client picked before switching to a group', () => {
    render(<Harness />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Client' }), {
      target: { value: 'client-1' },
    })
    pickGroup()
    expect(taskBox()).toHaveValue('')
    // One Task box in group mode: the single-client picker is gone.
    expect(screen.getAllByPlaceholderText('Pick a task or type your own')).toHaveLength(1)
  })

  it('leaves the single-client timer exactly as it was', () => {
    const onStopTimer = vi.fn().mockResolvedValue(undefined)
    render(
      <Harness
        initial={{
          employeeId: ME,
          clientId: 'client-1',
          description: 'Reconciled the operating account.',
          startedAt: STARTED_AT,
          taskId: null,
        }}
        onStopTimer={onStopTimer}
      />,
    )
    fireEvent.click(stopButton())
    expect(onStopTimer).not.toHaveBeenCalled()
    expect(screen.getByText(TASK_SENTENCE)).toBeInTheDocument()

    fireEvent.change(taskBox(), { target: { value: 'Monthly close' } })
    fireEvent.click(stopButton())
    expect(onStopTimer).toHaveBeenCalledTimes(1)
  })
})

/**
 * The real `<App>`: the stop payload for a group timer, and the localStorage
 * mirror (`pbj.activeTimer.v1`) that keeps a running timer across a reload.
 */
describe('the group timer in the app', () => {
  const TIMER_KEY = 'pbj.activeTimer.v1'
  type Posted = Record<string, unknown>
  let posted: Posted[]

  beforeEach(() => {
    posted = []
    window.localStorage.clear()
    window.history.pushState({}, '', '/time')
    installFetchMock({
      sessionUser: OWNER_SESSION,
      appData: createSeedData(),
      extraRoutes: [
        (path, method, body) => {
          if (path.endsWith('/api/time-entries') && method === 'POST') {
            posted.push(body as Posted)
            return new Response(JSON.stringify({ ...(body as Posted), id: 'time-new', approvalStatus: 'approved' }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
          }
          return undefined
        },
      ],
    })
  })

  const saveTimer = (timer: Record<string, unknown>) => {
    const ids = createSeedData()
      .clients.slice(0, 2)
      .map((client) => client.id)
    window.localStorage.setItem(
      TIMER_KEY,
      JSON.stringify({
        employeeId: OWNER_SESSION.id,
        clientId: '',
        description: 'Quarter-end review across the group.',
        startedAt: Date.now() - 10 * 60_000,
        taskId: null,
        groupClientIds: ids,
        ...timer,
      }),
    )
    return ids
  }

  it('sends the typed task with the stop, as a label, and no task id', async () => {
    const ids = saveTimer({ taskLabel: 'Payroll' })
    render(<App />)

    const box = await screen.findByPlaceholderText('Pick a task or type your own')
    // A reload keeps the task that was saved with the running timer.
    expect(box).toHaveValue('Payroll')

    fireEvent.click(await screen.findByRole('button', { name: /stop & log/i }))
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toMatchObject({
      clientId: '',
      groupClientIds: ids,
      taskId: null,
      taskLabel: 'Payroll',
      entryMethod: 'timer',
      billable: false,
    })
  })

  it('trims what was typed on the way to the server', async () => {
    saveTimer({ taskLabel: '  Payroll  ' })
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /stop & log/i }))
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0].taskLabel).toBe('Payroll')
  })

  it('still loads a group timer saved before it had a task, and asks for one at the stop', async () => {
    // The old shape: no `taskLabel` key at all.
    saveTimer({})
    render(<App />)

    const box = await screen.findByPlaceholderText('Pick a task or type your own')
    expect(box).toHaveValue('')

    fireEvent.click(await screen.findByRole('button', { name: /stop & log/i }))
    expect(await screen.findByText(TASK_SENTENCE)).toBeInTheDocument()
    expect(posted).toHaveLength(0)

    fireEvent.change(box, { target: { value: 'Payroll' } })
    // The mirror follows the running timer, so a reload now keeps the task.
    await waitFor(() => {
      const saved = JSON.parse(window.localStorage.getItem(TIMER_KEY) ?? '{}') as TimerState
      expect(saved.taskLabel).toBe('Payroll')
    })
    fireEvent.click(await screen.findByRole('button', { name: /stop & log/i }))
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0].taskLabel).toBe('Payroll')
  })

  it('shows the task on the unsplit block in Recent time', async () => {
    const appData = createSeedData()
    const today = new Date()
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    appData.timeEntries = [
      {
        id: 'time-hold',
        employeeId: OWNER_SESSION.id,
        clientId: '',
        isAdministrative: false,
        date,
        minutes: 30,
        category: 'General',
        description: 'Payroll run for both clients',
        billable: false,
        taskId: null,
        taskLabel: 'Payroll',
        approvalStatus: 'approved',
        entryMethod: 'timer',
        groupClientIds: appData.clients.slice(0, 2).map((client) => client.id),
      } as unknown as (typeof appData.timeEntries)[number],
    ]
    installFetchMock({ sessionUser: OWNER_SESSION, appData })
    render(<App />)

    expect(await screen.findByText('Needs split')).toBeInTheDocument()
    expect(screen.getByText('Task: Payroll')).toBeInTheDocument()
  })
})
