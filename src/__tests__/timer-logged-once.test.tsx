import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DUPLICATE_SESSION_MESSAGE,
  MAX_WORK_SESSIONS,
  TIMER_ALREADY_LOGGED_MESSAGE,
  findAlreadyLoggedTimer,
  hasDuplicateSessionStart,
  normalizeWorkSessions,
} from '../../lib/time-entry.js'
import { createTimeEntry, updateTimeEntryRequest } from '../lib/api'
import { TIMER_STORAGE_KEY, sameStoredTimer, subscribeStoredTimer } from '../lib/timerStorage'
import {
  isDuplicateSessionRefusal,
  isTimerAlreadyLogged,
  stretchAlreadyIn,
  withSavedTimeEntry,
  withoutStoppedTimer,
} from '../lib/timerStop'
import { TimeCapture } from '../pages/TimePage'
import {
  ApiError,
  type Client,
  type Employee,
  type TimeEntry,
  type TimerState,
  type TimerStopResult,
} from '../lib/types'

/**
 * A TIMER IS LOGGED ONCE.
 *
 * Production, 2026-11-04 (featreq-0a6de076, "two entries on the same day at the
 * same time"): one timer, saved twice, 12 seconds apart. Two rows with the
 * identical start instant, the same client, task and note, both approved, the
 * time paid and billed twice. The running timer lives in the browser; nothing
 * on the server knew a timer had already been saved, and an open tab kept its
 * own copy of a timer another tab had logged.
 *
 * Three layers, each tested here (the store's one-at-a-time save is in
 * db/store-staleness.test.mjs):
 *  - the server refuses a repeat of the same timer (the guarantee);
 *  - every tab of a browser follows the stored timer (so a person does not
 *    reach the refusal);
 *  - the page treats the refusal as "already done", not as a failure, and never
 *    clears a timer whose time was not saved.
 */

const START = '2026-11-04T21:04:00.253Z'
const entry = (over: Record<string, unknown> = {}) => ({
  id: 'time-1',
  employeeId: 'emp-lisa',
  startAt: START,
  endAt: '2026-11-04T22:15:39.693Z',
  sessions: [{ startAt: START, endAt: '2026-11-04T22:15:39.693Z' }],
  ...over,
})
const repeat = [{ startAt: START, endAt: '2026-11-04T22:15:51.273Z' }]

