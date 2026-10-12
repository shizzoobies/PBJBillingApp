// The words for a proposal's outcome (engagements stage 1, docs/plans/engagements-2026-10.md).
// The stored statuses stay `accepted` / `declined`; everything the firm reads says Won and
// closed as lost. Pure and shared by server.js and db/store.js, so every refusal on a decided
// proposal uses the same words as the status pill (src/lib/proposals.ts PROPOSAL_STATUS_LABELS).

/** A status as a state: "This proposal is <Won | closed as lost | sent | draft>". */
export function proposalOutcomeWords(status) {
  if (status === 'accepted') return 'Won'
  if (status === 'declined') return 'closed as lost'
  return String(status ?? '')
}

/** A status as something done to it: "it can't be <marked Won | closed as lost | sent> again". */
export function proposalOutcomeAction(status) {
  if (status === 'accepted') return 'marked Won'
  if (status === 'declined') return 'closed as lost'
  return String(status ?? '')
}
