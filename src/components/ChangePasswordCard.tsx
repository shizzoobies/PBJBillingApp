import { useState, type FormEvent } from 'react'
import { changePasswordRequest } from '../lib/api'
import { ApiError } from '../lib/types'

/**
 * Self-service "Set / change my password" card. Shown on Settings (owners)
 * and Security (bookkeepers / accountants). The session cookie is the
 * authorization — no current-password challenge — so a user who signed in
 * via magic link can establish their first password without already
 * knowing one. Server enforces the minimum length.
 *
 * UX choices:
 *  - Two fields (new + confirm) to catch typos before submit.
 *  - Optional show/hide toggle isn't worth the surface here; the field
 *    is type="password" with autocomplete="new-password".
 *  - Success state stays for a moment, then both inputs clear.
 */
const MIN_LENGTH = 8

export function ChangePasswordCard({ userEmail }: { userEmail: string | null }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submitting) return
    if (password.length < MIN_LENGTH) {
      setError(`Password must be at least ${MIN_LENGTH} characters.`)
      return
    }
    if (password !== confirm) {
      setError("Passwords don't match.")
      return
    }
    setSubmitting(true)
    setError('')
    setSaved(false)
    try {
      await changePasswordRequest(password)
      setSaved(true)
      setPassword('')
      setConfirm('')
      window.setTimeout(() => setSaved(false), 4000)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change password.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="panel" aria-label="Set or change password">
      <div className="section-heading">
        <div>
          <h2 style={{ margin: 0 }}>Password</h2>
          <p className="muted-text" style={{ margin: '4px 0 0 0' }}>
            Sign in with email + password as an alternative to the magic-link
            email. Works even if email delivery is delayed or blocked.
            {userEmail ? (
              <>
                {' '}
                Your sign-in email is <strong>{userEmail}</strong>.
              </>
            ) : null}
          </p>
        </div>
      </div>
      <form
        className="auth-form"
        onSubmit={handleSubmit}
        style={{ display: 'grid', gap: 12, maxWidth: 360 }}
      >
        <label className="field">
          <span>New password</span>
          <input
            autoComplete="new-password"
            className="input"
            onChange={(event) => setPassword(event.target.value)}
            placeholder={`At least ${MIN_LENGTH} characters`}
            required
            type="password"
            value={password}
          />
        </label>
        <label className="field">
          <span>Confirm new password</span>
          <input
            autoComplete="new-password"
            className="input"
            onChange={(event) => setConfirm(event.target.value)}
            placeholder="Type it again"
            required
            type="password"
            value={confirm}
          />
        </label>
        {error ? <p className="auth-error">{error}</p> : null}
        {saved ? (
          <p className="muted-text" aria-live="polite">
            Saved. You can now sign in with this password on the /owner or /staff page.
          </p>
        ) : null}
        <div>
          <button
            type="submit"
            className="primary-action"
            disabled={submitting || password.length < MIN_LENGTH || password !== confirm}
          >
            {submitting ? 'Saving…' : 'Set password'}
          </button>
        </div>
      </form>
    </section>
  )
}
