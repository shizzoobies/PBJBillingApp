/**
 * The e-signature request statuses a request never leaves (featreq-56d39567; featreq-60118b28), in ONE place:
 * db/store.js applies them, the two webhook handlers and the withdrawal (lib/engagement-esign.js) read them,
 * and the letter page (src/components/engagements/EsignPanel.tsx) hides Check for them.
 *
 * `withdrawn` is the app's own end: the letter was voided, marked signed by hand or superseded while the
 * request was still open, and the provider confirmed the withdrawal (or its contract reads not signed).
 */
export const FINISHED_SIGNATURE_STATUSES = Object.freeze(['completed', 'declined', 'expired', 'canceled', 'withdrawn'])

/** The finished statuses that ended WITHOUT a signature here (everything but completed). */
export const ENDED_SIGNATURE_STATUSES = Object.freeze(FINISHED_SIGNATURE_STATUSES.filter((status) => status !== 'completed'))
