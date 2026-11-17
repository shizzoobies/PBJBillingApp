import { describe, expect, it } from 'vitest'
import {
  WEEK_PLAN_MARK_NOTE_MAX,
  WEEK_PLAN_NOTE_MAX,
  addDays,
  asPerTaskRow,
  buildWeekPlan,
  isDateOnly,
  isClientDayRow,
  isEmptyWeekPlanEntry,
  isMonday,
  isOpenWorkFor,
  mondayOf,
  monthEndOf,
  normalizeWeekPlanEntry,
  normalizeWeekPlanInput,
  taskDueFor,
  taskWaitState,
  weekDays,
  withTaskDayToggled,
  withTaskStatusSet,
} from './week-plan.js'

/**
 * My Week (featreq-f0e8046b). Brittany: "look at the week and say ok I need to
 * touch these clients ... and then sort clients by day"; Lisa "would sort her
 * own schedule ... and she could pick the day she wanted to touch them"; "I do
 * not want to micromanage their days".
 *
 * Her answers these pin: the list is every client with open work due this month
 * or overdue; one row per client with its tasks under it; the STATUS IS ON EACH
 * TASK; Monday to Friday.
 */

const WEEK = '2026-11-16' // a Monday
const TODAY = '2026-11-17'

describe('the calendar helpers', () => {
  it('knows a real date from a made-up one', () => {
    expect(isDateOnly('2026-11-16')).toBe(true)
    expect(isDateOnly('2028-02-29')).toBe(true)
    expect(isDateOnly('2026-02-29')).toBe(false)
    expect(isDateOnly('2026-02-30')).toBe(false)
    expect(isDateOnly('2026-13-01')).toBe(false)
    expect(isDateOnly('2026-11-16T00:00:00Z')).toBe(false)
    expect(isDateOnly('11/16/2026')).toBe(false)
    expect(isDateOnly(20261116)).toBe(false)
    expect(isDateOnly(null)).toBe(false)
  })

  it('moves by whole days across a month, a year and a leap day', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDays(WEEK, 7)).toBe('2026-11-23')
    expect(addDays(WEEK, -7)).toBe('2026-11-09')
  })

  it('across the autumn and spring clock changes a day is still a day', () => {
    // 2026-11-01 and 2026-03-08 are the US clock-change Sundays.
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01')
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02')
    expect(addDays('2026-03-07', 1)).toBe('2026-03-08')
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09')
    expect(mondayOf('2026-11-01')).toBe('2026-10-26')
    expect(mondayOf('2026-11-02')).toBe('2026-11-02')
  })

  it('finds the Monday of any day; a weekend belongs to the week that just ended', () => {
    expect(mondayOf('2026-11-16')).toBe('2026-11-16')
    expect(mondayOf('2026-11-17')).toBe('2026-11-16')
    expect(mondayOf('2026-11-20')).toBe('2026-11-16')
    expect(mondayOf('2026-11-21')).toBe('2026-11-16') // Saturday
    expect(mondayOf('2026-11-22')).toBe('2026-11-16') // Sunday
    expect(mondayOf('2026-11-23')).toBe('2026-11-23')
    expect(mondayOf('2027-01-01')).toBe('2026-12-28') // a Friday, across the year
  })

  it('only a Monday starts a week', () => {
    expect(isMonday('2026-11-16')).toBe(true)
    expect(isMonday('2026-11-15')).toBe(false)
    expect(isMonday('2026-11-17')).toBe(false)
    expect(isMonday('2026-02-30')).toBe(false)
    expect(isMonday('')).toBe(false)
    expect(isMonday(undefined)).toBe(false)
  })

  it('a week is Monday to Friday', () => {
    expect(weekDays(WEEK)).toEqual(['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20'])
    expect(weekDays('2026-11-30')).toEqual(['2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04'])
  })

  it('knows the last day of a month', () => {
    expect(monthEndOf('2026-11-16')).toBe('2026-11-30')
    expect(monthEndOf('2026-12-04')).toBe('2026-12-31')
    expect(monthEndOf('2028-02-10')).toBe('2028-02-29')
    expect(monthEndOf('2026-02-10')).toBe('2026-02-28')
  })
})

describe('normalizeWeekPlanEntry: what a stored row always looks like', () => {
  it('orders the days, drops repeats and junk, trims the note', () => {
    expect(
      normalizeWeekPlanEntry({
        clientId: 'c1',
        plannedDays: ['2026-11-18', '2026-11-16', '2026-11-18', 'tuesday', null, '2026-02-30'],
        note: '  bank feed   first ',
        taskMarks: { b: { status: 'finished' }, a: { status: 'questions', note: ' asked  her ' } },
        updatedAt: '2026-11-16T15:00:00.000Z',
      }),
    ).toEqual({
      clientId: 'c1',
      plannedDays: ['2026-11-16', '2026-11-18'],
      note: 'bank feed first',
      taskMarks: {
        a: { status: 'questions', note: 'asked her', days: [] },
        b: { status: 'finished', note: '', days: [] },
      },
      updatedAt: '2026-11-16T15:00:00.000Z',
    })
  })

  // Her send-back: days go on each task.
  it('a mark can carry the task’s days, with or without a status', () => {
    const entry = normalizeWeekPlanEntry({
      clientId: 'c1',
      taskMarks: {
        daysOnly: { days: ['2026-11-20', '2026-11-16', '2026-11-20', 'friday', '2026-02-30'] },
        both: { status: 'questions', note: ' asked ', days: ['2026-11-18'] },
        // A note with no status belongs to nothing and is dropped; the days stay.
        noteNoStatus: { note: 'stray', days: ['2026-11-17'] },
        // Neither a status nor a day: says nothing, not kept.
        nothing: { note: 'x', days: [] },
        badStatus: { status: 'planned', days: [] },
      },
    })
    expect(entry.taskMarks).toEqual({
      both: { status: 'questions', note: 'asked', days: ['2026-11-18'] },
      daysOnly: { status: null, note: '', days: ['2026-11-16', '2026-11-20'] },
      noteNoStatus: { status: null, note: '', days: ['2026-11-17'] },
    })
    expect(isEmptyWeekPlanEntry(entry)).toBe(false)
  })

  it('knows a row from before days were per task: days on the client, none on any task', () => {
    expect(isClientDayRow(normalizeWeekPlanEntry({ plannedDays: ['2026-11-18'] }))).toBe(true)
    expect(
      isClientDayRow(
        normalizeWeekPlanEntry({ plannedDays: ['2026-11-18'], taskMarks: { a: { status: 'questions' } } }),
      ),
    ).toBe(true)
    expect(
      isClientDayRow(
        normalizeWeekPlanEntry({ plannedDays: ['2026-11-18'], taskMarks: { a: { days: ['2026-11-18'] } } }),
      ),
    ).toBe(false)
    expect(isClientDayRow(normalizeWeekPlanEntry({ taskMarks: { a: { status: 'questions' } } }))).toBe(false)
    expect(isClientDayRow(null)).toBe(false)
  })

  it('keeps only the two marks a person can set, and cuts long text', () => {
    const entry = normalizeWeekPlanEntry({
      clientId: 'c1',
      note: 'n'.repeat(WEEK_PLAN_NOTE_MAX + 50),
      taskMarks: {
        ok: { status: 'questions', note: 'm'.repeat(WEEK_PLAN_MARK_NOTE_MAX + 50) },
        planned: { status: 'planned' },
        work: { status: 'work' },
        text: 'questions',
        nothing: null,
        '': { status: 'finished' },
      },
    })
    expect(entry.note).toHaveLength(WEEK_PLAN_NOTE_MAX)
    expect(Object.keys(entry.taskMarks)).toEqual(['ok'])
    expect(entry.taskMarks.ok.note).toHaveLength(WEEK_PLAN_MARK_NOTE_MAX)
  })

  it('never throws on junk', () => {
    const empty = { clientId: '', plannedDays: [], note: '', taskMarks: {}, updatedAt: null }
    for (const junk of [null, undefined, 7, 'x', [], { plannedDays: 'monday', taskMarks: [] }]) {
      expect(normalizeWeekPlanEntry(junk)).toEqual(empty)
    }
  })

  it('knows a row with nothing on it', () => {
    expect(isEmptyWeekPlanEntry(normalizeWeekPlanEntry({ clientId: 'c1' }))).toBe(true)
    expect(isEmptyWeekPlanEntry(normalizeWeekPlanEntry({ clientId: 'c1', note: '   ' }))).toBe(true)
    expect(isEmptyWeekPlanEntry(normalizeWeekPlanEntry({ plannedDays: ['2026-11-16'] }))).toBe(false)
    expect(isEmptyWeekPlanEntry(normalizeWeekPlanEntry({ note: 'x' }))).toBe(false)
    expect(isEmptyWeekPlanEntry(normalizeWeekPlanEntry({ taskMarks: { a: { status: 'finished' } } }))).toBe(false)
    expect(isEmptyWeekPlanEntry(null)).toBe(true)
  })
})

