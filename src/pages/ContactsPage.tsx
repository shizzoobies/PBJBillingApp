import { Lock, Plus, Trash2, Unlock, Upload } from 'lucide-react'
import { useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { useAppContext } from '../AppContext'
import { CollapsibleSection, SavingTextInput, SavingTextarea } from '../components/SectionKit'
import type { Client, Contact } from '../lib/types'
import {
  applyMerge,
  buildImportPlan,
  parseContactRows,
  type ContactField,
  type FieldChoice,
  type HeaderMap,
  type ImportRow,
  type ParsedRow,
} from '../lib/contactImport'

export function ContactsPage() {
  const { data, addContact, updateContact, deleteContact, ownerMode } = useAppContext()
  return (
    <section className="content-grid two-column" id="contacts">
      <ContactBuilder onCreate={addContact} />
      <ContactLibrary
        contacts={data.contacts}
        clients={data.clients}
        ownerMode={ownerMode}
        onUpdate={updateContact}
        onDelete={deleteContact}
        onAdd={addContact}
      />
    </section>
  )
}

function ContactBuilder({
  onCreate,
}: {
  onCreate: (contact: Omit<Contact, 'id'>) => void
}) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) {
      return
    }

    onCreate({
      name: trimmed,
      email: email.trim(),
      phone: phone.trim(),
      title: title.trim(),
      notes: notes.trim(),
    })
    setName('')
    setEmail('')
    setPhone('')
    setTitle('')
    setNotes('')
  }

  return (
    <CollapsibleSection kicker="Shared contacts" title="Add contact">
      <form className="form-grid single" onSubmit={handleSubmit}>
        <label className="field">
          <span>Name</span>
          <input className="input" onChange={(event) => setName(event.target.value)} value={name} />
        </label>
        <label className="field">
          <span>Title</span>
          <input
            className="input"
            onChange={(event) => setTitle(event.target.value)}
            value={title}
          />
        </label>
        <label className="field">
          <span>Email</span>
          <input
            className="input"
            type="email"
            onChange={(event) => setEmail(event.target.value)}
            value={email}
          />
        </label>
        <label className="field">
          <span>Phone</span>
          <input
            className="input"
            onChange={(event) => setPhone(event.target.value)}
            value={phone}
          />
        </label>
        <label className="field">
          <span>Notes</span>
          <textarea
            className="input"
            onChange={(event) => setNotes(event.target.value)}
            rows={3}
            value={notes}
          />
        </label>
        <button className="primary-action" type="submit">
          <Plus size={16} />
          Add contact
        </button>
      </form>
    </CollapsibleSection>
  )
}

