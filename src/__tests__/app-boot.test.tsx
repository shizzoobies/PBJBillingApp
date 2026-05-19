import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import App from '../App'
import { installFetchMock, OWNER_SESSION } from './helpers'

/**
 * App-boot smoke test — the safety net for "the app crashes or renders blank
 * on boot." A production outage shipped a blank screen because `<App>` derived
 * `effectiveUser` with a `sessionUser as SessionUser` cast that hid a null,
 * then read `.role` on it during render. `npm run build` only type-checks and
 * bundles — it never mounts the app — so the crash got past CI.
 *
 * These tests mount the REAL `<App>` (not a stub) against a mocked `fetch`,
 * covering both the logged-out and logged-in boot paths. If a null-deref on
 * boot is ever reintroduced, `npm run test` fails here.
 */

describe('App boot', () => {
  beforeEach(() => {
    // `<App>` mounts its own <BrowserRouter>, which reads window.location.
    // Reset to the site root before each test so routing is deterministic.
    window.history.pushState({}, '', '/')
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('logged out: boots without throwing and renders the sign-in screen', async () => {
    // No session user — this is the exact state the outage broke: when logged
    // out `effectiveUser` was null and reading `.role` threw during render.
    installFetchMock({ sessionUser: null })

    expect(() => render(<App />)).not.toThrow()

    // The session fetch resolves asynchronously, after which <App> swaps the
    // "Loading…" shell for the SignInScreen. `findBy*` retries until then.
    const heading = await screen.findByRole('heading', { name: /staff sign-in/i })
    expect(heading).toBeInTheDocument()

    // The sign-in form's email field should be present and interactive.
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument()
  })

  it('logged in as owner: boots without throwing and renders authenticated chrome', async () => {
    // A real owner session plus a minimal-but-valid AppData (the seed) from
    // /api/app-data. This exercises the authenticated render path end to end.
    installFetchMock({ sessionUser: OWNER_SESSION })

    expect(() => render(<App />)).not.toThrow()

    // Once signed in, <App> renders the AppLayout shell. The sidebar's <nav>
    // is rendered synchronously from the nav config and does not depend on any
    // fetch succeeding — it's a stable proof that authenticated chrome mounted.
    const nav = await screen.findByRole('navigation')
    expect(nav).toBeInTheDocument()

    // A nav link proves the sidebar populated. Use an exact name so this
    // doesn't ambiguously match "Time" and "Time Approvals" both.
    expect(screen.getByRole('link', { name: 'Time' })).toBeInTheDocument()
    // Owner-only nav items render because the session is an owner.
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument()

    // The sign-in screen must NOT be on the page in the authenticated state.
    expect(
      screen.queryByRole('heading', { name: /staff sign-in/i }),
    ).not.toBeInTheDocument()
  })
})
