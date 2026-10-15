/**
 * The two pure decisions behind PACKAGES (featreq-f890f05b) — what a package's
 * checklist set starts as, and what applying one says it will do.
 *
 * They live here rather than beside the components that use them because they
 * are used on two different pages (the Plans page builds a package, the client
 * page applies one) and because both are worth testing without rendering
 * anything.
 */
import type { PlanSetUpStep } from '../../lib/checklist-link-match.js'
import type { ChecklistTemplate, Client, Package, SubscriptionPlan } from './types'

/** What Set up does with one missing blueprint: link an existing checklist, create, or leave it for her. */
export type SetUpStep = PlanSetUpStep<ChecklistTemplate, ChecklistTemplate>

/** Why a row is left for her to choose, counted: "2 checklists match" / "its schedule differs ...". */
export function chooseReasonText(step: Extract<SetUpStep, { kind: 'choose' }>): string {
  if (step.reason === 'schedule') return `its schedule differs from the plan's "How often"`
  const count = step.candidates.length
  return count > 1 ? `${count} checklists match` : '1 checklist matches, but it also fits another row'
}

/** One row of the Set up confirm, naming what happens to it. */
function setUpLine(step: SetUpStep): string {
  if (step.kind === 'link') return `${step.blueprint.title} -> link "${step.copy.title}"`
  if (step.kind === 'create') return `${step.blueprint.title} -> create`
  return `${step.blueprint.title} -> left for you to choose (${chooseReasonText(step)})`
}

/**
 * The confirm before a Set up that would LINK or leave a row (a plain create
 * needs none): every row and what happens to it, so nothing is a surprise.
 * `heading` is the question ("Set up package checklists for Acme?").
 */
export function setUpConfirmText(heading: string, steps: readonly SetUpStep[]): string {
  return [
    heading,
    '',
    ...steps.map(setUpLine),
    '',
    'A checklist the client already has is linked, not copied.',
  ].join('\n')
}

/** What a Set up just did: "2 linked, 1 created" (plus any rows left for her). */
export function setUpResultText(steps: readonly SetUpStep[]): string {
  const count = (kind: SetUpStep['kind']) => steps.filter((step) => step.kind === kind).length
  const parts = [
    [count('link'), 'linked'],
    [count('create'), 'created'],
    [count('choose'), 'left for you to choose'],
  ]
    .filter(([n]) => (n as number) > 0)
    .map(([n, word]) => `${n} ${word}`)
  return parts.length > 0 ? `${parts.join(', ')}.` : 'Nothing to set up.'
}

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
 * The packages that COVER a client's plans: every one of the package's plans is
 * on the client (and it has at least one). Before a package was stored on the
 * client (`client.packageIds`), coverage was how the client page recognized "this
 * client is on that package"; it is now the FALLBACK for a client with none chosen
 * (`packagesForClient`). A covering package whose plans
 * are a strict subset of another covering package's is dropped, and of several
 * with identical plans only the first by name is kept; the dropped package's
 * checklist ids are folded into the kept one. Sorted by name. Pure.
 */
export function packagesCoveringPlans(
  clientPlanIds: readonly string[],
  packages: readonly Package[],
): Package[] {
  const have = new Set(clientPlanIds)
  const covering = packages
    .filter((pkg) => pkg.planIds.length > 0 && pkg.planIds.every((id) => have.has(id)))
    .sort((a, b) => a.name.localeCompare(b.name))
  const contains = (outer: Package, inner: Package) =>
    inner.planIds.every((id) => outer.planIds.includes(id))
  const sameSet = (a: Package, b: Package) =>
    a.planIds.length === b.planIds.length && contains(a, b)
  const subsumed = (pkg: Package, index: number) =>
    covering.some(
      (other, otherIndex) =>
        other !== pkg &&
        contains(other, pkg) &&
        (other.planIds.length > pkg.planIds.length || (sameSet(other, pkg) && otherIndex < index)),
    )
  const kept = covering.filter((pkg, index) => !subsumed(pkg, index))
  // A dropped package's own checklist set is editable and may hold a checklist
  // no plan bundles, so it is folded into the first kept package that contains it.
  return kept.map((pkg) => {
    const folded = covering
      .filter((other, index) => subsumed(other, index))
      .filter((other) => kept.find((candidate) => contains(candidate, other)) === pkg)
      .flatMap((other) => other.templateIds)
    const templateIds = [...new Set([...pkg.templateIds, ...folded])]
    return templateIds.length === pkg.templateIds.length ? pkg : { ...pkg, templateIds }
  })
}

/**
 * The packages the owner CHOSE for a client (`client.packageIds`, in that order),
 * leaving out an id whose package no longer exists. Empty when none is chosen.
 * Pure.
 */
export function chosenPackagesOf(
  client: Pick<Client, 'packageIds'>,
  packages: readonly Package[],
): Package[] {
  const byId = new Map(packages.map((pkg) => [pkg.id, pkg]))
  return (client.packageIds ?? [])
    .map((id) => byId.get(id))
    .filter((pkg): pkg is Package => Boolean(pkg))
}

/**
 * The packages that group a client's checklists (the Plan checklists panel and To
 * 100%): the CHOSEN ones once the client has a list (even an empty one - she chose
 * none, so no fallback), and only while it was NEVER chosen (`packageIds` null or
 * absent) the packages its plans cover (`packagesCoveringPlans`), so a client
 * nobody has picked a package for reads exactly as it did before. Pure.
 */
export function packagesForClient(
  client: Pick<Client, 'planIds' | 'packageIds'>,
  packages: readonly Package[],
): Package[] {
  if (Array.isArray(client.packageIds)) return chosenPackagesOf(client, packages)
  return packagesCoveringPlans(client.planIds ?? [], packages)
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
  linkLines = [],
  chooseLines = [],
}: {
  packageName: string
  clientName: string
  addedPlanNames: readonly string[]
  newChecklistTitles: readonly string[]
  skippedCount: number
  /** Checklists the client already has that the apply LINKS instead of copying ("Reconciliations -> Quarterly Reconciliations"). */
  linkLines?: readonly string[]
  /** Rows left for her to choose, each with its reason ("Reports (2 checklists match)"). */
  chooseLines?: readonly string[]
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
  } else if (linkLines.length > 0 || chooseLines.length > 0) {
    lines.push(
      `Creates no new checklists${skippedCount > 0 ? ` (${skippedCount} already set up and will be skipped)` : ''}.`,
    )
  } else if (skippedCount > 0) {
    lines.push(`Creates no checklists — all ${skippedCount} of them are already set up here.`)
  } else {
    lines.push('This package has no checklists attached yet, so none are created.')
  }
  if (linkLines.length > 0) {
    lines.push(
      `Links ${linkLines.length} checklist${linkLines.length === 1 ? '' : 's'} this client already has instead of copying: ${linkLines.join('; ')}.`,
    )
  }
  if (chooseLines.length > 0) {
    lines.push(`Leaves ${chooseLines.length} for you to choose: ${chooseLines.join('; ')}.`)
  }
  lines.push('')
  lines.push('Nothing on the invoice changes — plans are labels; the monthly rate stays as it is.')
  return lines.join('\n')
}
