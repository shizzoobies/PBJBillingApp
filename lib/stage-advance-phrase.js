/**
 * The plain phrase staff read when a tick saved but the next step of its case
 * could not be created for a reason that is not already worded (a Postgres
 * message, a stack fragment). The raw text stays in the server log; the store
 * answers this phrase as `spawnError`, the Activity row and the page notice
 * carry it. ONE copy, imported by the store and by the page, so neither
 * compares against a literal.
 *
 * "Untick and tick this step again" is the real retry: the second tick finds
 * the stage still missing and creates it (`maybeSpawnNextStage` answers
 * `already_spawned` when it is already there, so retrying is safe).
 */
export const STAGE_ADVANCE_FAILED_PHRASE =
  'The next step could not be created. The tick was saved - untick and tick this step again to retry, or tell Alex (the server log has the detail).'

/** Whether `message` is the plain phrase above (as opposed to a worded refusal). */
export function isStageAdvanceFailedPhrase(message) {
  return String(message ?? '') === STAGE_ADVANCE_FAILED_PHRASE
}