describe('findAlreadyLoggedTimer', () => {
  it('finds the entry the same timer already made (the production pair)', () => {
    const first = entry()
    expect(
      findAlreadyLoggedTimer({
        entries: [entry({ id: 'time-0', startAt: undefined, sessions: [] }), first],
        employeeId: 'emp-lisa',
        sessions: repeat,
      }),
    ).toBe(first)
  })

  it('is exact to the millisecond: a timer started a moment later is a different timer', () => {
    expect(
      findAlreadyLoggedTimer({
        entries: [entry()],
        employeeId: 'emp-lisa',
        sessions: [{ startAt: '2026-11-04T21:04:00.254Z' }],
      }),
    ).toBeNull()
  })

  it('compares instants, not spellings of them', () => {
    expect(
      findAlreadyLoggedTimer({
        entries: [entry()],
        employeeId: 'emp-lisa',
        sessions: [{ startAt: '2026-11-04T16:04:00.253-05:00' }],
      }),
    ).not.toBeNull()
  })

  it('never matches another person’s entry', () => {
    expect(findAlreadyLoggedTimer({ entries: [entry()], employeeId: 'emp-allison', sessions: repeat })).toBeNull()
  })

  it('finds a timer that was resumed into an entry (one of several stretches)', () => {
    const resumed = entry({
      startAt: '2026-11-04T14:00:00.000Z',
      sessions: [
        { startAt: '2026-11-04T14:00:00.000Z', endAt: '2026-11-04T14:30:00.000Z' },
        { startAt: START, endAt: '2026-11-04T22:15:39.693Z' },
      ],
    })
    expect(findAlreadyLoggedTimer({ entries: [resumed], employeeId: 'emp-lisa', sessions: repeat })).toBe(resumed)
  })

  it('finds a block that was saved and then split (every share keeps the block’s stretches)', () => {
    const shares = [entry({ id: 'time-a', groupId: 'grp-1' }), entry({ id: 'time-b', groupId: 'grp-1' })]
    expect(findAlreadyLoggedTimer({ entries: shares, employeeId: 'emp-lisa', sessions: repeat })).toBe(shares[0])
  })

  it('reads an older entry with a start and stop and no stretches', () => {
    const older = entry({ sessions: [] })
    expect(findAlreadyLoggedTimer({ entries: [older], employeeId: 'emp-lisa', sessions: repeat })).toBe(older)
    // ...but an entry WITH stretches is read by its stretches, not its envelope.
    const edited = entry({ sessions: [{ startAt: '2026-11-04T21:10:00.000Z', endAt: '2026-11-04T22:00:00.000Z' }] })
    expect(findAlreadyLoggedTimer({ entries: [edited], employeeId: 'emp-lisa', sessions: repeat })).toBeNull()
  })

  it('answers null, never an entry, when there is nothing to compare', () => {
    expect(findAlreadyLoggedTimer()).toBeNull()
    expect(findAlreadyLoggedTimer({ entries: [entry()], employeeId: '', sessions: repeat })).toBeNull()
    expect(findAlreadyLoggedTimer({ entries: [entry()], employeeId: 'emp-lisa', sessions: [] })).toBeNull()
    expect(
      findAlreadyLoggedTimer({ entries: [entry()], employeeId: 'emp-lisa', sessions: [{ startAt: 'not a time' }] }),
    ).toBeNull()
    expect(findAlreadyLoggedTimer({ entries: null, employeeId: 'emp-lisa', sessions: repeat })).toBeNull()
    // Minutes-only entries (no stamps at all) can never be "the same timer".
    expect(
      findAlreadyLoggedTimer({
        entries: [entry({ startAt: undefined, endAt: undefined, sessions: [] })],
        employeeId: 'emp-lisa',
        sessions: repeat,
      }),
    ).toBeNull()
  })
})

describe('hasDuplicateSessionStart', () => {
  it('is true when one stretch is listed twice', () => {
    expect(
      hasDuplicateSessionStart([
        { startAt: '2026-11-04T14:00:00.000Z' },
        { startAt: START },
        { startAt: '2026-11-04T16:04:00.253-05:00' },
      ]),
    ).toBe(true)
  })

  it('is false for distinct stretches, an empty list and nonsense', () => {
    expect(hasDuplicateSessionStart([{ startAt: '2026-11-04T14:00:00.000Z' }, { startAt: START }])).toBe(false)
    expect(hasDuplicateSessionStart([])).toBe(false)
    expect(hasDuplicateSessionStart(null)).toBe(false)
    expect(hasDuplicateSessionStart([{ startAt: 'x' }, { startAt: 'x' }, {}])).toBe(false)
  })
})

describe('normalizeWorkSessions: one entry holds a bounded number of stretches', () => {
  const stretches = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      startAt: new Date(Date.UTC(2026, 10, 4, 0, 0, index * 2)).toISOString(),
      endAt: new Date(Date.UTC(2026, 10, 4, 0, 0, index * 2 + 1)).toISOString(),
    }))

  it('takes the most it allows and refuses one more, before parsing any of them', () => {
    expect(normalizeWorkSessions(stretches(MAX_WORK_SESSIONS)).error).toBeNull()
    expect(normalizeWorkSessions(stretches(MAX_WORK_SESSIONS + 1))).toEqual({
      error: `An entry can hold at most ${MAX_WORK_SESSIONS} work sessions.`,
    })
    // Not even a list of nonsense that long is walked.
    expect(normalizeWorkSessions(new Array(MAX_WORK_SESSIONS + 1).fill(null)).error).toMatch(/at most/)
  })
})

