/**
 * RFC 6238 (TOTP) + RFC 4226 (HOTP) implementation. Pure built-in crypto —
 * no external dependencies (we deliberately do NOT pull in `speakeasy` or
 * `otplib`).
 *
 * Public API:
 *   generateSecret() -> { base32, otpauthUri(label, issuer) }
 *   verifyCode(secret, code, { window = 1 }) -> boolean
 *   generateBackupCodes(n = 8) -> { plain: string[], hashed: string[] }
 *   verifyBackupCode(plainCode, hashedList) -> { ok, updatedHashedList }
 *
 * Storage note: `totpSecret` is stored as plaintext in the DB for v1. The
 * right defense against secret leakage is encryption-at-rest at the database
 * layer (Railway Postgres encrypts disks; for higher assurance, switch to a
 * KMS-backed wrapping key and store ciphertext here). Backup codes are
 * sha-256 hashed before storage — only the hash is persisted.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto'

// RFC 4648 base32 alphabet — no padding ('='), uppercase. Authenticator apps
// accept lowercase too but uppercase is the canonical form.
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

// Backup-code alphabet excludes ambiguous characters (0/O/I/1/L) so people
// can read the codes back off paper without confusion.
const BACKUP_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

function encodeBase32(buffer) {
  let bits = 0
  let value = 0
  let output = ''
  for (let i = 0; i < buffer.length; i += 1) {
    value = (value << 8) | buffer[i]
    bits += 8
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f]
      bits -= 5
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f]
  }
  return output
}

function decodeBase32(input) {
  const cleaned = String(input || '')
    .toUpperCase()
    .replace(/[^A-Z2-7]/g, '')
  let bits = 0
  let value = 0
  const bytes = []
  for (let i = 0; i < cleaned.length; i += 1) {
    const idx = BASE32_ALPHABET.indexOf(cleaned[i])
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

/**
 * HOTP (RFC 4226): produce a 6-digit code for the given counter. SHA-1 is the
 * algorithm every authenticator app speaks by default, so we hard-code it.
 */
function hotpCode(secretBuffer, counter, digits = 6) {
  const counterBuffer = Buffer.alloc(8)
  // Counter is 64-bit big-endian. JS bitwise ops are 32-bit, so split.
  const high = Math.floor(counter / 0x100000000)
  const low = counter >>> 0
  counterBuffer.writeUInt32BE(high, 0)
  counterBuffer.writeUInt32BE(low, 4)

  const hmac = createHmac('sha1', secretBuffer).update(counterBuffer).digest()
  const offset = hmac[hmac.length - 1] & 0x0f
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  const code = binary % 10 ** digits
  return String(code).padStart(digits, '0')
}

/**
 * Generate a fresh 20-byte (160-bit) secret encoded as base32 — the size
 * recommended by RFC 4226 for HMAC-SHA1.
 *
 * Returns:
 *   { base32, otpauthUri(label, issuer) }
 *
 * `otpauthUri` produces the URL authenticator apps consume, e.g.:
 *   otpauth://totp/Issuer:user@example.com?secret=...&issuer=Issuer&algorithm=SHA1&digits=6&period=30
 */
export function generateSecret() {
  const buffer = randomBytes(20)
  const base32 = encodeBase32(buffer)
  return {
    base32,
    otpauthUri(label, issuer) {
      const safeLabel = encodeURIComponent(String(label || 'user'))
      const safeIssuer = encodeURIComponent(String(issuer || 'PB&J Strategic Accounting'))
      const params = [
        `secret=${base32}`,
        `issuer=${safeIssuer}`,
        `algorithm=SHA1`,
        `digits=6`,
        `period=30`,
      ].join('&')
      return `otpauth://totp/${safeIssuer}:${safeLabel}?${params}`
    },
  }
}

