import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { AppContext, type AppContextValue } from '../AppContext'
import { TopbarTimer } from '../components/TopbarTimer'
import { workableClients } from '../lib/clientLifecycle'
import { createSeedData } from '../lib/seed'
import type { Client, TimerState } from '../lib/types'
import { currentBillingPeriod } from '../lib/utils'
import { installFetchMock, OWNER_SESSION } from './helpers'

/**
 * The GLOBAL time-tracking control in the topbar.
 *
 * The feature's whole claim is continuity: one clock, visible from every
 * screen, still running after you navigate. So the thing worth pinning is not
 * that a button renders — it is that the control is a VIEW over the app-level
 * timer (`App.tsx`'s `timer` + its 1s interval + the `pbj.activeTimer.v1`
 * mirror) rather than a second timer of its own. A parallel implementation
 * would pass a "does it tick?" test and then disagree with the Time page about
 * how long you had been working, which is a billing bug.
 *
 * The second half of the file therefore boots the REAL `<App>`: starting from
 * the bar, ticking, and surviving a route change are only meaningful against
 * the real state, and it is also the only place where `timeTrackingClients` is
 * computed for real — which is what proves a BILLING MASTER cannot be picked
 * here. A master is a payer that holds no work and the server refuses time
 * written against it, so offering one is an invitation to a refusal.
 */

const ME = 'emp-me'

const ACME = { id: 'client-acme', name: 'Acme Dental' } as unknown as Client
const MASTER = {
  id: 'client-klc-master',
  name: 'KLC Master',
  isBillingMaster: true,
} as unknown as Client
const ALL_CLIENTS = [ACME, MASTER]

/** Reads the pathname the control navigated to. */
function LocationProbe() {
  const location = useLocation()
  return <output aria-label="path">{location.pathname}</output>
}

/** The slice of the workspace the control reads, with whatever locks a case needs. */
function workspace(timesheetLocks: { userId: string; period: string }[] = []) {
  return { clients: ALL_CLIENTS, checklists: [], checklistTemplates: [], timesheetLocks }
}

function renderControl(
  overrides: Partial<AppContextValue> = {},
  initialPath = '/dashboard',
) {
  const value = {
    activeEmployeeId: ME,
    data: workspace(),
    previewMode: false,
    role: 'employee',
    startTimer: vi.fn(),
    // Exactly what App hands down: the work-pickable list, masters removed.
    timeTrackingClients: workableClients(ALL_CLIENTS),
    timer: null,
    timerElapsed: '0:00',
    ...overrides,
  } as unknown as AppContextValue

  render(
    <AppContext.Provider value={value}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <TopbarTimer />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </AppContext.Provider>,
  )
  return value
}

function running(overrides: Partial<TimerState> = {}): TimerState {
  return {
    employeeId: ME,
    clientId: ACME.id,
    description: '',
    startedAt: Date.now() - 60_000,
    ...overrides,
  }
}