describe('the routes (read from server.js)', () => {
  const server = readFileSync(resolve(__dirname, '../../server.js'), 'utf8').replace(/\r\n/g, '\n')
  const post = server.slice(
    server.indexOf("if (normalizedPath === '/api/time-entries') {"),
    server.indexOf("if (normalizedPath === '/api/time-entries/approve-batch') {"),
  )

  it('POST asks first on the workspace it read, before every gate (month lock, weekly gate, visibility)', () => {
    const ask = post.indexOf('findAlreadyLoggedTimer({')
    expect(ask).toBeGreaterThan(-1)
    expect(ask).toBeGreaterThan(post.indexOf('const allData = await appDataStore.read()'))
    // A month locked since the first save must not hide "already logged" behind a 423.
    expect(ask).toBeLessThan(post.indexOf('appDataStore.isTimesheetLocked('))
    expect(ask).toBeLessThan(post.indexOf('listBlockingWeeks('))
    expect(ask).toBeLessThan(post.indexOf("'Client not visible to this user'"))
    // The workspace is still read exactly once.
    expect(post.split('await appDataStore.read()').length - 1).toBe(1)
    const early = post.slice(post.indexOf('if (isTimerCapture) {'), post.indexOf('listBlockingWeeks('))
    expect(early).toContain('entries: allData.timeEntries,')
    expect(early).toContain('employeeId,')
    expect(early).toContain('sessions: finalSessions,')
    expect(early).toContain('answerTimerAlreadyLogged(alreadyLogged)\n            return')
  })

  it('POST asks only for a timer capture that is not a share of a split', () => {
    expect(post).toContain("const isTimerCapture = entryMethod === 'timer' && !groupId")
  })

  // The read above is several awaits old by the time of the insert: two
  // requests for one timer in flight together would both pass it.
  it('POST saves a timer capture through the store’s one-at-a-time door, and nothing else that way', () => {
    const save = post.slice(post.indexOf('let entry\n'), post.indexOf("if (entryMethod === 'manual' && ownTime) {"))
    expect(save).toContain('if (isTimerCapture) {')
    expect(save).toContain('const saved = await appDataStore.createTimerEntryOnce(newEntry)')
    expect(save).toContain('if (saved.alreadyLogged) {\n            answerTimerAlreadyLogged(saved.entry)\n            return\n          }')
    expect(save).toContain('entry = saved.entry')
    expect(save).toContain('entry = await appDataStore.createTimeEntry(newEntry)')
    // The only two saves in the route.
    expect(post.split('appDataStore.createTimeEntry(').length - 1).toBe(1)
    expect(post.split('appDataStore.createTimerEntryOnce(').length - 1).toBe(1)
  })

  it('the refusal is a 409 with a code and a sentence, and hands back the entry only to someone who can see it', () => {
    const answer = post.slice(
      post.indexOf('const answerTimerAlreadyLogged = (existing) => {'),
      post.indexOf('const isTimerCapture ='),
    )
    expect(answer).toContain("session.user.role === 'owner' ||")
    expect(answer).toContain(
      'isTimeEntryVisibleToScope(existing, session.user.id, visibleClientIdSet(session, allData))',
    )
    expect(answer).toContain('sendJson(response, 409, {')
    expect(answer).toContain("error: 'timer_already_logged',")
    expect(answer).toContain('message: TIMER_ALREADY_LOGGED_MESSAGE,')
    expect(answer).toContain('...(visible ? { entry: existing } : {}),')
    // Never the entry outright.
    expect(answer).not.toMatch(/^\s*entry: existing,/m)
  })

  it('PATCH refuses a stretch listed twice before the entry is touched', () => {
    const patch = server.slice(server.indexOf("if (Object.prototype.hasOwnProperty.call(payload ?? {}, 'sessions')) {"))
    const refuse = patch.indexOf('if (hasDuplicateSessionStart(sessionsResult.sessions)) {')
    expect(refuse).toBeGreaterThan(-1)
    expect(refuse).toBeLessThan(patch.indexOf('patch.sessions = sessionsResult.sessions'))
    expect(patch.slice(refuse, refuse + 240)).toContain(
      "sendJson(response, 409, { error: 'duplicate_session', message: DUPLICATE_SESSION_MESSAGE })",
    )
  })

  it('the sentences say what to do', () => {
    // A page that does not know the code shows this with its timer still on screen.
    expect(TIMER_ALREADY_LOGGED_MESSAGE).toMatch(/not saved a second time/)
    expect(TIMER_ALREADY_LOGGED_MESSAGE).toMatch(/Refresh the page/)
    expect(TIMER_ALREADY_LOGGED_MESSAGE).toMatch(/Cancel/)
    expect(DUPLICATE_SESSION_MESSAGE).toMatch(/counted twice/)
    expect(DUPLICATE_SESSION_MESSAGE).toMatch(/Nothing was changed/)
  })
})

