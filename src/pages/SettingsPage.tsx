import { useEffect, useRef, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useAppContext } from '../AppContext'
import { ChangePasswordCard } from '../components/ChangePasswordCard'
import {
  fetchAuthStatus,
  fetchFirmSettings,
  fetchTotpStatus,
  totpDisable,
  totpRegenerateBackups,
  updateFirmSettingsRequest,
  type AuthStatus,
} from '../lib/api'
import {
  ApiError,
  DEFAULT_FIRM_SETTINGS,
  type FirmSettings,
  type TotpStatus,
} from '../lib/types'

export function SettingsPage() {
  const { ownerMode, sessionUser, setFirmSettings } = useAppContext()
  const [settings, setSettings] = useState<FirmSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [savedFlash, setSavedFlash] = useState(false)
  const savedTimeoutRef = useRef<number | null>(null)

  useEffect(() => {
    if (!ownerMode) return
    const controller = new AbortController()
    fetchFirmSettings(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) {
          setSettings({ ...DEFAULT_FIRM_SETTINGS, ...data })
          setLoading(false)
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setSettings({ ...DEFAULT_FIRM_SETTINGS })
          setLoading(false)
        }
      })
    return () => controller.abort()
  }, [ownerMode])

  useEffect(() => {
    return () => {
      if (savedTimeoutRef.current) {
        window.clearTimeout(savedTimeoutRef.current)
      }
    }
  }, [])

  if (!ownerMode) {
    return <Navigate to="/time" replace />
  }

  const flashSaved = () => {
    setSavedFlash(true)
    if (savedTimeoutRef.current) {
      window.clearTimeout(savedTimeoutRef.current)
    }
    savedTimeoutRef.current = window.setTimeout(() => setSavedFlash(false), 1500)
  }

  const commit = async (patch: Partial<FirmSettings>) => {
    if (!settings) return
    const optimistic = { ...settings, ...patch }
    setSettings(optimistic)
    try {
      const updated = await updateFirmSettingsRequest(patch)
      setSettings({ ...DEFAULT_FIRM_SETTINGS, ...updated })
      setFirmSettings({ ...DEFAULT_FIRM_SETTINGS, ...updated })
      flashSaved()
    } catch {
      // Roll back on failure.
      setSettings(settings)
    }
  }

  if (loading || !settings) {
    return (
      <section className="panel">
        <p>Loading firm settings…</p>
      </section>
    )
  }

  return (
    <section className="content-grid settings-layout">
      <header className="client-detail-header">
        <div>
          <h1>Settings</h1>
          <p className="muted-text">
            Firm branding and details. These appear in the sidebar, login screen, invoices, and
            printed reports.
          </p>
        </div>
        {savedFlash ? <span className="saved-flash">Saved</span> : null}
      </header>

      <BrandingSection settings={settings} onCommit={commit} />
      <AddressSection settings={settings} onCommit={commit} />
      <ContactSection settings={settings} onCommit={commit} />
      <BusinessSection settings={settings} onCommit={commit} />
      <AuthenticationSection />
      <SecuritySection />
      <ChangePasswordCard userEmail={sessionUser?.email ?? null} />
    </section>
  )
}

