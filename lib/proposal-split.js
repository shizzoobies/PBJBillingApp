// Splitting a proposal into parts (featreq-23b26bb1).
//
// A prospect who says yes to only some of what was proposed: the lines they did
// not accept move to a NEW draft proposal, and the proposal they came from keeps
// the rest. Each part is an ordinary proposal from then on (its own letter, its
// own Accept), and the parts of one split stay tied together by `splitFromId` so
// they end up on ONE client.
//
// Pure helpers only: the store does the writes (`splitProposal` in db/store.js)
// and both the server and the pages read the rules from here.

import {
  ANNUAL_GROUP,
  CLEANUP_GROUP,
  MONTHLY_GROUPS,
  SOFTWARE_GROUP,
  formatProposalMoney,
  unpricedProposalLines,
} from './proposal-pricing.js'

/** Only an open proposal can be split: a Won or Closed/Lost one is a record of what happened. */
export const SPLIT_STATUSES = Object.freeze(['draft', 'sent'])

export const SPLIT_PICK_ONE = 'Tick at least one line to move.'
export const SPLIT_LEAVE_ONE = 'Leave at least one line on this proposal - to move everything, use Copy to new proposal.'
export const SPLIT_LINE_GONE =
  'One of those lines is no longer on this proposal. Nothing was moved - look it over and split again.'
export const SPLIT_CHANGED =
  'This proposal changed while you were splitting it. Nothing was moved - look it over and split again.'

/** True when the proposal has something to split: it is open and has at least two lines. */
export function canSplitProposal(proposal) {
  return (
    Boolean(proposal) &&
    SPLIT_STATUSES.includes(proposal.status) &&
    Array.isArray(proposal.selections) &&
    proposal.selections.length >= 2
  )
}

/**
 * The picked lines taken off a selection list: `move` are the selections named in
 * `moveIds` (in the proposal's own order, exactly as stored - an override or a
 * typed amount goes with its line), `stay` is everything else, and `unknown` are
 * ids that name no line on this proposal.
 */
export function splitSelections(selections, moveIds) {
  const list = Array.isArray(selections) ? selections : []
  const wanted = new Set(
    (Array.isArray(moveIds) ? moveIds : []).filter((id) => typeof id === 'string' && id),
  )
  const have = new Set(list.map((entry) => entry?.serviceId))
  return {
    move: list.filter((entry) => wanted.has(entry?.serviceId)),
    stay: list.filter((entry) => !wanted.has(entry?.serviceId)),
    unknown: [...wanted].filter((id) => !have.has(id)),
  }
}

/**
 * Why this split cannot happen, as a sentence, or null when it can. `statusWords`
 * is how the caller names a decided status ("Won" / "Closed/Lost").
 */
export function splitRefusal({ status, selections, moveIds, statusWords = null } = {}) {
  if (!SPLIT_STATUSES.includes(status)) {
    return `This proposal is ${statusWords || status} - only a Draft or Sent proposal can be split.`
  }
  const { move, stay, unknown } = splitSelections(selections, moveIds)
  if (unknown.length > 0) return SPLIT_LINE_GONE
  if (move.length === 0) return SPLIT_PICK_ONE
  if (stay.length === 0) return SPLIT_LEAVE_ONE
  return null
}

/**
 * The key every part of one split shares: the id at the top of its `splitFromId`
 * chain. A part whose parent was deleted still groups with that parent's other
 * parts (the key is the missing parent's id). A proposal never split is its own key.
 */
function familyKey(byId, proposal) {
  let current = proposal
  const seen = new Set()
  while (current?.splitFromId && !seen.has(current.id)) {
    seen.add(current.id)
    const parent = byId.get(current.splitFromId)
    if (!parent) return current.splitFromId
    current = parent
  }
  return current?.id ?? null
}

/**
 * Every part of the split `id` belongs to, itself included, oldest first. A
 * proposal that was never split (and never split from) answers with just itself;
 * an id that is not in the list answers with nothing.
 */
export function splitFamily(proposals, id) {
  const list = (Array.isArray(proposals) ? proposals : []).filter((entry) => entry && entry.id)
  const byId = new Map(list.map((entry) => [entry.id, entry]))
  const self = byId.get(id)
  if (!self) return []
  const key = familyKey(byId, self)
  return list
    .filter((entry) => familyKey(byId, entry) === key)
    .sort(
      (a, b) =>
        String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')) || String(a.id).localeCompare(String(b.id)),
    )
}