describe('the browser’s door (src/lib/api.ts)', () => {
  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })
  const draft = { employeeId: 'emp-lisa', clientId: 'c1', date: '2026-11-04', minutes: 71.65 } as Omit<
    TimeEntry,
    'id' | 'approvalStatus'
  >

  it('a refused repeat carries the code and the entry the first save made', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: 'timer_already_logged', message: TIMER_ALREADY_LOGGED_MESSAGE, entry: entry() }, 409),
    )
    const error = await createTimeEntry(draft).catch((caught) => caught)
    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(409)
    expect(error.code).toBe('timer_already_logged')
    expect(error.message).toBe(TIMER_ALREADY_LOGGED_MESSAGE)
    expect(error.timeEntry).toMatchObject({ id: 'time-1' })
    expect(isTimerAlreadyLogged(error)).toBe(true)
  })

  it('a refused repeat whose entry the person may not see carries the code alone', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: 'timer_already_logged', message: TIMER_ALREADY_LOGGED_MESSAGE }, 409),
    )
    const error = await createTimeEntry(draft).catch((caught) => caught)
    expect(isTimerAlreadyLogged(error)).toBe(true)
    expect(error.timeEntry).toBeUndefined()
  })

  it('an ordinary refusal is unchanged: the server’s sentence, and no code made out of it', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: 'You have an unsubmitted timesheet for the week of 2026-11-01.' }, 423),
    )
    const error = await createTimeEntry(draft).catch((caught) => caught)
    expect(error.status).toBe(423)
    expect(error.message).toBe('You have an unsubmitted timesheet for the week of 2026-11-01.')
    expect(error.code).toBeUndefined()
    expect(error.timeEntry).toBeUndefined()
    expect(isTimerAlreadyLogged(error)).toBe(false)
  })

  it('a reply with no readable body still says something', async () => {
    fetchMock.mockResolvedValue(new Response('<html>', { status: 502 }))
    const error = await createTimeEntry(draft).catch((caught) => caught)
    expect(error.message).toBe('Failed to create time entry (502)')
    expect(error.code).toBeUndefined()
  })

  it('an edit refused for a stretch listed twice carries its code, which is NOT "already logged"', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'duplicate_session', message: DUPLICATE_SESSION_MESSAGE }, 409))
    const error = await updateTimeEntryRequest('time-1', { sessions: [] }).catch((caught) => caught)
    expect(error.status).toBe(409)
    expect(error.code).toBe('duplicate_session')
    expect(error.message).toBe(DUPLICATE_SESSION_MESSAGE)
    expect(isDuplicateSessionRefusal(error)).toBe(true)
    // The list is wrong; that says nothing about a running timer's time being stored.
    expect(isTimerAlreadyLogged(error)).toBe(false)
  })
})