function SecuritySection() {
  const navigate = useNavigate()
  const [status, setStatus] = useState<TotpStatus | null>(null)
  const [error, setError] = useState('')
  const [disableCode, setDisableCode] = useState('')
  const [regenCode, setRegenCode] = useState('')
  const [disabling, setDisabling] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [newBackupCodes, setNewBackupCodes] = useState<string[] | null>(null)

  const refresh = async () => {
    try {
      const next = await fetchTotpStatus()
      setStatus(next)
    } catch {
      setStatus(null)
    }
  }

  useEffect(() => {
    let active = true
    fetchTotpStatus()
      .then((next) => {
        if (active) setStatus(next)
      })
      .catch(() => {
        if (active) setStatus(null)
      })
    return () => {
      active = false
    }
  }, [])

  const handleEnable = () => {
    navigate('/two-factor/setup')
  }

  const handleDisable = async () => {
    if (!disableCode.trim() || disabling) return
    setDisabling(true)
    setError('')
    try {
      await totpDisable(disableCode.trim())
      setDisableCode('')
      await refresh()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not disable two-factor.')
    } finally {
      setDisabling(false)
    }
  }

  const handleRegenerate = async () => {
    if (!regenCode.trim() || regenerating) return
    setRegenerating(true)
    setError('')
    try {
      const result = await totpRegenerateBackups(regenCode.trim())
      setNewBackupCodes(result.backupCodes)
      setRegenCode('')
      await refresh()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not regenerate backup codes.')
    } finally {
      setRegenerating(false)
    }
  }

  // Owner-required treatment: owners cannot disable.
  const ownerRequired = Boolean(status?.requiredForRole)
  const enabled = Boolean(status?.enabled)

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Security</p>
          <h2>Two-factor authentication</h2>
        </div>
      </div>
      <div className="form-grid">
        {ownerRequired ? (
          <p className="muted-text">
            <strong>Owner two-factor:</strong>{' '}
            {enabled ? (
              <span style={{ color: '#1f7d4d' }}>Required, enabled</span>
            ) : (
              <span style={{ color: '#b45309' }}>Required, not yet set up</span>
            )}
          </p>
        ) : (
          <p className="muted-text">
            <strong>Two-factor:</strong>{' '}
            {enabled ? (
              <span style={{ color: '#1f7d4d' }}>Enabled</span>
            ) : (
              <span>Not enabled</span>
            )}
          </p>
        )}

        {!enabled ? (
          <button className="primary-action" onClick={handleEnable} type="button">
            Enable two-factor
          </button>
        ) : (
          <>
            <p className="muted-text">
              <strong>Backup codes remaining:</strong> {status?.remainingBackupCodes ?? 0} of 8
            </p>
            <div className="form-grid two-col">
              <label className="field">
                <span>Regenerate backup codes</span>
                <input
                  className="input"
                  inputMode="numeric"
                  maxLength={6}
                  onChange={(event) => setRegenCode(event.target.value)}
                  placeholder="Current 6-digit code"
                  type="text"
                  value={regenCode}
                />
                <small className="field-helper">
                  Replaces all existing backup codes. Old codes stop working.
                </small>
                <button
                  className="auth-secondary"
                  disabled={regenerating || !regenCode.trim()}
                  onClick={handleRegenerate}
                  style={{ marginTop: 8 }}
                  type="button"
                >
                  {regenerating ? 'Regenerating…' : 'Regenerate'}
                </button>
              </label>
              {!ownerRequired ? (
                <label className="field">
                  <span>Disable two-factor</span>
                  <input
                    className="input"
                    inputMode="numeric"
                    maxLength={6}
                    onChange={(event) => setDisableCode(event.target.value)}
                    placeholder="Current 6-digit code"
                    type="text"
                    value={disableCode}
                  />
                  <small className="field-helper">
                    Bookkeepers can opt out. You can re-enable any time.
                  </small>
                  <button
                    className="team-danger-button"
                    disabled={disabling || !disableCode.trim()}
                    onClick={handleDisable}
                    style={{ marginTop: 8 }}
                    type="button"
                  >
                    {disabling ? 'Disabling…' : 'Disable'}
                  </button>
                </label>
              ) : null}
            </div>
            {newBackupCodes ? (
              <div>
                <p className="muted-text">
                  <strong>New backup codes — save these now.</strong> The old codes no longer work.
                </p>
                <ul
                  style={{
                    background: '#f6f5f1',
                    border: '1px solid #e6e2dc',
                    borderRadius: 10,
                    padding: '12px 18px',
                    margin: '4px 0',
                    listStyle: 'none',
                    fontFamily: 'ui-monospace, monospace',
                  }}
                >
                  {newBackupCodes.map((code) => (
                    <li key={code}>{code}</li>
                  ))}
                </ul>
                <button
                  className="auth-secondary"
                  onClick={() => setNewBackupCodes(null)}
                  type="button"
                >
                  Done
                </button>
              </div>
            ) : null}
          </>
        )}

        {error ? <p className="auth-error">{error}</p> : null}
      </div>
    </section>
  )
}

function AuthenticationSection() {
  const [status, setStatus] = useState<AuthStatus | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetchAuthStatus(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setStatus(data)
      })
      .catch(() => {
        // Non-fatal — leave status null, UI falls back gracefully.
      })
    return () => controller.abort()
  }, [])

  const sendingDomain = status
    ? (status.sendingDomain ?? 'Not configured — set EMAIL_FROM in Railway')
    : '…'
  const appUrl = status ? status.appUrl : '…'
  const ownerWarning = status && !status.ownerEmailConfigured

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Authentication</p>
          <h2>Sign-in</h2>
        </div>
      </div>
      <div className="form-grid">
        <p className="muted-text">
          Email-gated sign-in is active. Bookkeepers receive a sign-in link by email each time
          they sign in.
        </p>
        {ownerWarning && (
          <p className="muted-text" style={{ color: 'var(--color-warning, #b45309)' }}>
            <strong>Warning:</strong> OWNER_EMAIL is not set. If Brittany Ferguson's email is still
            a placeholder (@pbj.local), sign-in will not work. Set OWNER_EMAIL in your Railway
            environment.
          </p>
        )}
        {status && !status.adminEmailConfigured && (
          <p className="muted-text">
            <strong>Note:</strong> ADMIN_EMAIL is not set. The second owner account (Alex Anderson)
            will not be created until ADMIN_EMAIL is configured.
          </p>
        )}
        <p className="muted-text">
          <strong>Sending domain:</strong> {sendingDomain}
        </p>
        <p className="muted-text">
          <strong>App URL:</strong> {appUrl}
        </p>
      </div>
    </section>
  )
}

