import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildMemoryDigest, safeEqual, verifyElevenLabsSignature } from './voice.js'

const SECRET = 'whsec_test_secret'

function sign(body, secret = SECRET, atMs = Date.now()) {
  const t = Math.floor(atMs / 1000)
  const v0 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')
  return `t=${t},v0=${v0}`
}

describe('verifyElevenLabsSignature', () => {
  const body = JSON.stringify({ type: 'post_call_transcription', data: { conversation_id: 'c1' } })

  it('accepts a valid signature', () => {
    const now = Date.now()
    expect(verifyElevenLabsSignature(body, sign(body, SECRET, now), SECRET, now)).toBe(true)
  })

  it('rejects a wrong secret', () => {
    const now = Date.now()
    expect(verifyElevenLabsSignature(body, sign(body, 'whsec_other', now), SECRET, now)).toBe(false)
  })

  it('rejects a tampered body', () => {
    const now = Date.now()
    const header = sign(body, SECRET, now)
    expect(verifyElevenLabsSignature(body.replace('c1', 'c2'), header, SECRET, now)).toBe(false)
  })

  it('rejects a stale timestamp (replay)', () => {
    const now = Date.now()
    const old = now - 31 * 60 * 1000
    expect(verifyElevenLabsSignature(body, sign(body, SECRET, old), SECRET, now)).toBe(false)
  })

  it('rejects malformed headers and missing inputs', () => {
    expect(verifyElevenLabsSignature(body, 'not-a-signature', SECRET)).toBe(false)
    expect(verifyElevenLabsSignature(body, '', SECRET)).toBe(false)
    expect(verifyElevenLabsSignature(body, sign(body), '')).toBe(false)
  })
})

describe('safeEqual', () => {
  it('compares equal and unequal strings without throwing', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'abcd')).toBe(false)
    expect(safeEqual('', '')).toBe(true)
  })
})

describe('buildMemoryDigest', () => {
  it('formats newest-first facts with dates and caps the size', () => {
    const digest = buildMemoryDigest([
      { fact: 'Riverbend close moved to the 5th', createdAt: '2026-06-10T12:00:00Z' },
      { fact: 'Prefers reports on Mondays', createdAt: '2026-06-01T12:00:00Z' },
    ])
    expect(digest).toContain('- Riverbend close moved to the 5th (noted 2026-06-10)')
    expect(digest).toContain('- Prefers reports on Mondays (noted 2026-06-01)')
  })

  it('handles no memories', () => {
    expect(buildMemoryDigest([])).toBe('No saved memories yet.')
    expect(buildMemoryDigest(undefined)).toBe('No saved memories yet.')
  })

  it('stays under the character cap', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      fact: `Fact number ${i} ${'x'.repeat(200)}`,
      createdAt: '2026-06-10T12:00:00Z',
    }))
    expect(buildMemoryDigest(many).length).toBeLessThanOrEqual(2500)
  })
})