describe('the small rules of stopping a timer (src/lib/timerStop.ts)', () => {
  const timer = (startedAt: number): TimerState => ({
    employeeId: 'emp-lisa',
    clientId: 'c1',
    description: '',
    startedAt,
    taskId: null,
  })

  it('only a 409 with the code is "already logged"', () => {
    expect(isTimerAlreadyLogged(new ApiError(409, 'x', 'timer_already_logged'))).toBe(true)
    expect(isTimerAlreadyLogged(new ApiError(400, 'x', 'timer_already_logged'))).toBe(false)
    expect(isTimerAlreadyLogged(new ApiError(409, 'x'))).toBe(false)
    expect(isTimerAlreadyLogged(new ApiError(409, 'x', 'prepayment_unpaid'))).toBe(false)
    expect(isTimerAlreadyLogged(new Error('timer_already_logged'))).toBe(false)
    expect(isTimerAlreadyLogged(null)).toBe(false)
  })

  it('clears the timer that was stopped, and never a newer one', () => {
    const stopped = timer(1000)
    const newer = timer(2000)
    expect(withoutStoppedTimer(stopped, 1000)).toBeNull()
    // A late reply for timer 1000 arrives while timer 2000 (started in another tab) is running here.
    expect(withoutStoppedTimer(newer, 1000)).toBe(newer)
    expect(withoutStoppedTimer(null, 1000)).toBeNull()
  })

  it('puts the entry the first save made into the list once', () => {
    const a = { id: 'time-a', minutes: 5 } as TimeEntry
    const b = { id: 'time-b', minutes: 9 } as TimeEntry
    const fresh = { id: 'time-b', minutes: 71.65 } as TimeEntry
    // Already held: replaced in place, never a second row with the same id.
    expect(withSavedTimeEntry([a, b], fresh)).toEqual([a, fresh])
    // Not held yet: added.
    expect(withSavedTimeEntry([a], fresh)).toEqual([fresh, a])
    expect(withSavedTimeEntry([], fresh)).toEqual([fresh])
  })

  it('knows when a resumed timer’s stretch is already in its entry', () => {
    const prior = [
      { startAt: '2026-11-04T14:00:00.000Z', endAt: '2026-11-04T14:30:00.000Z' },
      { startAt: START, endAt: '2026-11-04T22:15:39.693Z' },
    ]
    expect(stretchAlreadyIn(prior, START)).toBe(true)
    expect(stretchAlreadyIn(prior, '2026-11-04T16:04:00.253-05:00')).toBe(true)
    expect(stretchAlreadyIn(prior, '2026-11-04T21:04:00.254Z')).toBe(false)
    expect(stretchAlreadyIn([], START)).toBe(false)
    expect(stretchAlreadyIn(prior, 'not a time')).toBe(false)
  })
})

