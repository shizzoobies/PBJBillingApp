import { useEffect, useState, type FormEvent } from 'react'
import { ApiError, type PublicFirmSettings } from '../lib/types'
import {
  fetchPublicFirmSettings,
  totpVerifyBackupChallenge,
  totpVerifyChallenge,
} from '../lib/api'
import { DEFAULT_FIRM_SETTINGS } from '../lib/types'

/**
 * Open-redirect guard for a server-supplied `redirectTo`. Only accepts a
 * same-origin relative path — it must start with a single `/` and must NOT
 * start with `//` (a protocol-relative URL that points off-site). Anything
 * else falls back to `fallback`.
 */
function safeRedirectPath(value: string | null | undefined, fallback: string): string {
  if (typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')) {
    return value
  }
  return fallback
}

/**
 * Sign-in challenge: the user already clicked the email link and is holding
 * the pending-2fa cookie. We just need a 6-digit TOTP (or a backup code).
 *
 * On success the server replaces the pending cookie with a full session
 * cookie and we hard-navigate to the returned `redirectTo`.
 */
export function TwoFactorPage() {
  const [code, setCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [useBackup, setUseBackup] = useState(false)
  const [firm, setFirm] = useState<PublicFirmSettings>({
    name: DEFAULT_FIRM_SETTINGS.name,
    tagline: DEFAULT_FIRM_SETTINGS.tagline ?? '',
    logoUrl: DEFAULT_FIRM_SETTINGS.logoUrl ?? '',
    brandColor: DEFAULT_FIRM_SETTINGS.brandColor ?? '#3c2044',
  })

  useEffect(() => {
    const controller = new AbortController()
    fetchPublicFirmSettings(controller.signal)
      .then((settings) => {
        if (controller.signal.aborted) return
        setFirm({
          name: settings.name || DEFAULT_FIRM_SETTINGS.name,
          tagline: settings.tagline ?? '',
          logoUrl: settings.logoUrl ?? '',
          brandColor: settings.brandColor || '#3c2044',
        })
      })
      .catch(() => {
        /* fall back to defaults */
      })
    return () => controller.abort()
  }, [])

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!code.trim() || submitting) return
    setSubmitting(true)
    setError('')
    try {
      const result = useBackup
        ? await totpVerifyBackupChallenge(code.trim())
        : await totpVerifyChallenge(code.trim())
      // Hard navigation so the new session cookie picks up cleanly and the
      // app re-bootstraps with /api/session.
      window.location.assign(safeRedirectPath(result.redirectTo, '/'))
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not verify code right now.',
      )
      setSubmitting(false)
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <p className="eyeline">{firm.name}</p>
        <h1>Two-factor verification</h1>
        <form className="auth-form" onSubmit={handleSubmit}>
          <p className="auth-copy">
            {useBackup
              ? 'Enter one of the backup codes you saved when you set up two-factor.'
              : 'Open your authenticator app and enter the 6-digit code shown for this account.'}
          </p>
          <label className="field">
            <span>{useBackup ? 'Backup code' : '6-digit code'}</span>
            <input
              autoComplete="one-time-code"
              autoFocus
              className="input"
              inputMode={useBackup ? 'text' : 'numeric'}
              maxLength={useBackup ? 12 : 6}
              onChange={(event) => setCode(event.target.value)}
              placeholder={useBackup ? 'XXXX-XXXX-XX' : '123456'}
              required
              type="text"
              value={code}
            />
          </label>
          {error ? <p className="auth-error">{error}</p> : null}
          <button
            className="primary-action auth-submit"
            disabled={submitting || !code.trim()}
            type="submit"
          >
            {submitting ? 'Verifying…' : 'Continue'}
          </button>
          <button
            className="auth-secondary"
            onClick={() => {
              setUseBackup((current) => !current)
              setCode('')
              setError('')
            }}
            type="button"
          >
            {useBackup ? 'Use my authenticator code instead' : 'Use a backup code instead'}
          </button>
        </form>
      </section>
    </main>
  )
}
