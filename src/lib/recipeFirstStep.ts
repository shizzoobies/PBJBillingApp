/**
 * "Start the first one now" and the recipe editor's per-step dates
 * (featreq-8b54d117).
 *
 * Brittany's report: "Step 1 of a checklist should populate on the show before
 * due (days) and have the due date assigned at the step level. Step 2 should
 * auto populate once step 1 has been completed with the due date assigned to
 * it." The "Start the first one now" box used to create a plain one-off
 * checklist (due today, no recipe, no step fields), so ticking it finished at
 * the last step and Step 2 never followed - and the recipe later made its real
 * Step 1 as well. It now asks the server for the recipe's REAL Step 1
 * (`generateChecklistFromTemplate`, which is idempotent: it hands back the one
 * that already exists for that cycle), once the new recipe has been saved.
 */
import { flooredCycleStart, templateStartFloor } from '../../lib/checklist-start-floor.js'
import { addDays, advanceChecklistFrequency, resolveStageDueDate } from './utils'
import type { Checklist, ChecklistTemplate, TemplateStage } from './types'

/**
 * Why the first checklist cannot be started, or null when it can. A recipe
 * whose Step 1 has nothing on its list would start an empty task (and the
 * schedule itself skips such a recipe), so say so instead.
 */
export function startFirstStepBlocker(template: Pick<ChecklistTemplate, 'stages'>): string | null {
  const stages = template.stages ?? []
  const stageOne = stages[0]
  if (stageOne && stageOne.items.length > 0) return null
  return stages.length > 1
    ? 'Step 1 has no steps yet, so its first checklist was not started. Add steps to Step 1, then use Generate a task now.'
    : 'This recipe has no steps yet, so its first checklist was not started. Add steps, then use Generate a task now.'
}

export const START_FIRST_NOT_SAVED =
  'The recipe was not saved yet, so its first checklist was not started. Once it saves, use Generate a task now on the recipe.'

/** How long to wait for the new recipe's save before giving up on starting it. */
export const START_FIRST_SAVE_TIMEOUT_MS = 40_000

export type StartFirstStepResult = { started: Checklist } | { note: string } | null

/**
 * The cycle a new recipe's first Step 1 belongs to: the Next due date as the
 * owner typed it, floored the way both materializers floor it
 * (`flooredCycleStart`, lib/checklist-start-floor.js). A date two or more
 * cycles before the recipe was made is walked forward to the first cycle the
 * schedule will actually run; one overdue cycle is kept, as there.
 *
 * NOT the recipe's stored Next due: the browser's materializer may already
 * have made this cycle's Step 1 and moved the recipe on to the next cycle, and
 * asking for that would start the NEXT cycle. With this date the server finds
 * the existing Step 1 and returns it.
 */
export function firstCycleForNewRecipe(
  template: Pick<ChecklistTemplate, 'nextDueDate' | 'frequency' | 'createdAt'>,
): string {
  if (!template.nextDueDate) return ''
  return flooredCycleStart(
    template.nextDueDate,
    template.frequency,
    templateStartFloor({ createdAt: template.createdAt }),
    advanceChecklistFrequency,
  )
}

/**
 * Start a new recipe's real Step 1. `saved` settles once the workspace save
 * that carries the new recipe has landed (the generate endpoint 404s on a
 * recipe the server has not seen); it is null in preview, which is read-only,
 * and then nothing happens and nothing is said. A save that has not landed
 * within `saveTimeoutMs` is reported like one that failed.
 */
