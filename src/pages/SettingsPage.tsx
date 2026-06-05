import { useEffect, useRef, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useAppContext } from '../AppContext'
import { ChangePasswordCard } from '../components/ChangePasswordCard'
import {
  CollapsibleSection,
  SavingNumberInput,
  SavingTextarea,
  SavingTextInput,
} from '../components/SectionKit'
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
  type BillingMode,
  type FirmSettings,
  type TotpStatus,
} from '../lib/types'
import { isSafeImageSrc } from '../lib/utils'

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
      <ClientDefaultsSection settings={settings} onCommit={commit} />
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
    <CollapsibleSection kicker="Branding" title="Firm identity" lockable>
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
        <LogoUploadField
          settings={settings}
          onCommit={onCommit}
        />
        <label className="field">
          <span>Brand color</span>
          <ColorInput
            value={settings.brandColor ?? '#3c2044'}
            onCommit={(value) => onCommit({ brandColor: value })}
          />
          <small className="field-helper">Sets the sidebar background. A light color works well with a dark sidebar text color (and vice-versa).</small>
        </label>
        <label className="field">
          <span>Sidebar text color</span>
          <ColorInput
            value={settings.sidebarTextColor ?? '#ffffff'}
            onCommit={(value) => onCommit({ sidebarTextColor: value })}
          />
          <small className="field-helper">Color of the text that appears on top of the brand color in the sidebar.</small>
        </label>
        <label className="field">
          <span>Active section color</span>
          <ColorInput
            value={settings.sidebarActiveTextColor ?? '#ffffff'}
            onCommit={(value) => onCommit({ sidebarActiveTextColor: value })}
          />
          <small className="field-helper">Color of the currently-open page in the sidebar — pick something that contrasts with the sidebar text color above.</small>
        </label>
      </div>
    </CollapsibleSection>
  )
}

/**
 * Logo upload UI — accepts a local image file, validates type/size, and
 * stores the encoded data URI in the firm settings. Keeps the inline
 * preview so the owner can see what's selected. Picking another file
 * replaces the existing logo; the Remove button clears it entirely.
 */
