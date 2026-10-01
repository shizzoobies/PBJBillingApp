/**
 * The rules behind "delete this step from this and every future checklist"
 * (featreq-01464e64), shared by the file backend and the Postgres branch of
 * `deleteChecklistItemFromSeries` so the two cannot drift apart.
 *
 * The one thing this operation must never do is destroy work it cannot see. A
 * later copy of the step is removed only when it is UNTOUCHED: not done, no done
 * sub-step or sub-sub-step, and no wait of any kind. A saved wait is permanent
 * by the owner's standing rule (SAVED_WAIT_IS_PERMANENT in waiting-on-state.js),
 * so a wait that was verified long ago still counts as work here.
 *
 * `stepCarriesWork` is the JavaScript statement of that rule (file backend, and
 * the reference for the tests); `untouchedStepSql` is the same rule as a SQL
 * expression (Postgres). Change one, change the other, and the tests that pin
 * the SQL text will say so.
 */

/** Said back to the owner when the series delete would empty the first stage. */
export const LAST_RECURRING_STEP_MESSAGE =
  'This is the last step of the recurring checklist. Delete or pause the recurring checklist instead.'

/** Said when the checklist has no recurring checklist behind it (a 400 on the owner's own delete). */
export const NOT_RECURRING_MESSAGE = 'This checklist is not part of a recurring series'

/** Said when the recurring checklist is shared or another client's, so it is never edited from here. */
export const SHARED_TEMPLATE_MESSAGE =
  'This recurring checklist is shared or belongs to another client, so a step cannot be removed from it here.'

/**
 * Why a step of this checklist cannot be removed from its series, or null when it
 * can. Needs no write, so it runs before the owner deletes AND before a team
 * member's request is filed AND again when the owner approves one. The series
 * delete edits the recurring checklist and the later copies it made, so it is
 * only for this client's own: a shared (standard) one, or one that belongs to
 * another client, is refused rather than edited.
 *
 * @returns {{ status: 400 | 409, error: string } | null}
 */
export function seriesDeleteDenial(checklist, templates) {
  if (!checklist?.templateId) return { status: 400, error: NOT_RECURRING_MESSAGE }
  const template = (templates ?? []).find((entry) => entry.id === checklist.templateId)
  if (template && (template.isStandard || template.clientId !== checklist.clientId)) {
    return { status: 409, error: SHARED_TEMPLATE_MESSAGE }
  }
  return null
}

/**
 * The series delete itself, shared by the owner's own DELETE and by approving a
 * team member's "This + all future" request so the two cannot drift apart. The
 * caller has already run `seriesDeleteDenial`. Answers `{ status, body }`:
 * 404 when the step is gone, 409 (nothing written) when it is the recurring
 * checklist's last first-stage step, else 200 with what changed so the owner's
 * tab can merge it. On success it logs the activity and calls `broadcast`.
 */
export async function runSeriesStepDelete({ store, actorId, broadcast, checklist, itemId, label }) {
  const removal = await store.deleteChecklistItemFromSeries(checklist.id, itemId)
  if (!removal) return { status: 404, body: { error: 'Checklist item not found' } }
  // Taking the template's last first-stage step would silently stop the whole
  // series (the materializer skips an empty first stage). Nothing was written;
  // say so and let the owner pause or delete it instead.
  if ('refusal' in removal) {
    return { status: 409, body: { error: removal.refusal, message: LAST_RECURRING_STEP_MESSAGE } }
  }
  await store.recordActivity(actorId, 'checklist_item_removed_series', `${checklist.title}: ${label}`)
  broadcast()
  // Hand back what changed so the tab can merge it rather than keep a stale
  // template that its next autosave would write straight back.
  const fresh = await store.read()
  const touched = new Set([checklist.id, ...removal.removedFromChecklists])
  return {
    status: 200,
    body: {
      ...removal,
      checklists: fresh.checklists.filter((entry) => touched.has(entry.id)),
      template: fresh.checklistTemplates.find((entry) => entry.id === checklist.templateId) ?? null,
    },
  }
}

/**
 * The duplicate rule for a team member's deletion request: one request per path.
 * When one is already pending for the same step, no second is created; if it
 * asks for a different scope than was just chosen, it is changed to the new
 * one (the latest choice wins). Returns the pending request, or null when there
 * is none and the caller should create one.
 *
 * @param {{ checklistId: string, itemId: string, subItemId?: string | null,
 *   subSubItemId?: string | null, scope?: string }} path
 */
export async function reuseDuplicateDeletionRequest(store, existing, path) {
  const duplicate = existing.find(
    (req) =>
      req.checklistId === path.checklistId &&
      req.itemId === path.itemId &&
      (req.subItemId ?? null) === (path.subItemId ?? null) &&
      (req.subSubItemId ?? null) === (path.subSubItemId ?? null),
  )
  if (!duplicate) return null
  const scope = path.scope === 'series' ? 'series' : 'checklist'
  if ((duplicate.scope ?? 'checklist') === scope) return duplicate
  return (await store.setItemDeletionRequestScope(duplicate.id, scope)) ?? duplicate
}

