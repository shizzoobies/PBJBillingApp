import { describe, expect, it } from 'vitest'
import {
  WEEK_PLAN_MARK_NOTE_MAX,
  WEEK_PLAN_NOTE_MAX,
  addDays,
  buildWeekPlan,
  isDateOnly,
  isEmptyWeekPlanEntry,
  isMonday,
  isOpenWorkFor,
  mondayOf,
  monthEndOf,
  normalizeWeekPlanEntry,
  normalizeWeekPlanInput,
  taskDueFor,
  weekDays,
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
      taskMarks: { a: { status: 'questions', note: 'asked her' }, b: { status: 'finished', note: '' } },
      updatedAt: '2026-11-16T15:00:00.000Z',
    })
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
        taskMarks: { 'chk-1': { status: 'questions', note: ' asked ' } },
      }),
    ).toEqual({
      ok: true,
      value: {
        weekStart: WEEK,
        plannedDays: ['2026-11-16', '2026-11-20'],
        note: 'payroll first',
        taskMarks: { 'chk-1': { status: 'questions', note: 'asked' } },
      },
    })
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
    expect(result.value.taskMarks).toEqual({ 'chk-2': { status: 'finished', note: '' } })
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
    expect(row.rollup).toEqual({ planned: 1, notPlanned: 0, questions: 1, finished: 0 })
    expect(row.allParked).toBe(false)
    expect(row.started).toBe(true)
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
    expect(all.rows[0].rollup).toEqual({ planned: 0, notPlanned: 0, questions: 1, finished: 1 })
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
      },
    ])
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
      notPlannedCount: 0,
      questions: [],
    })
    expect(build({ checklists: null, clients: null, entries: null }).rows).toEqual([])
  })
})
