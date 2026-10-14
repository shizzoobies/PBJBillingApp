/**
 * The sentences, and the one rule, for a billing master's letter covering its
 * sub-companies in one Send. Shared by lib/letter-send.js (the server) and the
 * Letters page, which sends ten at a time and so sees a master's result in one
 * request and its sub's in another. No imports: the page bundles this file.
 */

/** "<Sub> bills through <Master>, which is in this batch - the master's letter covers it." */
export const coveredByMasterSentence = (clientName, masterName) =>
  `${clientName} bills through ${masterName}, which is in this batch - the master's letter covers it.`

/** The same skip, once the master's own letter turned out not to go. */
export const masterDidNotGoSentence = (clientName, masterName) =>
  `${clientName} was skipped because ${masterName} was in this batch, but ${masterName}'s letter did not go - send ${clientName} on its own or fix ${masterName} first.`

/** The master's own send never finished (it may or may not have gone), so neither "covered" nor "did not go" is known. */
export const masterUnsureSentence = (clientName, masterName) =>
  `${clientName} was skipped because ${masterName} was in this batch, but ${masterName}'s earlier send never finished - check ${masterName}'s send first.`

/**
 * Rewrites each `master_in_batch` result from what became of its master, both ways, so a later
 * Send again that sends the master puts "covered" back:
 *  - the master's letter went (sent, already sent today, or another owner's send running now): covered;
 *  - it was deleted (`letter_deleted`): the sub's result is left as it is;
 *  - its earlier send never finished (`unfinished`): a neutral "check the master's send first";
 *  - any other result (skipped, failed): the master's letter did not go;
 *  - no result for the master: left alone, or "did not go" with `missingMasterDidNotGo` (a request
 *    that failed before the master was reached).
 * Pure; returns a new list.
 */
export function reconcileCoveredResults(results, { missingMasterDidNotGo = false } = {}) {
  const byId = new Map(results.map((result) => [result.clientId, result]))
  return results.map((result) => {
    if (result.code !== 'master_in_batch' || !result.masterId) return result
    const master = byId.get(result.masterId)
    const { clientName, masterName } = result
    if (!master) {
      return missingMasterDidNotGo ? { ...result, message: masterDidNotGoSentence(clientName, masterName) } : result
    }
    if (master.code === 'letter_deleted') return result
    if (master.status === 'sent' || master.code === 'already_sent' || master.code === 'sending_now') {
      return { ...result, message: coveredByMasterSentence(clientName, masterName) }
    }
    if (master.code === 'unfinished') return { ...result, message: masterUnsureSentence(clientName, masterName) }
    return { ...result, message: masterDidNotGoSentence(clientName, masterName) }
  })
}
