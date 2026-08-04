/**
 * The three areas of the Checklists page: In progress / Repeating / Standard.
 *
 * They used to be stacked vertically, so reaching a repeating task meant
 * scrolling past the entire in-progress list — 554 checklists in production.
 * That was the reported problem ("it is so hard to get to a repeating task to
 * fix it"), so each area is now one click away.
 *
 * The resolution rules live here rather than inline in the page because the
 * deep-link precedence is the part that can break SILENTLY: a `?focusTemplate=`
 * link (the Plans page's "set up checklists" card) points at
 * RepeatingTasksManager, which is not mounted at all unless its tab is open. If
 * the area didn't follow the link, the click would simply appear to do nothing.
 */

export type TaskArea = 'progress' | 'repeating' | 'standard'

export const TASK_AREA_KEYS: TaskArea[] = ['progress', 'repeating', 'standard']

/**
 * Which area to open, in priority order:
 *
 * 1. `?focusTemplate=` → Repeating. Only RepeatingTasksManager consumes that
 *    param, and only for non-standard templates.
 * 2. `?focus=` → In progress. That param targets a checklist card.
 * 3. `?area=` when it names a real area.
 * 4. In progress, the default.
 *
 * Deliberately derived from the URL on every render rather than mirrored into
 * state: a link that arrives after mount still wins, and there is no flash from
 * an effect correcting the view after paint.
 */
export function resolveTaskArea(params: {
  areaParam?: string | null
  focusChecklist?: string | null
  focusTemplate?: string | null
}): TaskArea {
  if (params.focusTemplate) return 'repeating'
  if (params.focusChecklist) return 'progress'
  if (params.areaParam === 'repeating' || params.areaParam === 'standard') {
    return params.areaParam
  }
  return 'progress'
}
