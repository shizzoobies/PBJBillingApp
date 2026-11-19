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
    checklist('chk-close', 'c-acme', 'Monthly close', '2026-11-20'),
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
// Days are on each TASK (her send-back): the buttons sit on the task's line.
// A client name is accepted as shorthand for that client's first-listed task
// in these fixtures, so the older tests read as they did.
const FIRST_TASK: Record<string, string> = { 'Acme Dental': 'Payroll', 'Bright Books': 'Sales tax' }
const dayGroup = (taskOrClient: string) =>
  screen.getByRole('group', { name: new RegExp(`^Days for ${FIRST_TASK[taskOrClient] ?? taskOrClient} \\(`) })
const dayButton = (taskOrClient: string, day: RegExp) =>
  within(dayGroup(taskOrClient)).getByRole('button', { name: day })

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
    expect(acme.getByText('Due this week, Nov 20')).toBeInTheDocument()
    expect(acme.getAllByText('1 of 2 done')).toHaveLength(2)
    expect(within(row('Bright Books')).getByText('Overdue, was due Nov 10')).toBeInTheDocument()
    expect(acme.getByText('2 not planned')).toBeInTheDocument()
  })

  it('shows Monday to Friday with today marked, and the plan she already saved', async () => {
    mockFetch.mockResolvedValue({
      weekStart: WEEK,
      userId: LISA,
      // A row saved before days were per task: the CLIENT was put on Wednesday.
      entries: [entry('c-acme', { plannedDays: ['2026-11-18'], note: 'bank feed first' })],
    })
    render(page())
    await screen.findByText('My clients this week')
    expect(screen.getAllByRole('listitem', { name: /day Nov/ })).toHaveLength(5)
    expect(dayColumn(/^Tuesday Nov 17$/)).toHaveClass('is-today')
    // So both of its tasks are on Wednesday, each on its own line.
    const wednesday = within(dayColumn(/^Wednesday Nov 18$/))
    expect(wednesday.getAllByText('Acme Dental')).toHaveLength(2)
    expect(wednesday.getByText('Payroll')).toBeInTheDocument()
    expect(wednesday.getByText('Monthly close')).toBeInTheDocument()
    expect(within(dayColumn(/^Monday Nov 16$/)).getByText('Nothing planned')).toBeInTheDocument()
    expect(dayButton('Payroll', /^Wednesday/)).toHaveAttribute('aria-pressed', 'true')
    expect(dayButton('Monthly close', /^Wednesday/)).toHaveAttribute('aria-pressed', 'true')
    expect(dayButton('Payroll', /^Monday/)).toHaveAttribute('aria-pressed', 'false')
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
  it('putting a TASK on a day saves the whole row and shows only that task on that day', async () => {
    render(page())
    await screen.findByText('My clients this week')
    fireEvent.click(dayButton('Payroll', /^Thursday/))

    const thursday = within(dayColumn(/^Thursday Nov 19$/))
    expect(thursday.getByText('Acme Dental')).toBeInTheDocument()
    expect(thursday.getByText('Payroll')).toBeInTheDocument()
    // The client's OTHER task is not dragged along.
    expect(thursday.queryByText('Monthly close')).not.toBeInTheDocument()
    expect(dayButton('Monthly close', /^Thursday/)).toHaveAttribute('aria-pressed', 'false')
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    expect(mockSave).toHaveBeenCalledWith('c-acme', {
      weekStart: WEEK,
      plannedDays: ['2026-11-19'],
      note: '',
      taskMarks: { 'chk-payroll': { status: null, note: '', days: ['2026-11-19'] } },
    })
    expect(screen.getByText('1 client not planned this week')).toBeInTheDocument()
    expect(within(row('Acme Dental')).getByText('1 planned, 1 not planned')).toBeInTheDocument()
  })

  // Her send-back: "for Associated ... there are 3 task associated with it and
  // I do not want to work on each task on the same day. I need to be able to
  // put them to different days." Done when each of the three can go on its own
  // day and the five-day view shows only that task on each day.
  it('three tasks of one client go on three different days', async () => {
    contextValue = {
      ...contextValue,
      data: {
        ...data,
        clients: [{ id: 'c-assoc', name: 'Associated Enterprise' }],
        checklists: [
          checklist('chk-1', 'c-assoc', 'Bank recs', '2026-11-20'),
          checklist('chk-2', 'c-assoc', 'Payroll', '2026-11-20'),
          checklist('chk-3', 'c-assoc', 'Sales tax', '2026-11-20'),
        ],
      },
    } as unknown as AppContextValue
    render(page())
    await screen.findByText('My clients this week')
    fireEvent.click(dayButton('Bank recs', /^Monday/))
    fireEvent.click(dayButton('Payroll', /^Wednesday/))
    fireEvent.click(dayButton('Sales tax', /^Friday/))

    const onDay = (name: RegExp) =>
      Array.from(dayColumn(name).querySelectorAll('li small')).map((small) => small.textContent)
    expect(onDay(/^Monday Nov 16$/)).toEqual(['Bank recs'])
    expect(onDay(/^Tuesday Nov 17$/)).toEqual([])
    expect(onDay(/^Wednesday Nov 18$/)).toEqual(['Payroll'])
    expect(onDay(/^Thursday Nov 19$/)).toEqual([])
    expect(onDay(/^Friday Nov 20$/)).toEqual(['Sales tax'])
    expect(within(row('Associated Enterprise')).getByText('3 planned')).toBeInTheDocument()

    // The last save carries every task with its own days, and the row's days are their union.
    await waitFor(() =>
      expect(mockSave.mock.calls[mockSave.mock.calls.length - 1][1]).toEqual({
        weekStart: WEEK,
        plannedDays: ['2026-11-16', '2026-11-18', '2026-11-20'],
        note: '',
        taskMarks: {
          'chk-1': { status: null, note: '', days: ['2026-11-16'] },
          'chk-2': { status: null, note: '', days: ['2026-11-18'] },
          'chk-3': { status: null, note: '', days: ['2026-11-20'] },
        },
      }),
    )
  })

  it('a row from before (the client on a day) turns per-task at her first change, keeping what she had', async () => {
    mockFetch.mockResolvedValue({
      weekStart: WEEK,
      userId: LISA,
      entries: [entry('c-acme', { plannedDays: ['2026-11-18'], note: 'bank feed first' })],
    })
    render(page())
    await screen.findByText('My clients this week')
    // She moves Monthly close to Friday as well; Payroll stays on Wednesday.
    fireEvent.click(dayButton('Monthly close', /^Friday/))
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    expect(mockSave).toHaveBeenCalledWith('c-acme', {
      weekStart: WEEK,
      plannedDays: ['2026-11-18', '2026-11-20'],
      note: 'bank feed first',
      taskMarks: {
        'chk-close': { status: null, note: '', days: ['2026-11-18', '2026-11-20'] },
        'chk-payroll': { status: null, note: '', days: ['2026-11-18'] },
      },
    })
    // Now she can take Wednesday off one of them without touching the other.
    fireEvent.click(dayButton('Monthly close', /^Wednesday/))
    expect(dayButton('Monthly close', /^Wednesday/)).toHaveAttribute('aria-pressed', 'false')
    expect(dayButton('Payroll', /^Wednesday/)).toHaveAttribute('aria-pressed', 'true')
    const wednesday = within(dayColumn(/^Wednesday Nov 18$/))
    expect(wednesday.getByText('Payroll')).toBeInTheDocument()
    expect(wednesday.queryByText('Monthly close')).not.toBeInTheDocument()
  })

  it('two quick clicks on two tasks of one client both land (the second builds on the first)', async () => {
    mockSave.mockImplementation(() => new Promise(() => {}))
    render(page())
    await screen.findByText('My clients this week')
    fireEvent.click(dayButton('Payroll', /^Monday/))
    fireEvent.click(dayButton('Monthly close', /^Tuesday/))
    expect(dayButton('Payroll', /^Monday/)).toHaveAttribute('aria-pressed', 'true')
    expect(dayButton('Monthly close', /^Tuesday/)).toHaveAttribute('aria-pressed', 'true')
    expect(dayButton('Monthly close', /^Monday/)).toHaveAttribute('aria-pressed', 'false')
  })

  it('taking a client off the week keeps a status on a task that is not listed right now', async () => {
    contextValue = {
      ...contextValue,
      data: {
        ...data,
        checklists: [
          checklist('chk-done', 'c-acme', 'Monthly close', '2026-11-20', { items: [step('a', true)] }),
          // Still open, but its due date moved into next year: not on this page for now.
          checklist('chk-later', 'c-acme', 'Year-end', '2027-01-15'),
        ],
      },
    } as unknown as AppContextValue
    mockFetch.mockResolvedValue({
      weekStart: WEEK,
      userId: LISA,
      entries: [
        entry('c-acme', {
          plannedDays: ['2026-11-18'],
          note: 'call them',
          taskMarks: {
            'chk-done': { status: null, note: '', days: ['2026-11-18'] },
            'chk-later': { status: 'questions', note: 'asked', days: [] },
          },
        }),
      ],
    })
    render(page())
    await screen.findByText('My clients this week')
    // There is a note, so the button says it goes too.
    fireEvent.click(within(row('Acme Dental')).getByRole('button', { name: 'Take it off my week (clears the note)' }))
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    expect(mockSave).toHaveBeenCalledWith('c-acme', {
      weekStart: WEEK,
      plannedDays: [],
      note: '',
      taskMarks: { 'chk-later': { status: 'questions', note: 'asked', days: [] } },
    })
    expect(screen.queryByRole('link', { name: 'Acme Dental' })).not.toBeInTheDocument()
  })

  it('a planned client with nothing open any more can be taken off the week', async () => {
    contextValue = {
      ...contextValue,
      data: {
        ...data,
        checklists: [checklist('chk-done', 'c-acme', 'Monthly close', '2026-11-20', { items: [step('a', true)] })],
      },
    } as unknown as AppContextValue
    mockFetch.mockResolvedValue({
      weekStart: WEEK,
      userId: LISA,
      entries: [
        entry('c-acme', {
          plannedDays: ['2026-11-18'],
          taskMarks: { 'chk-done': { status: null, note: '', days: ['2026-11-18'] } },
        }),
      ],
    })
    render(page())
    await screen.findByText('My clients this week')
    expect(within(dayColumn(/^Wednesday Nov 18$/)).getByText('Nothing open')).toBeInTheDocument()
    // No note on it, so the button says nothing about one.
    fireEvent.click(within(row('Acme Dental')).getByRole('button', { name: 'Take it off my week' }))
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    expect(mockSave).toHaveBeenCalledWith('c-acme', { weekStart: WEEK, plannedDays: [], note: '', taskMarks: {} })
    expect(screen.queryByRole('link', { name: 'Acme Dental' })).not.toBeInTheDocument()
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
      entries: [
        entry('c-acme', {
          plannedDays: ['2026-11-17'],
          taskMarks: {
            'chk-close': { status: null, note: '', days: ['2026-11-17'] },
            'chk-payroll': { status: null, note: '', days: ['2026-11-17'] },
          },
        }),
      ],
    })
    render(page())
    await screen.findByText('My clients this week')
    fireEvent.change(screen.getByLabelText('Status of Payroll'), { target: { value: 'questions' } })

    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    // The task keeps its day; only its status changes.
    expect(mockSave).toHaveBeenCalledWith('c-acme', {
      weekStart: WEEK,
      plannedDays: ['2026-11-17'],
      note: '',
      taskMarks: {
        'chk-close': { status: null, note: '', days: ['2026-11-17'] },
        'chk-payroll': { status: 'questions', note: '', days: ['2026-11-17'] },
      },
    })
    expect(screen.getByLabelText('Status of Payroll')).toHaveValue('questions')
    expect(screen.getByLabelText('Status of Monthly close')).toHaveValue('work')
    expect(within(row('Acme Dental')).getByText('1 planned, 1 in questions')).toBeInTheDocument()
    // On its day the waiting task is greyed and says so; the other one is live.
    const tuesday = within(dayColumn(/^Tuesday Nov 17$/))
    expect(tuesday.getByText('Payroll (waiting or finished)').closest('li')).toHaveClass('is-parked')
    expect(tuesday.getByText('Monthly close').closest('li')).not.toHaveClass('is-parked')

    const sent = screen.getByRole('region', { name: 'Sent questions' })
    expect(within(sent).getByText('Acme Dental')).toBeInTheDocument()
    expect(within(sent).getByText('Payroll')).toBeInTheDocument()

    // Back to "Work on this week": the status goes, the day stays.
    fireEvent.change(screen.getByLabelText('Status of Payroll'), { target: { value: 'work' } })
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(2))
    expect(mockSave.mock.calls[1][1].taskMarks['chk-payroll']).toEqual({
      status: null,
      note: '',
      days: ['2026-11-17'],
    })
  })

  // Whatever she changes on a row from before (not only a day), it is saved
  // in the new form: each task carrying the day the client was on.
  it('a status set on a row from before keeps every task on the client’s day', async () => {
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
      taskMarks: {
        'chk-close': { status: null, note: '', days: ['2026-11-17'] },
        'chk-payroll': { status: 'questions', note: '', days: ['2026-11-17'] },
      },
    })
    // Both tasks are still shown on Tuesday.
    expect(dayButton('Payroll', /^Tuesday/)).toHaveAttribute('aria-pressed', 'true')
    expect(dayButton('Monthly close', /^Tuesday/)).toHaveAttribute('aria-pressed', 'true')
  })

  it('a note typed on a row from before saves each task on the client’s day too', async () => {
    mockFetch.mockResolvedValue({
      weekStart: WEEK,
      userId: LISA,
      entries: [entry('c-acme', { plannedDays: ['2026-11-17'] })],
    })
    render(page())
    await screen.findByText('My clients this week')
    const note = screen.getByLabelText('Note for Acme Dental')
    fireEvent.focus(note)
    fireEvent.change(note, { target: { value: 'bank feed first' } })
    fireEvent.blur(note)
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    expect(mockSave).toHaveBeenCalledWith('c-acme', {
      weekStart: WEEK,
      plannedDays: ['2026-11-17'],
      note: 'bank feed first',
      taskMarks: {
        'chk-close': { status: null, note: '', days: ['2026-11-17'] },
        'chk-payroll': { status: null, note: '', days: ['2026-11-17'] },
      },
    })
    expect(dayButton('Monthly close', /^Tuesday/)).toHaveAttribute('aria-pressed', 'true')
  })

  it('a save refused because the page is out of date shows the words to reload', async () => {
    mockSave.mockRejectedValue(new Error('My Week has changed. Reload the page, then make the change again.'))
    render(page())
    await screen.findByText('My clients this week')
    fireEvent.click(dayButton('Payroll', /^Monday/))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That change was not saved: My Week has changed. Reload the page, then make the change again.',
    )
  })

  it('greys a task on its day when it is in questions or finished, and only that task', async () => {
    mockFetch.mockResolvedValue({
      weekStart: WEEK,
      userId: LISA,
      entries: [
        entry('c-acme', {
          plannedDays: ['2026-11-17'],
          taskMarks: {
            'chk-payroll': { status: 'questions', note: '', days: ['2026-11-17'] },
            'chk-close': { status: null, note: '', days: ['2026-11-17'] },
          },
        }),
      ],
    })
    render(page())
    await screen.findByText('My clients this week')
    const tuesday = within(dayColumn(/^Tuesday Nov 17$/))
    expect(tuesday.getByText('Payroll (waiting or finished)').closest('li')).toHaveClass('is-parked')
    expect(tuesday.getByText('Monthly close').closest('li')).not.toHaveClass('is-parked')
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

/**
 * featreq-f8ebbfc4 (2026-11-17), Brittany: "I need to be able to see all my
 * clients and choose whether I work on any without a task - I might have adhoc
 * work needed".
 */
describe('My Week: work with no task', () => {
  const OTHER = { status: null, note: '', days: ['2026-11-18'] }
  const picker = () => screen.getByLabelText('Work on a client that has no task') as HTMLSelectElement
  // Choosing in the picker adds nothing by itself (on Windows an arrow key
  // changes a closed picker): the button beside it does.
  const add = (clientId: string) => {
    fireEvent.change(picker(), { target: { value: clientId } })
    fireEvent.click(screen.getByRole('button', { name: 'Add to my week' }))
  }
  const otherDay = (clientName: string, day: RegExp) =>
    within(
      within(row(clientName)).getByRole('group', { name: `Days for other work (${clientName})` }),
    ).getByRole('button', { name: day })

  beforeEach(() => {
    // Two of her clients have no task of hers: Quiet Co and Zeta Farm.
    contextValue = {
      ...contextValue,
      data: {
        ...data,
        clients: [...data.clients, { id: 'c-zeta', name: 'Zeta Farm' }, { id: 'c-quiet', name: 'Quiet Co' }],
      },
    } as unknown as AppContextValue
  })

  it('the picker lists her clients that are not on the page, by name', async () => {
    render(page())
    await screen.findByText('My clients this week')
    // Not the ones already listed for their tasks, and never an inactive one.
    expect([...picker().options].map((option) => option.textContent)).toEqual([
      'Choose a client…',
      'Quiet Co',
      'Zeta Farm',
    ])
    expect(screen.queryByRole('link', { name: 'Quiet Co' })).not.toBeInTheDocument()
  })

  it('choosing a client adds it at the top with an Other work line, and saves nothing yet', async () => {
    render(page())
    await screen.findByText('My clients this week')
    const names = () =>
      [...document.querySelectorAll('.my-week-row .client-name-link')].map((link) => link.textContent)
    // Nothing to add until one is chosen; choosing one adds nothing by itself.
    expect(screen.getByRole('button', { name: 'Add to my week' })).toBeDisabled()
    fireEvent.change(picker(), { target: { value: 'c-quiet' } })
    expect(names()).not.toContain('Quiet Co')
    fireEvent.click(screen.getByRole('button', { name: 'Add to my week' }))
    expect(names()[0]).toBe('Quiet Co')
    expect(picker().value).toBe('')
    expect(within(row('Quiet Co')).getByText('Other work (no task)')).toBeInTheDocument()
    expect(otherDay('Quiet Co', /^Wednesday/)).toHaveAttribute('aria-pressed', 'false')
    expect(mockSave).not.toHaveBeenCalled()
    // It is on the page now, so it is no longer offered; the count of clients
    // with tasks to plan has not moved.
    expect([...picker().options].map((option) => option.textContent)).toEqual(['Choose a client…', 'Zeta Farm'])
    expect(screen.getByText('2 clients not planned this week')).toBeInTheDocument()
    // A second one goes under the first.
    add('c-zeta')
    expect(names().slice(0, 2)).toEqual(['Quiet Co', 'Zeta Farm'])
  })

  it('a day on it is saved under the key for other work, and shows on that day', async () => {
    render(page())
    await screen.findByText('My clients this week')
    add('c-quiet')
    fireEvent.click(otherDay('Quiet Co', /^Wednesday/))
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    expect(mockSave).toHaveBeenCalledWith('c-quiet', {
      weekStart: WEEK,
      plannedDays: ['2026-11-18'],
      note: '',
      taskMarks: { '*': OTHER },
    })
    expect(otherDay('Quiet Co', /^Wednesday/)).toHaveAttribute('aria-pressed', 'true')
    const wednesday = within(dayColumn(/^Wednesday Nov 18$/))
    expect(wednesday.getByText('Quiet Co')).toBeInTheDocument()
    expect(wednesday.getByText('Other work')).toBeInTheDocument()
    expect(wednesday.queryByText('Nothing open')).not.toBeInTheDocument()
    expect(within(row('Quiet Co')).getByText('Other work', { selector: '.my-week-rollup' })).toBeInTheDocument()
  })

  it('other work that is stored comes back by itself, and can be taken off the week', async () => {
    mockFetch.mockResolvedValue({
      weekStart: WEEK,
      userId: LISA,
      entries: [entry('c-quiet', { plannedDays: ['2026-11-18'], taskMarks: { '*': OTHER } })],
    })
    render(page())
    await screen.findByText('My clients this week')
    expect(otherDay('Quiet Co', /^Wednesday/)).toHaveAttribute('aria-pressed', 'true')
    expect([...picker().options].map((option) => option.textContent)).toEqual(['Choose a client…', 'Zeta Farm'])
    fireEvent.click(within(row('Quiet Co')).getByRole('button', { name: 'Take it off my week' }))
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    expect(mockSave).toHaveBeenCalledWith('c-quiet', { weekStart: WEEK, plannedDays: [], note: '', taskMarks: {} })
    expect(screen.queryByRole('link', { name: 'Quiet Co' })).not.toBeInTheDocument()
    // And it is offered again.
    expect([...picker().options].map((option) => option.textContent)).toContain('Quiet Co')
  })

  it('taking the last day off other work leaves the line there, to put it on another day', async () => {
    mockFetch.mockResolvedValue({
      weekStart: WEEK,
      userId: LISA,
      entries: [
        entry('c-quiet', { plannedDays: ['2026-11-18'], taskMarks: { '*': OTHER } }),
        entry('c-acme', { plannedDays: ['2026-11-18'], taskMarks: { '*': OTHER } }),
      ],
    })
    render(page())
    await screen.findByText('My clients this week')
    // Other work alone does not make a client with open tasks planned.
    expect(screen.getByText('2 clients not planned this week')).toBeInTheDocument()
    // A client with no task: the row stays, with nothing on it.
    fireEvent.click(otherDay('Quiet Co', /^Wednesday/))
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    expect(mockSave).toHaveBeenLastCalledWith('c-quiet', { weekStart: WEEK, plannedDays: [], note: '', taskMarks: {} })
    expect(otherDay('Quiet Co', /^Wednesday/)).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(otherDay('Quiet Co', /^Thursday/))
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(2))
    expect(mockSave).toHaveBeenLastCalledWith('c-quiet', {
      weekStart: WEEK,
      plannedDays: ['2026-11-19'],
      note: '',
      taskMarks: { '*': { status: null, note: '', days: ['2026-11-19'] } },
    })
    // A client listed for its tasks: the line stays too.
    fireEvent.click(otherDay('Acme Dental', /^Wednesday/))
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(3))
    expect(otherDay('Acme Dental', /^Wednesday/)).toHaveAttribute('aria-pressed', 'false')
    expect(within(row('Acme Dental')).queryByRole('button', { name: /^Add other work/ })).not.toBeInTheDocument()
  })

  it('a client added by mistake is taken off without saving anything', async () => {
    render(page())
    await screen.findByText('My clients this week')
    add('c-quiet')
    fireEvent.click(within(row('Quiet Co')).getByRole('button', { name: 'Take it off my week' }))
    expect(screen.queryByRole('link', { name: 'Quiet Co' })).not.toBeInTheDocument()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(mockSave).not.toHaveBeenCalled()
  })

  it('a client listed for its tasks can have other work too, and its tasks keep their days', async () => {
    mockFetch.mockResolvedValue({
      weekStart: WEEK,
      userId: LISA,
      entries: [
        entry('c-acme', {
          plannedDays: ['2026-11-16'],
          taskMarks: { 'chk-payroll': { status: null, note: '', days: ['2026-11-16'] } },
        }),
      ],
    })
    render(page())
    await screen.findByText('My clients this week')
    const acme = within(row('Acme Dental'))
    // Not shown until she asks for it.
    expect(acme.queryByText('Other work (no task)')).not.toBeInTheDocument()
    fireEvent.click(acme.getByRole('button', { name: 'Add other work for Acme Dental' }))
    expect(acme.queryByRole('button', { name: 'Add other work for Acme Dental' })).not.toBeInTheDocument()
    expect(mockSave).not.toHaveBeenCalled()
    // It stays where it was in the list.
    expect(document.querySelector('.my-week-row .client-name-link')?.textContent).toBe('Bright Books')

    fireEvent.click(otherDay('Acme Dental', /^Friday/))
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    expect(mockSave).toHaveBeenCalledWith('c-acme', {
      weekStart: WEEK,
      plannedDays: ['2026-11-16', '2026-11-20'],
      note: '',
      taskMarks: {
        'chk-payroll': { status: null, note: '', days: ['2026-11-16'] },
        '*': { status: null, note: '', days: ['2026-11-20'] },
      },
    })
    expect(dayButton('Payroll', /^Monday/)).toHaveAttribute('aria-pressed', 'true')
    expect(dayButton('Payroll', /^Friday/)).toHaveAttribute('aria-pressed', 'false')
    expect(within(dayColumn(/^Friday Nov 20$/)).getByText('Other work')).toBeInTheDocument()
    expect(acme.getByText('1 planned, 1 not planned, other work')).toBeInTheDocument()
    // No "take it off" here: this client is on the page for its tasks.
    expect(acme.queryByRole('button', { name: /Take it off my week/ })).not.toBeInTheDocument()
  })

  it('a client planned the old way with nothing open now keeps its day when she adds other work', async () => {
    contextValue = {
      ...contextValue,
      data: {
        ...contextValue.data,
        checklists: [checklist('chk-done', 'c-acme', 'Monthly close', '2026-11-20', { items: [step('a', true)] })],
      },
    } as unknown as AppContextValue
    // Saved by the first version: the client on Wednesday, no days on any task.
    mockFetch.mockResolvedValue({ weekStart: WEEK, userId: LISA, entries: [entry('c-acme', { plannedDays: ['2026-11-18'] })] })
    render(page())
    await screen.findByText('My clients this week')
    // With no task left to carry it, the day she planned is the client's other
    // work: shown pressed on that line, so a click acts on what she sees.
    expect(within(dayColumn(/^Wednesday Nov 18$/)).getByText('Other work')).toBeInTheDocument()
    expect(otherDay('Acme Dental', /^Wednesday/)).toHaveAttribute('aria-pressed', 'true')
    expect(otherDay('Acme Dental', /^Monday/)).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(otherDay('Acme Dental', /^Monday/))
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    expect(mockSave).toHaveBeenLastCalledWith('c-acme', {
      weekStart: WEEK,
      plannedDays: ['2026-11-16', '2026-11-18'],
      note: '',
      taskMarks: { '*': { status: null, note: '', days: ['2026-11-16', '2026-11-18'] } },
    })
    expect(otherDay('Acme Dental', /^Wednesday/)).toHaveAttribute('aria-pressed', 'true')
    expect(within(dayColumn(/^Monday Nov 16$/)).getByText('Other work')).toBeInTheDocument()
    // A click on the day that is on takes only that day off.
    fireEvent.click(otherDay('Acme Dental', /^Wednesday/))
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(2))
    expect(mockSave).toHaveBeenLastCalledWith('c-acme', {
      weekStart: WEEK,
      plannedDays: ['2026-11-16'],
      note: '',
      taskMarks: { '*': { status: null, note: '', days: ['2026-11-16'] } },
    })
    expect(otherDay('Acme Dental', /^Wednesday/)).toHaveAttribute('aria-pressed', 'false')
    expect(otherDay('Acme Dental', /^Monday/)).toHaveAttribute('aria-pressed', 'true')
  })

  it('adding other work to a client that came onto the page after it opened does not move it to the top', async () => {
    const { rerender } = render(page())
    await screen.findByText('My clients this week')
    // New work arrives for Zeta Farm while the page is open.
    contextValue = {
      ...contextValue,
      data: {
        ...contextValue.data,
        checklists: [...contextValue.data.checklists, checklist('chk-zeta', 'c-zeta', 'Cleanup', '2026-11-19')],
      },
    } as unknown as AppContextValue
    rerender(page())
    const names = () =>
      [...document.querySelectorAll('.my-week-row .client-name-link')].map((link) => link.textContent)
    await waitFor(() => expect(names()).toEqual(['Acme Dental', 'Bright Books', 'Zeta Farm']))
    fireEvent.click(within(row('Zeta Farm')).getByRole('button', { name: 'Add other work for Zeta Farm' }))
    expect(within(row('Zeta Farm')).getByText('Other work (no task)')).toBeInTheDocument()
    expect(names()).toEqual(['Acme Dental', 'Bright Books', 'Zeta Farm'])
  })

  it('a client with nothing open keeps its Other work line', async () => {
    contextValue = {
      ...contextValue,
      data: {
        ...contextValue.data,
        checklists: [checklist('chk-done', 'c-acme', 'Monthly close', '2026-11-20', { items: [step('a', true)] })],
      },
    } as unknown as AppContextValue
    mockFetch.mockResolvedValue({
      weekStart: WEEK,
      userId: LISA,
      entries: [entry('c-acme', { note: 'call them' })],
    })
    render(page())
    await screen.findByText('My clients this week')
    fireEvent.click(otherDay('Acme Dental', /^Thursday/))
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    expect(mockSave).toHaveBeenCalledWith('c-acme', {
      weekStart: WEEK,
      plannedDays: ['2026-11-19'],
      note: 'call them',
      taskMarks: { '*': { status: null, note: '', days: ['2026-11-19'] } },
    })
  })

  it('an added client is for the week on screen only; a planned one is stored with its week', async () => {
    render(page())
    await screen.findByText('My clients this week')
    add('c-quiet')
    fireEvent.click(screen.getByRole('button', { name: 'Next week' }))
    await screen.findByText(/Week of Nov 23 to Nov 27, 2026/)
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))
    await screen.findByText('My clients this week')
    expect(screen.queryByRole('link', { name: 'Quiet Co' })).not.toBeInTheDocument()
    expect(mockSave).not.toHaveBeenCalled()
  })

  // Around an update the previous server can answer for a few seconds; it has
  // no route for this page's save address, so the save fails and nothing is written.
  it('a save that found no route says so and shows what is stored', async () => {
    // What the request helper says for a save that found no route (week-plan-api.test.ts).
    mockSave.mockRejectedValue(new Error('My Week is being updated. Try again in a moment.'))
    render(page())
    await screen.findByText('My clients this week')
    add('c-quiet')
    fireEvent.click(otherDay('Quiet Co', /^Wednesday/))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That change was not saved: My Week is being updated. Try again in a moment.',
    )
    // The stored week is read again; the client she added is still there to try again.
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(otherDay('Quiet Co', /^Wednesday/)).toHaveAttribute('aria-pressed', 'false'))
  })

  it('while an owner previews someone nothing can be added, and stored other work is shown but not changed', async () => {
    contextValue = { ...contextValue, previewMode: true } as unknown as AppContextValue
    mockFetch.mockResolvedValue({
      weekStart: WEEK,
      userId: LISA,
      entries: [entry('c-quiet', { plannedDays: ['2026-11-18'], taskMarks: { '*': OTHER } })],
    })
    render(page())
    await screen.findByText("Lisa's clients this week")
    expect(screen.queryByLabelText('Work on a client that has no task')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Add other work/ })).not.toBeInTheDocument()
    expect(otherDay('Quiet Co', /^Wednesday/)).toHaveAttribute('aria-pressed', 'true')
    expect(otherDay('Quiet Co', /^Wednesday/)).toBeDisabled()
    expect(within(row('Quiet Co')).queryByRole('button', { name: /Take it off my week/ })).not.toBeInTheDocument()
    // A client listed for its tasks has no empty Other work line here.
    expect(within(row('Acme Dental')).queryByText('Other work (no task)')).not.toBeInTheDocument()
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
    await screen.findByText("Lisa's clients this week")
    expect(screen.getByText("You are looking at Lisa's week. It cannot be changed from here.")).toBeInTheDocument()
    // The advice written to "you" is for her own week only.
    expect(screen.queryByText(/Put each client on the day or days you plan/)).not.toBeInTheDocument()
    // No picker and no team table while previewing: preview shows one person's own view.
    expect(screen.queryByLabelText('Whose week')).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: "Everyone's week" })).not.toBeInTheDocument()

    // Every task's day buttons, not just one task's.
    const dayGroups = screen.getAllByRole('group', { name: /^Days for / })
    expect(dayGroups.length).toBeGreaterThan(1)
    for (const group of dayGroups) {
      for (const button of within(group).getAllByRole('button')) expect(button).toBeDisabled()
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
    checklist(id, clientId, title, '2026-11-20', {
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
      checklist('chk-old', 'c-bright', 'Bank recs', '2026-11-20', {
        items: [{ ...step('a', false), waiting: true, waitingOn: 'statements from the bank' }],
      }),
    ])
    render(page())
    await screen.findByText('My clients this week')
    expect(within(row('Acme Dental')).getByText('Waiting on the client since Nov 16')).toBeInTheDocument()
    expect(within(row('Bright Books')).getByText('Marked waiting: statements from the bank')).toBeInTheDocument()
  })

  it('greys a waiting task on its day, and a live task beside it is not greyed', async () => {
    withData([waitingTask('chk-w', 'c-acme', 'Monthly close')])
    mockFetch.mockResolvedValue({
      weekStart: WEEK,
      userId: LISA,
      entries: [entry('c-acme', { plannedDays: ['2026-11-17'] })],
    })
    const view = render(page())
    await screen.findByText('My clients this week')
    const tuesday = () => within(dayColumn(/^Tuesday Nov 17$/))
    expect(tuesday().getByText('Monthly close (waiting or finished)').closest('li')).toHaveClass('is-parked')

    withData([waitingTask('chk-w', 'c-acme', 'Monthly close'), checklist('chk-p', 'c-acme', 'Payroll', '2026-11-18')])
    view.rerender(page())
    expect(tuesday().getByText('Monthly close (waiting or finished)').closest('li')).toHaveClass('is-parked')
    expect(tuesday().getByText('Payroll').closest('li')).not.toHaveClass('is-parked')
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
      checklist('chk-two', 'c-acme', 'Monthly close', '2026-11-20', {
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
      checklist('chk-nodate', 'c-bright', 'Sales tax', '2026-11-20', {
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
      checklist('chk-many', 'c-acme', 'Monthly close', '2026-11-20', {
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
      checklist('chk-me', 'c-acme', 'Monthly close', '2026-11-20', {
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
      checklist('chk-c', 'c-acme', 'Monthly close', '2026-11-20', {
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
      checklist('chk-done', 'c-acme', 'Monthly close', '2026-11-20', { items: [step('a', true)] }),
      checklist('chk-open', 'c-bright', 'Sales tax', '2026-11-20'),
    ])
    render(page())
    await screen.findByText('My clients this week')
    expect(screen.getByText('1 client is finished for the month.')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Acme Dental' })).not.toBeInTheDocument()
  })
})

/**
 * Ship 3. From the ticket: "She can peek at everyone's from her page with a
 * button." An owner gets a "Whose week" picker and a line per person; a team
 * member gets neither, and the server refuses her anyone's week but her own.
 */
describe('My Week: an owner looks at anyone’s week from her own page', () => {
  const OWNER = 'emp-owner'
  const ALLISON = 'emp-allison'
  const plans: Record<string, ReturnType<typeof entry>[]> = {}

  beforeEach(() => {
    for (const key of Object.keys(plans)) delete plans[key]
    plans[LISA] = [entry('c-acme', { plannedDays: ['2026-11-18'], note: 'bank feed first' })]
    plans[ALLISON] = []
    plans[OWNER] = []
    contextValue = {
      data: {
        ...data,
        employees: [
          { id: OWNER, name: 'Brittany', role: 'Owner' },
          { id: LISA, name: 'Lisa', role: 'Bookkeeper' },
          { id: ALLISON, name: 'Allison', role: 'Accountant' },
          { id: 'emp-idle', name: 'Zed', role: 'Bookkeeper' },
          { id: 'emp-none', name: 'Nia', role: 'Bookkeeper' },
        ],
        checklists: [
          ...data.checklists,
          checklist('chk-own', 'c-bright', 'Owner review', '2026-11-20', { assigneeId: OWNER }),
        ],
      },
      activeEmployeeId: OWNER,
      previewMode: false,
      role: 'owner',
    } as unknown as AppContextValue
    mockFetch.mockImplementation(async (weekStart, userId) => {
      const who = userId ?? OWNER
      if (who === 'emp-idle') throw new Error('Could not load the week (500)')
      return { weekStart, userId: who, entries: plans[who] ?? [] }
    })
  })

  const teamTable = () => screen.getByRole('region', { name: "Everyone's week" })
  const teamRow = (name: string) =>
    within(teamTable()).getByRole('rowheader', { name }).closest('tr') as HTMLElement
  const cells = (name: string) =>
    Array.from(teamRow(name).querySelectorAll('td')).map((cell) => cell.textContent)

  // Her only open item is a later task with an answer in: hers to pick up, so she has a line.
  it('keeps a line for a person whose only work is a later task with an answer in', async () => {
    contextValue = {
      ...contextValue,
      data: {
        ...contextValue.data,
        checklists: [
          ...contextValue.data.checklists,
          checklist('chk-nia', 'c-bright', 'Year-end prep', '2026-11-24', {
            assigneeId: 'emp-none',
            items: [
              {
                ...step('b', false),
                waitingOns: [
                  {
                    id: 'w-nia',
                    blockerId: OWNER,
                    requestedBy: 'emp-none',
                    note: '',
                    createdAt: '2026-11-16T15:00:00.000Z',
                    resolvedAt: '2026-11-18T14:00:00.000Z',
                    resolvedBy: OWNER,
                  },
                ],
              },
            ],
          }),
        ],
      },
    } as unknown as AppContextValue
    render(page())
    await screen.findByText('My clients this week')
    await waitFor(() => expect(cells('Nia')).toEqual(['0', '0', '0', '1', '0', expect.anything()]))
  })

  it('opens on her own week, with a picker and a line per person who has open work', async () => {
    render(page())
    await screen.findByText('My clients this week')
    // Her own week is asked for without naming anyone.
    expect(mockFetch).toHaveBeenCalledWith(WEEK, null, expect.anything())
    expect(screen.getByLabelText('Whose week')).toHaveValue(OWNER)
    expect(within(screen.getByLabelText('Whose week')).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'My week',
      'Allison',
      'Lisa',
      'Nia',
      'Zed',
    ])

    await waitFor(() => expect(cells('Lisa')[0]).toBe('2'))
    // Lisa: Acme (planned Wednesday) and Bright (not planned).
    expect(cells('Lisa').slice(0, 5)).toEqual(['2', '1', '0', '0', '0'])
    // Her own line comes from her own page.
    expect(cells('Me').slice(0, 5)).toEqual(['1', '1', '0', '0', '0'])
    expect(within(teamRow('Me')).getByText('On screen')).toBeInTheDocument()
    // Allison holds one task on Bright Books and has planned nothing.
    expect(cells('Allison').slice(0, 5)).toEqual(['1', '1', '0', '0', '0'])
    // Nia has nothing open: no line. Zed's plan could not be read: said so.
    expect(within(teamTable()).queryByRole('rowheader', { name: 'Nia' })).not.toBeInTheDocument()
    expect(within(teamRow('Zed')).getByText('Could not be read')).toBeInTheDocument()
    // Each other person's plan was asked for by name, once.
    for (const id of [LISA, ALLISON, 'emp-idle', 'emp-none']) {
      expect(mockFetch.mock.calls.filter((call) => call[1] === id)).toHaveLength(1)
    }
  })

  it('her own line moves as she plans', async () => {
    render(page())
    await screen.findByText('My clients this week')
    await waitFor(() => expect(cells('Me')[1]).toBe('1'))
    fireEvent.click(dayButton('Owner review', /^Monday/))
    await waitFor(() => expect(cells('Me')[1]).toBe('0'))
    expect(mockSave).toHaveBeenCalledTimes(1)
    expect(mockSave.mock.calls[0][0]).toBe('c-bright')
  })

  it('picking a person shows their week, by name, and nothing on it can be changed', async () => {
    render(page())
    await screen.findByText('My clients this week')
    fireEvent.change(screen.getByLabelText('Whose week'), { target: { value: LISA } })

    await screen.findByText("Lisa's clients this week")
    expect(screen.getByText("You are looking at Lisa's week. It cannot be changed from here.")).toBeInTheDocument()
    expect(screen.getByLabelText('Note for Acme Dental')).toHaveValue('bank feed first')
    expect(screen.getByLabelText('Note for Acme Dental')).toBeDisabled()
    expect(dayButton('Acme Dental', /^Wednesday/)).toHaveAttribute('aria-pressed', 'true')
    // Every task's day buttons, not just one task's.
    const dayGroups = screen.getAllByRole('group', { name: /^Days for / })
    expect(dayGroups.length).toBeGreaterThan(1)
    for (const group of dayGroups) {
      for (const button of within(group).getAllByRole('button')) expect(button).toBeDisabled()
    }
    expect(screen.getByLabelText('Status of Payroll')).toBeDisabled()
    // Her own task is not on Lisa's week.
    expect(screen.queryByText('Owner review')).not.toBeInTheDocument()
    fireEvent.click(dayButton('Acme Dental', /^Monday/))
    expect(mockSave).not.toHaveBeenCalled()
    expect(within(teamRow('Lisa')).getByText('On screen')).toBeInTheDocument()

    // Back to her own.
    fireEvent.change(screen.getByLabelText('Whose week'), { target: { value: OWNER } })
    await screen.findByText('My clients this week')
    expect(screen.getByText('Owner review')).toBeInTheDocument()
    expect(dayButton('Owner review', /^Monday/)).not.toBeDisabled()
  })

  it('Look on a person’s line opens their week, and Look on her own line comes back', async () => {
    render(page())
    await screen.findByText('My clients this week')
    await waitFor(() => expect(cells('Lisa')[0]).toBe('2'))
    fireEvent.click(within(teamRow('Lisa')).getByRole('button', { name: "Look at Lisa's week" }))
    await screen.findByText("Lisa's clients this week")
    expect(screen.getByLabelText('Whose week')).toHaveValue(LISA)

    // Her own line cannot be built from her page while it shows Lisa, so it is left out...
    expect(within(teamTable()).queryByRole('rowheader', { name: 'Me' })).not.toBeInTheDocument()
    // ...and the picker is the way back.
    fireEvent.change(screen.getByLabelText('Whose week'), { target: { value: OWNER } })
    await screen.findByText('My clients this week')
    expect(within(teamRow('Me')).getByText('On screen')).toBeInTheDocument()
  })

  it('never shows one person’s plan under another’s name', async () => {
    mockFetch.mockImplementation(async (weekStart, userId) => ({
      weekStart,
      // The server answers for the wrong person whenever Lisa is asked for.
      userId: userId === LISA ? ALLISON : (userId ?? OWNER),
      entries: userId === LISA ? [entry('c-acme', { note: 'not hers' })] : [],
    }))
    render(page())
    await screen.findByText('My clients this week')
    await waitFor(() => expect(within(teamRow('Lisa')).getByText('Could not be read')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Whose week'), { target: { value: LISA } })
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the week.')
    expect(screen.queryByDisplayValue('not hers')).not.toBeInTheDocument()
  })

  it('a new week reads everyone again; a refresh of the same people does not', async () => {
    const view = render(page())
    await screen.findByText('My clients this week')
    await waitFor(() => expect(cells('Lisa')[0]).toBe('2'))
    const before = mockFetch.mock.calls.length

    // The workspace refreshes: a new array holding the same people.
    contextValue = {
      ...contextValue,
      data: { ...contextValue.data, employees: [...contextValue.data.employees] },
    } as unknown as AppContextValue
    view.rerender(page())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(mockFetch.mock.calls.length).toBe(before)

    fireEvent.click(screen.getByRole('button', { name: 'Next week' }))
    await waitFor(() =>
      expect(mockFetch.mock.calls.filter((call) => call[0] === '2026-11-23' && call[1] === LISA)).toHaveLength(1),
    )
  })

  it('a change of hers still being saved survives a look at someone else and back', async () => {
    type Saved = Awaited<ReturnType<typeof saveWeekPlanEntryRequest>>
    let finishSave: () => void = () => {}
    mockSave.mockImplementation(
      (clientId, body) =>
        new Promise<Saved>((resolve) => {
          finishSave = () => resolve({ weekStart: body.weekStart, entry: entry(clientId, { plannedDays: body.plannedDays }) })
        }),
    )
    render(page())
    await screen.findByText('My clients this week')
    fireEvent.click(dayButton('Owner review', /^Monday/))
    expect(mockSave).toHaveBeenCalledTimes(1)

    // She looks at Lisa and comes straight back; the store has not got Monday yet,
    // so her own week is read back WITHOUT it.
    fireEvent.change(screen.getByLabelText('Whose week'), { target: { value: LISA } })
    await screen.findByText("Lisa's clients this week")
    fireEvent.change(screen.getByLabelText('Whose week'), { target: { value: OWNER } })
    await screen.findByText('My clients this week')
    // Monday is still on her screen: the save in flight is newer than what was read.
    expect(dayButton('Owner review', /^Monday/)).toHaveAttribute('aria-pressed', 'true')

    // And her next click builds on it instead of putting the older row back.
    finishSave()
    await waitFor(() => expect(dayButton('Owner review', /^Monday/)).not.toBeDisabled())
    fireEvent.click(dayButton('Owner review', /^Tuesday/))
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(2))
    expect(mockSave.mock.calls[1][1].plannedDays).toEqual(['2026-11-16', '2026-11-17'])
  })

  it('a save of hers that fails while she is looking at someone else says nothing on their week', async () => {
    let failSave: (error: Error) => void = () => {}
    mockSave.mockReturnValue(
      new Promise((_, reject) => {
        failSave = reject
      }),
    )
    render(page())
    await screen.findByText('My clients this week')
    fireEvent.click(dayButton('Owner review', /^Monday/))
    fireEvent.change(screen.getByLabelText('Whose week'), { target: { value: LISA } })
    await screen.findByText("Lisa's clients this week")

    failSave(new Error('Client not found'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    // Lisa's week stays on screen; it is not thrown back to "Loading".
    expect(screen.getByText("Lisa's clients this week")).toBeInTheDocument()

    // Back on her own week, what is stored is shown: Monday was never saved.
    fireEvent.change(screen.getByLabelText('Whose week'), { target: { value: OWNER } })
    await screen.findByText('My clients this week')
    expect(dayButton('Owner review', /^Monday/)).toHaveAttribute('aria-pressed', 'false')
  })

  it('an error on one person’s week is not left standing on the next person’s', async () => {
    render(page())
    await screen.findByText('My clients this week')
    // Zed's plan cannot be read.
    fireEvent.change(screen.getByLabelText('Whose week'), { target: { value: 'emp-idle' } })
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the week (500)')
    fireEvent.change(screen.getByLabelText('Whose week'), { target: { value: LISA } })
    await screen.findByText("Lisa's clients this week")
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('opening a person’s week reads the team’s lines again', async () => {
    render(page())
    await screen.findByText('My clients this week')
    await waitFor(() => expect(cells('Lisa')[0]).toBe('2'))
    const allisonReads = () => mockFetch.mock.calls.filter((call) => call[1] === ALLISON).length
    expect(allisonReads()).toBe(1)
    fireEvent.click(within(teamRow('Lisa')).getByRole('button', { name: "Look at Lisa's week" }))
    await screen.findByText("Lisa's clients this week")
    await waitFor(() => expect(allisonReads()).toBe(2))
    // Her own saves do not: the lines of the others are not read again for them.
    fireEvent.change(screen.getByLabelText('Whose week'), { target: { value: OWNER } })
    await screen.findByText('My clients this week')
    await waitFor(() => expect(allisonReads()).toBe(3))
    fireEvent.click(dayButton('Owner review', /^Monday/))
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(allisonReads()).toBe(3)
  })

  it('a team member has no picker and no team table, and asks only for her own week', async () => {
    contextValue = { ...contextValue, role: 'employee', activeEmployeeId: LISA } as unknown as AppContextValue
    mockFetch.mockImplementation(async (weekStart) => ({ weekStart, userId: LISA, entries: plans[LISA] }))
    render(page())
    await screen.findByText('My clients this week')
    expect(screen.queryByLabelText('Whose week')).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: "Everyone's week" })).not.toBeInTheDocument()
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch.mock.calls[0][1]).toBeNull()
  })
})

/**
 * Her send-back (2026-11-17): "Task for the week of 11/23 are showing up in
 * 11/16's que to schedule ... to push it to next week or bring to this week".
 * In the week of 11/16 a task due 11/24 is not on the list; "Bring to this
 * week" puts it there (and on a day); "Push to next week" takes a task off.
 */
describe('My Week: this week’s tasks only, Bring to this week and Push to next week', () => {
  const NEXT_TASK = checklist('chk-next', 'c-acme', 'Year-end prep', '2026-11-24')
  const LATER_ONLY = checklist('chk-later', 'c-zeta', 'Cleanup', '2026-11-27')
  beforeEach(() => {
    contextValue = {
      ...contextValue,
      data: {
        ...data,
        clients: [...data.clients, { id: 'c-zeta', name: 'Zeta Farms' }],
        checklists: [...data.checklists, NEXT_TASK, LATER_ONLY],
      },
    } as unknown as AppContextValue
    mockFetch.mockResolvedValue({ weekStart: WEEK, userId: LISA, entries: [], weekMoves: true })
  })
  const later = () => screen.getByRole('region', { name: 'Due in a later week' })
  const pushedLine = () => screen.getByRole('region', { name: 'Pushed to next week' })

  it('a task due next week is not on this week’s list; it waits, collapsed, under "Due in a later week"', async () => {
    render(page())
    await screen.findByText('My clients this week')
    expect(screen.queryByRole('link', { name: 'Year-end prep' })).not.toBeInTheDocument()
    // A client there only for a later task is not on the list, nor in the count.
    expect(screen.queryByRole('link', { name: 'Zeta Farms' })).not.toBeInTheDocument()
    expect(screen.getByText('2 clients not planned this week')).toBeInTheDocument()
    const toggle = within(later()).getByRole('button', { name: 'Due in a later week (2)' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    expect(within(later()).getByText('Acme Dental')).toBeInTheDocument()
    expect(within(later()).getByRole('link', { name: 'Year-end prep' })).toBeInTheDocument()
    expect(within(later()).getByText('Due Nov 24')).toBeInTheDocument()
    expect(within(later()).getByText('Zeta Farms')).toBeInTheDocument()
    expect(within(later()).getByText('Due Nov 27')).toBeInTheDocument()
  })

  it('Bring to this week puts it on the list, labeled, saved to /week, and it can go on a day', async () => {
    render(page())
    await screen.findByText('My clients this week')
    fireEvent.click(within(later()).getByRole('button', { name: /^Due in a later week/ }))
    fireEvent.click(within(later()).getByRole('button', { name: 'Bring to this week for Year-end prep (Acme Dental)' }))
    const acme = within(row('Acme Dental'))
    expect(acme.getByRole('link', { name: 'Year-end prep' })).toBeInTheDocument()
    expect(acme.getByText('Brought forward · due Nov 24')).toBeInTheDocument()
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    expect(mockSave).toHaveBeenCalledWith(
      'c-acme',
      {
        weekStart: WEEK,
        plannedDays: [],
        note: '',
        taskMarks: { 'chk-next': { status: null, note: '', days: [], brought: true } },
      },
      { weekMoves: true },
    )
    // The section stays for the visit, with one fewer.
    expect(within(later()).getByRole('button', { name: 'Due in a later week (1)' })).toBeInTheDocument()
    fireEvent.click(dayButton('Year-end prep', /^Thursday/))
    expect(within(dayColumn(/^Thursday Nov 19$/)).getByText('Year-end prep')).toBeInTheDocument()
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(2))
    expect(mockSave.mock.calls[1][1].taskMarks['chk-next']).toEqual({
      status: null,
      note: '',
      days: ['2026-11-19'],
      brought: true,
    })
  })

  it('Put back sends a brought task back to its week and clears its days here', async () => {
    mockFetch.mockResolvedValue({
      weekStart: WEEK,
      userId: LISA,
      weekMoves: true,
      entries: [
        entry('c-acme', {
          plannedDays: ['2026-11-19'],
          taskMarks: { 'chk-next': { status: null, note: '', days: ['2026-11-19'], brought: true } },
        }),
      ],
    })
    render(page())
    await screen.findByText('My clients this week')
    const acme = within(row('Acme Dental'))
    expect(acme.queryByRole('button', { name: /^Push to next week: Year-end prep/ })).not.toBeInTheDocument()
    fireEvent.click(acme.getByRole('button', { name: 'Put back for Year-end prep (Acme Dental)' }))
    expect(within(row('Acme Dental')).queryByRole('link', { name: 'Year-end prep' })).not.toBeInTheDocument()
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    expect(mockSave.mock.calls[0][1]).toEqual({ weekStart: WEEK, plannedDays: [], note: '', taskMarks: {} })
    fireEvent.click(within(later()).getByRole('button', { name: 'Due in a later week (2)' }))
    expect(within(later()).getByRole('link', { name: 'Year-end prep' })).toBeInTheDocument()
  })

  it('Push to next week takes a task off this list; the line stays for the visit and undoes it', async () => {
    render(page())
    await screen.findByText('My clients this week')
    expect(screen.queryByRole('region', { name: 'Pushed to next week' })).not.toBeInTheDocument()
    fireEvent.click(dayButton('Payroll', /^Monday/))
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    fireEvent.click(within(row('Acme Dental')).getByRole('button', { name: 'Push to next week for Payroll (Acme Dental)' }))
    expect(within(row('Acme Dental')).queryByRole('link', { name: 'Payroll' })).not.toBeInTheDocument()
    expect(within(dayColumn(/^Monday Nov 16$/)).getByText('Nothing planned')).toBeInTheDocument()
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(2))
    expect(mockSave.mock.calls[1]).toEqual([
      'c-acme',
      {
        weekStart: WEEK,
        plannedDays: [],
        note: '',
        taskMarks: { 'chk-payroll': { status: null, note: '', days: [], pushed: true } },
      },
      { weekMoves: true },
    ])
    const toggle = within(pushedLine()).getByRole('button', { name: 'Pushed to next week (1)' })
    fireEvent.click(toggle)
    fireEvent.click(within(pushedLine()).getByRole('button', { name: 'Bring back to this week for Payroll (Acme Dental)' }))
    expect(within(row('Acme Dental')).getByRole('link', { name: 'Payroll' })).toBeInTheDocument()
    // The line does not vanish under her hand.
    expect(within(pushedLine()).getByRole('button', { name: 'Pushed to next week (0)' })).toBeInTheDocument()
    expect(within(pushedLine()).getByText('Nothing is pushed to next week.')).toBeInTheDocument()
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(3))
    expect(mockSave.mock.calls[2][1].taskMarks).toEqual({})
  })

  it('on a later visit what she pushed is still listed', async () => {
    mockFetch.mockResolvedValue({
      weekStart: WEEK,
      userId: LISA,
      weekMoves: true,
      entries: [entry('c-acme', { taskMarks: { 'chk-payroll': { status: null, note: '', days: [], pushed: true } } })],
    })
    render(page())
    await screen.findByText('My clients this week')
    expect(within(row('Acme Dental')).queryByRole('link', { name: 'Payroll' })).not.toBeInTheDocument()
    fireEvent.click(within(pushedLine()).getByRole('button', { name: 'Pushed to next week (1)' }))
    expect(within(pushedLine()).getByRole('link', { name: 'Payroll' })).toBeInTheDocument()
    expect(within(pushedLine()).getByText('Due Nov 18')).toBeInTheDocument()
  })

  it('a server that does not keep the moves: the lists show, the three controls do not, saves go to /row', async () => {
    mockFetch.mockResolvedValue({ weekStart: WEEK, userId: LISA, entries: [] })
    render(page())
    await screen.findByText('My clients this week')
    expect(screen.queryByRole('button', { name: /^Push to next week/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Put back/ })).not.toBeInTheDocument()
    fireEvent.click(within(later()).getByRole('button', { name: 'Due in a later week (2)' }))
    expect(within(later()).getByRole('link', { name: 'Year-end prep' })).toBeInTheDocument()
    expect(within(later()).queryByRole('button', { name: /^Bring to this week/ })).not.toBeInTheDocument()
    fireEvent.click(dayButton('Payroll', /^Monday/))
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    // No third argument: the request helper saves to /row.
    expect(mockSave.mock.calls[0]).toHaveLength(2)
  })

  it('looking at a week that cannot be changed: the same lists and labels, no controls', async () => {
    contextValue = { ...contextValue, previewMode: true } as unknown as AppContextValue
    mockFetch.mockResolvedValue({
      weekStart: WEEK,
      userId: LISA,
      weekMoves: true,
      entries: [
        entry('c-acme', {
          taskMarks: {
            'chk-next': { status: null, note: '', days: [], brought: true },
            'chk-payroll': { status: null, note: '', days: [], pushed: true },
          },
        }),
      ],
    })
    render(page())
    await screen.findByText(/clients this week/)
    expect(within(row('Acme Dental')).getByText('Brought forward · due Nov 24')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^(Push to next week|Put back)/ })).not.toBeInTheDocument()
    fireEvent.click(within(pushedLine()).getByRole('button', { name: 'Pushed to next week (1)' }))
    expect(within(pushedLine()).queryByRole('button', { name: /^Bring back/ })).not.toBeInTheDocument()
    fireEvent.click(within(later()).getByRole('button', { name: 'Due in a later week (1)' }))
    expect(within(later()).queryByRole('button', { name: /^Bring to this week/ })).not.toBeInTheDocument()
  })
})

/**
 * The week rule decides the PLANNING list only. Work that is hers to pick up
 * (an answer that is in, someone waiting on her) is never hidden by it.
 */
describe('My Week: tasks off this week’s list that need her', () => {
  const BRITT = 'emp-britt'
  const BOB = 'emp-bob'
  const answeredStep = {
    ...step('b', false),
    waitingOns: [
      {
        id: 'w1',
        blockerId: BRITT,
        requestedBy: LISA,
        note: 'which account?',
        createdAt: '2026-11-16T15:00:00.000Z',
        resolvedAt: '2026-11-18T14:00:00.000Z',
        resolvedBy: BRITT,
      },
    ],
  }
  const onHerStep = {
    ...step('b', false),
    assigneeId: BOB,
    waitingOns: [{ id: 'w2', blockerId: LISA, requestedBy: BOB, note: '', createdAt: '2026-11-16T15:00:00.000Z' }],
  }
  const withChecklists = (extra: unknown[]) => {
    contextValue = {
      ...contextValue,
      data: {
        ...data,
        employees: [...data.employees, { id: BRITT, name: 'Brittany', role: 'Owner' }, { id: BOB, name: 'Bob', role: 'Bookkeeper' }],
        checklists: [...data.checklists, ...extra],
      },
    } as unknown as AppContextValue
  }
  const later = () => screen.getByRole('region', { name: 'Due in a later week' })
  beforeEach(() => {
    mockFetch.mockResolvedValue({ weekStart: WEEK, userId: LISA, entries: [], weekMoves: true })
  })

  it('a later task whose answer is in is in "Answered: pick these up", and its section says so', async () => {
    withChecklists([checklist('chk-next', 'c-acme', 'Year-end prep', '2026-11-24', { items: [step('a', true), answeredStep] })])
    render(page())
    await screen.findByText('My clients this week')
    const answered = screen.getByRole('region', { name: 'Answered' })
    expect(within(answered).getByText('Year-end prep')).toBeInTheDocument()
    // Not in this week's client list: the line says where it lives.
    expect(within(answered).getByText('due Nov 24 · later week')).toBeInTheDocument()
    expect(within(answered).getByText('Brittany answered. Open it to confirm and carry on.')).toBeInTheDocument()
    const toggle = within(later()).getByRole('button', { name: 'Due in a later week (1) · 1 answered' })
    fireEvent.click(toggle)
    expect(within(later()).getByText('Answered. Brittany answered. Open it to confirm and carry on.')).toBeInTheDocument()
  })

  it('a later task where someone is waiting on her says so, and the heading counts it', async () => {
    withChecklists([checklist('chk-next', 'c-acme', 'Year-end prep', '2026-11-24', { items: [step('a', true), onHerStep] })])
    render(page())
    await screen.findByText('My clients this week')
    fireEvent.click(within(later()).getByRole('button', { name: 'Due in a later week (1) · 1 waiting on you' }))
    expect(within(later()).getByText('Bob has been waiting on you since Nov 16.')).toBeInTheDocument()
  })

  it('a pushed task whose answer is in stays in "Answered: pick these up"', async () => {
    withChecklists([])
    contextValue = {
      ...contextValue,
      data: {
        ...contextValue.data,
        checklists: [
          ...data.checklists.filter((each) => each.id !== 'chk-payroll'),
          checklist('chk-payroll', 'c-acme', 'Payroll', '2026-11-18', { items: [step('a', true), answeredStep] }),
        ],
      },
    } as unknown as AppContextValue
    mockFetch.mockResolvedValue({
      weekStart: WEEK,
      userId: LISA,
      weekMoves: true,
      entries: [entry('c-acme', { taskMarks: { 'chk-payroll': { status: null, note: '', days: [], pushed: true } } })],
    })
    render(page())
    await screen.findByText('My clients this week')
    expect(within(row('Acme Dental')).queryByRole('link', { name: 'Payroll' })).not.toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Answered' })).getByText('Payroll')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Answered' })).getByText('pushed to next week')).toBeInTheDocument()
    const pushedLine = screen.getByRole('region', { name: 'Pushed to next week' })
    expect(within(pushedLine).getByRole('button', { name: 'Pushed to next week (1) · 1 answered' })).toBeInTheDocument()
  })

  it('Push on a task whose brought flag is stale (due date moved into this week) pushes it', async () => {
    mockFetch.mockResolvedValue({
      weekStart: WEEK,
      userId: LISA,
      weekMoves: true,
      entries: [
        entry('c-acme', {
          plannedDays: ['2026-11-19'],
          taskMarks: { 'chk-payroll': { status: null, note: '', days: ['2026-11-19'], brought: true } },
        }),
      ],
    })
    render(page())
    await screen.findByText('My clients this week')
    const acme = within(row('Acme Dental'))
    expect(acme.queryByText(/^Brought forward/)).not.toBeInTheDocument()
    fireEvent.click(acme.getByRole('button', { name: 'Push to next week for Payroll (Acme Dental)' }))
    expect(within(row('Acme Dental')).queryByRole('link', { name: 'Payroll' })).not.toBeInTheDocument()
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    expect(mockSave.mock.calls[0][1].taskMarks['chk-payroll']).toEqual({ status: null, note: '', days: [], pushed: true })
  })

  it('a task due on the week’s Saturday or Sunday reads "Due this week"', async () => {
    withChecklists([checklist('chk-sun', 'c-bright', 'Weekend close', '2026-11-22')])
    render(page())
    await screen.findByText('My clients this week')
    expect(within(row('Bright Books')).getByText('Due this week, Nov 22')).toBeInTheDocument()
  })

  it('a client added from the picker whose tasks are all later says where they are', async () => {
    withChecklists([checklist('chk-later', 'c-zeta', 'Cleanup', '2026-11-27')])
    contextValue = {
      ...contextValue,
      data: { ...contextValue.data, clients: [...data.clients, { id: 'c-zeta', name: 'Zeta Farms' }] },
    } as unknown as AppContextValue
    render(page())
    await screen.findByText('My clients this week')
    fireEvent.change(screen.getByLabelText('Work on a client that has no task'), { target: { value: 'c-zeta' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add to my week' }))
    const zeta = within(row('Zeta Farms'))
    expect(zeta.getByText(/Its tasks are due in a later week/)).toBeInTheDocument()
    expect(zeta.queryByText(/No task of yours is open/)).not.toBeInTheDocument()
  })

  it('each collapsed section button says which list it opens', async () => {
    withChecklists([checklist('chk-next', 'c-acme', 'Year-end prep', '2026-11-24')])
    render(page())
    await screen.findByText('My clients this week')
    const toggle = within(later()).getByRole('button', { name: /^Due in a later week/ })
    const controlled = toggle.getAttribute('aria-controls')
    expect(controlled).toBeTruthy()
    expect(document.getElementById(controlled as string)).not.toBeNull()
    expect(later().contains(document.getElementById(controlled as string))).toBe(true)
  })
})