describe('normalizeWeekPlanInput: what a save may carry', () => {
  const context = { checklistIds: ['chk-1', 'chk-2'] }
  const ok = (input) => normalizeWeekPlanInput({ weekStart: WEEK, ...input }, context)

  it('accepts a whole row and hands back exactly what will be stored', () => {
    expect(
      ok({
        plannedDays: ['2026-11-20', '2026-11-16', '2026-11-16'],
        note: ' payroll  first ',
        taskMarks: { 'chk-1': { status: 'questions', note: ' asked ', days: ['2026-11-20', '2026-11-16', '2026-11-16'] } },
      }),
    ).toEqual({
      ok: true,
      value: {
        weekStart: WEEK,
        plannedDays: ['2026-11-16', '2026-11-20'],
        note: 'payroll first',
        taskMarks: { 'chk-1': { status: 'questions', note: 'asked', days: ['2026-11-16', '2026-11-20'] } },
      },
    })
  })

  it('takes each task’s days, and sets the row’s days to their union whatever was sent', () => {
    const result = ok({
      // What the request says the row's days are is never believed.
      plannedDays: ['2026-11-19'],
      taskMarks: {
        'chk-1': { days: ['2026-11-20', '2026-11-16'] },
        'chk-2': { status: 'finished', days: ['2026-11-16'] },
      },
    })
    expect(result).toEqual({
      ok: true,
      value: {
        weekStart: WEEK,
        plannedDays: ['2026-11-16', '2026-11-20'],
        note: '',
        taskMarks: {
          'chk-1': { status: null, note: '', days: ['2026-11-16', '2026-11-20'] },
          'chk-2': { status: 'finished', note: '', days: ['2026-11-16'] },
        },
      },
    })
  })

  it('never stores days on the row that no kept task carries', () => {
    // No task days at all: the row has none, whatever the request names.
    expect(ok({ plannedDays: ['2026-11-18'], taskMarks: { 'chk-1': { status: 'questions' } } }).value).toEqual({
      weekStart: WEEK,
      plannedDays: [],
      note: '',
      taskMarks: { 'chk-1': { status: 'questions', note: '', days: [] } },
    })
    // The only task carrying days is not this client's any more: its days go
    // with it, and the row must not fall back to "the client is on Monday".
    const moved = ok({
      plannedDays: ['2026-11-16'],
      taskMarks: { 'chk-gone': { days: ['2026-11-16'] }, 'chk-2': { status: 'finished' } },
    })
    expect(moved.value.plannedDays).toEqual([])
    expect(isClientDayRow(moved.value)).toBe(false)
  })

  it('refuses a task day outside that week’s Monday to Friday, or days that are not a list', () => {
    for (const day of ['2026-11-21', '2026-11-23', 'Monday', null, 16]) {
      expect(ok({ taskMarks: { 'chk-1': { days: [day] } } })).toEqual({
        ok: false,
        error: 'A day must be Monday to Friday of that week.',
      })
    }
    expect(ok({ taskMarks: { 'chk-1': { days: '2026-11-16' } } })).toEqual({
      ok: false,
      error: 'The days must be a list.',
    })
    // The refusal comes before the stale-checklist drop: a bad day is never quietly accepted.
    expect(ok({ taskMarks: { 'chk-gone': { days: ['2026-11-22'] } } }).ok).toBe(false)
  })

  it('a mark with no status is allowed only as days; an unknown status is still refused', () => {
    expect(ok({ taskMarks: { 'chk-1': { status: null, days: ['2026-11-16'] } } }).ok).toBe(true)
    expect(ok({ taskMarks: { 'chk-1': {} } }).value.taskMarks).toEqual({})
    expect(ok({ taskMarks: { 'chk-1': { status: 'planned', days: ['2026-11-16'] } } }).ok).toBe(false)
    expect(ok({ taskMarks: { 'chk-1': ['2026-11-16'] } }).ok).toBe(false)
  })

  it('days for a checklist that is not this client’s any more are dropped, and so leave the union', () => {
    const result = ok({
      taskMarks: { 'chk-1': { days: ['2026-11-16'] }, 'chk-gone': { days: ['2026-11-20'] } },
    })
    expect(result.value.plannedDays).toEqual(['2026-11-16'])
    expect(Object.keys(result.value.taskMarks)).toEqual(['chk-1'])
  })

  it('accepts an empty row (that is how a row is cleared)', () => {
    expect(ok({})).toEqual({
      ok: true,
      value: { weekStart: WEEK, plannedDays: [], note: '', taskMarks: {} },
    })
    expect(ok({ plannedDays: [], note: null, taskMarks: {} }).ok).toBe(true)
  })

  it('refuses a week that does not start on a Monday', () => {
    for (const weekStart of ['2026-11-17', '2026-11-15', '2026-13-01', '', null, undefined, 20261116]) {
      const result = normalizeWeekPlanInput({ weekStart, plannedDays: [] }, context)
      expect(result).toEqual({ ok: false, error: 'The week must start on a Monday.' })
    }
  })

  it('refuses a day outside that week’s Monday to Friday', () => {
    for (const day of ['2026-11-21', '2026-11-22', '2026-11-15', '2026-11-23', 'Monday', null, 16]) {
      expect(ok({ plannedDays: [day] })).toEqual({
        ok: false,
        error: 'A day must be Monday to Friday of that week.',
      })
    }
    expect(ok({ plannedDays: '2026-11-16' })).toEqual({ ok: false, error: 'The days must be a list.' })
  })

  it('refuses a note or a mark of the wrong kind', () => {
    expect(ok({ note: 12 }).ok).toBe(false)
    expect(ok({ note: { text: 'x' } }).ok).toBe(false)
    expect(ok({ taskMarks: [] }).ok).toBe(false)
    expect(ok({ taskMarks: 'questions' }).ok).toBe(false)
    expect(ok({ taskMarks: { 'chk-1': { status: 'done' } } })).toEqual({
      ok: false,
      error: 'A task can be marked In questions or Finished for month.',
    })
    expect(ok({ taskMarks: { 'chk-1': 'questions' } }).ok).toBe(false)
    expect(ok({ taskMarks: { 'chk-1': { status: 'questions', note: 5 } } }).ok).toBe(false)
  })

  it('a null mark clears it: "Work on this week" is no mark at all', () => {
    const result = ok({ taskMarks: { 'chk-1': null, 'chk-2': { status: 'finished' } } })
    expect(result.ok).toBe(true)
    expect(result.value.taskMarks).toEqual({ 'chk-2': { status: 'finished', note: '', days: [] } })
  })

  it('quietly drops a mark for a checklist that is not this client’s any more', () => {
    // Parsed, as a request body is: here __proto__ is a real key of its own.
    const result = ok({
      taskMarks: JSON.parse(
        '{"chk-1":{"status":"questions"},"chk-gone":{"status":"finished"},"__proto__":{"status":"finished"}}',
      ),
    })
    expect(result.ok).toBe(true)
    expect(Object.keys(result.value.taskMarks)).toEqual(['chk-1'])
  })

  it('with no checklists to check against, keeps no marks at all', () => {
    const result = normalizeWeekPlanInput({
      weekStart: WEEK,
      taskMarks: { 'chk-1': { status: 'questions' } },
    })
    expect(result.ok).toBe(true)
    expect(result.value.taskMarks).toEqual({})
  })
})

const item = (id, done, extra = {}) => ({ id, label: id, done, ...extra })
const checklist = (overrides = {}) => ({
  id: 'chk-1',
  title: 'Monthly close',
  clientId: 'c1',
  assigneeId: 'lisa',
  dueDate: '2026-11-30',
  viewerIds: [],
  editorIds: [],
  items: [item('a', true), item('b', false)],
  ...overrides,
})

describe('isOpenWorkFor: whose open work a checklist is', () => {
  it('is the assignee’s while a step is still open', () => {
    expect(isOpenWorkFor(checklist(), 'lisa')).toBe(true)
    expect(isOpenWorkFor(checklist(), 'allison')).toBe(false)
  })

  it('is not open once every step is done', () => {
    expect(isOpenWorkFor(checklist({ items: [item('a', true), item('b', true)] }), 'lisa')).toBe(false)
  })

  it('counts sub-steps: a step with an open sub-step is open', () => {
    const withSubs = checklist({
      items: [item('a', false, { subItems: [{ id: 's1', label: 's1', done: true }, { id: 's2', label: 's2', done: false }] })],
    })
    expect(isOpenWorkFor(withSubs, 'lisa')).toBe(true)
    const subsDone = checklist({
      items: [item('a', false, { subItems: [{ id: 's1', label: 's1', done: true }] })],
    })
    expect(isOpenWorkFor(subsDone, 'lisa')).toBe(false)
  })

  it('is also the work of someone an OPEN step is assigned to by name', () => {
    const shared = checklist({ items: [item('a', true, { assigneeId: 'allison' }), item('b', false, { assigneeId: 'pat' })] })
    expect(isOpenWorkFor(shared, 'pat')).toBe(true)
    // Allison's step is done: nothing of hers is open here.
    expect(isOpenWorkFor(shared, 'allison')).toBe(false)
    expect(isOpenWorkFor(shared, 'lisa')).toBe(true)
  })

  it('a checklist with no steps is open (nothing says it is done)', () => {
    expect(isOpenWorkFor(checklist({ items: [] }), 'lisa')).toBe(true)
  })

  it('never a skipped or deleted checklist, and never for nobody', () => {
    expect(isOpenWorkFor(checklist({ skippedAt: '2026-11-10T00:00:00.000Z' }), 'lisa')).toBe(false)
    expect(isOpenWorkFor(checklist({ deletedAt: '2026-11-10T00:00:00.000Z' }), 'lisa')).toBe(false)
    expect(isOpenWorkFor(checklist(), '')).toBe(false)
    expect(isOpenWorkFor(null, 'lisa')).toBe(false)
  })
})

