import { useEffect, useState, type FormEvent } from 'react'
import {
  ApiError,
  DEFAULT_FIRM_SETTINGS,
  type PublicFirmSettings,
  type TotpSetupInit,
} from '../lib/types'
import {
  fetchPublicFirmSettings,
  totpSetupComplete,
  totpSetupInit,
  totpSetupVerify,
} from '../lib/api'

type Step = 'qr' | 'verify' | 'backup'

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
 * Two-factor setup wizard. Reachable two ways:
 *   1. Forced flow on first owner login (with `pbj_2fa_pending` cookie set
 *      by /verify/:token). On completion the page calls /setup-complete to
 *      swap the pending cookie for a real session, then redirects to
 *      /dashboard.
 *   2. From Settings -> "Enable two-factor" by an already-signed-in user.
 *      In that case the page just shows the backup codes and lets the user
 *      close the modal — no /setup-complete call needed.
 */
export function TwoFactorSetupPage({
  forced,
  onClose,
}: {
  forced?: boolean
  onClose?: () => void
}) {
  const [step, setStep] = useState<Step>('qr')
  const [setup, setSetup] = useState<TotpSetupInit | null>(null)
  const [code, setCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [showSecret, setShowSecret] = useState(false)
  const [backupCodes, setBackupCodes] = useState<string[]>([])
  const [needsSessionFinalize, setNeedsSessionFinalize] = useState(false)
  const [finalizeError, setFinalizeError] = useState('')
  const [firm, setFirm] = useState<PublicFirmSettings>({
    name: DEFAULT_FIRM_SETTINGS.name,
    tagline: DEFAULT_FIRM_SETTINGS.tagline ?? '',
    logoUrl: DEFAULT_FIRM_SETTINGS.logoUrl ?? '',
    brandColor: DEFAULT_FIRM_SETTINGS.brandColor ?? '#3c2044',
  })
  const [savedFlash, setSavedFlash] = useState('')

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

  useEffect(() => {
    let active = true
    totpSetupInit()
      .then((data) => {
        if (!active) return
        setSetup(data)
      })
      .catch((err) => {
        if (!active) return
        setError(err instanceof ApiError ? err.message : 'Could not start setup right now.')
      })
    return () => {
      active = false
    }
  }, [])

  const handleVerify = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!code.trim() || submitting) return
    setSubmitting(true)
    setError('')
    try {
      const result = await totpSetupVerify(code.trim())
      setBackupCodes(result.backupCodes)
      setNeedsSessionFinalize(result.needsSessionFinalize)
      setStep('backup')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not verify code right now.')
    } finally {
      setSubmitting(false)
    }
  }

  const handleFinish = async () => {
    setFinalizeError('')
    if (needsSessionFinalize) {
      try {
        const result = await totpSetupComplete()
        window.location.assign(safeRedirectPath(result.redirectTo, '/dashboard'))
      } catch (err) {
        setFinalizeError(
          err instanceof ApiError ? err.message : 'Could not finalize sign-in.',
        )
      }
    } else if (onClose) {
      onClose()
    } else {
      window.location.assign('/settings')
    }
  }

  const handleCopyCodes = async () => {
    try {
      await navigator.clipboard.writeText(backupCodes.join('\n'))
      setSavedFlash('Copied to clipboard')
      window.setTimeout(() => setSavedFlash(''), 1500)
    } catch {
      setSavedFlash('Copy failed — select and copy manually')
      window.setTimeout(() => setSavedFlash(''), 2000)
    }
  }

  const handleDownloadCodes = () => {
    const blob = new Blob([backupCodes.join('\n')], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'pbj-strategic-accounting-backup-codes.txt'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  return (
    <main className="auth-shell">
      <section className="auth-card" style={{ maxWidth: 480 }}>
        <p className="eyeline">{firm.name}</p>
        <h1>{forced ? 'Set up two-factor authentication' : 'Enable two-factor'}</h1>

        {step === 'qr' && setup ? (
          <div className="auth-form">
            <p className="auth-copy">
              {forced
                ? "Owners are required to use two-factor authentication. You'll need an authenticator app on your phone — most people use the one that came with their phone (Apple Passwords on iPhone, Google Authenticator on Android) or a password manager (1Password, Bitwarden)."
                : "You'll need an authenticator app on your phone — most people use Apple Passwords (iPhone), Google Authenticator (Android), or a password manager."}
            </p>

            <a
              className="primary-action auth-submit"
              href={setup.otpauthUri}
              style={{ textAlign: 'center', textDecoration: 'none', display: 'block' }}
            >
              Open in my authenticator app
            </a>
            <p className="auth-copy" style={{ fontSize: 13, color: '#695f71', marginTop: 4 }}>
              ↑ Tap this if you're on your phone — it opens your authenticator app and adds the
              account in one tap.
            </p>

            <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '16px 0' }}>
              <hr style={{ flex: 1, border: 0, borderTop: '1px solid #e6dde8' }} />
              <span style={{ fontSize: 12, color: '#695f71' }}>OR SCAN THIS QR FROM ANOTHER DEVICE</span>
              <hr style={{ flex: 1, border: 0, borderTop: '1px solid #e6dde8' }} />
            </div>

            <p className="auth-copy" style={{ fontSize: 14 }}>
              On your phone:
              <br />
              1. Open your authenticator app
              <br />
              2. Tap the <strong>+</strong> (add) button
              <br />
              3. Choose <strong>Scan a QR code</strong>
              <br />
              4. Point your camera at the code below
            </p>
            <div
              className="totp-qr"
              style={{ display: 'flex', justifyContent: 'center', padding: '12px 0' }}
            >
              <img src={setup.qrDataUrl} alt="Authenticator QR code" />
            </div>

            <button
              className="auth-secondary"
              onClick={() => setShowSecret((current) => !current)}
              type="button"
            >
              {showSecret ? 'Hide manual entry code' : "Still stuck? Type the setup code instead"}
            </button>
            {showSecret ? (
              <>
                <p className="auth-copy" style={{ fontSize: 13, marginBottom: 4 }}>
                  In your authenticator app, choose "Enter a setup key" and paste this:
                </p>
                <p
                  className="auth-copy"
                  style={{ wordBreak: 'break-all', fontFamily: 'ui-monospace, monospace' }}
                >
                  <strong>{setup.secret}</strong>
                </p>
              </>
            ) : null}

            <button
              className="primary-action auth-submit"
              onClick={() => setStep('verify')}
              type="button"
            >
              I added it — next
            </button>
          </div>
        ) : null}

        {step === 'qr' && !setup && !error ? (
          <p className="auth-copy">Loading…</p>
        ) : null}

        {step === 'verify' ? (
          <form className="auth-form" onSubmit={handleVerify}>
            <p className="auth-copy">
              Enter the 6-digit code currently shown in your authenticator app.
            </p>
            <label className="field">
              <span>6-digit code</span>
              <input
                autoComplete="one-time-code"
                autoFocus
                className="input"
                inputMode="numeric"
                maxLength={6}
                onChange={(event) => setCode(event.target.value)}
                placeholder="123456"
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
              {submitting ? 'Verifying…' : 'Verify and continue'}
            </button>
            <button
              className="auth-secondary"
              onClick={() => setStep('qr')}
              type="button"
            >
              Back to QR code
            </button>
          </form>
        ) : null}

        {step === 'backup' ? (
          <div className="auth-form">
            <p className="auth-copy">
              <strong>Save these somewhere safe.</strong> You can use them to sign in if you lose
              your phone. Each code works once.
            </p>
            <ul
              style={{
                background: '#f6f5f1',
                border: '1px solid #e6e2dc',
                borderRadius: 10,
                padding: '12px 18px',
                margin: '4px 0 12px',
                listStyle: 'none',
                fontFamily: 'ui-monospace, monospace',
                fontSize: 15,
                lineHeight: 1.7,
              }}
            >
              {backupCodes.map((codeStr) => (
                <li key={codeStr}>{codeStr}</li>
              ))}
            </ul>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="auth-secondary" onClick={handleCopyCodes} type="button">
                Copy to clipboard
              </button>
              <button className="auth-secondary" onClick={handleDownloadCodes} type="button">
                Download as text
              </button>
            </div>
            {savedFlash ? <p className="auth-copy">{savedFlash}</p> : null}
            {finalizeError ? <p className="auth-error">{finalizeError}</p> : null}
            <button
              className="primary-action auth-submit"
              onClick={handleFinish}
              type="button"
            >
              I&rsquo;ve saved my codes
            </button>
          </div>
        ) : null}

        {error && step !== 'verify' ? <p className="auth-error">{error}</p> : null}
      </section>
    </main>
  )
}