/** The ids of every proposal that is one part of a split with two or more parts. */
export function splitPartIds(proposals) {
  const list = (Array.isArray(proposals) ? proposals : []).filter((entry) => entry && entry.id)
  const byId = new Map(list.map((entry) => [entry.id, entry]))
  const keys = new Map(list.map((entry) => [entry.id, familyKey(byId, entry)]))
  const sizes = new Map()
  for (const key of keys.values()) sizes.set(key, (sizes.get(key) ?? 0) + 1)
  return new Set(list.filter((entry) => sizes.get(keys.get(entry.id)) > 1).map((entry) => entry.id))
}

/** The other parts of the split `id` belongs to (never itself). */
export function splitSiblings(proposals, id) {
  return splitFamily(proposals, id).filter((entry) => entry.id !== id)
}

const PART_TOTALS = [
  ['monthly', 'Monthly'],
  ['annual', 'Annual'],
  ['oneTime', 'One-time'],
  ['cleanup', 'Clean-up'],
  ['software', 'Software'],
]

/**
 * What a set of priced lines comes to, in a few words: "Monthly $191.25 ·
 * Clean-up $315.00". Only the totals that have something; a total of $0 whose
 * lines are all not yet priced is left out, and nothing priced at all reads
 * "Not yet priced" (never $0.00, the same rule the list and the letter keep).
 */
export function splitTotalsWords(totals) {
  const source = totals && typeof totals === 'object' ? totals : {}
  const words = PART_TOTALS.filter(([key]) => Number(source[key]) > 0).map(
    ([key, label]) => `${label} ${formatProposalMoney(Number(source[key]))}`,
  )
  return words.length > 0 ? words.join(' · ') : 'Not yet priced'
}

/** `splitTotalsWords` for a proposal's own snapshot, flagging a partial total. */
export function splitPartWords(proposal) {
  const snapshot = proposal?.pricingSnapshot ?? null
  const lines = Array.isArray(snapshot?.lines) ? snapshot.lines : []
  if (lines.length === 0) return 'No lines yet'
  const words = splitTotalsWords(snapshot?.totals)
  const unpriced = unpricedProposalLines(snapshot).length
  return unpriced > 0 && words !== 'Not yet priced' ? `${words} (partly priced)` : words
}

/** The four money totals (and software) of a set of priced lines, the same sums `priceProposal` makes. */
export function splitLineTotals(lines) {
  const cents = { monthly: 0, annual: 0, oneTime: 0, cleanup: 0, software: 0 }
  for (const line of Array.isArray(lines) ? lines : []) {
    const amount = Math.round((Number(line?.amount) || 0) * 100)
    if (line?.group === SOFTWARE_GROUP) cents.software += amount
    else if (line?.group === CLEANUP_GROUP) cents.cleanup += amount
    else if (line?.group === ANNUAL_GROUP) {
      if (line?.cadence === 'one-time') cents.oneTime += amount
      else cents.annual += amount
    } else if (MONTHLY_GROUPS.includes(line?.group)) cents.monthly += amount
  }
  return Object.fromEntries(Object.entries(cents).map(([key, value]) => [key, value / 100]))
}

/** What Accept answers while another part of the same split already belongs to a client. */
export function splitClientRefusal(clientName) {
  return `Another part of this proposal already belongs to ${clientName || 'a client'}. Pick ${clientName || 'that client'} as the existing client on the Estimate tab first, so this part is added to them instead of creating a second client.`
}

/** What Accept answers while another part is Won and its letter is not signed yet. */
export const SPLIT_SIGN_FIRST =
  'Another part of this proposal is already Won and its engagement letter is not signed yet. Mark that letter signed first, or void it if that part will not go ahead - this part is then added to the same client instead of creating a second one.'

/** What Accept answers while another part is Won and has no engagement letter at all yet. */
export const SPLIT_DRAFT_FIRST =
  'Another part of this proposal is already Won and has no engagement letter yet. Draft its letter and mark it signed first - this part is then added to the same client instead of creating a second one.'

/**
 * What marking a letter signed answers when it would make a client and another
 * part of the same split already belongs to one. `tied` says whether this
 * letter's proposal now belongs to that client too (then a redraft is an
 * amendment); when it could not be tied, a copy with the client picked is the way.
 */
export function splitSignRefusal(clientName, { tied = true } = {}) {
  const name = clientName || 'a client'
  const lead = `Another part of this proposal already belongs to ${name}, so this letter would create a second client.`
  return tied
    ? `${lead} Void this letter, then use Draft the engagement on its proposal: it is drafted as an amendment for ${name}.`
    : `${lead} Void this letter, then use Copy to new proposal on its proposal, pick ${name} as the existing client on the copy and accept the copy.`
}