function safeStringEqual(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/**
 * Verify a 6-digit TOTP code against `secret` (base32). The optional `window`
 * (default 1) allows ±N 30-second steps of clock drift, so window=1 means the
 * code must be valid within a ±30-second window around server time.
 */
export function verifyCode(secret, code, { window = 1 } = {}) {
  const trimmed = String(code || '').replace(/\s+/g, '')
  if (!/^\d{6}$/.test(trimmed)) return false
  const secretBuffer = decodeBase32(secret)
  if (secretBuffer.length === 0) return false
  const step = Math.floor(Date.now() / 1000 / 30)
  const range = Math.max(0, Number(window) || 0)
  for (let drift = -range; drift <= range; drift += 1) {
    const candidate = hotpCode(secretBuffer, step + drift)
    if (safeStringEqual(candidate, trimmed)) return true
  }
  return false
}

function randomBackupCode() {
  // 10 chars (without separators), shaped as XXXX-XXXX-XX for legibility.
  const bytes = randomBytes(10)
  let raw = ''
  for (let i = 0; i < 10; i += 1) {
    raw += BACKUP_ALPHABET[bytes[i] % BACKUP_ALPHABET.length]
  }
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 10)}`
}

function hashBackupCode(plain) {
  return createHash('sha256').update(String(plain).toUpperCase().replace(/-/g, '')).digest('hex')
}

/**
 * Generate `n` backup codes. The `plain` array is shown to the user once; the
 * `hashed` array (sha-256 hex of normalized code) is what gets persisted.
 */
export function generateBackupCodes(n = 8) {
  const plain = []
  const hashed = []
  for (let i = 0; i < n; i += 1) {
    const code = randomBackupCode()
    plain.push(code)
    hashed.push(hashBackupCode(code))
  }
  return { plain, hashed }
}

/**
 * Validate `plainCode` against `hashedList`. Returns `{ ok, updatedHashedList }`
 * — when `ok` is true the matching hash is removed from the returned list so
 * the caller can persist the consumed-state.
 */
export function verifyBackupCode(plainCode, hashedList) {
  if (!plainCode || !Array.isArray(hashedList) || hashedList.length === 0) {
    return { ok: false, updatedHashedList: hashedList ?? [] }
  }
  const candidate = hashBackupCode(plainCode)
  const idx = hashedList.findIndex((entry) => safeStringEqual(entry, candidate))
  if (idx === -1) {
    return { ok: false, updatedHashedList: hashedList }
  }
  const next = hashedList.filter((_, i) => i !== idx)
  return { ok: true, updatedHashedList: next }
}

/* -------------------------------------------------------------------------- */
/* Encryption-at-rest for the TOTP secret (H5).                               */
/*                                                                            */
/* The secret is wrapped with AES-256-GCM using a key derived from the        */
/* `TOTP_ENC_KEY` env var. Designed to be ZERO-RISK to deploy:                */
/*   - No TOTP_ENC_KEY set  -> encrypt is a no-op, decrypt passes through.    */
/*     Behaviour is byte-for-byte identical to the old plaintext storage.     */
/*   - TOTP_ENC_KEY set     -> new secrets are stored as `enc:v1:<b64>`;      */
/*     reads detect the marker and decrypt. EXISTING plaintext rows have no   */
/*     marker, so they keep verifying — the table migrates lazily as users    */
/*     re-enroll. Nothing breaks the moment the key is added.                 */
/* -------------------------------------------------------------------------- */

const ENC_PREFIX = 'enc:v1:'

function totpEncKey() {
  const raw = process.env.TOTP_ENC_KEY
  if (!raw || !String(raw).trim()) return null
  // Derive a stable 32-byte key from whatever the operator set. A fixed salt is
  // fine here: the env value IS the secret; scrypt just normalizes length.
  return scryptSync(String(raw), 'pbj-totp-enc-v1', 32)
}

/**
 * Encrypt a TOTP secret for storage. Returns the input unchanged when no
 * `TOTP_ENC_KEY` is configured (plaintext fallback) or when given an empty
 * value. Output format: `enc:v1:<base64(iv|tag|ciphertext)>`.
 */
export function encryptSecretAtRest(plain) {
  if (plain === null || plain === undefined || plain === '') return plain
  const key = totpEncKey()
  if (!key) return plain // no key configured → store as-is (unchanged behaviour)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return ENC_PREFIX + Buffer.concat([iv, tag, ciphertext]).toString('base64')
}

/**
 * Decrypt a stored TOTP secret. Plaintext values (no `enc:v1:` marker) are
 * returned as-is, so pre-encryption rows keep working. An encrypted value with
 * no/garbled key returns null (can't be used) rather than throwing.
 */
export function decryptSecretAtRest(stored) {
  if (stored === null || stored === undefined || stored === '') return stored
  const value = String(stored)
  if (!value.startsWith(ENC_PREFIX)) return stored // legacy plaintext → unchanged
  const key = totpEncKey()
  if (!key) return null // marked encrypted but no key available → unusable
  try {
    const blob = Buffer.from(value.slice(ENC_PREFIX.length), 'base64')
    const iv = blob.subarray(0, 12)
    const tag = blob.subarray(12, 28)
    const ciphertext = blob.subarray(28)
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch {
    return null // tampered / wrong key → fail closed
  }
}