function ContactLibrary({
  contacts,
  clients,
  ownerMode,
  onUpdate,
  onDelete,
  onAdd,
}: {
  contacts: Contact[]
  clients: Client[]
  ownerMode: boolean
  onUpdate: (contactId: string, patch: Partial<Contact>) => void
  onDelete: (contactId: string) => void
  onAdd: (contact: Omit<Contact, 'id'>) => void
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [importText, setImportText] = useState<string | null>(null)

  const handleDelete = (contact: Contact) => {
    const attached = clients.filter((client) => (client.contactIds ?? []).includes(contact.id))
    const attachedSummary =
      attached.length === 0
        ? 'No clients reference this contact.'
        : `${attached.length} client${attached.length === 1 ? '' : 's'} reference this contact: ${attached
            .map((client) => client.name)
            .join(', ')}. It will be removed from them.`
    if (!window.confirm(`Delete "${contact.name}"?\n\n${attachedSummary}\n\nThis can't be undone.`)) {
      return
    }
    onDelete(contact.id)
  }

  const handleFileSelected = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    // Reset so picking the same file again re-triggers onChange.
    event.target.value = ''
    if (!file) {
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : ''
      setImportText(text)
    }
    reader.readAsText(file)
  }

  const importActions = ownerMode ? (
    <div className="section-heading-actions">
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,text/csv"
        onChange={handleFileSelected}
        style={{ display: 'none' }}
        aria-hidden="true"
        tabIndex={-1}
      />
      <button
        className="secondary-action"
        type="button"
        onClick={() => fileInputRef.current?.click()}
      >
        <Upload size={16} />
        Import from CSV
      </button>
    </div>
  ) : null

  return (
    <>
      <CollapsibleSection
        kicker="Directory"
        title="Contacts"
        lockable
        headerAction={importActions}
      >
        <div className="plan-list">
        {contacts.length === 0 ? (
          <p className="muted-text">No contacts yet. Add one to select it on a client.</p>
        ) : null}
        {contacts.map((contact) => {
          const attachedCount = clients.filter((client) =>
            (client.contactIds ?? []).includes(contact.id),
          ).length
          const locked = Boolean(contact.locked)
          return (
            <article
              className={`plan-row${locked ? ' contact-locked' : ''}`}
              key={contact.id}
            >
              <div className="contact-edit-fields">
                {locked ? (
                  <div className="contact-locked-view">
                    <strong className="contact-locked-name">{contact.name}</strong>
                    {contact.title ? <span>{contact.title}</span> : null}
                    {contact.email ? <span>{contact.email}</span> : null}
                    {contact.phone ? <span>{contact.phone}</span> : null}
                    {contact.notes ? (
                      <p className="contact-locked-notes">{contact.notes}</p>
                    ) : null}
                  </div>
                ) : (
                  <>
                    <ContactTextInput
                      ariaLabel={`${contact.name} name`}
                      canonical={contact.name}
                      onCommit={(value) => {
                        const trimmed = value.trim()
                        if (trimmed) onUpdate(contact.id, { name: trimmed })
                      }}
                    />
                    <ContactTextInput
                      ariaLabel={`${contact.name} title`}
                      canonical={contact.title ?? ''}
                      placeholder="Title"
                      onCommit={(value) => onUpdate(contact.id, { title: value })}
                    />
                    <ContactTextInput
                      ariaLabel={`${contact.name} email`}
                      canonical={contact.email ?? ''}
                      placeholder="Email"
                      onCommit={(value) => onUpdate(contact.id, { email: value })}
                    />
                    <ContactTextInput
                      ariaLabel={`${contact.name} phone`}
                      canonical={contact.phone ?? ''}
                      placeholder="Phone"
                      onCommit={(value) => onUpdate(contact.id, { phone: value })}
                    />
                    <ContactNotesInput
                      ariaLabel={`${contact.name} notes`}
                      canonical={contact.notes ?? ''}
                      placeholder="Notes"
                      onCommit={(value) => onUpdate(contact.id, { notes: value })}
                    />
                  </>
                )}
                {attachedCount > 0 ? (
                  <span className="checklist-meta-line">
                    On {attachedCount} client{attachedCount === 1 ? '' : 's'}
                  </span>
                ) : null}
              </div>
              <div className="contact-row-actions">
                <button
                  className={`contact-lock-btn${locked ? ' is-locked' : ''}`}
                  type="button"
                  aria-pressed={locked}
                  aria-label={locked ? `Unlock ${contact.name}` : `Lock ${contact.name}`}
                  title={
                    locked
                      ? 'Locked — click to unlock and edit'
                      : 'Lock to protect this contact from edits'
                  }
                  onClick={() => onUpdate(contact.id, { locked: !locked })}
                >
                  {locked ? <Lock size={14} /> : <Unlock size={14} />}
                </button>
                {ownerMode && !locked ? (
                  <button
                    className="item-delete-btn"
                    type="button"
                    aria-label={`Delete ${contact.name}`}
                    title="Delete this contact"
                    onClick={() => handleDelete(contact)}
                  >
                    <Trash2 size={14} />
                  </button>
                ) : null}
              </div>
            </article>
          )
        })}
        </div>
      </CollapsibleSection>
      {ownerMode && importText !== null ? (
        <ImportContactsModal
          text={importText}
          existing={contacts}
          onAdd={onAdd}
          onUpdate={onUpdate}
          onClose={() => setImportText(null)}
        />
      ) : null}
    </>
  )
}

// Reliable inline editor: commits on a short debounce, on Enter, and on blur,
// and re-syncs to the saved value when idle (via the shared SectionKit
// control). Replaces the old blur-only input that could lose an edit if you
// left the field without clicking away first.
function ContactTextInput({
  ariaLabel,
  canonical,
  placeholder,
  onCommit,
}: {
  ariaLabel: string
  canonical: string
  placeholder?: string
  onCommit: (value: string) => void
}) {
  return (
    <SavingTextInput
      ariaLabel={ariaLabel}
      canonical={canonical}
      placeholder={placeholder}
      onCommit={onCommit}
    />
  )
}

