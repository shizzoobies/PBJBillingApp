/**
 * Why a recurring checklist recipe will — or silently will NOT — generate.
 *
 * ONE copy of the gate, because three places have to agree about it:
 *   1. the materializer itself (`materializeRecurringChecklists` in
 *      db/store.js) — the thing that actually skips the template;
 *   2. the To-100% "never generates" detector (src/lib/completeness.ts);
 *   3. the assistant's `diagnose_recurring_checklist` tool (lib/diagnostics.js).
 *
 * (2) used to be a hand-mirrored copy of (1) carrying a "if you change one,
 * change both" comment. Adding (3) as a third copy is how that comment stops
 * being true, so the conditions live here instead and both callers read them.
 *
 * Plain JS (with a sibling .d.ts) so `src/` and the server share one file —
 * same arrangement as lib/group-allocation.js.
 */

/**
 * Is this client stage a retired one? The single definition of "inactive",
 * shared by the gate below and by the three generators that hand-inline their
 * skip rules (the server materializer, `ensureRecurringChecklists`, and the
 * Board/Gantt projection) — none of which can call the gate directly, but all
 * of which must agree about which clients have stopped producing work.
 *
 * @param {string | undefined | null} stage  A client's `lifecycleStage`.
 * @returns {boolean}
 */
export function isInactiveClientStage(stage) {
  return stage === 'inactive'
}

/**
 * The ids of every retired client in a workspace snapshot, as a Set the
 * generators can test `template.clientId` against in their loop.
 *
 * @param {{ id?: string, lifecycleStage?: string }[]} [clients]
 * @returns {Set<string>}
 */
export function inactiveClientIds(clients = []) {
  const ids = new Set()
  for (const client of clients ?? []) {
    if (client?.id && isInactiveClientStage(client.lifecycleStage)) ids.add(client.id)
  }
  return ids
}

/**
 * Evaluate one template against the gate.
 *
 * @param {object} template  A checklist template (stages-shaped).
 * @param {{ currentYear?: number, clientStage?: string }} [options]
 *   `clientStage` is the `lifecycleStage` of the template's client, which the
 *   template itself doesn't carry. Omit it and the client is assumed to be
 *   working — an absent stage has always meant 'active'.
 * @returns {{ skipped: boolean, reason: string | null, warnings: string[] }}
 *   - `skipped`: a standard blueprint — never scheduled, so it is not a fault.
 *   - `reason`: the FIRST missing ingredient, or null when it will generate:
 *     'no-client' | 'inactive-client' | 'inactive' | 'no-stages' | 'no-steps' |
 *     'no-months' | 'stale-year' | 'no-due-date'. Note 'inactive' is the
 *     TEMPLATE's own on/off switch; 'inactive-client' is the retired client
 *     behind it, which no amount of editing the template will fix.
 *   - `warnings`: things that don't stop generation but land it badly —
 *     'no-assignee' (nobody can tick the steps off) and 'no-board-column'
 *     (everything piles into "Uncategorized"). Only ever set when `reason` is
 *     null, since a recipe that never runs can't land anywhere.
 */
export function evaluateRecurringTemplate(template, options = {}) {
  const currentYear =
    typeof options.currentYear === 'number' ? options.currentYear : new Date().getFullYear()

  // Standard blueprints are recipes to copy, not schedules — an empty one
  // isn't broken, it's just a blueprint.
  if (template?.isStandard) return { skipped: true, reason: null, warnings: [] }

  const verdict = (reason) => ({ skipped: false, reason, warnings: [] })
  const stages = template?.stages ?? []

  if (!template?.clientId) return verdict('no-client')
  // A retired client outranks every template-level fault below: the recipe may
  // be perfectly well formed, it just has nobody left to run for. Reported
  // before 'inactive' so the assistant says "the client is retired" rather than
  // sending someone to flip a switch that would change nothing.
  if (isInactiveClientStage(options.clientStage)) return verdict('inactive-client')
  if (!template.active) return verdict('inactive')
  if (stages.length === 0) return verdict('no-stages')
  if ((stages[0].items ?? []).length === 0) return verdict('no-steps')

  if (template.frequency === 'specific-months') {
    const months = Array.isArray(template.scheduledMonths) ? template.scheduledMonths : []
    const usable = months.filter((month) => Number.isInteger(month) && month >= 1 && month <= 12)
    if (usable.length === 0) return verdict('no-months')
    // "Repeat every year" off pins the recipe to one calendar year.
    if (template.repeatAnnually === false && template.scheduleYear !== currentYear) {
      return verdict('stale-year')
    }
  } else if (!template.nextDueDate) {
    return verdict('no-due-date')
  }

  const warnings = []
  if (!stages[0].assigneeId) warnings.push('no-assignee')
  if (!template.categoryId) warnings.push('no-board-column')
  return { skipped: false, reason: null, warnings }
}