/**
 * Her send-back (2026-11-16): "for Associated for instance there are 3 task
 * associated with it and I do not want to work on each task on the same day. I
 * need to be able to put them to different days." Confirmed: "each of
 * Associated Enterprise's 3 tasks can be put on a different day (e.g., task 1
 * Mon, task 2 Wed, task 3 Fri), and the five-day view at the top shows only
 * that task on each of those days, not the whole client on all three."
 */
describe('days are on each task', () => {
  const clients = [
    { id: 'c1', name: 'Associated Enterprise' },
    { id: 'c2', name: 'Bright Tower' },
  ]
  const three = [
    checklist({ id: 't1', title: 'Bank recs' }),
    checklist({ id: 't2', title: 'Payroll' }),
    checklist({ id: 't3', title: 'Sales tax' }),
  ]
  const build = (overrides = {}) =>
    buildWeekPlan({ checklists: three, clients, entries: [], userId: 'lisa', weekStart: WEEK, today: TODAY, ...overrides })
  const titlesOn = (view, date) => view.byDay.find((day) => day.date === date).items.map((line) => line.title)

  it('three tasks of one client on three different days: each day shows only its task', () => {
    const view = build({
      entries: [
        {
          clientId: 'c1',
          plannedDays: ['2026-11-16', '2026-11-18', '2026-11-20'],
          taskMarks: {
            t1: { days: ['2026-11-16'] },
            t2: { days: ['2026-11-18'] },
            t3: { days: ['2026-11-20'] },
          },
        },
      ],
    })
    expect(Object.fromEntries(view.rows[0].tasks.map((task) => [task.checklistId, task.days]))).toEqual({
      t1: ['2026-11-16'],
      t2: ['2026-11-18'],
      t3: ['2026-11-20'],
    })
    expect(view.byDay.map((day) => day.items.map((line) => line.title))).toEqual([
      ['Bank recs'],
      [],
      ['Payroll'],
      [],
      ['Sales tax'],
    ])
    expect(view.byDay[0].items[0]).toEqual({
      clientId: 'c1',
      clientName: 'Associated Enterprise',
      checklistId: 't1',
      title: 'Bank recs',
      parked: false,
      nothingOpen: false,
    })
    expect(view.rows[0].tasks.map((task) => task.status)).toEqual(['planned', 'planned', 'planned'])
    expect(view.rows[0].plannedDays).toEqual(['2026-11-16', '2026-11-18', '2026-11-20'])
  })

  it('a task with no day of its own is not planned, though its client’s other task is', () => {
    const view = build({
      entries: [{ clientId: 'c1', plannedDays: ['2026-11-16'], taskMarks: { t1: { days: ['2026-11-16'] } } }],
    })
    expect(Object.fromEntries(view.rows[0].tasks.map((task) => [task.checklistId, task.status]))).toEqual({
      t1: 'planned',
      t2: 'not_planned',
      t3: 'not_planned',
    })
    expect(view.rows[0].rollup).toMatchObject({ planned: 1, notPlanned: 2 })
    expect(view.rows[0].started).toBe(true)
    expect(titlesOn(view, '2026-11-16')).toEqual(['Bank recs'])
  })

  it('one task can be on two days', () => {
    const view = build({
      entries: [{ clientId: 'c1', taskMarks: { t2: { days: ['2026-11-17', '2026-11-19'] } } }],
    })
    expect(titlesOn(view, '2026-11-17')).toEqual(['Payroll'])
    expect(titlesOn(view, '2026-11-19')).toEqual(['Payroll'])
  })

  it('a row from before (days on the client) reads as every task on those days', () => {
    const view = build({ entries: [{ clientId: 'c1', plannedDays: ['2026-11-18'] }] })
    expect(view.rows[0].tasks.map((task) => task.days)).toEqual([['2026-11-18'], ['2026-11-18'], ['2026-11-18']])
    expect(titlesOn(view, '2026-11-18')).toEqual(['Bank recs', 'Payroll', 'Sales tax'])
    expect(view.rows[0].tasks.every((task) => task.status === 'planned')).toBe(true)
  })

  it('a task in questions or finished stays on its day, marked parked; a planned one is not', () => {
    const view = build({
      entries: [
        {
          clientId: 'c1',
          taskMarks: {
            t1: { status: 'questions', days: ['2026-11-17'] },
            t2: { status: 'finished', days: ['2026-11-17'] },
            t3: { days: ['2026-11-17'] },
          },
        },
      ],
    })
    expect(view.byDay[1].items.map((line) => [line.title, line.parked])).toEqual([
      ['Bank recs', true],
      ['Payroll', true],
      ['Sales tax', false],
    ])
  })

  it('a planned client with nothing open any more shows once on its days, as that', () => {
    const view = build({
      checklists: [checklist({ id: 't1', items: [item('a', true)] })],
      entries: [{ clientId: 'c1', plannedDays: ['2026-11-18'], taskMarks: { t1: { days: ['2026-11-18'] } } }],
    })
    expect(view.rows[0]).toMatchObject({ noOpenWork: true, plannedDays: ['2026-11-18'] })
    expect(view.byDay[2].items).toEqual([
      { clientId: 'c1', clientName: 'Associated Enterprise', checklistId: null, title: '', parked: true, nothingOpen: true },
    ])
  })

  it('orders a day by client, then task', () => {
    const view = build({
      checklists: [...three, checklist({ id: 'b1', clientId: 'c2', title: 'Aardvark review' })],
      entries: [
        { clientId: 'c2', taskMarks: { b1: { days: ['2026-11-16'] } } },
        { clientId: 'c1', taskMarks: { t3: { days: ['2026-11-16'] }, t1: { days: ['2026-11-16'] } } },
      ],
    })
    expect(view.byDay[0].items.map((line) => [line.clientName, line.title])).toEqual([
      ['Associated Enterprise', 'Bank recs'],
      ['Associated Enterprise', 'Sales tax'],
      ['Bright Tower', 'Aardvark review'],
    ])
  })

  describe('withTaskDayToggled: one click on one task', () => {
    const ids = ['t1', 't2', 't3']
    const empty = normalizeWeekPlanEntry({ clientId: 'c1' })

    it('puts the day on that task only, and the row’s days become the union', () => {
      const next = withTaskDayToggled(empty, ids, 't2', '2026-11-18')
      expect(next.taskMarks).toEqual({ t2: { status: null, note: '', days: ['2026-11-18'] } })
      expect(next.plannedDays).toEqual(['2026-11-18'])
      const more = withTaskDayToggled(next, ids, 't1', '2026-11-16')
      expect(more.plannedDays).toEqual(['2026-11-16', '2026-11-18'])
      expect(more.taskMarks.t1.days).toEqual(['2026-11-16'])
      expect(more.taskMarks.t2.days).toEqual(['2026-11-18'])
    })

    it('a second click takes the day off; a task left with nothing has no mark', () => {
      const on = withTaskDayToggled(empty, ids, 't2', '2026-11-18')
      const off = withTaskDayToggled(on, ids, 't2', '2026-11-18')
      expect(off.taskMarks).toEqual({})
      expect(off.plannedDays).toEqual([])
      expect(isEmptyWeekPlanEntry(off)).toBe(true)
    })

    it('keeps a status she had set on the task, and its note', () => {
      const marked = normalizeWeekPlanEntry({
        clientId: 'c1',
        taskMarks: { t2: { status: 'questions', note: 'asked' } },
      })
      const next = withTaskDayToggled(marked, ids, 't2', '2026-11-18')
      expect(next.taskMarks.t2).toEqual({ status: 'questions', note: 'asked', days: ['2026-11-18'] })
    })

    it('turns a row from before into per-task days: every task keeps the client’s days', () => {
      const before = normalizeWeekPlanEntry({ clientId: 'c1', plannedDays: ['2026-11-18'], note: 'kept' })
      // She adds Friday to one task.
      const next = withTaskDayToggled(before, ids, 't3', '2026-11-20')
      expect(next.taskMarks).toEqual({
        t1: { status: null, note: '', days: ['2026-11-18'] },
        t2: { status: null, note: '', days: ['2026-11-18'] },
        t3: { status: null, note: '', days: ['2026-11-18', '2026-11-20'] },
      })
      expect(next.plannedDays).toEqual(['2026-11-18', '2026-11-20'])
      expect(next.note).toBe('kept')
      expect(isClientDayRow(next)).toBe(false)
      // Or takes the client's day off just one of them.
      const off = withTaskDayToggled(before, ids, 't1', '2026-11-18')
      expect(Object.keys(off.taskMarks)).toEqual(['t2', 't3'])
      expect(off.plannedDays).toEqual(['2026-11-18'])
    })

    it('reads each task’s days off the row, so two clicks in a row build on each other', () => {
      const one = withTaskDayToggled(empty, ids, 't1', '2026-11-16')
      const two = withTaskDayToggled(one, ids, 't2', '2026-11-17')
      const three = withTaskDayToggled(two, ids, 't1', '2026-11-19')
      expect(three.taskMarks).toEqual({
        t1: { status: null, note: '', days: ['2026-11-16', '2026-11-19'] },
        t2: { status: null, note: '', days: ['2026-11-17'] },
      })
    })

    // Payroll set to In questions, then its due date moves into next month: it
    // is off her page for now, but what she set on it must still be there when
    // it comes back. (The server drops a mark only when the checklist is no
    // longer this client's at all.)
    it('leaves a mark on a task that is not on her page right now', () => {
      const withUnlisted = normalizeWeekPlanEntry({
        clientId: 'c1',
        taskMarks: { later: { status: 'questions', note: 'asked', days: ['2026-11-16'] } },
      })
      const next = withTaskDayToggled(withUnlisted, ids, 't1', '2026-11-17')
      expect(next.taskMarks).toEqual({
        later: { status: 'questions', note: 'asked', days: ['2026-11-16'] },
        t1: { status: null, note: '', days: ['2026-11-17'] },
      })
      expect(next.plannedDays).toEqual(['2026-11-16', '2026-11-17'])
    })

    it('a three-task row from before, changed on the middle task', () => {
      const before = normalizeWeekPlanEntry({
        clientId: 'c1',
        plannedDays: ['2026-11-18'],
        taskMarks: { t3: { status: 'finished', note: '' } },
      })
      const next = withTaskDayToggled(before, ids, 't2', '2026-11-18')
      expect(next.taskMarks).toEqual({
        t1: { status: null, note: '', days: ['2026-11-18'] },
        t3: { status: 'finished', note: '', days: ['2026-11-18'] },
      })
      expect(next.plannedDays).toEqual(['2026-11-18'])
    })
  })

  describe('asPerTaskRow: a row from before, in the new form', () => {
    const ids = ['t1', 't2', 't3']

    it('gives every listed task the client’s days and keeps the note and statuses', () => {
      const before = normalizeWeekPlanEntry({
        clientId: 'c1',
        plannedDays: ['2026-11-20', '2026-11-18'],
        note: 'bank feed first',
        taskMarks: { t2: { status: 'questions', note: 'asked' }, later: { status: 'finished' } },
      })
      const next = asPerTaskRow(before, ids)
      expect(next).toMatchObject({
        clientId: 'c1',
        note: 'bank feed first',
        plannedDays: ['2026-11-18', '2026-11-20'],
        taskMarks: {
          // Not on her page: untouched, and given no days.
          later: { status: 'finished', note: '', days: [] },
          t1: { status: null, note: '', days: ['2026-11-18', '2026-11-20'] },
          t2: { status: 'questions', note: 'asked', days: ['2026-11-18', '2026-11-20'] },
          t3: { status: null, note: '', days: ['2026-11-18', '2026-11-20'] },
        },
      })
      expect(isClientDayRow(next)).toBe(false)
      // What the page shows is the same before and after.
      const shown = (entry) =>
        buildWeekPlan({ checklists: three, clients, entries: [entry], userId: 'lisa', weekStart: WEEK, today: TODAY })
          .rows[0].tasks.map((task) => task.days)
      expect(shown(next)).toEqual(shown(before))
    })

    it('returns a row that is already per-task, or has no days, as it is', () => {
      const perTask = normalizeWeekPlanEntry({ clientId: 'c1', plannedDays: ['2026-11-16'], taskMarks: { t1: { days: ['2026-11-16'] } } })
      expect(asPerTaskRow(perTask, ids)).toBe(perTask)
      const noDays = normalizeWeekPlanEntry({ clientId: 'c1', note: 'x' })
      expect(asPerTaskRow(noDays, ids)).toBe(noDays)
    })

    it('with no task to carry them, the client’s days are let go', () => {
      const before = normalizeWeekPlanEntry({ clientId: 'c1', plannedDays: ['2026-11-18'], note: 'kept' })
      expect(asPerTaskRow(before, [])).toMatchObject({ plannedDays: [], note: 'kept', taskMarks: {} })
    })
  })

  describe('withTaskStatusSet: a status by hand', () => {
    it('sets and clears the status and keeps the task’s days', () => {
      const planned = normalizeWeekPlanEntry({ clientId: 'c1', taskMarks: { t1: { days: ['2026-11-16'] } } })
      const set = withTaskStatusSet(planned, 't1', 'questions')
      expect(set.taskMarks.t1).toEqual({ status: 'questions', note: '', days: ['2026-11-16'] })
      const cleared = withTaskStatusSet(set, 't1', null)
      expect(cleared.taskMarks.t1).toEqual({ status: null, note: '', days: ['2026-11-16'] })
      // A task with no days and no status has no mark at all.
      expect(withTaskStatusSet(normalizeWeekPlanEntry({ clientId: 'c1' }), 't1', null).taskMarks).toEqual({})
    })

    it('leaves the other tasks and the row’s days alone', () => {
      const row = normalizeWeekPlanEntry({
        clientId: 'c1',
        plannedDays: ['2026-11-16', '2026-11-18'],
        taskMarks: { t1: { days: ['2026-11-16'] }, t2: { days: ['2026-11-18'] } },
      })
      const next = withTaskStatusSet(row, 't2', 'finished')
      expect(next.plannedDays).toEqual(['2026-11-16', '2026-11-18'])
      expect(next.taskMarks.t1).toEqual({ status: null, note: '', days: ['2026-11-16'] })
      expect(next.taskMarks.t2).toEqual({ status: 'finished', note: '', days: ['2026-11-18'] })
    })

    it('on a row from before, the client’s days stay as they were', () => {
      const before = normalizeWeekPlanEntry({ clientId: 'c1', plannedDays: ['2026-11-18'] })
      const next = withTaskStatusSet(before, 't1', 'questions')
      expect(next.plannedDays).toEqual(['2026-11-18'])
      expect(isClientDayRow(next)).toBe(true)
    })

    it('anything but the two statuses is "Work on this week"', () => {
      const row = normalizeWeekPlanEntry({ clientId: 'c1', taskMarks: { t1: { status: 'questions', days: ['2026-11-16'] } } })
      expect(withTaskStatusSet(row, 't1', 'planned').taskMarks.t1.status).toBeNull()
      expect(withTaskStatusSet(row, 't1', undefined).taskMarks.t1.status).toBeNull()
    })
  })
})