// Multi-line notes editor for a contact. Reliable commit (debounce + Enter is
// n/a for textarea, but blur + debounce apply) via the shared control.
function ContactNotesInput({
  ariaLabel,
  canonical,
  placeholder,
  onCommit,
}: {
  ariaLabel: string
  canonical: string
  placeholder?: string
  onCommit: (value: string) => void
}) {
  return (
    <SavingTextarea
      ariaLabel={ariaLabel}
      canonical={canonical}
      className="input contact-notes-input"
      placeholder={placeholder}
      rows={2}
      onCommit={onCommit}
    />
  )
}

// ---------------------------------------------------------------------------
// CSV import flow (owner-only). Three steps inside one modal:
//   preview → review (per-row add/merge decisions) → result summary.
// ---------------------------------------------------------------------------

const FIELD_LABELS: Record<ContactField, string> = {
  name: 'Name',
  email: 'Email',
  phone: 'Phone',
  title: 'Title',
  notes: 'Notes',
}

const MERGE_FIELDS: ContactField[] = ['name', 'email', 'phone', 'title', 'notes']

type ImportStep = 'preview' | 'review' | 'result'

/**
 * Per-row decision state held while the owner reviews the import.
 *   - `include`: whether the row is acted on at all (default true).
 *   - `mode`: 'new' creates a contact, 'merge' patches `targetId`.
 *   - `targetId`: which matched contact to merge into.
 *   - `fieldChoices`: per-field keep-existing / use-CSV when values differ.
 */
type RowDecision = {
  include: boolean
  mode: 'new' | 'merge'
  targetId: string
  fieldChoices: Partial<Record<ContactField, FieldChoice>>
}

function initialDecision(item: ImportRow): RowDecision {
  if (item.matches.length === 0) {
    return { include: true, mode: 'new', targetId: '', fieldChoices: {} }
  }
  // Default the merge target to the email match if there is one, else first.
  const rowEmail = (item.row.email ?? '').trim().toLowerCase()
  const emailMatch =
    rowEmail !== ''
      ? item.matches.find((c) => (c.email ?? '').trim().toLowerCase() === rowEmail)
      : undefined
  const target = emailMatch ?? item.matches[0]
  return { include: true, mode: 'merge', targetId: target.id, fieldChoices: {} }
}

function HeaderMappingList({ headerMap, headers }: { headerMap: HeaderMap; headers: string[] }) {
  const entries = Object.entries(headerMap) as Array<[string, ContactField]>
  if (entries.length === 0) {
    return (
      <p className="muted-text">
        No recognized columns. Expected headers like Name, Email, Phone, Title, or Notes.
      </p>
    )
  }
  return (
    <ul className="import-mapping-list">
      {entries.map(([indexKey, field]) => (
        <li key={indexKey}>
          <span className="import-mapping-source">{headers[Number(indexKey)] || `Column ${Number(indexKey) + 1}`}</span>
          <span className="import-mapping-arrow" aria-hidden="true">→</span>
          <span className="import-mapping-target">{FIELD_LABELS[field]}</span>
        </li>
      ))}
    </ul>
  )
}

