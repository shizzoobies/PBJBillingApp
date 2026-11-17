import { ApiError, type TimeEntry, type TimerState, type WorkSession } from './types'

/**
 * The small rules of stopping a timer, kept out of App.tsx so they can be run.
 * They exist because "a timer is logged once" (see `findAlreadyLoggedTimer` in
 * lib/time-entry.js) has to hold without ever throwing away time that was NOT
 * saved: each of these answers one "is it really the same / really saved?"
 * question exactly.
 */

/** The server found this very timer saved already; nothing was saved a second time. */
export function isTimerAlreadyLogged(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 409 && error.code === 'timer_already_logged'
}

/**
 * The server refused a list of stretches that names one start twice. A clean
 * refusal (nothing is unsaved), but NOT "already logged": it says the list is
 * wrong, not that this timer's stretch is stored. The timer keeps running.
 */
export function isDuplicateSessionRefusal(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 409 && error.code === 'duplicate_session'
}

/** The list with `saved` in it once: in place when it is already there, first when it is new. */
export function withSavedTimeEntry(entries: TimeEntry[], saved: TimeEntry): TimeEntry[] {
  return entries.some((entry) => entry.id === saved.id)
    ? entries.map((entry) => (entry.id === saved.id ? saved : entry))
    : [saved, ...entries]
}

/**
 * Clear the timer that was STOPPED, and only that one. A reply can come back
 * late (a deploy pause), after another tab logged this timer and the person
 * started the next one; that newer timer reached this tab through
 * `subscribeStoredTimer`, and a bare "clear the timer" would delete it unsaved.
 * A timer is identified by the millisecond it started.
 */
export function withoutStoppedTimer(current: TimerState | null, stoppedStartedAt: number): TimerState | null {
  return current && current.startedAt === stoppedStartedAt ? null : current
}

/**
 * Is a stretch starting at this instant already among these? A RESUMED timer
 * adds one stretch to its entry, so when the entry (as this tab now holds it)
 * already has that stretch, another tab added it: there is nothing to send.
 */
export function stretchAlreadyIn(prior: ReadonlyArray<WorkSession>, startAt: string): boolean {
  const wanted = Date.parse(startAt)
  if (!Number.isFinite(wanted)) return false
  return prior.some((session) => Date.parse(session.startAt) === wanted)
}