const startControl = () => screen.getByRole('button', { name: /start timer/i })
const runningControl = () => screen.getByRole('button', { name: /timer running/i })

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('the topbar time-tracking control', () => {
  // "Available on every screen" is the acceptance criterion, and the control
  // reads nothing off the route, so this is really a statement that it is
  // route-independent — which is why it is mounted under two of them.
  it.each(['/dashboard', '/clients', '/checklists'])('is offered on %s', (path) => {
    renderControl({}, path)
    expect(startControl()).toBeInTheDocument()
  })

  it('opens the start modal when clicked', () => {
    renderControl()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.click(startControl())

    expect(screen.getByRole('dialog', { name: /start a timer/i })).toBeInTheDocument()
  })

  /*
   * The invariant that arrived with consolidated billing. `timeTrackingClients`
   * is already master-free, so what this really pins is that the modal picks
   * its options from THAT list and never re-derives its own from `data.clients`
   * — the mistake every new client dropdown is one line away from making.
   */
  it('never offers a billing master in the picker', () => {
    renderControl()
    fireEvent.click(startControl())

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('option', { name: 'Acme Dental' })).toBeInTheDocument()
    expect(within(dialog).queryByRole('option', { name: 'KLC Master' })).not.toBeInTheDocument()
  })

  it('starts the entry through the shared startTimer, then closes', () => {
    const value = renderControl()
    fireEvent.click(startControl())

    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Client'), { target: { value: ACME.id } })
    fireEvent.click(within(dialog).getByRole('button', { name: /start timer/i }))

    expect(value.startTimer).toHaveBeenCalledTimes(1)
    expect(value.startTimer).toHaveBeenCalledWith(
      expect.objectContaining({
        employeeId: ME,
        clientId: ACME.id,
        isAdministrative: false,
        taskId: null,
      }),
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  // Starting is FREE apart from knowing who the time is for, exactly as it is
  // on the Time page: a client, or the administrative tick that stands in for
  // one. Nothing may start without one of the two.
  it('will not start until there is a client (or administrative work)', () => {
    const value = renderControl()
    fireEvent.click(startControl())

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('button', { name: /start timer/i })).toBeDisabled()

    fireEvent.click(within(dialog).getByRole('checkbox', { name: /administrative work/i }))

    // No client, and therefore no task — the same rule the Time page applies.
    expect(within(dialog).queryByLabelText('Client')).not.toBeInTheDocument()
    expect(within(dialog).queryByLabelText('Task')).not.toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: /start timer/i }))
    expect(value.startTimer).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: '', isAdministrative: true }),
    )
  })

  it('shows the elapsed time and what is being timed while it runs', () => {
    renderControl({ timer: running(), timerElapsed: '12:34' })

    expect(runningControl()).toHaveTextContent('12:34')
    expect(runningControl()).toHaveTextContent('Acme Dental')
  })

  it('labels administrative work rather than guessing a client', () => {
    renderControl({ timer: running({ clientId: '', isAdministrative: true }) })
    expect(runningControl()).toHaveTextContent('Administrative')
  })

  // Stopping needs the required-field prompts, which live on the Time page's
  // timer panel — so the running control is a route there, not a second Stop.
  it('opens the Time page when the running timer is clicked', () => {
    renderControl({ timer: running() }, '/clients')
    expect(screen.getByLabelText('path')).toHaveTextContent('/clients')

    fireEvent.click(runningControl())

    expect(screen.getByLabelText('path')).toHaveTextContent('/time')
  })

  // The same two gates the Time page's own panel applies. Preview mode matters
  // most: `startTimer` is a no-op there, so an enabled button would look alive
  // and do nothing.
  it('cannot start while previewing another user', () => {
    renderControl({ previewMode: true })
    expect(startControl()).toBeDisabled()
  })

  it('cannot start while this month’s timesheet is locked', () => {
    renderControl({
      data: workspace([{ userId: ME, period: currentBillingPeriod() }]),
    } as unknown as Partial<AppContextValue>)
    expect(startControl()).toBeDisabled()
  })

  it('still lets an owner start when a lock exists for them', () => {
    renderControl({
      role: 'owner',
      data: workspace([{ userId: ME, period: currentBillingPeriod() }]),
    } as unknown as Partial<AppContextValue>)
    expect(startControl()).toBeEnabled()
  })

  /*
   * The task box is the shared pick-or-type field, so a name that is NOT one of
   * the client's real tasks has to travel as `taskLabel` rather than be dropped.
   * Losing it here would leave a running timer whose task box reads blank on the
   * Time page — and the task is required before the time can be logged.
   */
  it('carries a typed task name onto the timer', () => {
    const value = renderControl()
    fireEvent.click(startControl())

    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Client'), { target: { value: ACME.id } })
    fireEvent.change(within(dialog).getByLabelText('Task'), {
      target: { value: 'Quarterly cleanup' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: /start timer/i }))

    expect(value.startTimer).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: null, taskLabel: 'Quarterly cleanup' }),
    )
  })
})

/**
 * Against the real `<App>`: one clock, started from the bar, still ticking
 * after a route change. Fake timers run with `shouldAdvanceTime` so the boot
 * fetches still settle; the tick assertions therefore compare DIRECTION (the
 * clock moved forward by at least what we advanced) rather than an exact
 * string, which would be hostage to a millisecond of real drift.
 */
describe('the running timer across navigation', () => {
  /** Elapsed seconds as the topbar is currently displaying them. */
  function displayedSeconds(): number {
    const text = runningControl().textContent ?? ''
    const match = /(\d+):(\d{2})/.exec(text)
    if (!match) throw new Error(`no elapsed time in "${text}"`)
    return Number(match[1]) * 60 + Number(match[2])
  }

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    window.localStorage.clear()
    window.history.pushState({}, '', '/dashboard')

    const appData = createSeedData()
    appData.clients = [
      ...appData.clients,
      { ...appData.clients[0], id: MASTER.id, name: MASTER.name, isBillingMaster: true },
    ]
    installFetchMock({ sessionUser: OWNER_SESSION, appData })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts from any screen, ticks, and survives navigating away', async () => {
    render(<App />)
    // The dashboard, not the Time page — the point of the feature.
    await screen.findByRole('link', { name: 'Time' })
    fireEvent.click(startControl())

    const dialog = screen.getByRole('dialog', { name: /start a timer/i })
    const picker = within(dialog).getByLabelText('Client')
    // The workspace arrives over fetch, so the picker fills a tick later. Wait
    // for the real clients rather than the lone "Choose client" placeholder.
    await waitFor(() => expect(within(picker).getAllByRole('option').length).toBeGreaterThan(1))
    // Computed by App for real, so this is the live master-free list.
    expect(within(dialog).queryByRole('option', { name: MASTER.name })).not.toBeInTheDocument()

    const firstClient = within(picker).getAllByRole('option')[1] as HTMLOptionElement
    fireEvent.change(picker, { target: { value: firstClient.value } })
    fireEvent.click(within(dialog).getByRole('button', { name: /start timer/i }))

    await waitFor(() => expect(runningControl()).toBeInTheDocument())
    const started = displayedSeconds()

    await vi.advanceTimersByTimeAsync(3000)
    const afterTick = displayedSeconds()
    expect(afterTick).toBeGreaterThanOrEqual(started + 3)

    // Leave the page it was started from — the clock has to come along.
    fireEvent.click(screen.getByRole('link', { name: 'Checklists' }))
    await waitFor(() => expect(window.location.pathname).toBe('/checklists'))
    expect(runningControl()).toBeInTheDocument()

    await vi.advanceTimersByTimeAsync(3000)
    expect(displayedSeconds()).toBeGreaterThanOrEqual(afterTick + 3)
  })
})