function LogoUploadField({
  settings,
  onCommit,
}: {
  settings: FirmSettings
  onCommit: (patch: Partial<FirmSettings>) => void | Promise<void>
}) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const MAX_BYTES = 1_000_000 // 1 MB raw image. Base64 inflates ~33%.

  const handleSelected = (event: React.ChangeEvent<HTMLInputElement>) => {
    setError(null)
    const file = event.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setError('Logo must be an image file (PNG, JPG, SVG, etc.).')
      event.target.value = ''
      return
    }
    if (file.size > MAX_BYTES) {
      setError(
        `Logo is ${(file.size / 1024).toFixed(0)} KB. Please pick a file under ${(
          MAX_BYTES / 1024
        ).toFixed(0)} KB.`,
      )
      event.target.value = ''
      return
    }
    setBusy(true)
    const reader = new FileReader()
    reader.onload = async () => {
      try {
        const dataUrl = typeof reader.result === 'string' ? reader.result : ''
        if (!dataUrl) {
          setError('Could not read the image. Try a different file.')
          return
        }
        await onCommit({ logoUrl: dataUrl })
      } catch (commitError) {
        const message =
          commitError instanceof Error ? commitError.message : 'Failed to save logo.'
        setError(message)
      } finally {
        setBusy(false)
        // Reset the input so picking the same file again still fires onChange.
        if (inputRef.current) inputRef.current.value = ''
      }
    }
    reader.onerror = () => {
      setError('Could not read the image. Try a different file.')
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
    reader.readAsDataURL(file)
  }

  const handleRemove = async () => {
    setError(null)
    setBusy(true)
    try {
      await onCommit({ logoUrl: '' })
    } catch (commitError) {
      const message =
        commitError instanceof Error ? commitError.message : 'Failed to clear logo.'
      setError(message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="field logo-upload-field">
      <span>Logo</span>
      <div className="logo-preview">
        {isSafeImageSrc(settings.logoUrl) ? (
          <img alt={`${settings.name} logo`} src={settings.logoUrl} />
        ) : (
          <span className="muted-text">No logo uploaded yet.</span>
        )}
      </div>
      <div className="logo-upload-actions">
        <input
          ref={inputRef}
          id="firm-logo-upload"
          type="file"
          accept="image/*"
          onChange={handleSelected}
          disabled={busy}
          style={{ display: 'none' }}
        />
        <label htmlFor="firm-logo-upload" className="ghost-button">
          {busy ? 'Uploading…' : settings.logoUrl ? 'Replace logo' : 'Upload logo'}
        </label>
        {settings.logoUrl ? (
          <button type="button" className="ghost-button" onClick={handleRemove} disabled={busy}>
            Remove
          </button>
        ) : null}
      </div>
      <small className="field-helper">
        PNG, JPG, or SVG — under 1 MB. The image is stored with your firm settings.
      </small>
      {error ? <small className="field-helper error-text">{error}</small> : null}
    </div>
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
    <CollapsibleSection kicker="Address" title="Mailing address" lockable>
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
    </CollapsibleSection>
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
    <CollapsibleSection kicker="Contact" title="How clients reach you" lockable>
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
    </CollapsibleSection>
  )
}

/**
 * Owner-configurable defaults for the Add-client form. Editing these never
 * touches existing clients — it only changes what a brand-new client starts
 * with (house rate, terms, invoice prefs).
 */
function ClientDefaultsSection({
  settings,
  onCommit,
}: {
  settings: FirmSettings
  onCommit: (patch: Partial<FirmSettings>) => void | Promise<void>
}) {
  const defaults = settings.clientDefaults ?? DEFAULT_FIRM_SETTINGS.clientDefaults ?? {}
  const patch = (next: Partial<NonNullable<FirmSettings['clientDefaults']>>) => {
    onCommit({ clientDefaults: { ...defaults, ...next } })
  }

  return (
    <CollapsibleSection kicker="New clients" title="Default values for new clients" lockable>
      <p className="muted-text" style={{ marginTop: 0 }}>
        These pre-fill the “Add client” form so you don’t retype your house rate and terms each
        time. Changing them here never affects clients you’ve already created.
      </p>
      <div className="form-grid two-col">
        <label className="field">
          <span>Default billing type</span>
          <select
            className="input"
            value={defaults.billingMode ?? 'hourly'}
            onChange={(event) => patch({ billingMode: event.target.value as BillingMode })}
          >
            <option value="hourly">Hourly</option>
            <option value="subscription">Monthly</option>
            <option value="annual">Annual</option>
          </select>
        </label>
        <label className="field">
          <span>Default hourly rate</span>
          <SavingNumberInput
            canonical={defaults.hourlyRate ?? 0}
            min="0"
            step="0.01"
            onCommit={(value) => patch({ hourlyRate: value ?? 0 })}
          />
        </label>
        <label className="field">
          <span>Default monthly rate</span>
          <SavingNumberInput
            canonical={defaults.monthlyRate ?? 0}
            min="0"
            step="0.01"
            onCommit={(value) => patch({ monthlyRate: value ?? 0 })}
          />
        </label>
        <label className="field">
          <span>Default payment terms</span>
          <SavingTextInput
            canonical={defaults.paymentTerms ?? ''}
            placeholder='e.g. "Net 30" or "Due on receipt"'
            onCommit={(value) => patch({ paymentTerms: value })}
          />
        </label>
        <label className="field full-row">
          <span>Default invoice footer note</span>
          <SavingTextarea
            canonical={defaults.footerNote ?? ''}
            onCommit={(value) => patch({ footerNote: value })}
          />
        </label>
        <label className="field toggle-field">
          <span className="toggle-label">
            <input
              type="checkbox"
              checked={defaults.invoiceShowTimeBreakdown ?? true}
              onChange={(event) => patch({ invoiceShowTimeBreakdown: event.target.checked })}
            />
            <strong>Show time breakdown on invoices</strong>
          </span>
        </label>
        <label className="field toggle-field">
          <span className="toggle-label">
            <input
              type="checkbox"
              checked={defaults.invoiceHideInternalHours ?? true}
              onChange={(event) => patch({ invoiceHideInternalHours: event.target.checked })}
            />
            <strong>Hide internal hours on invoices</strong>
          </span>
        </label>
        <label className="field toggle-field">
          <span className="toggle-label">
            <input
              type="checkbox"
              checked={defaults.invoiceGroupByCategory ?? false}
              onChange={(event) => patch({ invoiceGroupByCategory: event.target.checked })}
            />
            <strong>Group invoice lines by category</strong>
          </span>
        </label>
      </div>
    </CollapsibleSection>
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
    <CollapsibleSection kicker="Business" title="Tax / business identifiers" lockable>
      <div className="form-grid two-col">
        <TextField
          label="EIN / Business ID"
          value={settings.ein ?? ''}
          onCommit={(value) => onCommit({ ein: value })}
        />
      </div>
    </CollapsibleSection>
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

// Reliable settings input: commits on a short debounce, on Enter, and on blur,
// and re-syncs when idle (via the shared SectionKit control). Replaces the old
// blur-only input that could drop an edit if the field was left without an
// explicit blur.
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
  return (
    <SavingTextInput
      canonical={canonical}
      onCommit={(value) => {
        void onCommit(value)
      }}
      placeholder={placeholder}
      type={type}
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
