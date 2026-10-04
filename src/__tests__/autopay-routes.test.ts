import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The autopay routes (featreq-bef42b72), pinned the way the pay-link routes are:
 * server.js listens at module scope and exports nothing, so this reads the
 * source. The store halves have real tests in db/store-staleness.test.mjs and
 * the payloads in lib/stripe-autopay.test.mjs; what is pinned HERE is the
 * ORDER and the gates of the routes that move or expose money.
 */

const serverSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.js'),
  'utf8',
)

function sliceBetween(from: string, to: string) {
  const start = serverSource.indexOf(from)
  expect(start, `${from} is gone from server.js`).toBeGreaterThan(-1)
  const end = serverSource.indexOf(to, start + from.length)
  expect(end, `${to} no longer follows ${from}`).toBeGreaterThan(start)
  return serverSource.slice(start, end)
}

const squash = (text: string) => text.replace(/\s+/g, ' ')

describe('GET /api/autopay (the owner’s panel)', () => {
  const block = sliceBetween(
    "normalizedPath === '/api/autopay' && request.method === 'GET'",
    '// POST /api/stripe/webhook',
  )

  it('is owner-only', () => {
    expect(block).toContain("session.user.role !== 'owner'")
    expect(block).toContain('sendJson(response, 403')
    expect(block.indexOf('403')).toBeLessThan(block.indexOf('listClientAutopay'))
  })

  it('answers summaries only, never the stored rows', () => {
    expect(squash(block)).toContain('.map(autopaySummary)')
    expect(block).not.toContain('setupToken')
  })
})

describe('what a team member is sent', () => {
  it('the file backend’s whole-file read is stripped of both autopay tables for staff', () => {
    const scope = sliceBetween('function scopeAppDataForSession(', 'Soft-deleted team members are owner-only')
    expect(scope).toContain('clientAutopay: undefined')
    expect(scope).toContain('autopayAttempts: undefined')
  })
})