function ImportContactsModal({
  text,
  existing,
  onAdd,
  onUpdate,
  onClose,
}: {
  text: string
  existing: Contact[]
  onAdd: (contact: Omit<Contact, 'id'>) => void
  onUpdate: (contactId: string, patch: Partial<Contact>) => void
  onClose: () => void
}) {
  const parsed = useMemo(() => parseContactRows(text), [text])
  const headers = useMemo(() => {
    // Re-derive the header row purely for display of the original column
    // names. Strip a leading UTF-8 BOM so the first header isn't polluted.
    const firstLine = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)[0] ?? ''
    return parseSingleCsvLine(firstLine)
  }, [text])
  const plan = useMemo(() => buildImportPlan(text, existing), [text, existing])

  const [step, setStep] = useState<ImportStep>('preview')
  const [decisions, setDecisions] = useState<RowDecision[]>(() => plan.map(initialDecision))
  const [result, setResult] = useState<{ added: number; merged: number; skipped: number } | null>(
    null,
  )

  const includedCount = decisions.filter((d) => d.include).length

  const updateDecision = (index: number, patch: Partial<RowDecision>) => {
    setDecisions((current) =>
      current.map((decision, i) => (i === index ? { ...decision, ...patch } : decision)),
    )
  }

  const handleImport = () => {
    let added = 0
    let merged = 0
    let skipped = parsed.skipped

    plan.forEach((item, index) => {
      const decision = decisions[index]
      if (!decision.include) {
        skipped += 1
        return
      }
      if (decision.mode === 'merge' && decision.targetId) {
        const target = item.matches.find((c) => c.id === decision.targetId)
        if (target) {
          const patch = applyMerge(target, item.row, decision.fieldChoices)
          if (Object.keys(patch).length > 0) {
            onUpdate(target.id, patch)
          }
          merged += 1
          return
        }
      }
      // New / add-as-new.
      onAdd(rowToContact(item.row))
      added += 1
    })

    setResult({ added, merged, skipped })
    setStep('result')
  }

  return (
    <div
      className="modal-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="modal-panel import-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Import contacts from CSV"
      >
        {step === 'preview' ? (
          <div className="modal-body">
            <h2 className="modal-title">Import contacts</h2>
            <p className="modal-intro">
              {parsed.rows.length} row{parsed.rows.length === 1 ? '' : 's'} ready to import
              {parsed.skipped > 0
                ? ` · ${parsed.skipped} skipped (no name)`
                : ''}
              .
            </p>
            <div className="import-section">
              <p className="section-kicker">Detected columns</p>
              <HeaderMappingList headerMap={parsed.headerMap} headers={headers} />
            </div>
            <div className="button-row">
              <button type="button" className="secondary-action" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="primary-action"
                onClick={() => setStep('review')}
                disabled={parsed.rows.length === 0}
              >
                Continue
              </button>
            </div>
          </div>
        ) : step === 'review' ? (
          <div className="modal-body">
            <h2 className="modal-title">Review import</h2>
            <p className="modal-intro">
              Choose how to handle each row. Rows with a possible duplicate can be merged into an
              existing contact or added as new.
            </p>
            <div className="import-review-list">
              {plan.map((item, index) => (
                <ReviewRow
                  key={index}
                  item={item}
                  decision={decisions[index]}
                  onChange={(patch) => updateDecision(index, patch)}
                />
              ))}
            </div>
            <div className="button-row">
              <button type="button" className="secondary-action" onClick={() => setStep('preview')}>
                Back
              </button>
              <button
                type="button"
                className="primary-action"
                onClick={handleImport}
                disabled={includedCount === 0}
              >
                Import {includedCount} contact{includedCount === 1 ? '' : 's'}
              </button>
            </div>
          </div>
        ) : (
          <div className="modal-body">
            <h2 className="modal-title">Import complete</h2>
            <p className="modal-intro">
              Added {result?.added ?? 0} · Merged {result?.merged ?? 0} · Skipped{' '}
              {result?.skipped ?? 0}
            </p>
            <div className="button-row">
              <button type="button" className="primary-action" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function ReviewRow({
  item,
  decision,
  onChange,
}: {
  item: ImportRow
  decision: RowDecision
  onChange: (patch: Partial<RowDecision>) => void
}) {
  const hasMatch = item.matches.length > 0
  const rowLabel = item.row.name

  return (
    <article className={`import-review-row${decision.include ? '' : ' is-excluded'}`}>
      <div className="import-review-header">
        <label className="check-row import-include-toggle">
          <input
            type="checkbox"
            checked={decision.include}
            onChange={(event) => onChange({ include: event.target.checked })}
          />
          <span>{rowLabel}</span>
        </label>
        <span className="import-row-badge">{hasMatch ? 'Possible duplicate' : 'New'}</span>
      </div>

      {decision.include && hasMatch ? (
        <div className="import-review-body">
          <div className="import-mode-choice">
            <label className="radio-inline">
              <input
                type="radio"
                name={`mode-${rowLabel}-${item.matches[0].id}`}
                checked={decision.mode === 'new'}
                onChange={() => onChange({ mode: 'new' })}
              />
              <span>Add as new</span>
            </label>
            <label className="radio-inline">
              <input
                type="radio"
                name={`mode-${rowLabel}-${item.matches[0].id}`}
                checked={decision.mode === 'merge'}
                onChange={() => onChange({ mode: 'merge' })}
              />
              <span>Merge into</span>
            </label>
            {decision.mode === 'merge' ? (
              <label className="field import-merge-target">
                <span className="visually-hidden">Merge target for {rowLabel}</span>
                <select
                  className="input"
                  aria-label={`Merge target for ${rowLabel}`}
                  value={decision.targetId}
                  onChange={(event) => onChange({ targetId: event.target.value })}
                >
                  {item.matches.map((match) => (
                    <option key={match.id} value={match.id}>
                      {match.name}
                      {match.email ? ` (${match.email})` : ''}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>

          {decision.mode === 'merge' ? (
            <MergeFieldDetail
              target={item.matches.find((m) => m.id === decision.targetId) ?? item.matches[0]}
              row={item.row}
              fieldChoices={decision.fieldChoices}
              onFieldChoice={(field, choice) =>
                onChange({ fieldChoices: { ...decision.fieldChoices, [field]: choice } })
              }
            />
          ) : null}
        </div>
      ) : null}
    </article>
  )
}

function MergeFieldDetail({
  target,
  row,
  fieldChoices,
  onFieldChoice,
}: {
  target: Contact
  row: ParsedRow
  fieldChoices: Partial<Record<ContactField, FieldChoice>>
  onFieldChoice: (field: ContactField, choice: FieldChoice) => void
}) {
  const rows = MERGE_FIELDS.map((field) => {
    const csvValue = (row[field] ?? '').trim()
    const existingValue = (target[field] ?? '').trim()
    return { field, csvValue, existingValue }
  }).filter(({ csvValue }) => csvValue !== '')

  if (rows.length === 0) {
    return <p className="muted-text import-merge-note">Nothing new to merge from this row.</p>
  }

  return (
    <div className="import-merge-fields">
      {rows.map(({ field, csvValue, existingValue }) => {
        const fills = existingValue === ''
        const differs = !fills && existingValue !== csvValue
        if (fills) {
          return (
            <p className="import-merge-note" key={field}>
              <strong>{FIELD_LABELS[field]}:</strong> will add &ldquo;{csvValue}&rdquo;
            </p>
          )
        }
        if (!differs) {
          return null
        }
        const choice = fieldChoices[field] ?? 'existing'
        return (
          <fieldset className="import-merge-conflict" key={field}>
            <legend>{FIELD_LABELS[field]}</legend>
            <label className="radio-inline">
              <input
                type="radio"
                name={`field-${target.id}-${field}`}
                checked={choice === 'existing'}
                onChange={() => onFieldChoice(field, 'existing')}
              />
              <span>Keep existing: {existingValue}</span>
            </label>
            <label className="radio-inline">
              <input
                type="radio"
                name={`field-${target.id}-${field}`}
                checked={choice === 'csv'}
                onChange={() => onFieldChoice(field, 'csv')}
              />
              <span>Use CSV: {csvValue}</span>
            </label>
          </fieldset>
        )
      })}
    </div>
  )
}

/** Turn a parsed row into the `Omit<Contact,'id'>` shape `addContact` wants. */
function rowToContact(row: ParsedRow): Omit<Contact, 'id'> {
  return {
    name: row.name,
    email: row.email ?? '',
    phone: row.phone ?? '',
    title: row.title ?? '',
    notes: row.notes ?? '',
  }
}

/**
 * Parse just the first CSV line into cells for displaying the ORIGINAL header
 * names in the mapping preview. Mirrors the quoting rules of `parseCsv` but
 * stops at the first record. Newlines inside quotes can't appear on a single
 * pre-split line, so this stays simple.
 */
function parseSingleCsvLine(line: string): string[] {
  const cells: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
    } else if (char === '"') {
      inQuotes = true
    } else if (char === ',') {
      cells.push(field)
      field = ''
    } else {
      field += char
    }
  }
  cells.push(field)
  return cells
}