describe('one timer, however many tabs (src/lib/timerStorage.ts)', () => {
  const running: TimerState = {
    employeeId: 'emp-lisa',
    clientId: 'c1',
    description: '',
    startedAt: Date.parse(START),
    taskId: null,
  }
  afterEach(() => {
    localStorage.removeItem(TIMER_STORAGE_KEY)
  })
  // What the browser does in every OTHER tab when one tab changes the stored timer.
  const fromAnotherTab = (key: string | null) => window.dispatchEvent(new StorageEvent('storage', { key }))

  it('hands a tab the timer another tab started or changed', () => {
    const seen: Array<TimerState | null> = []
    const stop = subscribeStoredTimer((timer) => seen.push(timer))
    localStorage.setItem(TIMER_STORAGE_KEY, JSON.stringify(running))
    fromAnotherTab(TIMER_STORAGE_KEY)
    expect(seen).toEqual([running])
    stop()
  })

  it('clears a tab’s timer when another tab logged or canceled it', () => {
    const seen: Array<TimerState | null> = []
    const stop = subscribeStoredTimer((timer) => seen.push(timer))
    localStorage.removeItem(TIMER_STORAGE_KEY)
    fromAnotherTab(TIMER_STORAGE_KEY)
    // The whole store cleared reads the same way.
    fromAnotherTab(null)
    expect(seen).toEqual([null, null])
    stop()
  })

  it('ignores every other stored thing, and stops when told to', () => {
    const seen: Array<TimerState | null> = []
    const stop = subscribeStoredTimer((timer) => seen.push(timer))
    fromAnotherTab('pbj.reportPeriod.v1.emp-lisa')
    stop()
    fromAnotherTab(TIMER_STORAGE_KEY)
    expect(seen).toEqual([])
  })

  it('tells the same timer in the same state from a changed one', () => {
    expect(sameStoredTimer(null, null)).toBe(true)
    expect(sameStoredTimer(running, { ...running })).toBe(true)
    expect(sameStoredTimer(running, { ...running, description: 'bank feed' })).toBe(false)
    expect(sameStoredTimer(running, { ...running, startedAt: running.startedAt + 1 })).toBe(false)
    expect(sameStoredTimer(running, null)).toBe(false)
    expect(sameStoredTimer(null, running)).toBe(false)
  })
})

describe('App wires the rules together (read from App.tsx)', () => {
  const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8').replace(/\r\n/g, '\n')
  const between = (from: string, to: string) => app.slice(app.indexOf(from), app.indexOf(to, app.indexOf(from)))

  it('follows the stored timer, and does not write back what it only received', () => {
    const sync = between('const receivedTimerRef = useRef<', '// The EFFECTIVE identity')
    expect(sync).toContain('subscribeStoredTimer((stored) => {')
    expect(sync).toContain('if (sameStoredTimer(current, stored)) return current')
    // What was received is remembered as a VALUE (boxed, so "nothing running" counts)...
    expect(sync).toContain('receivedTimerRef.current = { timer: stored }\n          return stored')
    // ...the skip is for that exact value only, and whichever run comes next
    // spends it, so a change made here in the same moment is always written.
    expect(sync).toContain(
      'const received = receivedTimerRef.current\n    receivedTimerRef.current = null\n    if (received && received.timer === timer) return\n    writeStoredTimer(timer)',
    )
  })

  it('never clears a timer whose time was not saved', () => {
    const log = between('const logStoppedTimer = async (', 'const stopTimer = async (')
    // No bare "clear the timer" is left: only the stopped one is cleared.
    expect(log).not.toContain('setTimer(null)')
    expect(log).toContain('const clearStoppedTimer = () => setTimer((current) => withoutStoppedTimer(current, stoppedStartedAt))')
    // Each of the three saves is asked whether it saved before the timer goes.
    expect(log).toContain(
      "if (!(await saveTimeEntryPatch(existing.id, { sessions: [...prior, session] }))) {\n          return { outcome: 'not_saved' }\n        }\n        clearStoppedTimer()",
    )
    expect(log).toContain("if (!savedBlock) return { outcome: 'not_saved' }\n      clearStoppedTimer()")
    expect(log).toContain("if (!saved) return { outcome: 'not_saved' }\n    clearStoppedTimer()")
    expect(log.split('clearStoppedTimer()').length - 1).toBe(4)
    // A resumed timer whose stretch is already in the entry sends nothing.
    const resume = log.slice(log.indexOf('if (stretchAlreadyIn(prior, session.startAt)) {'), log.indexOf('saveTimeEntryPatch('))
    expect(resume).toContain("return { outcome: 'already_logged', entry: existing }")
  })

  it('a save that found the session ended says it did not save', () => {
    const create = between('const saveNewTimeEntry = async (', 'const logTime = async (')
    expect(create).toContain('if (previewActiveRef.current) return false')
    expect(create).toContain("setDataSyncState('offline')\n        return false")
    expect(create).toContain("setDataSyncState('synced')\n      return true")
    const update = between('const saveTimeEntryPatch = async (', 'const updateTimeEntry = async (')
    expect(update).toContain('if (previewActiveRef.current) return false')
    expect(update).toContain("setDataSyncState('offline')\n        return false")
    expect(update).toContain("setDataSyncState('synced')\n      return true")
  })

  it('turns only "already logged" into an outcome; everything else is still thrown with the timer running', () => {
    const stop = between('const stopTimer = async (', 'const saveTimeEntryPatch = async (')
    expect(stop).toContain('return await logStoppedTimer(descriptionOverride)')
    expect(stop).toContain('if (!isTimerAlreadyLogged(error)) throw error')
    expect(stop).toContain('timeEntries: withSavedTimeEntry(current.timeEntries, saved),')
    expect(stop).toContain('setTimer((current) => withoutStoppedTimer(current, stoppedStartedAt))')
    expect(stop).not.toContain('setTimer(null)')
    expect(stop).toContain("outcome: 'already_logged'")
    // A list refused for naming one stretch twice is a clean refusal, not the alarm, and not "already logged".
    const update = between('const saveTimeEntryPatch = async (', 'const updateTimeEntry = async (')
    expect(update).toContain("if (isDuplicateSessionRefusal(error)) {")
    expect(update).not.toContain('isTimerAlreadyLogged')
  })
})

