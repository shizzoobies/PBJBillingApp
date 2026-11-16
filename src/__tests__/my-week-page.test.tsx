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
vi.mock('../../lib/firm-time.js', () => ({ firmToday: () => '2026-11-17' }))
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