describe('taskDueFor: the date a task is planned by', () => {
  it('is the checklist’s due date when no open step is due sooner', () => {
    expect(taskDueFor(checklist(), 'lisa')).toBe('2026-11-30')
    expect(taskDueFor(checklist({ items: [item('a', false, { dueDate: '2026-12-05' })] }), 'lisa')).toBe('2026-11-30')
  })

  it('is the soonest OPEN step’s due date when that comes first (the Board’s rule)', () => {
    const withSteps = checklist({
      dueDate: '2026-12-15',
      items: [
        item('a', true, { dueDate: '2026-11-05' }), // done: does not count
        item('b', false, { dueDate: '2026-11-18' }),
        item('c', false, { dueDate: '2026-11-25' }),
      ],
    })
    expect(taskDueFor(withSteps, 'lisa')).toBe('2026-11-18')
  })

  it('counts only HER open steps when just a step of the checklist is hers', () => {
    const shared = checklist({
      dueDate: '2026-12-15',
      items: [
        item('a', false, { dueDate: '2026-11-10', assigneeId: 'allison' }),
        item('b', false, { dueDate: '2026-11-20', assigneeId: 'pat' }),
      ],
    })
    expect(taskDueFor(shared, 'pat')).toBe('2026-11-20')
    expect(taskDueFor(shared, 'allison')).toBe('2026-11-10')
    // The person who holds the checklist is planned by the soonest of all of them.
    expect(taskDueFor(shared, 'lisa')).toBe('2026-11-10')
  })

  it('ignores a step date that is not a date', () => {
    expect(taskDueFor(checklist({ items: [item('a', false, { dueDate: 'soon' })] }), 'lisa')).toBe('2026-11-30')
    expect(taskDueFor(checklist({ items: [item('a', false, { dueDate: '' })] }), 'lisa')).toBe('2026-11-30')
  })
})

/**
 * Questions set themselves (ship 2). Her answer 4, to "Should a client move to
 * In questions by itself? The team already marks a step Waiting on you or on
 * the client. I would use that: when everything they have open ... is waiting,
 * it moves to Sent questions on its own, and comes back to the top of their day
 * when it is answered": "I like this". With her answer 3 it is read per TASK.
 */
const wait = (overrides = {}) => ({
  id: 'w1',
  blockerId: 'brittany',
  requestedBy: 'lisa',
  note: 'which account is this?',
  createdAt: '2026-11-16T15:00:00.000Z',
  ...overrides,
})

