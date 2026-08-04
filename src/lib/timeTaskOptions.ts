import type { Checklist, ChecklistTemplate } from './types'

/**
 * What the "Time" button's task picker offers.
 *
 * It used to offer ONLY the chosen client's open checklists, so a bookkeeper
 * timing routine work on a client with no open task had nothing to pick — and
 * work the firm does everywhere ("Payroll", "Bank reconciliation") had to be
 * re-typed as a note that never reached the task column on a report. So the
 * picker now offers three things at once:
 *
 * 1. the client's own open tasks (unchanged — these still attach the entry to
 *    the real checklist via `taskId`),
 * 2. the client's UPCOMING recurring tasks — the "get ahead" list the Time
 *    page's task dropdown used to carry in its own optgroup. No checklist
 *    exists for these yet, so choosing one has to generate the instance first
 *    and then attach to the new id,
 * 3. every STANDARD task in the workspace (the client-agnostic blueprints on
 *    the Checklists page's "Standard" tab), and
 * 4. anything the user types that isn't in the list.
 *
 * 3 and 4 both land in the entry's existing free-text `taskLabel` field — a
 * standard blueprint is not a real checklist for this client, so there is no id
 * to attach. Nothing new is persisted: `taskId` still means "a real checklist",
 * `taskLabel` still means "a name the user gave this work".
 */
export type TimeTaskOption = {
  /** Exactly the text shown in the picker (and matched when it's typed). */
  label: string
  /**
   * The client's open checklist this option attaches to, or `null` for a
   * standard blueprint (which resolves to a free-text `taskLabel` instead).
   */
  checklistId: string | null
  /**
   * The recurring template this option must GENERATE before it can be attached
   * — set only for an "upcoming" (get-ahead) option, `null` for every other
   * kind. The caller generates the checklist and attaches the returned id.
   */
  templateId: string | null
}

/** The " (upcoming)" suffix that marks a get-ahead option in the picker. */
const UPCOMING_SUFFIX = ' (upcoming)'

/** Case-insensitive, whitespace-insensitive key used for de-duplication. */
function dedupeKey(label: string): string {
  return label.trim().toLowerCase()
}

/**
 * Assemble the picker's options: the client's open tasks first (in the order
 * given — {@link import('./utils').eligibleChecklistsFor} already sorts them),
 * then its upcoming recurring tasks (labeled "… (upcoming)", exactly the text
 * the old dropdown's "Get ahead" group showed), then the firm's standard
 * blueprints alphabetically.
 *
 * De-duplicated by title, case-insensitively, FIRST WINS — so a client that
 * already has an open "Monthly Bookkeeping" task keeps the real checklist and
 * doesn't also show the identically-named blueprint below it. Blank titles are
 * dropped; they'd be unpickable rows.
 *
 * Pure — unit-tested.
 */
export function buildTimeTaskOptions(
  clientTasks: Checklist[],
  templates: ChecklistTemplate[],
  upcomingTemplates: ChecklistTemplate[] = [],
): TimeTaskOption[] {
  const seen = new Set<string>()
  const options: TimeTaskOption[] = []

  for (const task of clientTasks) {
    const label = (task.title ?? '').trim()
    if (!label) continue
    const key = dedupeKey(label)
    if (seen.has(key)) continue
    seen.add(key)
    options.push({ label, checklistId: task.id, templateId: null })
  }

  // The "(upcoming)" suffix is part of the label on purpose: it keeps a
  // get-ahead row distinguishable from an identically-named standard blueprint
  // in a flat datalist, and it's how this row has always read in the dropdown.
  for (const template of upcomingTemplates) {
    const title = (template.title ?? '').trim()
    if (!title) continue
    const label = `${title}${UPCOMING_SUFFIX}`
    const key = dedupeKey(label)
    if (seen.has(key)) continue
    seen.add(key)
    options.push({ label, checklistId: null, templateId: template.id })
  }

  const standards = templates
    .filter((template) => template.isStandard)
    .map((template) => (template.title ?? '').trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }))

  for (const label of standards) {
    const key = dedupeKey(label)
    if (seen.has(key)) continue
    seen.add(key)
    options.push({ label, checklistId: null, templateId: null })
  }

  return options
}

/**
 * Turn what's in the picker box into the two fields a time entry actually has.
 *
 * A typed value that matches one of the client's open tasks (case-insensitively)
 * attaches to that checklist, exactly as picking it from the old dropdown did.
 * A value that matches an UPCOMING recurring task comes back as `templateId`:
 * there is no checklist to attach yet, so the caller must generate it first —
 * the same "get ahead" flow the old dropdown's `template:<id>` option ran.
 * Anything else is kept VERBATIM (trimmed) as `taskLabel` — that covers both a
 * standard blueprint and a name the user made up. Empty means "no task", the
 * old "(none / general)" choice.
 *
 * Pure — unit-tested.
 */
export function resolveTimeTaskChoice(
  typed: string,
  options: TimeTaskOption[],
): { taskId: string | null; taskLabel: string | undefined; templateId: string | null } {
  const trimmed = (typed ?? '').trim()
  if (!trimmed) return { taskId: null, taskLabel: undefined, templateId: null }

  const key = dedupeKey(trimmed)
  const match = options.find((option) => dedupeKey(option.label) === key)
  if (match?.checklistId) {
    return { taskId: match.checklistId, taskLabel: undefined, templateId: null }
  }
  if (match?.templateId) {
    return { taskId: null, taskLabel: undefined, templateId: match.templateId }
  }

  return { taskId: null, taskLabel: trimmed, templateId: null }
}
