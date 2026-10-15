/**
 * Which checklists a client ALREADY has that stand for a plan or package
 * blueprint, and what "Set up" should do with each one (featreq-8bdc5ec5).
 *
 * ONE copy, shared by the browser (the Plan checklists panel, the To 100% fix,
 * adding a plan chip) and the server (applying a package, signing a letter), so
 * the screen's promise and the server's act cannot disagree. Brittany set her
 * clients' checklists up by hand before packages existed, under her own titles
 * ("Quarterly Reconciliations with Review - Quarterly" for the blueprint
 * "Reconciliations with Review"); making a second copy next to hers is the
 * duplicate incident of 2026-10-10 (featreq-2b067744).
 *
 * Pure: reads plain template objects and writes nothing.
 */

const LEADING_CADENCE_WORD = /^(weekly|monthly|quarterly|annually|annual)\s+/i
const TRAILING_CADENCE_WORD = /\s+[-–—]\s+(weekly|monthly|quarterly|annually|annual)$/i

/** A word as the frequency it names ("annual" is "annually"). */
function asFrequency(word) {
  const lower = word.toLowerCase()
  return lower === 'annual' ? 'annually' : lower
}

/**
 * A title as "Link existing" compares it: no leading or trailing cadence word
 * ("Quarterly Close - Quarterly" is "close"), any case, spaces collapsed. And the
 * cadence words that were dropped, as frequencies.
 */
function titleParts(title) {
  let rest = String(title ?? '').trim()
  const words = []
  const leading = LEADING_CADENCE_WORD.exec(rest)
  if (leading) {
    words.push(asFrequency(leading[1]))
    rest = rest.slice(leading[0].length)
  }
  const trailing = TRAILING_CADENCE_WORD.exec(rest)
  if (trailing) {
    words.push(asFrequency(trailing[1]))
    rest = rest.slice(0, trailing.index)
  }
  return { key: rest.replace(/\s+/g, ' ').trim().toLowerCase(), words }
}

/**
 * Whether a checklist's schedule says what a title's cadence word says. A
 * specific-months schedule counts by its month count (4 = quarterly, 12 =
 * monthly, 1 = annually). No word agrees with anything.
 */
function cadenceAgrees(word, template) {
  if (!word || template.frequency === word) return true
  if (template.frequency !== 'specific-months') return false
  const months = template.scheduledMonths?.length ?? 0
  return (
    (word === 'quarterly' && months === 4) ||
    (word === 'monthly' && months === 12) ||
    (word === 'annually' && months === 1)
  )
}

/**
 * How often the copy of a blueprint will run, as a frequency: the plan's cadence
 * when it names one (weekly / monthly / quarterly / annual), else the blueprint's
 * own schedule (a specific-months one by its month count). Null = unknown, which
 * agrees with anything.
 */
function wantedFrequency(blueprint, cadence) {
  if (cadence && cadence !== 'blueprint') return cadence === 'annual' ? 'annually' : cadence
  if (blueprint.frequency === 'specific-months') {
    const months = blueprint.scheduledMonths?.length ?? 0
    return months === 4 ? 'quarterly' : months === 12 ? 'monthly' : months === 1 ? 'annually' : null
  }
  return blueprint.frequency ?? null
}

/**
 * The client's own checklists "Link existing" can attach to a blueprint,
 * sorted by title: on this client, not a blueprint, not an onboarding checklist
 * (that one drives the client's lifecycle), and not already tied to a LIVE
 * standard blueprint. A stamp that points anywhere else does not count:
 * Duplicate and Copy-to-client stamp a copy with the SOURCE checklist's id
 * (often another client's recipe), and a stamp whose template is gone ties it
 * to nothing - both stay linkable, and the link overwrites the stamp with the
 * blueprint's id.
 */
export function linkableClientChecklists(clientId, templates) {
  const list = Array.isArray(templates) ? templates : []
  const byId = new Map(list.map((template) => [template.id, template]))
  return list
    .filter(
      (template) =>
        template.clientId === clientId &&
        !template.isStandard &&
        !template.onboardingForClientId &&
        !(template.sourceTemplateId && byId.get(template.sourceTemplateId)?.isStandard),
    )
    .sort((a, b) => String(a.title ?? '').trim().localeCompare(String(b.title ?? '').trim(), undefined, { sensitivity: 'base' }))
}

/**
 * The client's linkable checklists that stand for a blueprint: the same title
 * once a leading or trailing Weekly/Monthly/Quarterly/Annual(ly) is dropped,
 * provided any cadence word in either title agrees with the checklist's own
 * schedule, and the checklist is switched on. ("Monthly Transactions" is not a
 * copy of "Weekly Transactions", and "Monthly Reconciliations" is not a copy
 * of "Monthly Reconciliations with Review".)
 */
export function linkCandidatesForPlanTemplate(blueprint, clientId, templates) {
  const want = titleParts(blueprint.title)
  return linkableClientChecklists(clientId, templates).filter((template) => {
    if (template.active === false) return false
    const have = titleParts(template.title)
    return (
      have.key === want.key &&
      [...have.words, ...want.words].every((word) => cadenceAgrees(word, template))
    )
  })
}

/**
 * What "Set up" does with each blueprint the client does not have a copy of:
 *
 *   - link:   exactly one existing checklist stands for it, and no OTHER row
 *             wants that same checklist - tie that one to the blueprint
 *             instead of making a copy;
 *   - create: nothing existing stands for it - make a copy;
 *   - choose: several do (or one is wanted by two rows: reason 'several'), or
 *             the one that does runs on a schedule the plan's "How often" does
 *             not give (reason 'schedule') - do neither and leave the row Not
 *             set up, with the Link existing choices, for her to pick (a wrong
 *             guess either way is a duplicate or a wrong link).
 *
 * `blueprints` is the already-missing set (callers drop same-titled twins
 * first). Steps come back in the order given.
 *
 * `cadenceFor(blueprint)` (optional) is the "How often" the plan gives the copy
 * (`weekly | monthly | quarterly | annual | blueprint | null`). A link is automatic
 * only when that cadence - the blueprint's own frequency when there is none -
 * agrees with the existing checklist's schedule; a lone "X - Quarterly" for a
 * monthly plan's blueprint is a `choose`, not a silent link, since linking would
 * leave it running on a schedule the plan does not give. (The Link existing
 * suggestions do not apply this: she is choosing there.)
 */
export function planSetUpSteps(blueprints, clientId, templates, cadenceFor) {
  const rows = (Array.isArray(blueprints) ? blueprints : []).map((blueprint) => ({
    blueprint,
    candidates: linkCandidatesForPlanTemplate(blueprint, clientId, templates),
  }))
  const wantedBy = new Map()
  for (const row of rows) {
    for (const candidate of row.candidates) wantedBy.set(candidate.id, (wantedBy.get(candidate.id) ?? 0) + 1)
  }
  return rows.map(({ blueprint, candidates }) => {
    if (candidates.length === 0) return { kind: 'create', blueprint }
    if (candidates.length === 1 && wantedBy.get(candidates[0].id) === 1) {
      if (cadenceAgrees(wantedFrequency(blueprint, cadenceFor?.(blueprint)), candidates[0])) {
        return { kind: 'link', blueprint, copy: candidates[0] }
      }
      // One match, but it runs on a schedule the plan does not give.
      return { kind: 'choose', blueprint, candidates, reason: 'schedule' }
    }
    return { kind: 'choose', blueprint, candidates, reason: 'several' }
  })
}
