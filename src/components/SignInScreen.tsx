import { useEffect, useState, type FormEvent } from 'react'
import { ApiError, type PublicFirmSettings } from '../lib/types'
import { requestSignInLink } from '../lib/api'

/**
 * Email-gated sign-in entry page. Shared shape for the two role-segmented
 * URLs (`/staff` and `/owner`); the `role` prop controls which lane the
 * server validates against. The two pages are intentionally indistinguishable
 * to anyone who lands on them — same UX, same copy patterns — so that a
 * bookkeeper who finds /owner cannot tell it from their normal page.
 */
export function SignInScreen({
  role,
  heading,
  firmSettings,
}: {
  role: 'staff' | 'owner'
  heading: string
  firmSettings?: PublicFirmSettings
}) {
  const firmName = firmSettings?.name || 'PB&J Strategic Accounting'
  const [email, setEmail] = useState('')
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

  const sendLink = async (target: string) => {
    setSubmitting(true)
    setError('')
    try {
      await requestSignInLink(target, role)
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

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = email.trim()
    if (!trimmed || submitting) return
    await sendLink(trimmed)
  }

  const handleResend = async () => {
    if (!submittedEmail || resendCooldown > 0 || submitting) return
    await sendLink(submittedEmail)
  }

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <p className="eyeline">{firmName}</p>
        <h1>{heading}</h1>
        {submittedEmail ? (
          <div className="auth-form" aria-live="polite">
            <p className="auth-copy">
              Check <strong>{submittedEmail}</strong> for a sign-in link. It expires in 15 minutes
              and can only be used once.
            </p>
            <p className="auth-copy">
              Didn&rsquo;t get it? Try again in a minute, then check your spam folder.
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
          <form className="auth-form" onSubmit={handleSubmit}>
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
        )}
      </section>
    </main>
  )
}
