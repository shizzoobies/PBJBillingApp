import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildLoginLinkEmail } from './notify.js'

/**
 * The sign-in email template, and the desktop-handoff route that replaced
 * the email's short-lived pbjsa:// button.
 *
 * History worth keeping: the first desktop sign-in design put an
 * "Open in the desktop app" pbjsa:// button in this email, gated on the
 * shell's user-agent. It rendered fine and did NOTHING when clicked — web
 * mail clients (Gmail) strip non-http link schemes. The replacement is a
 * handoff button inside the signed-in web app (Settings → Sign-in), where a
 * real user click may launch a custom protocol. The first test pins that
 * this email stays scheme-free so the dead button cannot quietly return.
 */

const serverSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../server.js'),
  'utf8',
)

describe('the sign-in email', () => {
  const base = {
    firmName: 'PB&J Strategic Accounting',
    signInUrl: 'https://app.pbjsa.com/verify/tok-123',
  }

  it('carries the sign-in button and raw link — and NO custom-scheme button', () => {
    const { subject, html } = buildLoginLinkEmail(base)
    expect(subject).toContain('Sign in to')
    expect(html).toContain('https://app.pbjsa.com/verify/tok-123')
    // Custom schemes are stripped by web mail clients; a pbjsa:// button
    // here renders as a button that does nothing. See the header comment.
    expect(html).not.toContain('pbjsa://')
    expect(html).not.toContain('desktop app')
  })

  it('escapes an angle-bracketed firm name', () => {
    const { html } = buildLoginLinkEmail({ ...base, firmName: '<script>x</script>' })
    expect(html).not.toContain('<script>x</script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

describe('the desktop-handoff route (source-pinned, same shape as the route tests)', () => {
  const at = serverSource.indexOf("normalizedPath === '/api/auth/desktop-handoff'")
  const block = serverSource.slice(at, at + 1600)

  it('exists, and sits above the /api catch-all', () => {
    expect(at, 'the desktop-handoff route is gone').toBeGreaterThan(-1)
    const catchAllAt = serverSource.indexOf("// Nothing above matched. `/api/*` must fail loudly")
    expect(catchAllAt).toBeGreaterThan(-1)
    expect(at).toBeLessThan(catchAllAt)
  })

  it('demands a session BEFORE minting, and mints for the session user only', () => {
    const sessionAt = block.indexOf('requireSession(request, response)')
    const mintAt = block.indexOf('createLoginToken(session.user.id')
    expect(sessionAt).toBeGreaterThan(-1)
    expect(mintAt).toBeGreaterThan(-1)
    expect(sessionAt).toBeLessThan(mintAt)
    // The token must be minted for the SESSION user — never an id from the
    // request body, which would let any signed-in user mint someone else's.
    expect(block).not.toContain('payload')
  })

  it('keeps the CSRF and content-type guards, and encodes the token', () => {
    expect(block).toContain('isCrossSiteOrigin(request)')
    expect(block).toContain("'application/json required'")
    expect(block).toContain('pbjsa://verify/${encodeURIComponent(token)}')
    expect(block).toContain("recordActivity")
  })

  it('the request-link email path no longer builds a desktop url', () => {
    expect(serverSource).not.toContain('PBJDesktopShell')
  })
})