/**
 * Whitespace as JavaScript's `String.prototype.trim` sees it. Postgres `\s` does
 * not cover the non-breaking space or the byte order mark, so the SQL side spells
 * the same set out; otherwise "Reconcile" and "Reconcile<NBSP>" would match on
 * one backend and not the other.
 */
const TRIM_CLASS = String.raw`[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]`

/** A step label as the matcher sees it: trimmed and lowercased. */
export function normalizeStepLabel(label) {
  return String(label ?? '').trim().toLowerCase()
}

/** The same normalization as SQL, for a column expression such as `ci.label`. */
export function normalizedLabelSql(column) {
  return `lower(regexp_replace(${column}, '^${TRIM_CLASS}+|${TRIM_CLASS}+$', '', 'g'))`
}

const nonEmptyString = (value) => typeof value === 'string' && value !== ''

/** Does this one node (step, sub-step or sub-sub-step) carry a wait of any kind? */
function nodeHasWait(node) {
  return (
    node.waiting === true ||
    (Array.isArray(node.waitingOns) && node.waitingOns.length > 0) ||
    nonEmptyString(node.waitingOn) ||
    nonEmptyString(node.waitingForChecklistId)
  )
}

/**
 * Has work started on this step? True when the step, or anything beneath it, is
 * done or carries a wait (a live flag, a saved or verified `waitingOns` entry, a
 * `waitingOn` note, or a `waitingForChecklistId` link).
 */
export function stepCarriesWork(item) {
  const walk = (node) => {
    if (!node || typeof node !== 'object') return false
    if (node.done === true || nodeHasWait(node)) return true
    return (Array.isArray(node.subItems) ? node.subItems : []).some(walk)
  }
  return walk(item)
}

/**
 * The SQL twin of `!stepCarriesWork(row)`, for a `checklist_items` row aliased
 * as `alias`. Sub-steps live in the `sub_items` JSONB, so `$.**` walks every
 * level beneath the step.
 */
export function untouchedStepSql(alias = 'ci') {
  const node = String.raw`@.done == true || @.waiting == true || exists(@.waitingOns[0]) || @.waitingOn like_regex "." flag "s" || @.waitingForChecklistId like_regex "." flag "s"`
  return [
    `${alias}.done = false`,
    `${alias}.waiting = false`,
    `${alias}.waiting_ons = '[]'::jsonb`,
    `coalesce(${alias}.waiting_on, '') = ''`,
    `coalesce(${alias}.waiting_for_checklist_id, '') = ''`,
    `not jsonb_path_exists(${alias}.sub_items, '$.** ? (${node})')`,
  ].join('\n                  and ')
}

/**
 * Which same-label step the clicked one is: its position among the same-label
 * steps of its own checklist. With duplicate labels the matcher must remove ONE
 * template step and one copy per later checklist, not every look-alike.
 *
 * @param {{ id: string, label?: string }[]} items steps in display order
 * @returns {number} 0-based, or -1 when the step is not in the list
 */
export function sameLabelOrdinal(items, itemId) {
  const target = items.find((item) => item.id === itemId)
  if (!target) return -1
  const label = normalizeStepLabel(target.label)
  return items.filter((item) => normalizeStepLabel(item.label) === label).findIndex((item) => item.id === itemId)
}

/**
 * Pick the one copy to remove from a later checklist.
 *
 * The copy at the clicked step's ordinal goes when it is untouched. When it is
 * not there, or work has started on it, another untouched same-label copy goes
 * instead ONLY when the checklist has at least as many same-label copies as the
 * template stage had before the delete. A checklist with fewer has lost one of
 * them already (or never had it), and an untouched copy there may be the
 * counterpart of a template step that is being kept, so it is left alone.
 *
 * @param {{ id: string, carriesWork: boolean }[]} copies the same-label steps of
 *   that checklist, in display order
 * @param {number} ordinal the clicked step's `sameLabelOrdinal`
 * @param {number} templateCopies how many same-label steps the template stage
 *   had BEFORE the delete
 * @returns {{ removeId: string | null, kept: boolean }} `kept` is true only
 *   when nothing was removed from this checklist and a copy was left because
 *   work had started on it, so a checklist is never in both lists.
 */
export function pickCopyToRemove(copies, ordinal, templateCopies) {
  if (copies.length === 0) return { removeId: null, kept: false }
  const atOrdinal = copies[ordinal]
  let removable = null
  if (atOrdinal && !atOrdinal.carriesWork) {
    removable = atOrdinal
  } else if (copies.length >= templateCopies) {
    removable = copies.find((copy) => !copy.carriesWork) ?? null
  }
  return {
    removeId: removable ? removable.id : null,
    kept: !removable && copies.some((copy) => copy.carriesWork),
  }
}
