/**
 * The two pure decisions behind PACKAGES (featreq-f890f05b) — what a package's
 * checklist set starts as, and what applying one says it will do.
 *
 * They live here rather than beside the components that use them because they
 * are used on two different pages (the Plans page builds a package, the client
 * page applies one) and because both are worth testing without rendering
 * anything.
 */
import type { SubscriptionPlan } from './types'

/**
 * A package's default checklist set: the union of its plans' own blueprints, in
 * the order the plans were picked, deduplicated.
 *
 * It is only ever a DEFAULT. A plan already links the standard work that comes
 * with it, so a package combining three plans should not make the owner
 * re-pick the same nine checklists — but she edits the set from there, and an
 * edited set is left alone when the plan list changes.
 */
export function defaultPackageTemplateIds(
  planIds: readonly string[],
  plans: readonly SubscriptionPlan[],
): string[] {
  const byId = new Map(plans.map((plan) => [plan.id, plan]))
  const out: string[] = []
  for (const planId of planIds) {
    for (const templateId of byId.get(planId)?.templateIds ?? []) {
      if (!out.includes(templateId)) out.push(templateId)
    }
  }
  return out
}

/**
 * Everything applying a package will do, named in full before it happens — the
 * same rule "Mark inactive" follows (see `markInactiveConfirm`).
 *
 * The last line is the one that matters most. A package LOOKS like a price
 * change and is not: a plan is a label joined into the invoice's service line
 * (`lib/invoice-lines.js`), and the amount is the client's own monthly rate.
 * Saying so in the dialog is cheaper than explaining it after a send.
 */
export function applyPackageConfirmText({
  packageName,
  clientName,
  addedPlanNames,
  newChecklistTitles,
  skippedCount,
}: {
  packageName: string
  clientName: string
  addedPlanNames: readonly string[]
  newChecklistTitles: readonly string[]
  skippedCount: number
}): string {
  const lines = [`Apply the "${packageName}" package to ${clientName}?`, '']
  lines.push(
    addedPlanNames.length > 0
      ? `Adds plans: ${addedPlanNames.join(', ')}.`
      : 'Adds no plans — this client is already on all of them.',
  )
  if (newChecklistTitles.length > 0) {
    const skipNote =
      skippedCount > 0
        ? ` (${skippedCount} already ${skippedCount === 1 ? 'exists' : 'exist'} and will be skipped)`
        : ''
    lines.push(
      `Creates ${newChecklistTitles.length} checklist${
        newChecklistTitles.length === 1 ? '' : 's'
      } for this client: ${newChecklistTitles.join(', ')}${skipNote}.`,
    )
  } else if (skippedCount > 0) {
    lines.push(`Creates no checklists — all ${skippedCount} of them are already set up here.`)
  } else {
    lines.push('This package has no checklists attached yet, so none are created.')
  }
  lines.push('')
  lines.push('Nothing on the invoice changes — plans are labels; the monthly rate stays as it is.')
  return lines.join('\n')
}