describe('the Live timer panel', () => {
  const CLIENTS = [{ id: 'client-1', name: 'Acme Dental' }] as Client[]
  const EMPLOYEES = [{ id: 'emp-me', name: 'Me', role: 'Bookkeeper' }] as Employee[]

  /** Owns the timer the way App does: a stop that did not save leaves it running. */
  function Harness({ onStop }: { onStop: () => Promise<TimerStopResult | void> }) {
    const [timer, setTimer] = useState<TimerState | null>(null)
    return (
      <>
        {/* A timer can start and end without this panel: the top bar, a client page, another tab. */}
        <button
          type="button"
          onClick={() =>
            setTimer({ employeeId: 'emp-me', clientId: 'client-1', description: '', startedAt: 5000, taskId: null })
          }
        >
          a timer starts elsewhere
        </button>
        <button type="button" onClick={() => setTimer(null)}>
          that timer ends elsewhere
        </button>
      <TimeCapture
        activeEmployeeId="emp-me"
        clients={CLIENTS}
        checklists={[]}
        templates={[]}
        onGenerateFromTemplate={async () => null}
        employees={EMPLOYEES}
        onStartTimer={setTimer}
        onStopTimer={async () => {
          const result = await onStop()
          if (!result || result.outcome !== 'not_saved') setTimer(null)
          return result
        }}
        onUpdateTimer={(patch) => setTimer((current) => (current ? { ...current, ...patch } : current))}
        onCancelTimer={vi.fn()}
        role="owner"
        timer={timer}
        timerElapsed="42m"
        locked={false}
        previewMode={false}
        currentPeriod="2026-11"
      />
      </>
    )
  }
  const startButton = () => screen.getByRole('button', { name: /start timer/i })
  const stopButton = () => screen.getByRole('button', { name: /stop & log/i })
  const detailBox = () => screen.getByRole('textbox', { name: /what did you do|notes/i })
  const taskBox = () => screen.getByPlaceholderText('Pick a task or type your own')
  function fillAndStart() {
    fireEvent.change(screen.getByRole('combobox', { name: 'Client' }), { target: { value: 'client-1' } })
    fireEvent.change(taskBox(), { target: { value: 'Bank feed' } })
    fireEvent.change(detailBox(), { target: { value: 'Matched the feed.' } })
    fireEvent.click(startButton())
  }
  const firstSave = {
    id: 'time-1',
    minutes: 71.65,
    startAt: START,
    endAt: '2026-11-04T22:15:39.693Z',
    sessions: [{ startAt: START, endAt: '2026-11-04T22:15:39.693Z' }],
  } as TimeEntry

  it('says the timer was logged already, with what the first save holds, and shows no error', async () => {
    render(<Harness onStop={async () => ({ outcome: 'already_logged', entry: firstSave })} />)
    fillAndStart()
    fireEvent.click(stopButton())

    const notice = await screen.findByRole('status')
    const when = new Date(firstSave.endAt as string).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    expect(notice).toHaveTextContent(`This timer had already been logged (stopped at ${when}, 1h 11m saved)`)
    expect(notice).toHaveTextContent('it was not saved a second time')
    expect(notice).toHaveTextContent('edit that entry in Recent time to add the time')
    expect(screen.queryByText('Could not log this time.')).not.toBeInTheDocument()
    // The entry holds what was typed, so the form is wiped as after any log.
    expect(detailBox()).toHaveValue('')
  })

  it('leaves out the particulars when they would not be this timer’s', async () => {
    const plain = 'This timer had already been logged, so it was not saved a second time.'
    // The first entry is not known.
    const { unmount } = render(<Harness onStop={async () => ({ outcome: 'already_logged' })} />)
    fillAndStart()
    fireEvent.click(stopButton())
    expect(await screen.findByRole('status')).toHaveTextContent(plain)
    unmount()

    // A share of a split holds its own minutes, not the timer's.
    const share = render(
      <Harness onStop={async () => ({ outcome: 'already_logged', entry: { ...firstSave, groupId: 'grp-1', minutes: 13 } })} />,
    )
    fillAndStart()
    fireEvent.click(stopButton())
    expect(await screen.findByRole('status')).toHaveTextContent(plain)
    share.unmount()

    // A resumed entry's last stop and total are the whole entry's.
    const resumed = {
      ...firstSave,
      sessions: [{ startAt: '2026-11-04T14:00:00.000Z', endAt: '2026-11-04T14:30:00.000Z' }, ...(firstSave.sessions ?? [])],
    }
    render(<Harness onStop={async () => ({ outcome: 'already_logged', entry: resumed })} />)
    fillAndStart()
    fireEvent.click(stopButton())
    expect(await screen.findByRole('status')).toHaveTextContent(plain)
  })

  // The notice is about one timer. It must not come back when a LATER timer,
  // started and ended somewhere else, leaves the panel idle again.
  it('the notice ends with the next timer, wherever that one runs', async () => {
    render(<Harness onStop={async () => ({ outcome: 'already_logged' })} />)
    fillAndStart()
    fireEvent.click(stopButton())
    await screen.findByRole('status')

    fireEvent.click(screen.getByRole('button', { name: 'a timer starts elsewhere' }))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'that timer ends elsewhere' }))
    await screen.findByRole('button', { name: /start timer/i })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('an ordinary log says nothing', async () => {
    render(<Harness onStop={async () => ({ outcome: 'logged' })} />)
    fillAndStart()
    fireEvent.click(stopButton())
    await screen.findByRole('button', { name: /start timer/i })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(detailBox()).toHaveValue('')
  })

  // The session had ended: the app goes back to sign-in with the timer still
  // running. Wiping the form here would throw away what goes on the entry.
  it('keeps the timer and everything typed when nothing was saved', async () => {
    let finished = false
    render(
      <Harness
        onStop={async () => {
          finished = true
          return { outcome: 'not_saved' }
        }}
      />,
    )
    fillAndStart()
    fireEvent.click(stopButton())
    await vi.waitFor(() => expect(finished).toBe(true))
    await vi.waitFor(() => expect(stopButton()).toBeEnabled())

    expect(screen.queryByRole('button', { name: /start timer/i })).not.toBeInTheDocument()
    expect(detailBox()).toHaveValue('Matched the feed.')
    expect(taskBox()).toHaveValue('Bank feed')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByText('Could not log this time.')).not.toBeInTheDocument()
  })
})