export async function startFirstRecipeStep({
  template,
  templateId,
  saved,
  generate,
  saveTimeoutMs = START_FIRST_SAVE_TIMEOUT_MS,
}: {
  template: Pick<ChecklistTemplate, 'stages' | 'nextDueDate' | 'frequency' | 'createdAt'>
  templateId: string
  saved: Promise<boolean> | null
  generate: (templateId: string, payload: { dueDate?: string }) => Promise<Checklist | null>
  saveTimeoutMs?: number
}): Promise<StartFirstStepResult> {
  if (saved === null) return null
  const blocker = startFirstStepBlocker(template)
  if (blocker) return { note: blocker }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), saveTimeoutMs)
  })
  const landed = await Promise.race([saved, timedOut])
  clearTimeout(timer)
  if (!landed) return { note: START_FIRST_NOT_SAVED }
  try {
    const cycle = firstCycleForNewRecipe(template)
    const created = await generate(templateId, cycle ? { dueDate: cycle } : {})
    return created ? { started: created } : null
  } catch (error) {
    const reason = error instanceof Error && error.message ? ` (${error.message})` : ''
    return {
      note: `The recipe was saved, but its first checklist could not be started${reason}. Use Generate a task now on the recipe.`,
    }
  }
}

/**
 * Put a checklist the server returned into the local list. The generate
 * endpoint hands back an EXISTING row when this cycle's Step 1 is already
 * there (often the very row this tab's materializer made and just saved), so
 * appending blindly would show it twice.
 */
export function upsertChecklistById(checklists: Checklist[], next: Checklist): Checklist[] {
  if (!checklists.some((checklist) => checklist.id === next.id)) {
    return [...checklists, next]
  }
  return checklists.map((checklist) => (checklist.id === next.id ? next : checklist))
}

/**
 * Each step's due date for the cycle whose Next due is `nextDueDate`, the way
 * the app assigns them: Step 1 from the Next due date, and every later step
 * from the step before it (that is what it is spawned from when the step
 * before is finished). Empty when there is no Next due date.
 */
export function stageDueDatesForCycle(stages: TemplateStage[], nextDueDate: string): string[] {
  if (!nextDueDate) return []
  let base = nextDueDate
  return stages.map((stage) => {
    const due = resolveStageDueDate(stage, base)
    base = due
    return due
  })
}

const cycleDateFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
})

/** "Oct 10, 2026" for a YYYY-MM-DD date, read as a calendar day (no zone shift). */
export function formatCycleDate(dateOnly: string): string {
  const [year, month, day] = dateOnly.split('-').map(Number)
  if (!year || !month || !day) return dateOnly
  return cycleDateFormat.format(new Date(year, month - 1, day))
}

/**
 * What the "no date of its own" choice means for step `index` (0-based): Step 1
 * takes the recipe's Next due date (a specific-months recipe: that month's due
 * day), every later step the date of the step before it. A legacy
 * `offsetDays` moves it that many days earlier.
 */
export function inheritDueLabel(index: number, offsetDays: number, specificMonths: boolean): string {
  const anchor =
    index === 0 ? (specificMonths ? "the month's due day" : 'the Next due date') : 'the step before'
  const offset = Number(offsetDays) || 0
  if (offset > 0) return `${offset} day${offset === 1 ? '' : 's'} before ${anchor}`
  return index === 0 ? `On ${anchor}` : 'Same day as the step before'
}

/**
 * A step pinned to one calendar date in a recipe that repeats: the date never
 * moves, so Step 1 is never started again after that cycle and a later step of
 * every later cycle is born overdue. New picks are not offered; a step that
 * already has one keeps it, with this warning.
 */
export const SPECIFIC_DATE_ON_RECURRING_WARNING =
  'A specific date only fits one cycle. This recipe repeats, and every later cycle would keep this same date, so choose one of the options above instead.'

/** Shown when a recipe's Step 1 is due before the day it would appear. */
export const STEP_ONE_APPEARS_LATE_WARNING =
  "Step 1 will appear after it is already due - raise Show before Next due or move Step 1's day."

/**
 * Would Step 1 be born overdue? It appears "Show before Next due" days before
 * the Next due date (the materializers' rule, lead days capped at 120), so a
 * Step 1 due earlier than that day is already late when it shows up.
 */
export function stepOneAppearsLate(
  stepOneDue: string | undefined,
  nextDueDate: string,
  leadDays: number | undefined,
): boolean {
  if (!stepOneDue || !nextDueDate) return false
  const lead = typeof leadDays === 'number' && leadDays > 0 ? Math.min(Math.floor(leadDays), 120) : 0
  return stepOneDue < addDays(nextDueDate, -lead)
}
