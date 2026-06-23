import { Archive, ArchiveRestore, Lock, Plus, Trash2, Unlock, Upload } from 'lucide-react'
import { useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAppContext } from '../AppContext'
import { AddModal } from '../components/AddModal'
import { ChipMultiSelect } from '../components/ChipMultiSelect'
import { FloatingAddButton } from '../components/FloatingAddButton'
import { ListSearch } from '../components/ListSearch'
import { CollapsibleSection, SavingTextInput, SavingTextarea } from '../components/SectionKit'
import type { Client, Contact } from '../lib/types'
import { distinctGroupNames, groupContacts, unlinkedContacts } from '../lib/utils'
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
  const {
    data,
    addContact,
    updateContact,
    deleteContact,
    setContactLinks,
    setContactArchived,
    ownerMode,
  } = useAppContext()
  const groupNames = useMemo(() => distinctGroupNames(data.contacts), [data.contacts])
  const [addOpen, setAddOpen] = useState(false)
  return (
    <section className="panel" id="contacts">
      {/* Shared list of existing group names, referenced by every Group input. */}
      <datalist id={GROUP_DATALIST_ID}>
        {groupNames.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <ContactLibrary
        contacts={data.contacts}
        clients={data.clients}
        ownerMode={ownerMode}
        onUpdate={updateContact}
        onDelete={deleteContact}
        onAdd={addContact}
        onSetLinks={setContactLinks}
        onSetArchived={setContactArchived}
        onAddClick={() => setAddOpen(true)}
      />
      {addOpen ? (
        <AddModal title="Add contact" onClose={() => setAddOpen(false)}>
          <ContactBuilder
            variant="modal"
            onCreate={(values) => {
              addContact(values)
              setAddOpen(false)
            }}
          />
        </AddModal>
      ) : null}
    </section>
  )
}

/** Shared id for the existing-group-names <datalist> used by Group inputs. */
const GROUP_DATALIST_ID = 'contact-group-names'

