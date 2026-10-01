/**
 * Display order for a checklist's steps (and a step's sub-steps): the open ones
 * in their saved order, then the done ones in their saved order.
 *
 * This is a DISPLAY sort and nothing about it is persisted. A done step keeps
 * its saved slot; ticking it only moves it below the open group on screen, and
 * un-ticking brings it back to where it was saved. So a reorder acts within the
 * OPEN group, and the full order sent to the server is the new open order
 * followed by the existing done order (see {@link orderAfterDrag} and
 * {@link orderAfterMove}) - the saved order of done steps never changes.
 */

type StepLike = { id: string; done?: boolean }

const isDone = (step: StepLike) => Boolean(step.done)

/** Open steps in saved order, then done steps in saved order. Pure; never mutates. */
export function orderStepsForDisplay<T extends StepLike>(steps: readonly T[]): T[] {
  return [...steps.filter((step) => !isDone(step)), ...steps.filter(isDone)]
}

/** Move the entry at `from` to `to`, shifting the ones between. */
function moved(ids: string[], from: number, to: number): string[] {
  const next = [...ids]
  const [entry] = next.splice(from, 1)
  next.splice(to, 0, entry)
  return next
}

/**
 * The full order to send after dragging `draggedId` onto `targetId`: the new
 * order of the open steps followed by the existing order of the done steps. Null
 * when nothing should be sent - either id is unknown or done (a done step is not
 * part of the open group), or they are the same step.
 */
export function orderAfterDrag(
  steps: readonly StepLike[],
  draggedId: string,
  targetId: string,
): string[] | null {
  if (draggedId === targetId) return null
  const open = steps.filter((step) => !isDone(step)).map((step) => step.id)
  const done = steps.filter(isDone).map((step) => step.id)
  const from = open.indexOf(draggedId)
  const to = open.indexOf(targetId)
  if (from === -1 || to === -1) return null
  return [...moved(open, from, to), ...done]
}

/**
 * The full order to send after "Move up" / "Move down" on `stepId`, one place
 * within the open group. Null when it cannot move that way (already first or
 * last among the open steps) or the step is unknown or done.
 */
export function orderAfterMove(
  steps: readonly StepLike[],
  stepId: string,
  direction: 'up' | 'down',
): string[] | null {
  const open = steps.filter((step) => !isDone(step)).map((step) => step.id)
  const done = steps.filter(isDone).map((step) => step.id)
  const from = open.indexOf(stepId)
  if (from === -1) return null
  const to = direction === 'up' ? from - 1 : from + 1
  if (to < 0 || to >= open.length) return null
  return [...moved(open, from, to), ...done]
}

/** localStorage key for a checklist's "Hide completed" preference. */
export const hideDoneKey = (checklistId: string) => `pbj.hideDone.v1.${checklistId}`

/** Read the preference (per browser, like the section collapse bools). Off by default. */
export function readHideDone(checklistId: string): boolean {
  try {
    return window.localStorage.getItem(hideDoneKey(checklistId)) === '1'
  } catch {
    return false
  }
}

export function writeHideDone(checklistId: string, hidden: boolean) {
  try {
    window.localStorage.setItem(hideDoneKey(checklistId), hidden ? '1' : '0')
  } catch {
    // localStorage may be unavailable (private mode / quota) - the toggle still
    // works for this visit, it just is not remembered.
  }
}