describe('taskWaitState: what the Waiting flags say about a task', () => {
  it('nothing, when no step is waiting', () => {
    expect(taskWaitState(checklist(), 'lisa')).toEqual({ auto: null, waits: [] })
  })

  it('questions, when EVERY open step is held by a wait', () => {
    const state = taskWaitState(
      checklist({ items: [item('a', true), item('b', false, { waitingOns: [wait()] })] }),
      'lisa',
    )
    expect(state.auto).toBe('questions')
    expect(state.waits).toEqual([{ move: 'out', who: 'brittany', onClient: false, toConfirm: false, askedBack: false, since: '2026-11-16', note: 'which account is this?' }])
  })

  it('not questions when one open step is waiting and another is ordinary work', () => {
    const state = taskWaitState(
      checklist({ items: [item('a', false, { waitingOns: [wait()] }), item('b', false)] }),
      'lisa',
    )
    expect(state.auto).toBeNull()
    // The wait is still reported; it just does not park the task.
    expect(state.waits).toHaveLength(1)
  })

  it('reads a wait on a sub-step: the step is held only when all its open sub-steps are', () => {
    const sub = (id, done, extra = {}) => ({ id, title: id, done, ...extra })
    const held = checklist({
      items: [item('a', false, { subItems: [sub('s1', true), sub('s2', false, { waitingOns: [wait()] })] })],
    })
    expect(taskWaitState(held, 'lisa').auto).toBe('questions')
    const partly = checklist({
      items: [item('a', false, { subItems: [sub('s1', false), sub('s2', false, { waitingOns: [wait()] })] })],
    })
    expect(taskWaitState(partly, 'lisa').auto).toBeNull()
  })

  it('answered, as soon as a wait has been answered and is hers to confirm', () => {
    const state = taskWaitState(
      checklist({
        items: [
          item('a', false, { waitingOns: [wait({ resolvedAt: '2026-11-17T14:00:00.000Z', resolvedBy: 'brittany' })] }),
          item('b', false),
        ],
      }),
      'lisa',
    )
    expect(state.auto).toBe('answered')
    // She asked, so it is hers to confirm; the page names who answered.
    expect(state.waits[0]).toMatchObject({ move: 'answered', who: 'brittany' })
  })

  it('a wait that was closed out (confirmed) holds nothing and is not listed', () => {
    const closed = wait({
      resolvedAt: '2026-11-17T14:00:00.000Z',
      verifiedAt: '2026-11-17T15:00:00.000Z',
    })
    expect(taskWaitState(checklist({ items: [item('a', false, { waitingOns: [closed] })] }), 'lisa')).toEqual({
      auto: null,
      waits: [],
    })
  })

  it('a wait on a step that is already done is not looked at', () => {
    const state = taskWaitState(
      checklist({ items: [item('a', true, { waitingOns: [wait()] }), item('b', false)] }),
      'lisa',
    )
    expect(state).toEqual({ auto: null, waits: [] })
  })

  it('a wait on the client says so', () => {
    const state = taskWaitState(
      checklist({ items: [item('a', false, { waitingOns: [wait({ blockerType: 'client', blockerId: 'c1' })] })] }),
      'lisa',
    )
    expect(state.auto).toBe('questions')
    expect(state.waits[0]).toMatchObject({ onClient: true })
  })

  it('a step flagged waiting the old way counts, with no name', () => {
    const state = taskWaitState(
      checklist({ items: [item('a', false, { waiting: true, waitingOn: 'statements from the bank' })] }),
      'lisa',
    )
    expect(state.auto).toBe('questions')
    expect(state.waits).toEqual([
      { move: 'out', who: null, onClient: false, toConfirm: false, askedBack: false, since: null, note: 'statements from the bank' },
    ])
  })

  it('when only a step is hers, only her steps are read', () => {
    const shared = checklist({
      items: [
        item('a', false, { assigneeId: 'pat', waitingOns: [wait({ requestedBy: 'pat' })] }),
        item('b', false, { assigneeId: 'allison' }),
      ],
    })
    // Pat's only step is waiting: in questions for Pat.
    expect(taskWaitState(shared, 'pat').auto).toBe('questions')
    // Allison's step is ordinary work, and Pat's wait is not hers to see here.
    expect(taskWaitState(shared, 'allison')).toEqual({ auto: null, waits: [] })
    // Lisa holds the checklist: one step waiting, one not.
    expect(taskWaitState(shared, 'lisa').auto).toBeNull()
  })

  // The Delayed page puts this wait on HER "Waiting on me" tab. Reading it as
  // In questions would grey the client out while she is the one holding it up.
  it('a step where SHE is the one being asked is her work, never In questions', () => {
    const askedOfHer = checklist({
      items: [item('a', false, { assigneeId: 'bob', waitingOns: [wait({ blockerId: 'lisa', requestedBy: 'bob' })] })],
    })
    const state = taskWaitState(askedOfHer, 'lisa')
    expect(state.auto).toBeNull()
    expect(state.waits).toEqual([expect.objectContaining({ move: 'mine', who: 'bob', since: '2026-11-16' })])
    // For Bob, whose step it is, the same wait is a question out with Lisa.
    const forBob = taskWaitState(askedOfHer, 'bob')
    expect(forBob.auto).toBe('questions')
    expect(forBob.waits).toEqual([expect.objectContaining({ move: 'out', who: 'lisa' })])
  })

  it('one step waiting on her and another out with someone else: it is work', () => {
    const mixed = checklist({
      items: [
        item('a', false, { waitingOns: [wait({ id: 'w1', blockerId: 'lisa', requestedBy: 'bob' })] }),
        item('b', false, { waitingOns: [wait({ id: 'w2' })] }),
      ],
    })
    expect(taskWaitState(mixed, 'lisa').auto).toBeNull()
  })

  it('an answer that someone ELSE has to confirm is not "Answered" for her: it is still out', () => {
    // Bob asked Lisa; Lisa has done her part; it is Bob's to confirm.
    const hersDone = checklist({
      items: [
        item('a', false, {
          assigneeId: 'bob',
          waitingOns: [
            wait({ blockerId: 'lisa', requestedBy: 'bob', resolvedAt: '2026-11-17T14:00:00.000Z', resolvedBy: 'lisa' }),
          ],
        }),
      ],
    })
    const state = taskWaitState(hersDone, 'lisa')
    expect(state.auto).toBe('questions')
    expect(state.waits).toEqual([expect.objectContaining({ move: 'out', who: 'bob', toConfirm: true })])
    // For Bob it is the answer he is waiting for.
    expect(taskWaitState(hersDone, 'bob').auto).toBe('answered')
  })

  it('an answer is hers to confirm when the step is assigned to her, even if someone else asked', () => {
    const state = taskWaitState(
      checklist({
        assigneeId: 'allison',
        items: [
          item('a', false, {
            assigneeId: 'lisa',
            waitingOns: [wait({ requestedBy: 'allison', resolvedAt: '2026-11-17T14:00:00.000Z', resolvedBy: 'brittany' })],
          }),
        ],
      }),
      'lisa',
    )
    expect(state.auto).toBe('answered')
  })

  it('reads a wait two levels down', () => {
    const deep = checklist({
      items: [
        item('a', false, {
          subItems: [{ id: 's1', title: 's1', done: false, subItems: [{ id: 'ss1', title: 'ss1', done: false, waitingOns: [wait()] }] }],
        }),
      ],
    })
    const state = taskWaitState(deep, 'lisa')
    expect(state.auto).toBe('questions')
    expect(state.waits).toHaveLength(1)
  })

  // The Board reads a waiting step as held whatever is beneath it
  // (stageOpenWorkAllWaiting). Decided on purpose to match: the flag on the
  // step speaks for the step.
  it('a step that is waiting itself is held even with an open sub-step beneath it', () => {
    const parentWaiting = checklist({
      items: [
        item('a', false, {
          waitingOns: [wait()],
          subItems: [{ id: 's1', title: 'Reconcile checking', done: false }],
        }),
      ],
    })
    expect(taskWaitState(parentWaiting, 'lisa').auto).toBe('questions')
  })

  it('after a send-back the wait is out again, since the day it was sent back', () => {
    const sentBack = wait({
      createdAt: '2026-11-02T15:00:00.000Z',
      sendBacks: [
        { at: '2026-11-10T15:00:00.000Z', by: 'lisa', note: 'not that one' },
        { at: '2026-11-13T15:00:00.000Z', by: 'lisa', note: 'still not it' },
      ],
    })
    const state = taskWaitState(checklist({ items: [item('a', false, { waitingOns: [sentBack] })] }), 'lisa')
    expect(state.auto).toBe('questions')
    expect(state.waits[0]).toMatchObject({ move: 'out', since: '2026-11-13' })
  })

  // Nothing moves until she answers, so it is her work, though the record
  // still calls it the other person's turn.
  it('a question the person asked sends back to HER is her move, not In questions', () => {
    const asked = wait({ questions: [{ at: '2026-11-16T18:00:00.000Z', by: 'brittany', note: 'which month?' }] })
    const state = taskWaitState(checklist({ items: [item('a', false, { waitingOns: [asked] })] }), 'lisa')
    expect(state.auto).toBeNull()
    expect(state.waits[0]).toMatchObject({ move: 'mine', askedBack: true, who: 'brittany' })
  })

  it('a question from an earlier lap (before the last send-back) is not waiting on anyone', () => {
    const stale = wait({
      questions: [{ at: '2026-11-10T18:00:00.000Z', by: 'brittany', note: 'which month?' }],
      sendBacks: [{ at: '2026-11-12T15:00:00.000Z', by: 'lisa', note: 'October, try again' }],
    })
    const state = taskWaitState(checklist({ items: [item('a', false, { waitingOns: [stale] })] }), 'lisa')
    expect(state.auto).toBe('questions')
    expect(state.waits[0]).toMatchObject({ move: 'out', askedBack: false })
  })

  it('a question back between two OTHER people is only mentioned: for her it is still out', () => {
    // Allison asked Brittany on her own step; Lisa holds the checklist.
    const theirs = checklist({
      items: [
        item('a', false, {
          assigneeId: 'allison',
          waitingOns: [
            wait({ requestedBy: 'allison', questions: [{ at: '2026-11-16T18:00:00.000Z', by: 'brittany', note: '?' }] }),
          ],
        }),
      ],
    })
    const state = taskWaitState(theirs, 'lisa')
    expect(state.auto).toBe('questions')
    expect(state.waits[0]).toMatchObject({ move: 'out', askedBack: true, who: 'brittany' })
    // For Allison it is hers to answer.
    expect(taskWaitState(theirs, 'allison').auto).toBeNull()
  })

  it('when she is the one asked and SHE asked the question back, it is still simply her move', () => {
    const state = taskWaitState(
      checklist({
        items: [
          item('a', false, {
            assigneeId: 'bob',
            waitingOns: [
              wait({ blockerId: 'lisa', requestedBy: 'bob', questions: [{ at: '2026-11-16T18:00:00.000Z', by: 'lisa', note: '?' }] }),
            ],
          }),
        ],
      }),
      'lisa',
    )
    expect(state.waits[0]).toMatchObject({ move: 'mine', who: 'bob', askedBack: false })
  })

  // The Delayed page shows her this sub-step under "Waiting on me". The step
  // above it is held by a wait out with someone else; parking the task would
  // hide that someone is waiting on her.
  it('someone waiting on HER on a sub-step keeps the task as work, though the step above is held', () => {
    const state = taskWaitState(
      checklist({
        items: [
          item('a', false, {
            waitingOns: [wait({ id: 'w-out' })],
            subItems: [
              { id: 's1', title: 's1', done: false, waitingOns: [wait({ id: 'w-me', blockerId: 'lisa', requestedBy: 'bob' })] },
            ],
          }),
        ],
      }),
      'lisa',
    )
    expect(state.auto).toBeNull()
    expect(state.waits.map((entry) => entry.move).sort()).toEqual(['mine', 'out'])
  })

  it('when only a step is hers and it is held, someone waiting on her on ANOTHER step still makes it work', () => {
    const shared = checklist({
      assigneeId: 'allison',
      items: [
        item('a', false, { assigneeId: 'bob', waitingOns: [wait({ id: 'w-me', blockerId: 'pat', requestedBy: 'bob' })] }),
        item('b', false, { assigneeId: 'pat', waitingOns: [wait({ id: 'w-out', blockerId: 'allison', requestedBy: 'pat' })] }),
      ],
    })
    const state = taskWaitState(shared, 'pat')
    expect(state.auto).toBeNull()
    expect(state.waits).toEqual([
      expect.objectContaining({ move: 'out', who: 'allison' }),
      expect.objectContaining({ move: 'mine', who: 'bob' }),
    ])
    // Without the wait on her, her held step parks it.
    const quiet = checklist({
      assigneeId: 'allison',
      items: [
        item('a', false, { assigneeId: 'bob', waitingOns: [wait({ id: 'w-x', blockerId: 'carol', requestedBy: 'bob' })] }),
        item('b', false, { assigneeId: 'pat', waitingOns: [wait({ id: 'w-out', blockerId: 'allison', requestedBy: 'pat' })] }),
      ],
    })
    const calm = taskWaitState(quiet, 'pat')
    expect(calm.auto).toBe('questions')
    // Other people's waits on other people's steps are not hers to see here.
    expect(calm.waits).toEqual([expect.objectContaining({ move: 'out', who: 'allison' })])
  })

  it('an answer that is hers outranks a wait that is her move; both are reported', () => {
    const both = checklist({
      items: [
        item('a', false, { waitingOns: [wait({ id: 'w1', resolvedAt: '2026-11-17T14:00:00.000Z', resolvedBy: 'brittany' })] }),
        item('b', false, { assigneeId: 'bob', waitingOns: [wait({ id: 'w2', blockerId: 'lisa', requestedBy: 'bob' })] }),
      ],
    })
    expect(taskWaitState(both, 'lisa').auto).toBe('answered')
  })

  it('a step with one wait out and one that is her move is not held', () => {
    const state = taskWaitState(
      checklist({
        items: [
          item('a', false, {
            waitingOns: [wait({ id: 'w1' }), wait({ id: 'w2', blockerId: 'lisa', requestedBy: 'bob' })],
          }),
        ],
      }),
      'lisa',
    )
    expect(state.auto).toBeNull()
  })

  it('two open sub-steps, one held and one with nothing on it: the step is not held', () => {
    const state = taskWaitState(
      checklist({
        items: [
          item('a', false, {
            subItems: [
              { id: 's1', title: 's1', done: false, waitingOns: [wait()] },
              { id: 's2', title: 's2', done: false },
            ],
          }),
        ],
      }),
      'lisa',
    )
    expect(state.auto).toBeNull()
  })

  it('an answer for someone else to confirm, on a checklist she holds but has no part in', () => {
    const state = taskWaitState(
      checklist({
        items: [
          item('a', false, {
            assigneeId: 'allison',
            waitingOns: [wait({ requestedBy: 'allison', resolvedAt: '2026-11-17T14:00:00.000Z', resolvedBy: 'brittany' })],
          }),
        ],
      }),
      'lisa',
    )
    expect(state.auto).toBe('questions')
    expect(state.waits[0]).toMatchObject({ move: 'out', toConfirm: true, who: 'allison' })
  })

  it('the old flag beside a named wait adds nothing: the named wait speaks', () => {
    const state = taskWaitState(
      checklist({ items: [item('a', false, { waiting: true, waitingOn: 'old note', waitingOns: [wait()] })] }),
      'lisa',
    )
    expect(state.waits).toHaveLength(1)
    expect(state.waits[0]).toMatchObject({ who: 'brittany' })
  })

  it('reads the day in the firm’s time zone, not in UTC', () => {
    // 02:00 UTC on the 17th is still the evening of the 16th for the firm.
    const late = wait({ createdAt: '2026-11-17T02:00:00.000Z' })
    const state = taskWaitState(checklist({ items: [item('a', false, { waitingOns: [late] })] }), 'lisa')
    expect(state.waits[0].since).toBe('2026-11-16')
  })

  it('a bad date on a wait does not break it', () => {
    const state = taskWaitState(
      checklist({ items: [item('a', false, { waitingOns: [wait({ createdAt: 'yesterday' })] })] }),
      'lisa',
    )
    expect(state.waits[0].since).toBeNull()
  })
})