function BrandingSection({
  settings,
  onCommit,
}: {
  settings: FirmSettings
  onCommit: (patch: Partial<FirmSettings>) => void | Promise<void>
}) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Branding</p>
          <h2>Firm identity</h2>
        </div>
      </div>
      <div className="form-grid two-col">
        <TextField
          label="Firm name"
          value={settings.name ?? ''}
          onCommit={(value) => onCommit({ name: value })}
        />
        <TextField
          label="Tagline"
          value={settings.tagline ?? ''}
          placeholder="e.g. Strategic bookkeeping for growing firms"
          onCommit={(value) => onCommit({ tagline: value })}
        />
        <TextField
          label="Logo URL"
          value={settings.logoUrl ?? ''}
          placeholder="https://..."
          onCommit={(value) => onCommit({ logoUrl: value })}
        />
        <div className="logo-preview">
          {settings.logoUrl ? (
            <img alt={`${settings.name} logo`} src={settings.logoUrl} />
          ) : (
            <span className="muted-text">No logo set. Paste a public image URL.</span>
          )}
        </div>
        <label className="field">
          <span>Brand color</span>
          <ColorInput
            value={settings.brandColor ?? '#3c2044'}
            onCommit={(value) => onCommit({ brandColor: value })}
          />
          <small className="field-helper">Used for the sidebar background and accent colors.</small>
        </label>
      </div>
    </section>
  )
}

function AddressSection({
  settings,
  onCommit,
}: {
  settings: FirmSettings
  onCommit: (patch: Partial<FirmSettings>) => void | Promise<void>
}) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Address</p>
          <h2>Mailing address</h2>
        </div>
      </div>
      <div className="form-grid two-col">
        <TextField
          label="Address line 1"
          value={settings.addressLine1 ?? ''}
          onCommit={(value) => onCommit({ addressLine1: value })}
        />
        <TextField
          label="Address line 2"
          value={settings.addressLine2 ?? ''}
          onCommit={(value) => onCommit({ addressLine2: value })}
        />
        <TextField
          label="City"
          value={settings.city ?? ''}
          onCommit={(value) => onCommit({ city: value })}
        />
        <TextField
          label="State"
          value={settings.state ?? ''}
          onCommit={(value) => onCommit({ state: value })}
        />
        <TextField
          label="Postal code"
          value={settings.postalCode ?? ''}
          onCommit={(value) => onCommit({ postalCode: value })}
        />
      </div>
    </section>
  )
}

function ContactSection({
  settings,
  onCommit,
}: {
  settings: FirmSettings
  onCommit: (patch: Partial<FirmSettings>) => void | Promise<void>
}) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Contact</p>
          <h2>How clients reach you</h2>
        </div>
      </div>
      <div className="form-grid two-col">
        <TextField
          label="Phone"
          value={settings.phone ?? ''}
          onCommit={(value) => onCommit({ phone: value })}
        />
        <TextField
          label="Email"
          type="email"
          value={settings.email ?? ''}
          onCommit={(value) => onCommit({ email: value })}
        />
        <TextField
          label="Website"
          value={settings.website ?? ''}
          placeholder="https://..."
          onCommit={(value) => onCommit({ website: value })}
        />
      </div>
    </section>
  )
}

function BusinessSection({
  settings,
  onCommit,
}: {
  settings: FirmSettings
  onCommit: (patch: Partial<FirmSettings>) => void | Promise<void>
}) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Business</p>
          <h2>Tax / business identifiers</h2>
        </div>
      </div>
      <div className="form-grid two-col">
        <TextField
          label="EIN / Business ID"
          value={settings.ein ?? ''}
          onCommit={(value) => onCommit({ ein: value })}
        />
      </div>
    </section>
  )
}

function TextField({
  label,
  onCommit,
  placeholder,
  type,
  value,
}: {
  label: string
  onCommit: (value: string) => void | Promise<void>
  placeholder?: string
  type?: string
  value: string
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <BlurInput
        canonical={value}
        key={value}
        onCommit={onCommit}
        placeholder={placeholder}
        type={type ?? 'text'}
      />
    </label>
  )
}

function BlurInput({
  canonical,
  onCommit,
  placeholder,
  type,
}: {
  canonical: string
  onCommit: (value: string) => void | Promise<void>
  placeholder?: string
  type: string
}) {
  const [draft, setDraft] = useState(canonical)
  return (
    <input
      className="input"
      onBlur={() => {
        if (draft !== canonical) {
          void onCommit(draft)
        }
      }}
      onChange={(event) => setDraft(event.target.value)}
      placeholder={placeholder}
      type={type}
      value={draft}
    />
  )
}

function ColorInput({
  value,
  onCommit,
}: {
  value: string
  onCommit: (value: string) => void | Promise<void>
}) {
  const [draft, setDraft] = useState(value)
  const [lastValue, setLastValue] = useState(value)
  if (lastValue !== value) {
    setLastValue(value)
    setDraft(value)
  }
  return (
    <input
      className="input"
      type="color"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== value) {
          void onCommit(draft)
        }
      }}
    />
  )
}