function ContactBuilder({
  onCreate,
  variant = 'panel',
}: {
  onCreate: (contact: Omit<Contact, 'id'>) => void
  variant?: 'panel' | 'modal'
}) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [group, setGroup] = useState('')

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
      group: group.trim(),
    })
    setName('')
    setEmail('')
    setPhone('')
    setTitle('')
    setNotes('')
    setGroup('')
  }

  const form = (
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
          <span>Group</span>
          <input
            className="input"
            list={GROUP_DATALIST_ID}
            placeholder="Optional — e.g. Smith Family"
            onChange={(event) => setGroup(event.target.value)}
            value={group}
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
  )

  if (variant === 'modal') {
    return form
  }

  return (
    <CollapsibleSection kicker="Shared contacts" title="Add contact">
      {form}
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
  onSetLinks,
  onSetArchived,
  onAddClick,
}: {
  contacts: Contact[]
  clients: Client[]
  ownerMode: boolean
  onUpdate: (contactId: string, patch: Partial<Contact>) => void
  onDelete: (contactId: string) => void
  onAdd: (contact: Omit<Contact, 'id'>) => void
  onSetLinks: (contactId: string, nextLinkedIds: string[]) => void
  onSetArchived: (contactId: string, archived: boolean) => void
  onAddClick: () => void
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [importText, setImportText] = useState<string | null>(null)
  // Which contact rows are expanded to reveal the per-company-email + links
  // editor. Keyed by contact id.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set())
  // "Unlinked only" at-a-glance filter for the active list.
  const [unlinkedOnly, setUnlinkedOnly] = useState(false)
  // Text search query over the active list.
  const [query, setQuery] = useState('')
  // Default to the grouped view: groups sorted alphabetically by group name
  // (members by name, Ungrouped last). The toggle still flips to a flat,
  // name-sorted list.
  const [groupByGroup, setGroupByGroup] = useState(true)

  const toggleExpanded = (id: string) => {
    setExpandedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Active = not archived; archived split out into its own collapsible section.
  const activeContacts = useMemo(
    () => contacts.filter((contact) => !contact.archivedAt),
    [contacts],
  )
  const archivedContacts = useMemo(
    () => contacts.filter((contact) => contact.archivedAt),
    [contacts],
  )
  const unlinked = useMemo(() => unlinkedContacts(contacts, clients), [contacts, clients])
  const unlinkedIdSet = useMemo(() => new Set(unlinked.map((c) => c.id)), [unlinked])

  // Build a set of client names indexed by contact id for search.
  const contactClientNames = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const client of clients) {
      for (const cid of client.contactIds ?? []) {
        const existing = map.get(cid) ?? []
        existing.push(client.name)
        map.set(cid, existing)
      }
    }
    return map
  }, [clients])

  const matchesQuery = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return null // null = no filter
    return (contact: Contact) => {
      const clientNames = contactClientNames.get(contact.id) ?? []
      const fields = [
        contact.name,
        contact.title ?? '',
        contact.email ?? '',
        contact.phone ?? '',
        ...(contact.companyEmails ?? []).map((e) => e.email),
        ...clientNames,
      ]
      return fields.some((f) => f.toLowerCase().includes(q))
    }
  }, [query, contactClientNames])

  // Both filters (unlinked pill + search query) apply simultaneously.
  const unlinkedFiltered = unlinkedOnly
    ? activeContacts.filter((contact) => unlinkedIdSet.has(contact.id))
    : activeContacts
  const visibleActive = matchesQuery ? unlinkedFiltered.filter(matchesQuery) : unlinkedFiltered

  // When "Group by group" is on, partition the already-filtered list into
  // alphabetical group sections (with an "Ungrouped" bucket last). Computed off
  // visibleActive so search + the Unlinked pill apply first, then we group what
  // remains.
  const groupedSections = useMemo(
    () => (groupByGroup ? groupContacts(visibleActive) : null),
    [groupByGroup, visibleActive],
  )

  // One contact row — shared by the flat list and the grouped sections so the
  // wiring stays in one place.
  const renderContactRow = (contact: Contact) => (
    <ContactRow
      key={contact.id}
      contact={contact}
      clients={clients}
      contacts={contacts}
      ownerMode={ownerMode}
      isUnlinked={unlinkedIdSet.has(contact.id)}
      expanded={expandedIds.has(contact.id)}
      onToggleExpanded={() => toggleExpanded(contact.id)}
      onUpdate={onUpdate}
      onDelete={handleDelete}
      onSetLinks={onSetLinks}
      onSetArchived={onSetArchived}
    />
  )

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
      <FloatingAddButton label="Add contact" onClick={onAddClick} />
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
        stickyHeader
        headerAction={importActions}
      >
        {activeContacts.length > 0 ? (
          <div className="contacts-filter-bar">
            <button
              type="button"
              className={`contacts-filter-pill${unlinkedOnly ? ' is-active' : ''}`}
              aria-pressed={unlinkedOnly}
              onClick={() => setUnlinkedOnly((on) => !on)}
            >
              Unlinked ({unlinked.length})
            </button>
            <button
              type="button"
              className={`contacts-filter-pill${groupByGroup ? ' is-active' : ''}`}
              aria-pressed={groupByGroup}
              onClick={() => setGroupByGroup((on) => !on)}
            >
              Group by group
            </button>
            <ListSearch
              value={query}
              onChange={setQuery}
              placeholder="Search contacts…"
              resultCount={visibleActive.length}
              total={activeContacts.length}
            />
          </div>
        ) : null}
        <div className="plan-list">
          {activeContacts.length === 0 ? (
            <p className="muted-text">No contacts yet. Add one to select it on a client.</p>
          ) : null}
          {activeContacts.length > 0 && visibleActive.length === 0 && !query.trim() ? (
            <p className="muted-text">Every contact is linked to a client.</p>
          ) : null}
          {activeContacts.length > 0 && visibleActive.length === 0 && query.trim() ? (
            <p className="list-search-empty">
              No contacts match &ldquo;{query.trim()}&rdquo;.
            </p>
          ) : null}
          {groupedSections
            ? groupedSections.map((section) => (
                <div className="contact-group-section" key={section.group}>
                  <h3 className="contact-group-heading">
                    {section.group}{' '}
                    <span className="contact-group-count">({section.contacts.length})</span>
                  </h3>
                  {section.contacts.map(renderContactRow)}
                </div>
              ))
            : visibleActive.map(renderContactRow)}
        </div>
      </CollapsibleSection>
      {archivedContacts.length > 0 ? (
        <CollapsibleSection
          kicker="Archived"
          title={`Archived contacts (${archivedContacts.length})`}
          defaultCollapsed
        >
          <div className="plan-list">
            {archivedContacts.map((contact) => (
              <ContactRow
                key={contact.id}
                contact={contact}
                clients={clients}
                contacts={contacts}
                ownerMode={ownerMode}
                isUnlinked={false}
                expanded={expandedIds.has(contact.id)}
                onToggleExpanded={() => toggleExpanded(contact.id)}
                onUpdate={onUpdate}
                onDelete={handleDelete}
                onSetLinks={onSetLinks}
                onSetArchived={onSetArchived}
              />
            ))}
          </div>
        </CollapsibleSection>
      ) : null}
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

