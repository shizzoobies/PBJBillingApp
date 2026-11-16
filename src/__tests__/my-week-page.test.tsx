import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MyWeekPage } from '../pages/MyWeekPage'
import type { AppContextValue } from '../AppContext'
import type { AppData } from '../lib/types'

/**
 * The My Week page (featreq-f0e8046b). Brittany: "Lisa would sort her own
 * schedule ... and she could pick the day she wanted to touch them"; "she could
 * move it to a sent questions que that we could say revisit end of day".
 *
 * What the page owes: it lists the person's clients with open work, lets her
 * put a client on days, note it and set a status on each TASK; it saves the
 * whole row each time; it never shows another week's plan under this week; and
 * while an owner previews someone it changes nothing.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))
// Only today's date is pinned; the rest of the firm's calendar helpers are the real ones.
vi.mock('../../lib/firm-time.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  firmToday: () => '2026-11-17',
}))
vi.mock('../lib/api', () => ({
  fetchWeekPlanRequest: vi.fn(),
  saveWeekPlanEntryRequest: vi.fn(),
}))

import { fetchWeekPlanRequest, saveWeekPlanEntryRequest } from '../lib/api'

const mockFetch = vi.mocked(fetchWeekPlanRequest)
const mockSave = vi.mocked(saveWeekPlanEntryRequest)

const LISA = 'emp-lisa'
const WEEK = '2026-11-16'

const step = (id: string, done: boolean) => ({ id, label: id, done })
const checklist = (id: string, clientId: string, title: string, dueDate: string, extra = {}) => ({
  id,
  title,
  clientId,
  assigneeId: LISA,
  dueDate,
  viewerIds: [],
  editorIds: [],
  items: [step('a', true), step('b', false)],
  ...extra,
})

const data = {
  clients: [
    { id: 'c-acme', name: 'Acme Dental' },
    { id: 'c-bright', name: 'Bright Books' },
    { id: 'c-old', name: 'Old Client', lifecycleStage: 'inactive' },
  ],
  employees: [{ id: LISA, name: 'Lisa', role: 'Bookkeeper' }],
  checklists: [
    checklist('chk-close', 'c-acme', 'Monthly close', '2026-11-30'),
    checklist('chk-payroll', 'c-acme', 'Payroll', '2026-11-18'),
    checklist('chk-bright', 'c-bright', 'Sales tax', '2026-11-10'),
    checklist('chk-old', 'c-old', 'Wind down', '2026-11-20'),
    checklist('chk-other', 'c-bright', 'Not hers', '2026-11-20', { assigneeId: 'emp-allison' }),
  ],
} as unknown as AppData

let contextValue: AppContextValue

const entry = (clientId: string, over: Record<string, unknown> = {}) => ({
  clientId,
  plannedDays: [],
  note: '',
  taskMarks: {},
  updatedAt: null,
  ...over,
})

beforeEach(() => {
  mockFetch.mockReset()
  mockSave.mockReset()
  mockFetch.mockResolvedValue({ weekStart: WEEK, userId: LISA, entries: [] })
  mockSave.mockImplementation(async (clientId, body) => ({
    weekStart: body.weekStart,
    entry: entry(clientId, { plannedDays: body.plannedDays, note: body.note }),
  }))
  contextValue = {
    data,
    activeEmployeeId: LISA,
    previewMode: false,
  } as unknown as AppContextValue
})

const page = () => (
  <MemoryRouter initialEntries={['/my-week']}>
    <MyWeekPage />
  </MemoryRouter>
)

const row = (clientName: string) =>
  screen.getByRole('link', { name: clientName }).closest('.my-week-row') as HTMLElement
const dayColumn = (name: RegExp) => screen.getByRole('listitem', { name })
const dayButton = (clientName: string, day: RegExp) =>
  within(screen.getByRole('group', { name: `Days for ${clientName}` })).getByRole('button', { name: day })

describe('My Week: what it shows', () => {
  it('asks for her own week, this week, and lists her clients with open work', async () => {
    render(page())
    await screen.findByText('My clients this week')
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch.mock.calls[0][0]).toBe(WEEK)
    // Her own: nobody is named.
    expect(mockFetch.mock.calls[0][1]).toBeNull()

    expect(screen.getByRole('link', { name: 'Acme Dental' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Bright Books' })).toBeInTheDocument()
    // An inactive client and someone else's task are not her week.
    expect(screen.queryByText('Old Client')).not.toBeInTheDocument()
    expect(screen.queryByText('Not hers')).not.toBeInTheDocument()
    expect(screen.getByText('2 clients not planned this week')).toBeInTheDocument()
    expect(screen.getByText(/Week of Nov 16 to Nov 20, 2026/)).toBeInTheDocument()
  })

  it('lists each task under its client with its due date and progress', async () => {
    render(page())
    await screen.findByText('My clients this week')
    const acme = within(row('Acme Dental'))
    expect(acme.getByRole('link', { name: 'Payroll' })).toHaveAttribute('href', '/checklists?focus=chk-payroll')
    expect(acme.getByText('Due this week, Nov 18')).toBeInTheDocument()
    expect(acme.getByText('Due Nov 30')).toBeInTheDocument()
    expect(acme.getAllByText('1 of 2 done')).toHaveLength(2)
    expect(within(row('Bright Books')).getByText('Overdue, was due Nov 10')).toBeInTheDocument()
    expect(acme.getByText('2 not planned')).toBeInTheDocument()
  })

  it('shows Monday to Friday with today marked, and the plan she already saved', async () => {
    mockFetch.mockResolvedValue({
      weekStart: WEEK,
      userId: LISA,
      entries: [entry('c-acme', { plannedDays: ['2026-11-18'], note: 'bank feed first' })],
    })
    render(page())
    await screen.findByText('My clients this week')
    expect(screen.getAllByRole('listitem', { name: /day Nov/ })).toHaveLength(5)
    expect(dayColumn(/^Tuesday Nov 17$/)).toHaveClass('is-today')
    expect(within(dayColumn(/^Wednesday Nov 18$/)).getByText('Acme Dental')).toBeInTheDocument()
    expect(within(dayColumn(/^Wednesday Nov 18$/)).getByText('2 to work on')).toBeInTheDocument()
    expect(within(dayColumn(/^Monday Nov 16$/)).getByText('Nothing planned')).toBeInTheDocument()
    expect(dayButton('Acme Dental', /^Wednesday/)).toHaveAttribute('aria-pressed', 'true')
    expect(dayButton('Acme Dental', /^Monday/)).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByLabelText('Note for Acme Dental')).toHaveValue('bank feed first')
    expect(screen.getByText('1 client not planned this week')).toBeInTheDocument()
  })

  it('says so when there is nothing to plan', async () => {
    contextValue = { ...contextValue, data: { ...data, checklists: [] } } as unknown as AppContextValue
    render(page())
    expect(await screen.findByText('No open work due this month. Nothing to plan.')).toBeInTheDocument()
    expect(screen.queryByText('My clients this week')).not.toBeInTheDocument()
  })

  it('shows the reason when the week cannot be loaded, and no plan', async () => {
    mockFetch.mockRejectedValue(new Error('Could not load the week (500)'))
    render(page())
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the week (500)')
    expect(screen.queryByText('My clients this week')).not.toBeInTheDocument()
  })
})

describe('My Week: planning', () => {
  it('putting a client on a day saves the whole row and shows it on that day at once', async () => {
    render(page())
    await screen.findByText('My clients this week')
    fireEvent.click(dayButton('Acme Dental', /^Thursday/))

    expect(within(dayColumn(/^Thursday Nov 19$/)).getByText('Acme Dental')).toBeInTheDocument()
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    expect(mockSave).toHaveBeenCalledWith('c-acme', {
      weekStart: WEEK,
      plannedDays: ['2026-11-19'],
      note: '',
      taskMarks: {},
    })
    expect(screen.getByText('1 client not planned this week')).toBeInTheDocument()
    expect(within(row('Acme Dental')).getByText('2 planned')).toBeInTheDocument()
  })

  it('a client does not jump down the list the moment she plans it', async () => {
    render(page())
    await screen.findByText('My clients this week')
    const order = () =>
      Array.from(document.querySelectorAll('.my-week-row .client-name-link')).map((link) => link.textContent)
    expect(order()).toEqual(['Acme Dental', 'Bright Books'])
    // Acme is now started and Bright is not: a fresh sort would put Bright first.
    fireEvent.click(dayButton('Acme Dental', /^Monday/))
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    expect(order()).toEqual(['Acme Dental', 'Bright Books'])
    // The gold "not started" edge still follows what she has done.
    expect(row('Acme Dental')).not.toHaveClass('is-not-started')
    expect(row('Bright Books')).toHaveClass('is-not-started')
  })

  it('opens with the clients she has not started first', async () => {
    mockFetch.mockResolvedValue({
      weekStart: WEEK,
      userId: LISA,
      entries: [entry('c-acme', { plannedDays: ['2026-11-18'] })],
    })
    render(page())
    await screen.findByText('My clients this week')
    expect(
      Array.from(document.querySelectorAll('.my-week-row .client-name-link')).map((link) => link.textContent),
    ).toEqual(['Bright Books', 'Acme Dental'])
  })

  it('a client can be on more than one day, and a second click takes a day off', async () => {
    render(page())
    await screen.findByText('My clients this week')
    fireEvent.click(dayButton('Acme Dental', /^Monday/))
    fireEvent.click(dayButton('Acme Dental', /^Friday/))
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(2))
    expect(mockSave.mock.calls[1][1].plannedDays).toEqual(['2026-11-16', '2026-11-20'])

    fireEvent.click(dayButton('Acme Dental', /^Monday/))
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(3))
    expect(mockSave.mock.calls[2][1].plannedDays).toEqual(['2026-11-20'])
    expect(within(dayColumn(/^Monday Nov 16$/)).queryByText('Acme Dental')).not.toBeInTheDocument()
  })

  it('saves the note when she leaves the box, and not when nothing changed', async () => {
    render(page())
    await screen.findByText('My clients this week')
    const note = screen.getByLabelText('Note for Bright Books')
    fireEvent.focus(note)
    fireEvent.change(note, { target: { value: '  call them  about the 1099s ' } })
    fireEvent.blur(note)
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    expect(mockSave).toHaveBeenCalledWith('c-bright', {
      weekStart: WEEK,
      plannedDays: [],
      note: 'call them about the 1099s',
      taskMarks: {},
    })

    fireEvent.focus(note)
    fireEvent.blur(note)
    expect(mockSave).toHaveBeenCalledTimes(1)
  })

  it('the status is set on each TASK: one in questions, the other still to work on', async () => {
    mockFetch.mockResolvedValue({
      weekStart: WEEK,
      userId: LISA,
      entries: [entry('c-acme', { plannedDays: ['2026-11-17'] })],
    })
    render(page())
    await screen.findByText('My clients this week')
    fireEvent.change(screen.getByLabelText('Status of Payroll'), { target: { value: 'questions' } })

    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    expect(mockSave).toHaveBeenCalledWith('c-acme', {
      weekStart: WEEK,
      plannedDays: ['2026-11-17'],
      note: '',
      taskMarks: { 'chk-payroll': { status: 'questions', note: '' } },
    })
    expect(screen.getByLabelText('Status of Payroll')).toHaveValue('questions')
    expect(screen.getByLabelText('Status of Monthly close')).toHaveValue('work')
    expect(within(row('Acme Dental')).getByText('1 planned, 1 in questions')).toBeInTheDocument()
    // One task is still live, so the client is not greyed on its day.
    expect(within(dayColumn(/^Tuesday Nov 17$/)).getByText('1 to work on')).toBeInTheDocument()

    const sent = screen.getByRole('region', { name: 'Sent questions' })
    expect(within(sent).getByText('Acme Dental')).toBeInTheDocument()
    expect(within(sent).getByText('Payroll')).toBeInTheDocument()
  })

  it('greys a client on its day only when every task is in questions or finished', async () => {
    mockFetch.mockResolvedValue({
      weekStart: WEEK,
      userId: LISA,
      entries: [
        entry('c-acme', {
          plannedDays: ['2026-11-17'],
          taskMarks: {
            'chk-payroll': { status: 'questions', note: '' },
            'chk-close': { status: 'finished', note: '' },
          },
        }),
      ],
    })
    render(page())
    await screen.findByText('My clients this week')
    const placed = within(dayColumn(/^Tuesday Nov 17$/)).getByText('Acme Dental').closest('li')
    expect(placed).toHaveClass('is-parked')
    expect(within(dayColumn(/^Tuesday Nov 17$/)).getByText('Waiting, nothing to pick up')).toBeInTheDocument()
  })

  it('"Answered, back to work" takes a task out of Sent questions', async () => {
    mockFetch.mockResolvedValue({
      weekStart: WEEK,
      userId: LISA,
      entries: [entry('c-bright', { taskMarks: { 'chk-bright': { status: 'questions', note: '' } } })],
    })
    render(page())
    const sent = await screen.findByRole('region', { name: 'Sent questions' })
    fireEvent.click(within(sent).getByRole('button', { name: 'Answered, back to work' }))
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    expect(mockSave.mock.calls[0]).toEqual([
      'c-bright',
      { weekStart: WEEK, plannedDays: [], note: '', taskMarks: {} },
    ])
    expect(screen.queryByRole('region', { name: 'Sent questions' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Status of Sales tax')).toHaveValue('work')
  })

  it('quick clicks are saved one at a time, and the newest row is the last one written', async () => {
    type Saved = Awaited<ReturnType<typeof saveWeekPlanEntryRequest>>
    const finish: Array<() => void> = []
    mockSave.mockImplementation(
      (clientId, body) =>
        new Promise<Saved>((resolve) => {
          finish.push(() =>
            resolve({ weekStart: body.weekStart, entry: entry(clientId, { plannedDays: body.plannedDays }) }),
          )
        }),
    )
    render(page())
    await screen.findByText('My clients this week')

    fireEvent.click(dayButton('Acme Dental', /^Monday/))
    fireEvent.click(dayButton('Acme Dental', /^Tuesday/))
    fireEvent.click(dayButton('Acme Dental', /^Wednesday/))
    // All three show at once, but only the first save has gone out.
    for (const day of [/^Monday/, /^Tuesday/, /^Wednesday/]) {
      expect(dayButton('Acme Dental', day)).toHaveAttribute('aria-pressed', 'true')
    }
    expect(mockSave).toHaveBeenCalledTimes(1)
    expect(mockSave.mock.calls[0][1].plannedDays).toEqual(['2026-11-16'])

    // When it lands, ONE more save carries everything she clicked since.
    finish[0]()
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(2))
    expect(mockSave.mock.calls[1][1].plannedDays).toEqual(['2026-11-16', '2026-11-17', '2026-11-18'])
    finish[1]()
    await waitFor(() => expect(finish).toHaveLength(2))
    // Nothing further is sent: the last write is what is on screen.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(mockSave).toHaveBeenCalledTimes(2)

    // A later click starts a fresh save.
    fireEvent.click(dayButton('Acme Dental', /^Friday/))
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(3))
    expect(mockSave.mock.calls[2][1].plannedDays).toEqual([
      '2026-11-16',
      '2026-11-17',
      '2026-11-18',
      '2026-11-20',
    ])
  })

  it('two clients save side by side: one waiting does not hold up the other', async () => {
    mockSave.mockImplementation(() => new Promise(() => {}))
    render(page())
    await screen.findByText('My clients this week')
    fireEvent.click(dayButton('Acme Dental', /^Monday/))
    fireEvent.click(dayButton('Bright Books', /^Tuesday/))
    expect(mockSave).toHaveBeenCalledTimes(2)
    expect(mockSave.mock.calls.map((call) => call[0])).toEqual(['c-acme', 'c-bright'])
  })

  it('while the stored week is read again after a failed save, nothing can be changed', async () => {
    mockSave.mockRejectedValue(new Error('Client not found'))
    render(page())
    await screen.findByText('My clients this week')
    let answerReload: (value: Awaited<ReturnType<typeof fetchWeekPlanRequest>>) => void = () => {}
    mockFetch.mockReturnValue(
      new Promise((resolve) => {
        answerReload = resolve
      }),
    )
    fireEvent.click(dayButton('Acme Dental', /^Monday/))
    expect(await screen.findByRole('alert')).toHaveTextContent('That change was not saved')
    // The list is gone until what is stored is back, so a click cannot be lost to the reload.
    await waitFor(() => expect(screen.queryByText('My clients this week')).not.toBeInTheDocument())
    answerReload({ weekStart: WEEK, userId: LISA, entries: [] })
    await screen.findByText('My clients this week')
    expect(dayButton('Acme Dental', /^Monday/)).toHaveAttribute('aria-pressed', 'false')
  })

  it('after a failed save, the stored week is read only once every other save has landed', async () => {
    type Saved = Awaited<ReturnType<typeof saveWeekPlanEntryRequest>>
    let failAcme: (error: Error) => void = () => {}
    let finishBright: () => void = () => {}
    mockSave.mockImplementation(
      (clientId, body) =>
        new Promise<Saved>((resolve, reject) => {
          if (clientId === 'c-acme') failAcme = reject
          else finishBright = () => resolve({ weekStart: body.weekStart, entry: entry(clientId, { plannedDays: body.plannedDays }) })
        }),
    )
    render(page())
    await screen.findByText('My clients this week')
    fireEvent.click(dayButton('Acme Dental', /^Monday/))
    fireEvent.click(dayButton('Bright Books', /^Tuesday/))
    expect(mockSave).toHaveBeenCalledTimes(2)
    expect(mockFetch).toHaveBeenCalledTimes(1)

    failAcme(new Error('Client not found'))
    expect(await screen.findByRole('alert')).toHaveTextContent('That change was not saved')
    // Bright's save is still in flight: reading now could miss it.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(mockFetch).toHaveBeenCalledTimes(1)

    mockFetch.mockResolvedValue({
      weekStart: WEEK,
      userId: LISA,
      entries: [entry('c-bright', { plannedDays: ['2026-11-17'] })],
    })
    finishBright()
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))
    await screen.findByText('My clients this week')
    expect(dayButton('Bright Books', /^Tuesday/)).toHaveAttribute('aria-pressed', 'true')
    expect(dayButton('Acme Dental', /^Monday/)).toHaveAttribute('aria-pressed', 'false')
  })

  it('never shows a week the server says is someone else’s', async () => {
    mockFetch.mockResolvedValue({
      weekStart: WEEK,
      userId: 'emp-someone-else',
      entries: [entry('c-acme', { note: 'not hers' })],
    })
    render(page())
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the week.')
    expect(screen.queryByDisplayValue('not hers')).not.toBeInTheDocument()
    expect(screen.queryByText('My clients this week')).not.toBeInTheDocument()
  })

  it('a save that fails says so and puts back what is stored', async () => {
    mockSave.mockRejectedValue(new Error('Client not found'))
    render(page())
    await screen.findByText('My clients this week')
    fireEvent.click(dayButton('Acme Dental', /^Monday/))
    expect(await screen.findByRole('alert')).toHaveTextContent('That change was not saved: Client not found')
    // The stored week is read again, and the day she clicked is no longer shown as planned.
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(dayButton('Acme Dental', /^Monday/)).toHaveAttribute('aria-pressed', 'false'),
    )
  })
})

describe('My Week: moving between weeks', () => {
  it('asks for the next week and never shows this week’s plan under it', async () => {
    mockFetch.mockResolvedValueOnce({
      weekStart: WEEK,
      userId: LISA,
      entries: [entry('c-acme', { plannedDays: ['2026-11-18'], note: 'this week only' })],
    })
    let answerNext: (value: Awaited<ReturnType<typeof fetchWeekPlanRequest>>) => void = () => {}
    mockFetch.mockReturnValueOnce(
      new Promise((resolve) => {
        answerNext = resolve
      }),
    )
    render(page())
    await screen.findByDisplayValue('this week only')

    fireEvent.click(screen.getByRole('button', { name: 'Next week' }))
    await waitFor(() => expect(mockFetch).toHaveBeenLastCalledWith('2026-11-23', null, expect.anything()))
    // Until next week's answer is in, nothing of this week's plan is on screen.
    expect(screen.getByText('Loading your week…')).toBeInTheDocument()
    expect(screen.queryByDisplayValue('this week only')).not.toBeInTheDocument()
    expect(screen.getByText(/Week of Nov 23 to Nov 27, 2026/)).toBeInTheDocument()

    answerNext({ weekStart: '2026-11-23', userId: LISA, entries: [] })
    await screen.findByText('My clients this week')
    expect(screen.getByLabelText('Note for Acme Dental')).toHaveValue('')
    // "This week" is offered only away from this week, and brings her back.
    fireEvent.click(screen.getByRole('button', { name: 'This week' }))
    await waitFor(() => expect(mockFetch).toHaveBeenLastCalledWith(WEEK, null, expect.anything()))
  })

  it('a save that fails after she moved to another week says nothing under the new week', async () => {
    let failSave: (error: Error) => void = () => {}
    mockSave.mockReturnValue(
      new Promise((_, reject) => {
        failSave = reject
      }),
    )
    render(page())
    await screen.findByText('My clients this week')
    fireEvent.click(dayButton('Acme Dental', /^Monday/))
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))

    mockFetch.mockResolvedValue({ weekStart: '2026-11-23', userId: LISA, entries: [] })
    fireEvent.click(screen.getByRole('button', { name: 'Next week' }))
    await waitFor(() => expect(screen.getAllByRole('listitem', { name: /^Monday Nov 23$/ })).toHaveLength(1))
    await screen.findByText('My clients this week')
    const fetchesBefore = mockFetch.mock.calls.length

    failSave(new Error('Client not found'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(mockFetch.mock.calls.length).toBe(fetchesBefore)
    expect(screen.getByText('My clients this week')).toBeInTheDocument()
  })

  it('a save goes to the week on screen', async () => {
    render(page())
    await screen.findByText('My clients this week')
    mockFetch.mockResolvedValue({ weekStart: '2026-11-23', userId: LISA, entries: [] })
    fireEvent.click(screen.getByRole('button', { name: 'Next week' }))
    await waitFor(() => expect(screen.getAllByRole('listitem', { name: /^Monday Nov 23$/ })).toHaveLength(1))
    await screen.findByText('My clients this week')
    fireEvent.click(dayButton('Acme Dental', /^Monday/))
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    expect(mockSave.mock.calls[0][1]).toMatchObject({ weekStart: '2026-11-23', plannedDays: ['2026-11-23'] })
  })
})

describe('My Week: an owner looking at someone else’s week (preview)', () => {
  it('shows it, says whose it is, and changes nothing', async () => {
    contextValue = { ...contextValue, previewMode: true } as unknown as AppContextValue
    mockFetch.mockResolvedValue({
      weekStart: WEEK,
      userId: LISA,
      entries: [entry('c-acme', { taskMarks: { 'chk-payroll': { status: 'questions', note: '' } } })],
    })
    render(page())
    await screen.findByText('My clients this week')
    expect(screen.getByText("You are looking at Lisa's week. It cannot be changed from here.")).toBeInTheDocument()

    for (const button of within(screen.getByRole('group', { name: 'Days for Acme Dental' })).getAllByRole('button')) {
      expect(button).toBeDisabled()
    }
    expect(screen.getByLabelText('Note for Acme Dental')).toBeDisabled()
    expect(screen.getByLabelText('Status of Payroll')).toBeDisabled()
    const sent = screen.getByRole('region', { name: 'Sent questions' })
    expect(within(sent).queryByRole('button', { name: 'Answered, back to work' })).not.toBeInTheDocument()
    expect(within(sent).getByRole('link', { name: 'Open' })).toBeInTheDocument()

    fireEvent.click(dayButton('Acme Dental', /^Monday/))
    expect(mockSave).not.toHaveBeenCalled()
  })
})

/**
 * Ship 2: questions set themselves. Her answer 4, to "when everything they have
 * open ... is waiting, it moves to Sent questions on its own, and comes back to
 * the top of their day when it is answered": "I like this".
 */
