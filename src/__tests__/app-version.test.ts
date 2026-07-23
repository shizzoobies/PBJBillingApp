/**
 * Deploy detection (lib/appVersion): the stale-tab watchdog compares the
 * entry-script path in freshly-served index.html against the one the running
 * tab loaded. These pin the extraction — if the pattern drifts from Vite's
 * output shape, the toast silently never fires, so this is the canary.
 */
import { describe, expect, it } from 'vitest'
import { extractEntryScript } from '../lib/appVersion'

describe('extractEntryScript', () => {
  it('finds the fingerprinted entry script in built index.html markup', () => {
    const html =
      '<!doctype html><html><head>' +
      '<script type="module" crossorigin src="/assets/index-DVMDIUyF.js"></script>' +
      '<link rel="stylesheet" crossorigin href="/assets/index-B97s4mQE.css">' +
      '</head><body><div id="root"></div></body></html>'
    expect(extractEntryScript(html)).toBe('/assets/index-DVMDIUyF.js')
  })

  it('handles hashes with underscores and dashes', () => {
    expect(extractEntryScript('src="/assets/index-a_B-9z.js"')).toBe('/assets/index-a_B-9z.js')
  })

  it('returns null for dev-server markup with no fingerprinted bundle', () => {
    const devHtml = '<script type="module" src="/src/main.tsx"></script>'
    expect(extractEntryScript(devHtml)).toBeNull()
  })

  it('returns null for a non-HTML response (e.g. an error page)', () => {
    expect(extractEntryScript('Service temporarily unavailable')).toBeNull()
  })
})
