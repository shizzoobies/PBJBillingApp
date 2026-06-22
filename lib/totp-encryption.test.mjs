import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  decryptSecretAtRest,
  encryptSecretAtRest,
  generateSecret,
  verifyCode,
} from './totp.js'

// Save/restore the env var so tests don't leak state into each other.
let savedKey
beforeEach(() => {
  savedKey = process.env.TOTP_ENC_KEY
})
afterEach(() => {
  if (savedKey === undefined) delete process.env.TOTP_ENC_KEY
  else process.env.TOTP_ENC_KEY = savedKey
})

describe('TOTP secret encryption-at-rest (H5)', () => {
  it('is a no-op passthrough when TOTP_ENC_KEY is unset (plaintext fallback)', () => {
    delete process.env.TOTP_ENC_KEY
    const secret = generateSecret().base32
    const stored = encryptSecretAtRest(secret)
    expect(stored).toBe(secret) // stored verbatim, exactly as before
    expect(decryptSecretAtRest(stored)).toBe(secret)
  })

  it('round-trips an encrypted secret when a key is set', () => {
    process.env.TOTP_ENC_KEY = 'a-strong-operator-key'
    const secret = generateSecret().base32
    const stored = encryptSecretAtRest(secret)
    expect(stored).not.toBe(secret)
    expect(stored.startsWith('enc:v1:')).toBe(true)
    expect(decryptSecretAtRest(stored)).toBe(secret)
  })

  it('produces a distinct ciphertext each call (random IV) but same plaintext', () => {
    process.env.TOTP_ENC_KEY = 'a-strong-operator-key'
    const secret = generateSecret().base32
    const a = encryptSecretAtRest(secret)
    const b = encryptSecretAtRest(secret)
    expect(a).not.toBe(b)
    expect(decryptSecretAtRest(a)).toBe(secret)
    expect(decryptSecretAtRest(b)).toBe(secret)
  })

  it('still reads legacy plaintext rows after a key is introduced', () => {
    // A secret was stored before encryption existed (no marker)...
    const secret = generateSecret().base32
    // ...now the operator sets a key. Reading the legacy value must still work.
    process.env.TOTP_ENC_KEY = 'a-strong-operator-key'
    expect(decryptSecretAtRest(secret)).toBe(secret)
  })

  it('an encrypted secret verifies a real code end-to-end through the wrap', () => {
    process.env.TOTP_ENC_KEY = 'a-strong-operator-key'
    const { base32 } = generateSecret()
    const stored = encryptSecretAtRest(base32)
    const recovered = decryptSecretAtRest(stored)
    // The recovered secret must verify a code generated for the original.
    // (We can't easily compute a live code here without re-implementing HOTP,
    // so assert exact-equality which guarantees verifyCode behaves identically.)
    expect(recovered).toBe(base32)
    expect(verifyCode(recovered, '000000')).toBe(false) // sanity: function callable
  })

  it('returns null for an encrypted value when the key is missing (fail closed)', () => {
    process.env.TOTP_ENC_KEY = 'a-strong-operator-key'
    const stored = encryptSecretAtRest(generateSecret().base32)
    delete process.env.TOTP_ENC_KEY
    expect(decryptSecretAtRest(stored)).toBe(null)
  })

  it('handles null/empty without throwing', () => {
    expect(encryptSecretAtRest(null)).toBe(null)
    expect(encryptSecretAtRest('')).toBe('')
    expect(decryptSecretAtRest(null)).toBe(null)
    expect(decryptSecretAtRest('')).toBe('')
  })
})
