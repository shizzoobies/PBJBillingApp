import type { TimerState } from './types'

// The running timer is persisted in the browser so a refresh or a tab switch
// doesn't lose it (the elapsed time is recomputed from `startedAt`). Cleared on
// stop / cancel.
export const TIMER_STORAGE_KEY = 'pbj.activeTimer.v1'

export function readStoredTimer(): TimerState | null {
  try {
    const raw = localStorage.getItem(TIMER_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as TimerState
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.employeeId === 'string' &&
      typeof parsed.startedAt === 'number' &&
      Number.isFinite(parsed.startedAt)
    ) {
      return parsed
    }
  } catch {
    // ignore malformed / unavailable storage
  }
  return null
}

export function writeStoredTimer(timer: TimerState | null) {
  try {
    if (timer) localStorage.setItem(TIMER_STORAGE_KEY, JSON.stringify(timer))
    else localStorage.removeItem(TIMER_STORAGE_KEY)
  } catch {
    // ignore storage failures
  }
}

/** Do these two hold the same timer in the same state (what the store would hold for each)? */
export function sameStoredTimer(a: TimerState | null, b: TimerState | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * ONE timer, however many tabs. Every tab and window of a browser shares the
 * stored timer, but each kept its own copy from the moment it loaded: stop and
 * log it in one tab and the others went on showing it running, one press away
 * from logging the same time again (production, 2026-11-04: one timer saved
 * twice, 12 seconds apart). The browser tells every OTHER tab when the stored
 * timer changes; this hands each of them the timer as it now is (started,
 * edited, or gone).
 *
 * The server's own refusal (`findAlreadyLoggedTimer`) is the guarantee; this is
 * what keeps a person from reaching it. (The desktop app and a browser do not
 * share storage, so each has its own timers; a timer started in one never
 * exists in the other.)
 *
 * Returns the function that stops listening.
 */
export function subscribeStoredTimer(listener: (timer: TimerState | null) => void): () => void {
  const onStorage = (event: StorageEvent) => {
    // `key` is null when the whole store was cleared.
    if (event.key !== null && event.key !== TIMER_STORAGE_KEY) return
    listener(readStoredTimer())
  }
  window.addEventListener('storage', onStorage)
  return () => window.removeEventListener('storage', onStorage)
}
