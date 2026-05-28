import { Plus, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useAppContext } from '../AppContext'
import type { Client, Contact } from '../lib/types'

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
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Shared contacts</p>
          <h2>Add contact</h2>
        </div>
      </div>
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
    </section>
  )
}

function ContactLibrary({
  contacts,
  clients,
  ownerMode,
  onUpdate,
  onDelete,
}: {
  contacts: Contact[]
  clients: Client[]
  ownerMode: boolean
  onUpdate: (contactId: string, patch: Partial<Contact>) => void
  onDelete: (contactId: string) => void
}) {
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

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Directory</p>
          <h2>Contacts</h2>
        </div>
      </div>
      <div className="plan-list">
        {contacts.length === 0 ? (
          <p className="muted-text">No contacts yet. Add one to select it on a client.</p>
        ) : null}
        {contacts.map((contact) => {
          const attachedCount = clients.filter((client) =>
            (client.contactIds ?? []).includes(contact.id),
          ).length
          return (
            <article className="plan-row" key={contact.id}>
              <div className="contact-edit-fields">
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
                {attachedCount > 0 ? (
                  <span className="checklist-meta-line">
                    On {attachedCount} client{attachedCount === 1 ? '' : 's'}
                  </span>
                ) : null}
              </div>
              {ownerMode ? (
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
            </article>
          )
        })}
      </div>
    </section>
  )
}

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
  const [draft, setDraft] = useState(canonical)
  return (
    <input
      aria-label={ariaLabel}
      className="input"
      placeholder={placeholder}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== canonical) {
          onCommit(draft)
        }
      }}
    />
  )
}
