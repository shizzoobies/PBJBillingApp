import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  generateBackupCodes,
  generateSecret,
  verifyBackupCode,
  verifyCode,
} from '../../lib/totp.js'

/**
 * Re-implement just enough of RFC 4226 HOTP to produce the 6-digit code that
 * `verifyCode` should accept for "right now". This mirrors `hotpCode` inside
 * lib/totp.js (which is not exported) so the test can hand verifyCode a code
 * it must consider valid, without depending on a real authenticator app.
 */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function decodeBase32(input: string): Buffer {
  const cleaned = input.toUpperCase().replace(/[^A-Z2-7]/g, '')
  let bits = 0
  let value = 0
  const bytes: number[] = []
  for (const char of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(char)
    if (idx === -1) continue
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

function totpNow(base32Secret: string): string {
  const secretBuffer = decodeBase32(base32Secret)
  const counter = Math.floor(Date.now() / 1000 / 30)
  const counterBuffer = Buffer.alloc(8)
  counterBuffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0)
  counterBuffer.writeUInt32BE(counter >>> 0, 4)
  const hmac = createHmac('sha1', secretBuffer).update(counterBuffer).digest()
  const offset = hmac[hmac.length - 1] & 0x0f
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  return String(binary % 1_000_000).padStart(6, '0')
}

describe('totp generateSecret', () => {
  it('produces a usable base32 secret and an otpauth URI', () => {
    const secret = generateSecret()
    // 20 random bytes base32-encoded is 32 chars, all from the base32 alphabet.
    expect(secret.base32).toMatch(/^[A-Z2-7]+$/)
    expect(secret.base32.length).toBeGreaterThanOrEqual(32)

    const uri = secret.otpauthUri('user@example.com', 'PB&J Strategic Accounting')
    expect(uri.startsWith('otpauth://totp/')).toBe(true)
    expect(uri).toContain(`secret=${secret.base32}`)
    expect(uri).toContain('algorithm=SHA1')
  })

  it('generates a different secret each call', () => {
    expect(generateSecret().base32).not.toBe(generateSecret().base32)
  })
})

describe('totp verifyCode', () => {
  it('accepts a freshly generated code for the current time step', () => {
    const secret = generateSecret()
    const code = totpNow(secret.base32)
    expect(verifyCode(secret.base32, code)).toBe(true)
  })

  it('rejects an obviously wrong code', () => {
    const secret = generateSecret()
    const code = totpNow(secret.base32)
    // Flip the code to a guaranteed-different 6-digit string.
    const wrong = code === '000000' ? '999999' : '000000'
    expect(verifyCode(secret.base32, wrong)).toBe(false)
  })

  it('rejects malformed input (non-6-digit)', () => {
    const secret = generateSecret()
    expect(verifyCode(secret.base32, '')).toBe(false)
    expect(verifyCode(secret.base32, '12345')).toBe(false)
    expect(verifyCode(secret.base32, 'abcdef')).toBe(false)
  })
})

describe('totp backup codes', () => {
  it('generates the requested count of distinct codes', () => {
    const { plain, hashed } = generateBackupCodes(8)
    expect(plain).toHaveLength(8)
    expect(hashed).toHaveLength(8)
    expect(new Set(plain).size).toBe(8)
    // Plain codes are shaped XXXX-XXXX-XX; hashes are 64-char sha-256 hex.
    for (const code of plain) {
      expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{2}$/)
    }
    for (const hash of hashed) {
      expect(hash).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('round-trips: a valid backup code verifies and is consumed on reuse', () => {
    const { plain, hashed } = generateBackupCodes(3)
    const first = plain[0]

    // First use succeeds and returns a list with that hash removed.
    const used = verifyBackupCode(first, hashed)
    expect(used.ok).toBe(true)
    expect(used.updatedHashedList).toHaveLength(2)

    // Reusing the same code against the now-shortened list is rejected.
    const reuse = verifyBackupCode(first, used.updatedHashedList)
    expect(reuse.ok).toBe(false)
    expect(reuse.updatedHashedList).toHaveLength(2)
  })

  it('rejects a backup code that was never issued', () => {
    const { hashed } = generateBackupCodes(3)
    const result = verifyBackupCode('ZZZZ-ZZZZ-ZZ', hashed)
    expect(result.ok).toBe(false)
    expect(result.updatedHashedList).toHaveLength(3)
  })
})
