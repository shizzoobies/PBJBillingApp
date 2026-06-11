/**
 * Pending action proposals from the VOICE assistant (in-memory).
 *
 * The safety contract: the voice agent (or any AI path) can only ADD a
 * proposal here. Nothing in this module — or anywhere reachable from the
 * ElevenLabs webhook surface — executes an action. Execution happens solely
 * in POST /api/assistant/action, which requires the owner's authenticated
 * browser session + CSRF + the server-side tool allowlist, after she taps
 * "Run it" on the card. If the server restarts mid-call the proposal is
 * simply gone (she asks again) — ephemeral by design, so no DB schema.
 */

const DEFAULT_TTL_MS = 10 * 60 * 1000 // proposals expire after 10 minutes
const MAX_PER_USER = 5

export function createPendingActionStore({ ttlMs = DEFAULT_TTL_MS, max = MAX_PER_USER } = {}) {
  /** @type {Map<string, Array<{id: string, tool: string, label: string, summary: string, params: object, createdAt: number}>>} */
  const byUser = new Map()
  let counter = 0

  const sweep = (userId, now) => {
    const list = (byUser.get(userId) ?? []).filter((p) => now - p.createdAt < ttlMs)
    byUser.set(userId, list)
    return list
  }

  return {
    /** Park a proposal for the owner. Oldest is dropped past the cap. */
    add(userId, proposal, now = Date.now()) {
      if (!userId || !proposal?.tool) return null
      counter += 1
      const entry = {
        id: `pa-${now.toString(36)}-${counter}`,
        tool: proposal.tool,
        label: proposal.label ?? proposal.tool,
        summary: proposal.summary ?? '',
        params: proposal.params ?? {},
        createdAt: now,
      }
      const list = sweep(userId, now)
      list.push(entry)
      while (list.length > max) list.shift()
      byUser.set(userId, list)
      return entry
    },

    /** Live (unexpired) proposals for this user, oldest first. */
    list(userId, now = Date.now()) {
      if (!userId) return []
      return [...sweep(userId, now)]
    },

    /** Remove one proposal (after execute or dismiss). True if it existed. */
    resolve(userId, proposalId, now = Date.now()) {
      if (!userId || !proposalId) return false
      const list = sweep(userId, now)
      const index = list.findIndex((p) => p.id === proposalId)
      if (index === -1) return false
      list.splice(index, 1)
      byUser.set(userId, list)
      return true
    },
  }
}
