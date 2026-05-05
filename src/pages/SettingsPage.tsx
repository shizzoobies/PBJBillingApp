import { useEffect, useRef, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useAppContext } from '../AppContext'
import { fetchFirmSettings, updateFirmSettingsRequest } from '../lib/api'
import { DEFAULT_FIRM_SETTINGS, type FirmSettings } from '../lib/types'

export function SettingsPage() {
  const { ownerMode, setFirmSettings } = useAppContext()
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
