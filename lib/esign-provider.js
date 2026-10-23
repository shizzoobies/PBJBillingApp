/**
 * Which e-signature provider sends an engagement letter (featreq-56d39567, task 18; docs/esignatures.md).
 *
 *  - `esignatures` (eSignatures.io, esignatures.com) whenever ESIGNATURES_SECRET_TOKEN is set -
 *    unless ESIGN_PROVIDER=signwell asks for SignWell;
 *  - else `signwell` when SIGNWELL_API_KEY is set;
 *  - else none (null): Send for signature is hidden and refused.
 *
 * Asked for SignWell with no SignWell key is "none", never a silent switch to the other provider.
 * A stored request remembers its own provider (`requestProvider`), so a letter already out stays
 * with the provider it went to whatever these variables say later.
 */

export const ESIGN_PROVIDERS = Object.freeze(['esignatures', 'signwell'])
export const ESIGN_PROVIDER_LABELS = Object.freeze({ esignatures: 'eSignatures.io', signwell: 'SignWell' })

const set = (value) => String(value ?? '').trim() !== ''
const notFalse = (value) => String(value ?? '').trim().toLowerCase() !== 'false'

/** The provider a new send for signature goes through: 'esignatures', 'signwell' or null. */
export function esignProvider(env = process.env) {
  const wantsSignwell = String(env?.ESIGN_PROVIDER ?? '').trim().toLowerCase() === 'signwell'
  if (!wantsSignwell && set(env?.ESIGNATURES_SECRET_TOKEN)) return 'esignatures'
  if (set(env?.SIGNWELL_API_KEY)) return 'signwell'
  return null
}

/** True when some provider can send a letter for signature. */
export function esignConfigured(env = process.env) {
  return esignProvider(env) !== null
}

/** ESIGNATURES_TEST_MODE: missing (or anything but the literal `false`, any case) is TEST - SignWell's rule. */
export function esignaturesTestMode(env = process.env) {
  return notFalse(env?.ESIGNATURES_TEST_MODE)
}

/** Test mode of the provider a send would use, by that provider's own variable; with none set up, test. */
export function esignTestMode(env = process.env) {
  if (esignProvider(env) === 'esignatures') return esignaturesTestMode(env)
  return notFalse(env?.SIGNWELL_TEST_MODE)
}

/** A stored request's provider: null (every request before task 18) or anything unknown reads as SignWell. */
export function requestProvider(request) {
  return request?.provider === 'esignatures' ? 'esignatures' : 'signwell'
}

/** "eSignatures.io" / "SignWell" for a sentence. */
export function esignProviderLabel(provider) {
  return ESIGN_PROVIDER_LABELS[provider === 'esignatures' ? 'esignatures' : 'signwell']
}