describe('buildWeekPlan: questions that set themselves', () => {
  const clients = [
    { id: 'c1', name: 'Associated Enterprise' },
    { id: 'c2', name: 'Bright Tower' },
  ]
  const build = (overrides = {}) =>
    buildWeekPlan({ checklists: [], clients, entries: [], userId: 'lisa', weekStart: WEEK, today: TODAY, ...overrides })
  const waiting = (id, extra = {}) =>
    checklist({ id, items: [item('a', false, { waitingOns: [wait()] })], ...extra })
  const answeredOne = (id, extra = {}) =>
    checklist({
      id,
      items: [item('a', false, { waitingOns: [wait({ resolvedAt: '2026-11-17T14:00:00.000Z', resolvedBy: 'brittany' })] })],
      ...extra,
    })

  it('a task whose open work is all waiting is In questions with nothing set, and is in Sent questions', () => {
    const view = build({ checklists: [waiting('a')] })
    const [task] = view.rows[0].tasks
    expect(task).toMatchObject({ status: 'questions', auto: 'questions', hand: null })
    expect(task.waits).toEqual([expect.objectContaining({ move: 'out', who: 'brittany', since: '2026-11-16' })])
    expect(view.questions).toEqual([
      expect.objectContaining({ checklistId: 'a', auto: true, waits: task.waits }),
    ])
    // Questions are out: the client is not "not planned", and it is parked.
    expect(view.rows[0]).toMatchObject({ started: true, allParked: true })
    expect(view.notPlannedCount).toBe(0)
  })

  it('when the answer is in, the task reads Answered and leaves Sent questions', () => {
    const view = build({ checklists: [answeredOne('a')] })
    const [task] = view.rows[0].tasks
    expect(task).toMatchObject({ status: 'answered', auto: 'answered' })
    expect(task.waits).toEqual([expect.objectContaining({ move: 'answered', who: 'brittany' })])
    expect(view.questions).toEqual([])
    expect(view.answered).toEqual([expect.objectContaining({ checklistId: 'a', auto: true })])
    // An answer is something to pick up: the client is live again, not greyed.
    expect(view.rows[0].allParked).toBe(false)
    expect(view.rows[0].rollup).toEqual({ planned: 0, notPlanned: 0, questions: 0, answered: 1, finished: 0 })
  })

  it('an answer outranks a question she set by hand, and a question still waiting', () => {
    const view = build({
      checklists: [answeredOne('a')],
      entries: [{ clientId: 'c1', taskMarks: { a: { status: 'questions', note: 'emailed the client too' } } }],
    })
    expect(view.rows[0].tasks[0]).toMatchObject({ status: 'answered', hand: 'questions' })
    expect(view.questions).toEqual([])
  })

  it('"Finished for month" set by hand stands, whatever the waits say', () => {
    const view = build({
      checklists: [waiting('a'), answeredOne('b', { title: 'B' })],
      entries: [
        { clientId: 'c1', taskMarks: { a: { status: 'finished', note: '' }, b: { status: 'finished', note: '' } } },
      ],
    })
    expect(view.rows[0].tasks.map((task) => task.status)).toEqual(['finished', 'finished'])
    expect(view.rows[0].tasks.every((task) => task.waits.length === 0)).toBe(true)
    expect(view.questions).toEqual([])
    expect(view.answered).toEqual([])
  })

  it('a question she set by hand is not marked automatic, and carries no waits', () => {
    const view = build({
      checklists: [checklist({ id: 'a' })],
      entries: [{ clientId: 'c1', taskMarks: { a: { status: 'questions', note: 'emailed' } } }],
    })
    expect(view.questions).toEqual([
      expect.objectContaining({ auto: false, byHand: true, waits: [], note: 'emailed' }),
    ])
  })

  it('a question the flags set is not hers to clear; one she ALSO set by hand is', () => {
    const flagsOnly = build({ checklists: [waiting('a')] })
    expect(flagsOnly.questions).toEqual([expect.objectContaining({ auto: true, byHand: false })])
    const both = build({
      checklists: [waiting('a')],
      entries: [{ clientId: 'c1', taskMarks: { a: { status: 'questions', note: '' } } }],
    })
    expect(both.questions).toEqual([expect.objectContaining({ auto: true, byHand: true })])
  })

  it('one task waiting and one to do: the client stays live (her words: touched multiple times a week)', () => {
    const view = build({
      checklists: [waiting('a'), checklist({ id: 'b', title: 'B' })],
      entries: [{ clientId: 'c1', plannedDays: ['2026-11-17'] }],
    })
    expect(Object.fromEntries(view.rows[0].tasks.map((task) => [task.checklistId, task.status]))).toEqual({
      a: 'questions',
      b: 'planned',
    })
    expect(view.rows[0].allParked).toBe(false)
  })

  it('a task where someone is waiting on HER is ordinary work and says who is waiting', () => {
    const view = build({
      checklists: [
        checklist({
          id: 'a',
          items: [item('a', false, { assigneeId: 'bob', waitingOns: [wait({ blockerId: 'lisa', requestedBy: 'bob' })] })],
        }),
      ],
    })
    const [task] = view.rows[0].tasks
    expect(task).toMatchObject({ status: 'not_planned', auto: null })
    expect(task.waits).toEqual([expect.objectContaining({ move: 'mine', who: 'bob' })])
    expect(view.questions).toEqual([])
    expect(view.answered).toEqual([])
    // It is not parked, and it is still to be planned.
    expect(view.rows[0]).toMatchObject({ allParked: false, started: false })
    expect(view.notPlannedCount).toBe(1)
  })

  it('a client she planned that is now finished keeps its row and is not also counted as finished', () => {
    const view = build({
      checklists: [checklist({ id: 'f1', items: [item('a', true)] })],
      entries: [{ clientId: 'c1', plannedDays: ['2026-11-17'] }],
    })
    expect(view.rows.map((row) => row.clientId)).toEqual(['c1'])
    expect(view.rows[0].noOpenWork).toBe(true)
    expect(view.finishedClientCount).toBe(0)
  })

  it('"this month" for the finished count is today’s month, not the Friday’s', () => {
    const done = checklist({ id: 'nov', dueDate: '2026-11-25', items: [item('a', true)] })
    // The week of Mon Nov 30 to Fri Dec 4, looked at on that Monday.
    expect(
      build({ weekStart: '2026-11-30', today: '2026-11-30', checklists: [done] }).finishedClientCount,
    ).toBe(1)
    // The same week on Wednesday Dec 2: November's is last month now.
    expect(
      build({ weekStart: '2026-11-30', today: '2026-12-02', checklists: [done] }).finishedClientCount,
    ).toBe(0)
    // Looking at another week than today's: the month its Monday is in.
    expect(
      build({ weekStart: '2026-11-09', today: '2026-12-02', checklists: [done] }).finishedClientCount,
    ).toBe(1)
  })

  it('counts the clients finished for the month: everything she holds due this month is complete', () => {
    const done = (id, clientId, extra = {}) =>
      checklist({ id, clientId, items: [item('a', true)], ...extra })
    const view = build({
      checklists: [
        done('f1', 'c1'),
        done('f2', 'c1', { dueDate: '2026-11-05' }),
        // c2: one complete, one still open -> not finished.
        done('g1', 'c2'),
        checklist({ id: 'g2', clientId: 'c2' }),
      ],
    })
    expect(view.finishedClientCount).toBe(1)
    expect(view.rows.map((row) => row.clientId)).toEqual(['c2'])
  })

  it('does not count last month’s work, someone else’s, a skipped one, or a client with open work', () => {
    const done = (id, extra = {}) => checklist({ id, items: [item('a', true)], ...extra })
    expect(build({ checklists: [done('old', { dueDate: '2026-10-31' })] }).finishedClientCount).toBe(0)
    expect(build({ checklists: [done('theirs', { assigneeId: 'allison' })] }).finishedClientCount).toBe(0)
    expect(
      build({ checklists: [done('skipped', { skippedAt: '2026-11-10T00:00:00.000Z' })] }).finishedClientCount,
    ).toBe(0)
    // Complete this month, but an overdue checklist from last month is still open.
    expect(
      build({ checklists: [done('now'), checklist({ id: 'late', dueDate: '2026-10-20' })] }).finishedClientCount,
    ).toBe(0)
    // A checklist with no steps is open work (nothing says it is done), so its
    // client has a row and is not finished.
    const empty = build({ checklists: [checklist({ id: 'empty', items: [] })] })
    expect(empty.finishedClientCount).toBe(0)
    expect(empty.rows.map((row) => row.clientId)).toEqual(['c1'])
  })
})