describe('My Week: questions that set themselves from the Waiting flags', () => {
  const BRITT = 'emp-britt'
  const waitOn = (over: Record<string, unknown> = {}) => ({
    id: 'w1',
    blockerId: BRITT,
    requestedBy: LISA,
    note: 'which account?',
    createdAt: '2026-11-16T15:00:00.000Z',
    ...over,
  })
  const withData = (checklists: unknown[]) => {
    contextValue = {
      ...contextValue,
      data: {
        ...data,
        employees: [...data.employees, { id: BRITT, name: 'Brittany', role: 'Owner' }],
        checklists,
      },
    } as unknown as AppContextValue
  }
  const waitingTask = (id: string, clientId: string, title: string, wait = waitOn()) =>
    checklist(id, clientId, title, '2026-11-30', {
      items: [step('a', true), { ...step('b', false), waitingOns: [wait] }],
    })

  it('a task whose open work is all waiting reads In questions and says who and since when', async () => {
    withData([waitingTask('chk-w', 'c-acme', 'Monthly close')])
    render(page())
    await screen.findByText('My clients this week')
    const acme = within(row('Acme Dental'))
    expect(acme.getByText('Waiting on Brittany since Nov 16')).toBeInTheDocument()
    // The word beside the picker (the picker itself also lists 'In questions' as a choice).
    expect(acme.getByText('In questions', { selector: 'small' })).toBeInTheDocument()
    expect(acme.getByText('1 in questions')).toBeInTheDocument()
    // The picker is only what she set herself: nothing.
    expect(screen.getByLabelText('Status of Monthly close')).toHaveValue('work')
    // Questions are out, so this client is not "not planned".
    expect(screen.getByText('Every client is planned or in hand this week.')).toBeInTheDocument()

    const sent = screen.getByRole('region', { name: 'Sent questions' })
    expect(within(sent).getByText('Monthly close')).toBeInTheDocument()
    expect(within(sent).getByText('Waiting on Brittany since Nov 16')).toBeInTheDocument()
    // It clears by itself when answered: no button to do it by hand.
    expect(within(sent).queryByRole('button', { name: 'Answered, back to work' })).not.toBeInTheDocument()
    expect(mockSave).not.toHaveBeenCalled()
  })

  it('a wait on the client says "the client", and an old-style flag says it is marked waiting', async () => {
    withData([
      waitingTask('chk-c', 'c-acme', 'Sales tax', waitOn({ blockerType: 'client', blockerId: 'c-acme' })),
      checklist('chk-old', 'c-bright', 'Bank recs', '2026-11-30', {
        items: [{ ...step('a', false), waiting: true, waitingOn: 'statements from the bank' }],
      }),
    ])
    render(page())
    await screen.findByText('My clients this week')
    expect(within(row('Acme Dental')).getByText('Waiting on the client since Nov 16')).toBeInTheDocument()
    expect(within(row('Bright Books')).getByText('Marked waiting: statements from the bank')).toBeInTheDocument()
  })

  it('greys the client on its day while everything is waiting, and not once one task is live', async () => {
    withData([waitingTask('chk-w', 'c-acme', 'Monthly close')])
    mockFetch.mockResolvedValue({
      weekStart: WEEK,
      userId: LISA,
      entries: [entry('c-acme', { plannedDays: ['2026-11-17'] })],
    })
    const view = render(page())
    await screen.findByText('My clients this week')
    expect(within(dayColumn(/^Tuesday Nov 17$/)).getByText('Acme Dental').closest('li')).toHaveClass('is-parked')

    withData([waitingTask('chk-w', 'c-acme', 'Monthly close'), checklist('chk-p', 'c-acme', 'Payroll', '2026-11-18')])
    view.rerender(page())
    expect(within(dayColumn(/^Tuesday Nov 17$/)).getByText('Acme Dental').closest('li')).not.toHaveClass('is-parked')
    expect(within(dayColumn(/^Tuesday Nov 17$/)).getByText('1 to work on')).toBeInTheDocument()
  })

  it('when the answer is in, the task moves to "Answered: pick these up" and out of Sent questions', async () => {
    withData([
      waitingTask(
        'chk-w',
        'c-acme',
        'Monthly close',
        waitOn({ resolvedAt: '2026-11-17T14:00:00.000Z', resolvedBy: BRITT }),
      ),
    ])
    render(page())
    await screen.findByText('My clients this week')
    const answered = screen.getByRole('region', { name: 'Answered' })
    expect(within(answered).getByText('Acme Dental')).toBeInTheDocument()
    expect(within(answered).getByText('Brittany answered. Open it to confirm and carry on.')).toBeInTheDocument()
    expect(within(answered).getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/checklists?focus=chk-w')
    expect(screen.queryByRole('region', { name: 'Sent questions' })).not.toBeInTheDocument()
    const acme = within(row('Acme Dental'))
    expect(acme.getByText('Answered')).toBeInTheDocument()
    expect(acme.getByText('1 answered')).toBeInTheDocument()
  })

  it('a question she set herself still has its own button, beside one the flags set', async () => {
    withData([
      waitingTask('chk-w', 'c-acme', 'Monthly close'),
      checklist('chk-p', 'c-acme', 'Payroll', '2026-11-18'),
    ])
    mockFetch.mockResolvedValue({
      weekStart: WEEK,
      userId: LISA,
      entries: [entry('c-acme', { taskMarks: { 'chk-p': { status: 'questions', note: '' } } })],
    })
    render(page())
    const sent = await screen.findByRole('region', { name: 'Sent questions' })
    expect(within(sent).getAllByRole('listitem')).toHaveLength(2)
    expect(within(sent).getAllByRole('button', { name: 'Answered, back to work' })).toHaveLength(1)
    expect(screen.getByLabelText('Status of Payroll')).toHaveValue('questions')
    expect(screen.getByLabelText('Status of Monthly close')).toHaveValue('work')
  })

  it('a question she set by hand on a task the flags also hold keeps its button', async () => {
    withData([waitingTask('chk-w', 'c-acme', 'Monthly close')])
    mockFetch.mockResolvedValue({
      weekStart: WEEK,
      userId: LISA,
      entries: [entry('c-acme', { taskMarks: { 'chk-w': { status: 'questions', note: '' } } })],
    })
    render(page())
    const sent = await screen.findByRole('region', { name: 'Sent questions' })
    expect(within(sent).getByText('Waiting on Brittany since Nov 16')).toBeInTheDocument()
    fireEvent.click(within(sent).getByRole('button', { name: 'Answered, back to work' }))
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    expect(mockSave.mock.calls[0][1].taskMarks).toEqual({})
    // Her mark is gone; the flags still hold it, now without a button.
    expect(within(screen.getByRole('region', { name: 'Sent questions' })).queryByRole('button')).not.toBeInTheDocument()
  })

  it('says it plainly when two people are waiting on her, with and without a date', async () => {
    withData([
      checklist('chk-two', 'c-acme', 'Monthly close', '2026-11-30', {
        items: [
          {
            ...step('a', false),
            waitingOns: [
              waitOn({ id: 'w1', blockerId: LISA, requestedBy: BRITT }),
              waitOn({ id: 'w2', blockerId: LISA, requestedBy: 'emp-left', createdAt: '2026-11-12T15:00:00.000Z' }),
            ],
          },
        ],
      }),
      checklist('chk-nodate', 'c-bright', 'Sales tax', '2026-11-30', {
        items: [{ ...step('a', false), waitingOns: [waitOn({ blockerId: LISA, requestedBy: BRITT, createdAt: '' })] }],
      }),
    ])
    render(page())
    await screen.findByText('My clients this week')
    expect(
      within(row('Acme Dental')).getByText('Brittany and a teammate have been waiting on you since Nov 12.'),
    ).toBeInTheDocument()
    expect(within(row('Bright Books')).getByText('Brittany is waiting on you.')).toBeInTheDocument()
  })

  it('names the client and each person once when several waits hold a task', async () => {
    withData([
      checklist('chk-many', 'c-acme', 'Monthly close', '2026-11-30', {
        items: [
          { ...step('a', false), waitingOns: [waitOn({ id: 'w1', blockerType: 'client', blockerId: 'c-acme', createdAt: '2026-11-13T15:00:00.000Z' })] },
          { ...step('b', false), waitingOns: [waitOn({ id: 'w2' }), waitOn({ id: 'w3' })] },
        ],
      }),
    ])
    render(page())
    await screen.findByText('My clients this week')
    expect(within(row('Acme Dental')).getByText('Waiting on the client and Brittany since Nov 13')).toBeInTheDocument()
  })

  it('a task where someone is waiting on HER is shown as her work, with who is waiting', async () => {
    withData([
      checklist('chk-me', 'c-acme', 'Monthly close', '2026-11-30', {
        items: [{ ...step('a', false), waitingOns: [waitOn({ blockerId: LISA, requestedBy: BRITT })] }],
      }),
    ])
    render(page())
    await screen.findByText('My clients this week')
    const acme = within(row('Acme Dental'))
    expect(acme.getByText('Brittany has been waiting on you since Nov 16.')).toBeInTheDocument()
    expect(acme.getByText('Not planned', { selector: 'small' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Sent questions' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Answered' })).not.toBeInTheDocument()
    expect(screen.getByText('1 client not planned this week')).toBeInTheDocument()
  })

  it('an answer someone else must confirm reads as still waiting on them', async () => {
    withData([
      checklist('chk-c', 'c-acme', 'Monthly close', '2026-11-30', {
        items: [
          {
            ...step('a', false),
            assigneeId: BRITT,
            waitingOns: [
              waitOn({ blockerId: LISA, requestedBy: BRITT, resolvedAt: '2026-11-17T14:00:00.000Z', resolvedBy: LISA }),
            ],
          },
        ],
      }),
    ])
    render(page())
    await screen.findByText('My clients this week')
    expect(within(row('Acme Dental')).getByText('Waiting on Brittany to confirm an answer')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Answered' })).not.toBeInTheDocument()
  })

  it('names a person who has left the team as "a teammate", and says when a question came back', async () => {
    withData([
      waitingTask('chk-gone', 'c-acme', 'Monthly close', waitOn({ blockerId: 'emp-left' })),
      waitingTask(
        'chk-q',
        'c-bright',
        'Sales tax',
        waitOn({ questions: [{ at: '2026-11-16T18:00:00.000Z', by: BRITT, note: 'which month?' }] }),
      ),
    ])
    render(page())
    await screen.findByText('My clients this week')
    expect(within(row('Acme Dental')).getByText('Waiting on a teammate since Nov 16')).toBeInTheDocument()
    // Lisa asked; Brittany asked her a question back: answering is Lisa's move.
    const bright = within(row('Bright Books'))
    expect(bright.getByText('Brittany asked you a question back.')).toBeInTheDocument()
    expect(bright.getByText('Not planned', { selector: 'small' })).toBeInTheDocument()
    // So it is not parked in Sent questions; only the other one is.
    const sent = screen.getByRole('region', { name: 'Sent questions' })
    expect(within(sent).getAllByRole('listitem')).toHaveLength(1)
    expect(within(sent).getByText('Monthly close')).toBeInTheDocument()
  })

  it('says how many clients are finished for the month', async () => {
    withData([
      checklist('chk-done', 'c-acme', 'Monthly close', '2026-11-30', { items: [step('a', true)] }),
      checklist('chk-open', 'c-bright', 'Sales tax', '2026-11-30'),
    ])
    render(page())
    await screen.findByText('My clients this week')
    expect(screen.getByText('1 client is finished for the month.')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Acme Dental' })).not.toBeInTheDocument()
  })
})
