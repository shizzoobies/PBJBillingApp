import { useEffect, useState, type FormEvent } from 'react'
import { ApiError, type PublicFirmSettings } from '../lib/types'
import { requestSignInLink, signInWithPasswordRequest } from '../lib/api'

/**
 * Unified sign-in entry page. One URL (`/sign-in`) for everyone — the DB
 * already knows each user's role, so the form doesn't have to ask. The
 * post-sign-in routing (which sections of the app show up) is driven off
 * the role on the user row.
 *
 * Two auth methods via a tab toggle:
 *  - Password (default): bulletproof, doesn't depend on email delivery.
 *  - Magic link: one-time email link for users who don't yet have a
 *    password set, or as a backup when password is forgotten. Reusable
 *    within its 15-min window (email scanners often pre-fetch URLs).
 */
type AuthMethod = 'link' | 'password'

export function SignInScreen({
  firmSettings,
}: {
  firmSettings?: PublicFirmSettings
}) {
  const firmName = firmSettings?.name || 'PB&J Strategic Accounting'
  const heading = `Sign in to ${firmName}`

  // Default to password — that's the path that survives any email-pipeline
  // failure. A user with no password yet can switch to the Magic link tab.
  const [method, setMethod] = useState<AuthMethod>('password')

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submittedEmail, setSubmittedEmail] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [resendCooldown, setResendCooldown] = useState(0)

  useEffect(() => {
    if (resendCooldown <= 0) return
    const id = window.setInterval(() => {
      setResendCooldown((current) => (current > 0 ? current - 1 : 0))
    }, 1000)
    return () => window.clearInterval(id)
  }, [resendCooldown])

  // ---------------- Magic-link path ----------------

  const sendLink = async (target: string) => {
    setSubmitting(true)
    setError('')
    try {
      await requestSignInLink(target)
      setSubmittedEmail(target)
      setResendCooldown(60)
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not request a sign-in link right now.',
      )
    } finally {
      setSubmitting(false)
    }
  }

  const handleLinkSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = email.trim()
    if (!trimmed || submitting) return
    await sendLink(trimmed)
  }

  const handleResend = async () => {
    if (!submittedEmail || resendCooldown > 0 || submitting) return
    await sendLink(submittedEmail)
  }

  // ---------------- Password path ----------------

  const handlePasswordSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmedEmail = email.trim()
    if (!trimmedEmail || !password || submitting) return
    setSubmitting(true)
    setError('')
    try {
      const result = await signInWithPasswordRequest(trimmedEmail, password)
      // The session cookie (or pending-2FA cookie) is already on the
      // response — just route the browser per the server directive. A
      // full reload ensures the App-level session check picks up the
      // new cookie without any in-memory state staleness.
      const target =
        result.next === 'two-factor'
          ? '/two-factor'
          : result.next === 'two-factor-setup'
            ? '/two-factor/setup'
            : '/'
      window.location.replace(target)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign-in failed.')
      setSubmitting(false)
    }
  }

  const switchMethod = (next: AuthMethod) => {
    if (next === method) return
    setMethod(next)
    setError('')
    setPassword('')
    setSubmittedEmail(null)
  }

  // ---------------- Render ----------------

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <p className="eyeline">{firmName}</p>
        <h1>{heading}</h1>

        <div
          role="tablist"
          aria-label="Sign-in method"
          style={{
            display: 'flex',
            gap: 4,
            marginBottom: 16,
            borderBottom: '1px solid var(--border-subtle, #ddd)',
          }}
        >
          <button
            type="button"
            role="tab"
            aria-selected={method === 'password'}
            onClick={() => switchMethod('password')}
            className="auth-secondary"
            style={{
              padding: '8px 12px',
              borderBottom:
                method === 'password' ? '2px solid var(--accent, #7d2a4d)' : '2px solid transparent',
              fontWeight: method === 'password' ? 600 : 400,
            }}
          >
            Password
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={method === 'link'}
            onClick={() => switchMethod('link')}
            className="auth-secondary"
            style={{
              padding: '8px 12px',
              borderBottom:
                method === 'link' ? '2px solid var(--accent, #7d2a4d)' : '2px solid transparent',
              fontWeight: method === 'link' ? 600 : 400,
            }}
          >
            Magic link
          </button>
        </div>

        {method === 'link' ? (
          submittedEmail ? (
            <div className="auth-form" aria-live="polite">
              <p className="auth-copy">
                Check <strong>{submittedEmail}</strong> for a sign-in link. It works for 15
                minutes — open it as many times as you need (handy when your email scanner
                pre-fetches the URL).
              </p>
              <p className="auth-copy">
                Didn&rsquo;t get it? Try again in a minute, then check your spam folder. If it
                still doesn&rsquo;t arrive, switch to the <strong>Password</strong> tab above.
              </p>
              <button
                className="primary-action auth-submit"
                disabled={submitting || resendCooldown > 0}
                onClick={handleResend}
                type="button"
              >
                {resendCooldown > 0
                  ? `Resend link (${resendCooldown}s)`
                  : submitting
                    ? 'Sending…'
                    : 'Resend link'}
              </button>
              <button
                className="auth-secondary"
                onClick={() => {
                  setSubmittedEmail(null)
                  setError('')
                  setResendCooldown(0)
                }}
                type="button"
              >
                Use a different email
              </button>
              {error ? <p className="auth-error">{error}</p> : null}
            </div>
          ) : (
            <form className="auth-form" onSubmit={handleLinkSubmit}>
              <p className="auth-copy">
                Enter your work email and we&rsquo;ll send you a one-time sign-in link.
              </p>
              <label className="field">
                <span>Email</span>
                <input
                  autoComplete="email"
                  autoFocus
                  className="input"
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@firm.com"
                  required
                  type="email"
                  value={email}
                />
              </label>
              {error ? <p className="auth-error">{error}</p> : null}
              <button
                className="primary-action auth-submit"
                disabled={submitting || !email.trim()}
                type="submit"
              >
                {submitting ? 'Sending…' : 'Send me a sign-in link'}
              </button>
            </form>
          )
        ) : (
          <form className="auth-form" onSubmit={handlePasswordSubmit}>
            <p className="auth-copy">
              Sign in with your email and password. This is the recovery-safe path — it
              works even if email delivery is down. If you haven&rsquo;t set a password
              yet, use the <strong>Magic link</strong> tab once, then set one inside the
              app under Settings or Security.
            </p>
            <label className="field">
              <span>Email</span>
              <input
                autoComplete="email"
                autoFocus
                className="input"
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@firm.com"
                required
                type="email"
                value={email}
              />
            </label>
            <label className="field">
              <span>Password</span>
              <input
                autoComplete="current-password"
                className="input"
                onChange={(event) => setPassword(event.target.value)}
                placeholder="••••••••"
                required
                type="password"
                value={password}
              />
            </label>
            {error ? <p className="auth-error">{error}</p> : null}
            <button
              className="primary-action auth-submit"
              disabled={submitting || !email.trim() || !password}
              type="submit"
            >
              {submitting ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        )}
      </section>
    </main>
  )
}
