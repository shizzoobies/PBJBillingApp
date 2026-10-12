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
import type { Checklist, ChecklistTemplate } from './types'

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

export type StartFirstStepResult = { started: Checklist } | { note: string } | null

/**
 * Start a new recipe's real Step 1. `saved` settles once the workspace save
 * that carries the new recipe has landed (the generate endpoint 404s on a
 * recipe the server has not seen). The cycle date sent is the recipe's OWN
 * Next due as entered: the browser's materializer may already have made this
 * cycle's Step 1 and moved the recipe on to the next cycle, and asking for
 * "the recipe's next due date" after that would start the NEXT cycle. With the
 * entered date the server finds the existing Step 1 and returns it.
 *
 * Returns null when the app declined quietly (preview mode).
 */
export async function startFirstRecipeStep({
  template,
  templateId,
  saved,
  generate,
}: {
  template: Pick<ChecklistTemplate, 'stages' | 'nextDueDate'>
  templateId: string
  saved: Promise<boolean>
  generate: (templateId: string, payload: { dueDate?: string }) => Promise<Checklist | null>
}): Promise<StartFirstStepResult> {
  const blocker = startFirstStepBlocker(template)
  if (blocker) return { note: blocker }
  if (!(await saved)) return { note: START_FIRST_NOT_SAVED }
  try {
    const created = await generate(
      templateId,
      template.nextDueDate ? { dueDate: template.nextDueDate } : {},
    )
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
