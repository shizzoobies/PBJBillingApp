/**
 * Voice-agent helpers (ElevenLabs, V2): webhook signature verification and
 * the cross-call memory digest. Pure functions — server.js wires them up.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

/** Constant-time string compare that never throws on length mismatch. */
export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''))
  const bufB = Buffer.from(String(b ?? ''))
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/**
 * Verify an ElevenLabs post-call webhook signature.
 *
 * Header format (elevenlabs-signature): `t=<unix seconds>,v0=<hex hmac>` where
 * the HMAC-SHA256 is computed over `${t}.${rawBody}` with the shared webhook
 * secret. Rejects stale timestamps (default tolerance 30 minutes) so a
 * captured request can't be replayed later.
 *
 * @param {string} rawBody          The EXACT raw request body string.
 * @param {string} signatureHeader  The elevenlabs-signature header value.
 * @param {string} secret           The shared webhook secret.
 * @param {number} [nowMs]          Injection point for tests.
 */
export function verifyElevenLabsSignature(rawBody, signatureHeader, secret, nowMs = Date.now()) {
  if (!rawBody || !signatureHeader || !secret) return false
  const parts = String(signatureHeader).split(',')
  const timestamp = parts.find((p) => p.startsWith('t='))?.slice(2)
  const signature = parts.find((p) => p.startsWith('v0='))?.slice(3)
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false

  const ageMs = nowMs - Number(timestamp) * 1000
  if (ageMs > 30 * 60 * 1000 || ageMs < -5 * 60 * 1000) return false

  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')
  return safeEqual(signature, expected)
}

/**
 * Compact plain-text digest of saved memories for the agent's system prompt
 * (injected as the {{memory_digest}} dynamic variable at session start).
 * Newest first, capped so it stays cheap in the prompt.
 */
export function buildMemoryDigest(memories, maxItems = 25, maxChars = 2400) {
  const items = (memories ?? [])
    .filter((m) => m && typeof m.fact === 'string' && m.fact.trim())
    .slice(0, maxItems)
  if (items.length === 0) return 'No saved memories yet.'

  const lines = []
  let used = 0
  for (const m of items) {
    const date = typeof m.createdAt === 'string' ? m.createdAt.slice(0, 10) : ''
    const line = `- ${m.fact.trim()}${date ? ` (noted ${date})` : ''}`
    if (used + line.length > maxChars) break
    lines.push(line)
    used += line.length + 1
  }
  return lines.join('\n')
}
