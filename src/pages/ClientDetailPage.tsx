import { ArrowLeft, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { useAppContext } from '../AppContext'
import { recordClientProfileActivity } from '../lib/api'
import type { Client } from '../lib/types'
import {
  clientName,
  employeeName,
  formatHours,
  shortDate,
  sortChecklists,
} from '../lib/utils'

export function ClientDetailPage() {
  const { clientId } = useParams<{ clientId: string }>()
  const navigate = useNavigate()
  const { data, ownerMode, updateClient, deleteClient } = useAppContext()

  const client = useMemo(
    () => data.clients.find((entry) => entry.id === clientId),
    [data.clients, clientId],
  )

  // Activity-record debounce: only fire one event per ~60s of editing.
  const lastActivityRef = useRef<number>(0)
  const [savedFlash, setSavedFlash] = useState(false)
  const savedTimeoutRef = useRef<number | null>(null)

  // Track whether the last save came from this page so we can show "Saved".
  // We trigger the indicator on every commit attempt.
  const flashSaved = () => {
    setSavedFlash(true)
    if (savedTimeoutRef.current) {
      window.clearTimeout(savedTimeoutRef.current)
    }
    savedTimeoutRef.current = window.setTimeout(() => setSavedFlash(false), 1500)
  }

  useEffect(() => {
    return () => {
      if (savedTimeoutRef.current) {
        window.clearTimeout(savedTimeoutRef.current)
      }
    }
  }, [])

  if (!ownerMode) {
    return <Navigate to="/clients" replace />
  }

  if (!client) {
    return (
      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Owner client controls</p>
            <h2>Client not found</h2>
          </div>
        </div>
        <p>
          <Link className="back-link" to="/clients">
            <ArrowLeft size={14} /> Back to clients
          </Link>
        </p>
      </section>
    )
  }

  const commit = (patch: Partial<Client>) => {
    updateClient(client.id, patch)
    flashSaved()
    const now = Date.now()
    if (now - lastActivityRef.current > 60_000) {
      lastActivityRef.current = now
      void recordClientProfileActivity(client.id).catch(() => {
        // Activity logging is best-effort.
      })
    }
  }

  const handleDelete = () => {
    if (
      !window.confirm(
        `Delete ${client.name}? This removes the client from the workspace. Time entries and checklists referencing this client will be left intact in the data, but the client will no longer appear in lists.`,
      )
    ) {
      return
    }
    deleteClient(client.id)
    navigate('/clients', { replace: true })
  }

  const recentEntries = data.timeEntries
    .filter((entry) => entry.clientId === client.id)
    .slice(0, 8)

  const recentChecklists = sortChecklists(
    data.checklists.filter((checklist) => checklist.clientId === client.id),
  ).slice(0, 8)

  return (
    <section className="client-detail">
      <div className="client-detail-header">
        <Link className="back-link" to="/clients">
          <ArrowLeft size={14} />
          Back to clients
        </Link>
        {savedFlash ? <span className="saved-flash">Saved</span> : null}
      </div>

      <div className="panel">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Client profile</p>
            <NameField client={client} onCommit={commit} />
          </div>
          <button
            className="danger-action"
            onClick={handleDelete}
            type="button"
          >
            <Trash2 size={14} />
            Delete client
          </button>
        </div>
      </div>

      <ContactSection client={client} onCommit={commit} />
      <BrandingSection client={client} onCommit={commit} />
      <InvoiceSettingsSection client={client} onCommit={commit} />

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Activity</p>
            <h2>Recent work for this client</h2>
          </div>
        </div>
        <div className="form-grid two-col">
          <div>
            <h3 className="mini-heading">Recent time entries</h3>
            {recentEntries.length === 0 ? (
              <p className="muted-text">No time entries logged yet.</p>
            ) : (
              <ul className="activity-list">
                {recentEntries.map((entry) => (
                  <li key={entry.id}>
                    <strong>{shortDate.format(new Date(`${entry.date}T12:00:00`))}</strong>
                    <span>
                      {employeeName(data.employees, entry.employeeId)} ·{' '}
                      {formatHours(entry.minutes)} · {entry.category}
                      {entry.billable ? '' : ' (internal)'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h3 className="mini-heading">Recent checklists</h3>
            {recentChecklists.length === 0 ? (
              <p className="muted-text">No checklists for this client yet.</p>
            ) : (
              <ul className="activity-list">
                {recentChecklists.map((checklist) => {
                  const total = checklist.items.length
                  const done = checklist.items.filter((item) => item.done).length
                  return (
                    <li key={checklist.id}>
                      <strong>{checklist.title}</strong>
                      <span>
                        Due {checklist.dueDate} · {done}/{total} done ·{' '}
                        {clientName(data.clients, checklist.clientId)}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      </section>
    </section>
  )
}

function NameField({
  client,
  onCommit,
}: {
  client: Client
  onCommit: (patch: Partial<Client>) => void
}) {
  return (
    <h2 className="client-detail-title">
      <NameInput
        canonical={client.name}
        key={`${client.id}:${client.name}`}
        onCommit={(value) => onCommit({ name: value })}
      />
    </h2>
  )
}

function NameInput({
  canonical,
  onCommit,
}: {
  canonical: string
  onCommit: (value: string) => void
}) {
  const [value, setValue] = useState(canonical)
  return (
    <input
      aria-label="Client name"
      className="title-input"
      onBlur={() => {
        const trimmed = value.trim()
        if (!trimmed) {
          setValue(canonical)
          return
        }
        if (trimmed !== canonical) {
          onCommit(trimmed)
        }
      }}
      onChange={(event) => setValue(event.target.value)}
      value={value}
    />
  )
}

function ContactSection({
  client,
  onCommit,
}: {
  client: Client
  onCommit: (patch: Partial<Client>) => void
}) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Contact</p>
          <h2>Contact details</h2>
        </div>
      </div>
      <div className="form-grid two-col">
        <TextField
          label="Primary contact name"
          onCommit={(value) => onCommit({ contactName: value })}
          value={client.contactName ?? ''}
        />
        <TextField
          label="Email"
          onCommit={(value) => onCommit({ email: value })}
          type="email"
          value={client.email ?? ''}
        />
        <TextField
          label="Phone"
          onCommit={(value) => onCommit({ phone: value })}
          value={client.phone ?? ''}
        />
        <div />
        <TextField
          label="Address line 1"
          onCommit={(value) => onCommit({ addressLine1: value })}
          value={client.addressLine1 ?? ''}
        />
        <TextField
          label="Address line 2"
          onCommit={(value) => onCommit({ addressLine2: value })}
          value={client.addressLine2 ?? ''}
        />
        <TextField
          label="City"
          onCommit={(value) => onCommit({ city: value })}
          value={client.city ?? ''}
        />
        <TextField
          label="State"
          onCommit={(value) => onCommit({ state: value })}
          value={client.state ?? ''}
        />
        <TextField
          label="Postal code"
          onCommit={(value) => onCommit({ postalCode: value })}
          value={client.postalCode ?? ''}
        />
      </div>
    </section>
  )
}

function BrandingSection({
  client,
  onCommit,
}: {
  client: Client
  onCommit: (patch: Partial<Client>) => void
}) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Branding</p>
          <h2>Logo</h2>
        </div>
      </div>
      <div className="form-grid two-col">
        <TextField
          label="Logo URL"
          onCommit={(value) => onCommit({ logoUrl: value })}
          placeholder="https://..."
          value={client.logoUrl ?? ''}
        />
        <div className="logo-preview">
          {client.logoUrl ? (
            <img alt={`${client.name} logo`} src={client.logoUrl} />
          ) : (
            <span className="muted-text">No logo set. Paste a public image URL.</span>
          )}
        </div>
      </div>
    </section>
  )
}

function InvoiceSettingsSection({
  client,
  onCommit,
}: {
  client: Client
  onCommit: (patch: Partial<Client>) => void
}) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Invoice settings</p>
          <h2>Invoice customization</h2>
        </div>
      </div>
      <div className="form-grid two-col">
        <TextField
          label="Payment terms"
          onCommit={(value) => onCommit({ paymentTerms: value })}
          placeholder='e.g. "Net 30" or "Due on receipt"'
          value={client.paymentTerms ?? ''}
        />
        <TextField
          label="QuickBooks 'Pay Now' link"
          helper="Paste the public payment URL from QuickBooks. Will appear as a Pay button on each invoice."
          onCommit={(value) => onCommit({ quickbooksPayUrl: value })}
          placeholder="https://quickbooks.intuit.com/payments/..."
          value={client.quickbooksPayUrl ?? ''}
        />
        <label className="field full-row">
          <span>Invoice footer note</span>
          <BlurTextarea
            onCommit={(value) => onCommit({ footerNote: value })}
            value={client.footerNote ?? ''}
          />
        </label>
        <ToggleField
          checked={client.invoiceShowTimeBreakdown ?? true}
          description="Show each time entry on the invoice. When off, the invoice shows a single bookkeeping services line."
          label="Show time breakdown"
          onChange={(value) => onCommit({ invoiceShowTimeBreakdown: value })}
        />
        <ToggleField
          checked={client.invoiceHideInternalHours ?? true}
          description="Hide non-billable rows from the invoice."
          label="Hide internal hours"
          onChange={(value) => onCommit({ invoiceHideInternalHours: value })}
        />
        <ToggleField
          checked={client.invoiceGroupByCategory ?? false}
          description="Group line items by work-type category with subtotals."
          label="Group by category"
          onChange={(value) => onCommit({ invoiceGroupByCategory: value })}
        />
      </div>
    </section>
  )
}

function TextField({
  label,
  helper,
  onCommit,
  placeholder,
  type,
  value,
}: {
  label: string
  helper?: string
  onCommit: (value: string) => void
  placeholder?: string
  type?: string
  value: string
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <TextInputControl
        canonical={value}
        key={value}
        onCommit={onCommit}
        placeholder={placeholder}
        type={type ?? 'text'}
      />
      {helper ? <small className="field-helper">{helper}</small> : null}
    </label>
  )
}

function TextInputControl({
  canonical,
  onCommit,
  placeholder,
  type,
}: {
  canonical: string
  onCommit: (value: string) => void
  placeholder?: string
  type: string
}) {
  const [draft, setDraft] = useState(canonical)
  return (
    <input
      className="input"
      onBlur={() => {
        if (draft !== canonical) {
          onCommit(draft)
        }
      }}
      onChange={(event) => setDraft(event.target.value)}
      placeholder={placeholder}
      type={type}
      value={draft}
    />
  )
}

function BlurTextarea({
  onCommit,
  value,
}: {
  onCommit: (value: string) => void
  value: string
}) {
  return <TextareaControl canonical={value} key={value} onCommit={onCommit} />
}

function TextareaControl({
  canonical,
  onCommit,
}: {
  canonical: string
  onCommit: (value: string) => void
}) {
  const [draft, setDraft] = useState(canonical)
  return (
    <textarea
      className="input"
      onBlur={() => {
        if (draft !== canonical) {
          onCommit(draft)
        }
      }}
      onChange={(event) => setDraft(event.target.value)}
      rows={3}
      value={draft}
    />
  )
}

function ToggleField({
  checked,
  description,
  label,
  onChange,
}: {
  checked: boolean
  description: string
  label: string
  onChange: (value: boolean) => void
}) {
  return (
    <label className="field toggle-field">
      <span className="toggle-label">
        <input
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          type="checkbox"
        />
        <strong>{label}</strong>
      </span>
      <small className="field-helper">{description}</small>
    </label>
  )
}
