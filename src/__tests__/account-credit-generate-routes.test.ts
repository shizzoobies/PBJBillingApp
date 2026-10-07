import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Credit on account at generation (stage 1c), pinned the way the 1a and 1b routes
 * are: server.js listens at module scope and exports nothing, so this reads the
 * source. The store halves (the draw, the lock, the ledger, Void & regenerate)
 * have real tests in db/store-staleness.test.mjs; what is pinned HERE is that the
 * two routes that build monthly drafts hand the run's result straight back, and
 * that a send of an invoice credit covers in full still mints no pay link.
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

describe('the routes that generate monthly drafts', () => {
  const generate = sliceBetween("normalizedPath === '/api/invoices/generate'", "normalizedPath === '/api/invoices/regenerate'")
  const regenerate = sliceBetween("normalizedPath === '/api/invoices/regenerate'", "normalizedPath === '/api/clients' && request.method === 'POST'")

  it('Generate answers with the store\'s own result, so the drafts carry their credit line to the page', () => {
    expect(squash(generate)).toContain('result = await appDataStore.generateInvoicesForPeriod(period, {')
    expect(squash(generate)).toContain('sendJson(response, 200, result)')
  })

  it('Void & regenerate voids first (which returns the draws), then rebuilds through the same generator', () => {
    const text = squash(regenerate)
    const voided = text.indexOf('appDataStore.voidUnsentInvoicesForPeriod(regenPeriod)')
    const rebuilt = text.indexOf('appDataStore.generateInvoicesForPeriod(regenPeriod)')
    expect(voided).toBeGreaterThan(-1)
    expect(rebuilt).toBeGreaterThan(voided)
    expect(text).toContain('created: rebuilt.created')
  })
})

describe('a send of an invoice credit on account covers in full', () => {
  it('mints no checkout link: the pay link needs a total above zero, so it goes out as a statement', () => {
    const sendBlock = sliceBetween('const autopaySend = await planAutopaySend(invoice, sendClient)', '!autopaySend.active')
    expect(squash(sendBlock)).toContain('invoice.total > 0')
  })
})
