import { describe, expect, it } from 'vitest'
import { buildLoginLinkEmail } from './notify.js'

/**
 * The sign-in email template, including the desktop-shell second button.
 * The rule under test: the pbjsa:// button exists ONLY when the request-link
 * handler saw the shell's user-agent marker and passed desktopUrl — a
 * browser sign-in email must never grow a confusing second button.
 */
describe('the sign-in email', () => {
  const base = {
    firmName: 'PB&J Strategic Accounting',
    signInUrl: 'https://app.pbjsa.com/verify/tok-123',
  }

  it('carries the browser button and the raw link, no desktop button by default', () => {
    const { subject, html } = buildLoginLinkEmail(base)
    expect(subject).toContain('Sign in to')
    expect(html).toContain('https://app.pbjsa.com/verify/tok-123')
    expect(html).not.toContain('pbjsa://')
    expect(html).not.toContain('Open in the desktop app')
  })

  it('adds the desktop button when the request came from the shell', () => {
    const { html } = buildLoginLinkEmail({ ...base, desktopUrl: 'pbjsa://verify/tok-123' })
    expect(html).toContain('href="pbjsa://verify/tok-123"')
    expect(html).toContain('Open in the desktop app')
    // The browser link stays — the person may prefer to sign in there.
    expect(html).toContain('https://app.pbjsa.com/verify/tok-123')
  })

  it('escapes an angle-bracketed firm name', () => {
    const { html } = buildLoginLinkEmail({ ...base, firmName: '<script>x</script>' })
    expect(html).not.toContain('<script>x</script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

describe('the request-link handler wires the shell marker (source-pinned)', () => {
  it('gates the desktop url on the PBJDesktopShell user-agent, never the body', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const path = await import('node:path')
    const source = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../server.js'),
      'utf8',
    )
    const at = source.indexOf("user-agent'] || '').includes(")
    expect(at, 'the user-agent gate is gone from the request-link handler').toBeGreaterThan(-1)
    const block = source.slice(at, at + 400)
    expect(block).toContain('PBJDesktopShell')
    expect(block).toContain('pbjsa://verify/')
    expect(block).toContain('encodeURIComponent(token)')
  })
})