/**
 * A single contact in the directory (or archived) list. Shows the inline
 * editor (or a read-only view when locked), the client NAMES the contact is
 * linked to (each a Link to that client), an "Unlinked" / "Archived" badge,
 * and — when expanded — per-company email overrides and a contact-to-contact
 * link picker. Lock / archive / delete actions sit on the right.
 */
function ContactRow({
  contact,
  clients,
  contacts,
  ownerMode,
  isUnlinked,
  expanded,
  onToggleExpanded,
  onUpdate,
  onDelete,
  onSetLinks,
  onSetArchived,
}: {
  contact: Contact
  clients: Client[]
  contacts: Contact[]
  ownerMode: boolean
  isUnlinked: boolean
  expanded: boolean
  onToggleExpanded: () => void
  onUpdate: (contactId: string, patch: Partial<Contact>) => void
  onDelete: (contact: Contact) => void
  onSetLinks: (contactId: string, nextLinkedIds: string[]) => void
  onSetArchived: (contactId: string, archived: boolean) => void
}) {
  const locked = Boolean(contact.locked)
  const archived = Boolean(contact.archivedAt)
  const linkedClients = clients.filter((client) =>
    (client.contactIds ?? []).includes(contact.id),
  )
  const linkedContactIds = contact.linkedContactIds ?? []

  // Set the per-company email override for `clientId`. An empty value removes
  // the override (so the base email takes over again).
  const setCompanyEmail = (clientId: string, value: string) => {
    const trimmed = value.trim()
    const rest = (contact.companyEmails ?? []).filter((entry) => entry.clientId !== clientId)
    const next = trimmed ? [...rest, { clientId, email: trimmed }] : rest
    onUpdate(contact.id, { companyEmails: next })
  }

  return (
    <article className={`plan-row${locked ? ' contact-locked' : ''}${archived ? ' contact-archived' : ''}`}>
      <div className="contact-edit-fields">
        {locked ? (
          <div className="contact-locked-view">
            <strong className="contact-locked-name">{contact.name}</strong>
            {contact.title ? <span>{contact.title}</span> : null}
            {contact.email ? <span>{contact.email}</span> : null}
            {contact.phone ? <span>{contact.phone}</span> : null}
            {contact.notes ? <p className="contact-locked-notes">{contact.notes}</p> : null}
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
              placeholder="Email (default)"
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
            <ContactTextInput
              ariaLabel={`${contact.name} group`}
              canonical={contact.group ?? ''}
              placeholder="Group (optional)"
              list={GROUP_DATALIST_ID}
              onCommit={(value) => onUpdate(contact.id, { group: value })}
            />
          </>
        )}

        {/* Which client(s) this contact is on — by NAME, each a link. */}
        <div className="contact-client-links">
          {linkedClients.length === 0 ? (
            <span className="contact-badge contact-badge-unlinked">Not linked to any client</span>
          ) : (
            <span className="checklist-meta-line">
              On {linkedClients.length} client{linkedClients.length === 1 ? '' : 's'}:{' '}
              {linkedClients.map((client, index) => (
                <span key={client.id}>
                  {index > 0 ? ', ' : ''}
                  <Link className="contact-client-link" to={`/clients/${client.id}`}>
                    {client.name}
                  </Link>
                </span>
              ))}
            </span>
          )}
          {isUnlinked && linkedClients.length === 0 ? null : isUnlinked ? (
            <span className="contact-badge contact-badge-unlinked">Unlinked</span>
          ) : null}
          {archived ? <span className="contact-badge contact-badge-archived">Archived</span> : null}
        </div>

        {!locked ? (
          <button
            type="button"
            className="contact-expand-btn"
            aria-expanded={expanded}
            onClick={onToggleExpanded}
          >
            {expanded ? 'Hide details' : 'Per-company emails & links'}
          </button>
        ) : null}

        {expanded && !locked ? (
          <div className="contact-expanded">
            {linkedClients.length > 0 ? (
              <div className="contact-company-emails">
                <span className="section-kicker">Per-company email</span>
                {linkedClients.map((client) => (
                  <label className="field" key={client.id}>
                    <span>{client.name}</span>
                    <ContactTextInput
                      ariaLabel={`${contact.name} email for ${client.name}`}
                      canonical={
                        (contact.companyEmails ?? []).find((e) => e.clientId === client.id)
                          ?.email ?? ''
                      }
                      placeholder={
                        contact.email?.trim()
                          ? `Default: ${contact.email.trim()}`
                          : 'Email for this company'
                      }
                      onCommit={(value) => setCompanyEmail(client.id, value)}
                    />
                  </label>
                ))}
              </div>
            ) : (
              <p className="muted-text">
                Link this contact to a client to set a per-company email override.
              </p>
            )}

            <div className="contact-linked-contacts">
              <span className="section-kicker">Linked contacts</span>
              <ChipMultiSelect
                selectedIds={linkedContactIds}
                options={contacts
                  .filter((other) => other.id !== contact.id && !other.archivedAt)
                  .map((other) => ({ id: other.id, label: other.name }))}
                onChange={(nextIds) => onSetLinks(contact.id, nextIds)}
                addLabel="+ Link contact"
                emptyHelper="Not linked to any other contact."
              />
            </div>
          </div>
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
            className="contact-archive-btn"
            type="button"
            aria-label={archived ? `Unarchive ${contact.name}` : `Archive ${contact.name}`}
            title={archived ? 'Unarchive — return to the active list' : 'Archive — hide from active list & pickers'}
            onClick={() => onSetArchived(contact.id, !archived)}
          >
            {archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
          </button>
        ) : null}
        {ownerMode && !locked ? (
          <button
            className="item-delete-btn"
            type="button"
            aria-label={`Delete ${contact.name}`}
            title="Delete this contact"
            onClick={() => onDelete(contact)}
          >
            <Trash2 size={14} />
          </button>
        ) : null}
      </div>
    </article>
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
  list,
}: {
  ariaLabel: string
  canonical: string
  placeholder?: string
  onCommit: (value: string) => void
  list?: string
}) {
  return (
    <SavingTextInput
      ariaLabel={ariaLabel}
      canonical={canonical}
      placeholder={placeholder}
      onCommit={onCommit}
      list={list}
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