describe('buildWeekPlan: the page', () => {
  const clients = [
    { id: 'c1', name: 'Associated Enterprise' },
    { id: 'c2', name: 'Bright Tower' },
    { id: 'c3', name: 'Zeta Co' },
  ]
  const build = (overrides = {}) =>
    buildWeekPlan({
      checklists: [],
      clients,
      entries: [],
      userId: 'lisa',
      weekStart: WEEK,
      today: TODAY,
      ...overrides,
    })

  it('lists every client she has open work for that is due this month or overdue', () => {
    const view = build({
      checklists: [
        checklist({ id: 'due-month', clientId: 'c1', dueDate: '2026-11-30' }),
        checklist({ id: 'overdue', clientId: 'c2', dueDate: '2026-10-31' }),
        checklist({ id: 'next-month', clientId: 'c3', dueDate: '2026-12-01' }),
        checklist({ id: 'not-hers', clientId: 'c3', dueDate: '2026-11-20', assigneeId: 'allison' }),
        checklist({ id: 'finished', clientId: 'c3', dueDate: '2026-11-20', items: [item('a', true)] }),
      ],
    })
    expect(view.rows.map((row) => row.clientId)).toEqual(['c1', 'c2'])
    expect(view.dueThrough).toBe('2026-11-30')
    expect(view.days).toEqual(weekDays(WEEK))
  })

  it('marks what is overdue and what is due this week', () => {
    const view = build({
      checklists: [
        checklist({ id: 'a', dueDate: '2026-11-10' }),
        checklist({ id: 'b', dueDate: '2026-11-16', title: 'B' }),
        checklist({ id: 'c', dueDate: '2026-11-20', title: 'C' }),
        checklist({ id: 'd', dueDate: '2026-11-30', title: 'D' }),
      ],
    })
    const byId = Object.fromEntries(view.rows[0].tasks.map((task) => [task.checklistId, task]))
    expect(byId.a).toMatchObject({ overdue: true, dueThisWeek: false })
    // Due Monday, today is Tuesday: overdue AND inside this week.
    expect(byId.b).toMatchObject({ overdue: true, dueThisWeek: true })
    expect(byId.c).toMatchObject({ overdue: false, dueThisWeek: true })
    expect(byId.d).toMatchObject({ overdue: false, dueThisWeek: false })
    // Soonest first.
    expect(view.rows[0].tasks.map((task) => task.checklistId)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('a checklist due next month is on the list when an open step of it is due this month', () => {
    const view = build({
      checklists: [
        checklist({
          id: 'year-end',
          dueDate: '2026-12-31',
          items: [item('a', true), item('b', false, { dueDate: '2026-11-19' })],
        }),
        checklist({ id: 'later', dueDate: '2026-12-31', title: 'Later', items: [item('a', false, { dueDate: '2026-12-10' })] }),
      ],
    })
    expect(view.rows[0].tasks).toEqual([
      expect.objectContaining({ checklistId: 'year-end', dueDate: '2026-11-19', dueThisWeek: true, overdue: false }),
    ])
  })

  it('a step that is already late makes the task overdue, though the checklist is not due yet', () => {
    const view = build({
      checklists: [
        checklist({ id: 'late-step', dueDate: '2026-11-30', items: [item('a', false, { dueDate: '2026-11-12' })] }),
      ],
    })
    expect(view.rows[0].tasks[0]).toMatchObject({ dueDate: '2026-11-12', overdue: true, dueThisWeek: false })
  })

  it('a week that runs into next month shows that month’s work too', () => {
    const view = build({
      weekStart: '2026-11-30',
      today: '2026-11-30',
      checklists: [checklist({ id: 'dec', dueDate: '2026-12-15' }), checklist({ id: 'jan', dueDate: '2027-01-05' })],
    })
    expect(view.dueThrough).toBe('2026-12-31')
    expect(view.rows[0].tasks.map((task) => task.checklistId)).toEqual(['dec'])
  })

  it('one row per client with its tasks under it, and how far along each is', () => {
    const view = build({
      checklists: [
        checklist({ id: 'close', title: 'Monthly close', items: [item('a', true), item('b', true), item('c', false)] }),
        checklist({ id: 'payroll', title: 'Payroll', dueDate: '2026-11-18', stageIndex: 1, stageCount: 3, caseId: 'case-1' }),
      ],
    })
    expect(view.rows).toHaveLength(1)
    expect(view.rows[0].tasks).toEqual([
      expect.objectContaining({ checklistId: 'payroll', stepsDone: 1, stepsTotal: 2, stageIndex: 1, stageCount: 3, caseId: 'case-1', mine: 'checklist' }),
      expect.objectContaining({ checklistId: 'close', stepsDone: 2, stepsTotal: 3, stageIndex: null, stageCount: null, mine: 'checklist' }),
    ])
  })

  it('says when only a step of the checklist is hers', () => {
    const view = build({
      userId: 'pat',
      checklists: [checklist({ items: [item('a', false, { assigneeId: 'pat' })] })],
    })
    expect(view.rows[0].tasks[0].mine).toBe('step')
  })

  it('a client is planned by putting it on a day; its tasks follow until one is marked', () => {
    const view = build({
      checklists: [checklist({ id: 'close' }), checklist({ id: 'payroll', title: 'Payroll' })],
      entries: [
        {
          clientId: 'c1',
          plannedDays: ['2026-11-18', '2026-11-16'],
          note: 'bank feed first',
          taskMarks: { payroll: { status: 'questions', note: 'asked Brittany' } },
        },
      ],
    })
    const [row] = view.rows
    expect(row.plannedDays).toEqual(['2026-11-16', '2026-11-18'])
    expect(row.note).toBe('bank feed first')
    // THE STATUS IS ON EACH TASK (her answer 3): one in questions, one planned.
    expect(Object.fromEntries(row.tasks.map((task) => [task.checklistId, task.status]))).toEqual({
      close: 'planned',
      payroll: 'questions',
    })
    expect(row.rollup).toEqual({ planned: 1, notPlanned: 0, questions: 1, answered: 0, finished: 0 })
    expect(row.allParked).toBe(false)
    expect(row.started).toBe(true)
    // What she set herself is kept apart from what is shown, for the picker.
    expect(Object.fromEntries(row.tasks.map((task) => [task.checklistId, task.hand]))).toEqual({
      close: null,
      payroll: 'questions',
    })
  })

  it('a client not on any day: its unmarked tasks are not planned', () => {
    const view = build({ checklists: [checklist()] })
    expect(view.rows[0].tasks[0].status).toBe('not_planned')
    expect(view.rows[0]).toMatchObject({ started: false, allParked: false, plannedDays: [] })
    expect(view.notPlannedCount).toBe(1)
  })

  it('is parked only when EVERY task is in questions or finished', () => {
    const tasks = [checklist({ id: 'a' }), checklist({ id: 'b', title: 'B' })]
    const some = build({
      checklists: tasks,
      entries: [{ clientId: 'c1', plannedDays: ['2026-11-17'], taskMarks: { a: { status: 'questions' } } }],
    })
    expect(some.rows[0].allParked).toBe(false)
    const all = build({
      checklists: tasks,
      entries: [
        {
          clientId: 'c1',
          plannedDays: ['2026-11-17'],
          taskMarks: { a: { status: 'questions' }, b: { status: 'finished' } },
        },
      ],
    })
    expect(all.rows[0].allParked).toBe(true)
    expect(all.rows[0].rollup).toEqual({ planned: 0, notPlanned: 0, questions: 1, answered: 0, finished: 1 })
  })

  it('a mark alone counts as started, so the client leaves the "not planned" count', () => {
    const view = build({
      checklists: [checklist()],
      entries: [{ clientId: 'c1', taskMarks: { 'chk-1': { status: 'questions' } } }],
    })
    expect(view.rows[0].started).toBe(true)
    expect(view.notPlannedCount).toBe(0)
  })

  it('puts the clients she has not started first, then by name', () => {
    const view = build({
      checklists: [
        checklist({ id: 'a', clientId: 'c1' }),
        checklist({ id: 'b', clientId: 'c2' }),
        checklist({ id: 'c', clientId: 'c3' }),
      ],
      entries: [{ clientId: 'c1', plannedDays: ['2026-11-16'] }],
    })
    expect(view.rows.map((row) => row.clientName)).toEqual(['Bright Tower', 'Zeta Co', 'Associated Enterprise'])
    expect(view.notPlannedCount).toBe(2)
  })

  it('lists sent questions task by task, with the client', () => {
    const view = build({
      checklists: [checklist({ id: 'a' }), checklist({ id: 'b', clientId: 'c2', title: 'Sales tax' })],
      entries: [
        { clientId: 'c1', taskMarks: { a: { status: 'questions', note: 'asked the client' } } },
        { clientId: 'c2', taskMarks: { b: { status: 'finished' } } },
      ],
    })
    expect(view.questions).toEqual([
      {
        clientId: 'c1',
        clientName: 'Associated Enterprise',
        checklistId: 'a',
        title: 'Monthly close',
        dueDate: '2026-11-30',
        note: 'asked the client',
        // She set it, so she clears it; no wait in the app is behind it.
        auto: false,
        byHand: true,
        waits: [],
      },
    ])
    expect(view.answered).toEqual([])
  })

  it('ignores a mark for a task that is no longer hers or no longer open', () => {
    const view = build({
      checklists: [checklist({ id: 'a' })],
      entries: [{ clientId: 'c1', taskMarks: { gone: { status: 'questions' }, a: { status: 'finished' } } }],
    })
    expect(view.rows[0].tasks.map((task) => task.checklistId)).toEqual(['a'])
    expect(view.questions).toEqual([])
  })

  it('keeps a client she put on a day after its work is finished, and says nothing is open', () => {
    const view = build({
      checklists: [checklist({ items: [item('a', true)] })],
      entries: [{ clientId: 'c1', plannedDays: ['2026-11-17'], note: '' }],
    })
    expect(view.rows).toHaveLength(1)
    expect(view.rows[0]).toMatchObject({ noOpenWork: true, tasks: [], allParked: false, started: true })
    expect(view.notPlannedCount).toBe(0)
  })

  it('does not keep a client with only a stale mark and nothing open', () => {
    const view = build({
      entries: [{ clientId: 'c1', taskMarks: { old: { status: 'questions' } } }],
    })
    expect(view.rows).toEqual([])
  })

  it('shows only this week’s days of a stored row, and never a client that is not on the list', () => {
    const view = build({
      checklists: [checklist()],
      entries: [
        { clientId: 'c1', plannedDays: ['2026-11-16', '2026-11-23'] },
        { clientId: 'gone', plannedDays: ['2026-11-16'], note: 'x' },
      ],
    })
    expect(view.rows.map((row) => row.clientId)).toEqual(['c1'])
    expect(view.rows[0].plannedDays).toEqual(['2026-11-16'])
  })

  it('each person sees only her own work on a shared client', () => {
    const shared = [
      checklist({ id: 'step1', assigneeId: 'lisa' }),
      checklist({ id: 'step2', assigneeId: 'allison', title: 'Review' }),
    ]
    expect(build({ checklists: shared, userId: 'lisa' }).rows[0].tasks.map((task) => task.checklistId)).toEqual(['step1'])
    expect(build({ checklists: shared, userId: 'allison' }).rows[0].tasks.map((task) => task.checklistId)).toEqual(['step2'])
    expect(build({ checklists: shared, userId: 'nobody' }).rows).toEqual([])
  })

  it('an empty week is empty, not an error', () => {
    expect(build()).toEqual({
      weekStart: WEEK,
      days: weekDays(WEEK),
      dueThrough: '2026-11-30',
      rows: [],
      byDay: weekDays(WEEK).map((date) => ({ date, items: [] })),
      notPlannedCount: 0,
      questions: [],
      answered: [],
      finishedClientCount: 0,
    })
    expect(build({ checklists: null, clients: null, entries: null }).rows).toEqual([])
  })
})
