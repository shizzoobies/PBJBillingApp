import type { AppData } from './types'

/**
 * Someone waiting for a particular local edit to reach the server through the
 * whole-workspace autosave - "Start the first one now" waits for its new
 * recipe, because the server cannot start a recipe it has not seen yet.
 *
 * A waiter names what it needs (`covers`) rather than "the next save": a save
 * already in flight when the edit was made carries the OLD workspace, and
 * settling on it would ask the server about a recipe it does not have.
 */
export type WorkspaceSaveWaiter = {
  covers: (saved: AppData) => boolean
  settle: (saved: boolean) => void
}

/**
 * Settle the waiters a finished save answers. `saved` is the workspace the
 * successful save sent, or null when saving has stopped for good (signed out,
 * a stale tab, a refused client delete) - every waiter then hears `false`.
 * A failed save that will be retried settles nobody: the waiter keeps waiting
 * for the retry. Returns the waiters still waiting.
 */
export function settleWorkspaceSaveWaiters(
  waiters: WorkspaceSaveWaiter[],
  saved: AppData | null,
): WorkspaceSaveWaiter[] {
  if (waiters.length === 0) return waiters
  return waiters.filter((waiter) => {
    if (saved === null) {
      waiter.settle(false)
      return false
    }
    if (waiter.covers(saved)) {
      waiter.settle(true)
      return false
    }
    return true
  })
}
