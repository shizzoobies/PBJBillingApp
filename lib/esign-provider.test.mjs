import { describe, expect, it } from 'vitest'

import {
  ESIGN_PROVIDER_LABELS,
  esignConfigured,
  esignProvider,
  esignProviderLabel,
  esignTestMode,
  esignaturesTestMode,
  requestProvider,
} from './esign-provider.js'

/**
 * Which e-signature provider sends a letter (task 18): eSignatures.io whenever its token is set
 * (unless ESIGN_PROVIDER=signwell), else SignWell when its key is set, else none.
 */
const TOKEN = { ESIGNATURES_SECRET_TOKEN: 'es_fake_token_123456' }
const KEY = { SIGNWELL_API_KEY: 'sw_fake_key_1234567890' }

describe('esignProvider', () => {
  it('is eSignatures.io when its token is set, even with a SignWell key', () => {
    expect(esignProvider(TOKEN)).toBe('esignatures')
    expect(esignProvider({ ...TOKEN, ...KEY })).toBe('esignatures')
  })

  it('is SignWell when ESIGN_PROVIDER=signwell (any case, spaces) and the SignWell key is set', () => {
    expect(esignProvider({ ...TOKEN, ...KEY, ESIGN_PROVIDER: ' SignWell ' })).toBe('signwell')
    // Asked for SignWell, but SignWell has no key: nothing is set up (never a silent fall back to the other).
    expect(esignProvider({ ...TOKEN, ESIGN_PROVIDER: 'signwell' })).toBeNull()
  })

  it('is SignWell with only a SignWell key, and null with neither (or blank values)', () => {
    expect(esignProvider(KEY)).toBe('signwell')
    expect(esignProvider({})).toBeNull()
    expect(esignProvider({ ESIGNATURES_SECRET_TOKEN: '   ', SIGNWELL_API_KEY: '' })).toBeNull()
    expect(esignProvider(undefined)).toBe(esignProvider(process.env))
  })

  it('esignConfigured follows it', () => {
    expect(esignConfigured(TOKEN)).toBe(true)
    expect(esignConfigured(KEY)).toBe(true)
    expect(esignConfigured({})).toBe(false)
  })
})

describe('test mode', () => {
  it('ESIGNATURES_TEST_MODE: missing or anything but the literal false is TEST', () => {
    for (const value of [undefined, '', 'true', '0', 'no', 'False ', 'off', 'fasle']) {
      const expected = String(value ?? '').trim().toLowerCase() !== 'false'
      expect(esignaturesTestMode({ ESIGNATURES_TEST_MODE: value }), String(value)).toBe(expected)
    }
    expect(esignaturesTestMode({})).toBe(true)
    expect(esignaturesTestMode({ ESIGNATURES_TEST_MODE: 'FALSE' })).toBe(false)
  })

  it('esignTestMode reads the active provider\'s own variable; with none set up it is test', () => {
    expect(esignTestMode({ ...TOKEN, ESIGNATURES_TEST_MODE: 'false', SIGNWELL_TEST_MODE: 'true' })).toBe(false)
    expect(esignTestMode({ ...TOKEN, SIGNWELL_TEST_MODE: 'false' })).toBe(true)
    expect(esignTestMode({ ...KEY, SIGNWELL_TEST_MODE: 'false', ESIGNATURES_TEST_MODE: 'true' })).toBe(false)
    expect(esignTestMode({ ...KEY })).toBe(true)
    expect(esignTestMode({})).toBe(true)
  })
})

describe('a stored request\'s provider', () => {
  it('reads null or anything unknown as SignWell (every request before task 18 is one)', () => {
    expect(requestProvider({ provider: 'esignatures' })).toBe('esignatures')
    expect(requestProvider({ provider: null })).toBe('signwell')
    expect(requestProvider({})).toBe('signwell')
    expect(requestProvider(null)).toBe('signwell')
    expect(requestProvider({ provider: 'docusign' })).toBe('signwell')
  })

  it('names each provider for a sentence', () => {
    expect(esignProviderLabel('esignatures')).toBe('eSignatures.io')
    expect(esignProviderLabel('signwell')).toBe('SignWell')
    expect(esignProviderLabel(null)).toBe('SignWell')
    expect(ESIGN_PROVIDER_LABELS).toEqual({ esignatures: 'eSignatures.io', signwell: 'SignWell' })
  })
})
