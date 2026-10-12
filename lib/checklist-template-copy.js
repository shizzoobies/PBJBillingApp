/**
 * What a COPY of a recurring recipe carries over from its source - ONE list for
 * both copy paths, so they cannot drift again.
 *
 * Two places copy a recipe onto a client: the browser's clone
 * (src/lib/cloneChecklistTemplate.ts - "Set up plan checklists", Duplicate) and
 * the server's (`_clientTemplateCopy` in db/store.js - Apply a package, signing an
 * engagement, the To 100% fix, the assistant). The server copy listed its own
 * fields and silently dropped the schedule: a copy of a specific-months
 * blueprint landed with no months and never ran (production copies of
 * 2026-10-10), along with the due day, lead days, Board column, skip and
 * period-label settings, sub-steps and step due days.
 *
 * The field list is EXPLICIT on purpose: a new template field becomes a copied
 * field only when someone adds it here, once, for both paths. Stages and steps
 * are SPREAD (fresh ids at every level), the way the browser clone always did.
 *
 * Deliberately NOT carried here (each caller decides them): `id`, `title`,
 * `clientId`, `frequency`, `nextDueDate`, `createdAt`, `active`, `isStandard`,
 * `sourceTemplateId`, `onboardingForClientId` (a copy must not drive a client's
 * lifecycle) and the deprecated flat `items`.
 */

/** The template-level settings a copy keeps, with fresh arrays and maps. */
export function copiedTemplateSettings(source) {
  return {
    assigneeId: source.assigneeId || '',
    categoryId: source.categoryId ?? null,
    leadDays: source.leadDays,
    scheduledMonths: Array.isArray(source.scheduledMonths) ? [...source.scheduledMonths] : undefined,
    dueDayOfMonth: source.dueDayOfMonth,
    monthlyDueDays:
      source.monthlyDueDays && typeof source.monthlyDueDays === 'object'
        ? { ...source.monthlyDueDays }
        : undefined,
    repeatAnnually: source.repeatAnnually,
    scheduleYear: source.scheduleYear,
    skipAllowed: source.skipAllowed,
    // A copy of a recipe that labels "July 2026" labels its own cycles too; the
    // anchor keeps the source's phase.
    periodLabelEnabled: source.periodLabelEnabled,
    periodCoverageStart: source.periodCoverageStart ?? null,
    periodCoverageEnd: source.periodCoverageEnd ?? null,
    periodCoverageAnchorDue: source.periodCoverageAnchorDue ?? null,
    viewerIds: Array.isArray(source.viewerIds) ? [...source.viewerIds] : [],
    editorIds: Array.isArray(source.editorIds) ? [...source.editorIds] : [],
  }
}

/**
 * The stages of a copy: each stage spread (so a stage's due day, due date and
 * any later per-stage field come along), with fresh ids for the stage, each step
 * and each sub-step. `newId(prefix)` mints an id ('stage', 'template-item',
 * 'template-subitem').
 */
export function copiedTemplateStages(stages, newId) {
  return (Array.isArray(stages) ? stages : []).map((stage) => ({
    ...stage,
    id: newId('stage'),
    viewerIds: Array.isArray(stage.viewerIds) ? [...stage.viewerIds] : [],
    editorIds: Array.isArray(stage.editorIds) ? [...stage.editorIds] : [],
    items: (Array.isArray(stage.items) ? stage.items : []).map((item) => ({
      ...item,
      id: newId('template-item'),
      subItems: (Array.isArray(item.subItems) ? item.subItems : []).map((sub) => ({
        ...sub,
        id: newId('template-subitem'),
      })),
    })),
  }))
}
