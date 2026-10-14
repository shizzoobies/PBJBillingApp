import { useEffect, useState } from 'react'
import { ApiError, type EngagementParty } from '../../lib/types'

/** One address, the way the client form checks it (no spaces, one @, a dot after it). */
const EMAIL_SHAPE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/

export type AddressedToFields = Pick<EngagementParty, 'contactName' | 'email' | 'company'>

/**
 * "Addressed to": the name, email and company a letter with no client yet goes to (a
 * prospect's engagement). The editor has no other way to change them - a client's
 * details live on the client page, so the card is not shown once the letter has one.
 * Save sends only these three party fields; `onSave` throws to show its message.
 * The parent keys it on the stored values, so a fresh read starts it clean.
 */
export function AddressedTo({
  party,
  disabled,
  onSave,
  onDirtyChange,
  resetToken,
}: {
  party: EngagementParty
  disabled: boolean
  onSave: (fields: AddressedToFields) => Promise<void>
  onDirtyChange: (dirty: boolean) => void
  /** Changes when the page re-reads the letter (Reload): a failure shown before it is stale and goes. */
  resetToken: number
}) {
  const [contactName, setContactName] = useState(party.contactName ?? '')
  const [email, setEmail] = useState(party.email ?? '')
  const [company, setCompany] = useState(party.company ?? '')
  const [saving, setSaving] = useState(false)
  // The failure, with the token it happened under: shown only while that is still the page's token.
  const [failure, setFailure] = useState<{ message: string; token: number } | null>(null)
  const error = failure && failure.token === resetToken ? failure.message : ''

  const dirty =
    contactName !== (party.contactName ?? '') || email !== (party.email ?? '') || company !== (party.company ?? '')
  // A letter with no address cannot be sent or signed sensibly, so the email is required.
  const emailBlank = email.trim() === ''
  const emailProblem = !emailBlank && !EMAIL_SHAPE.test(email.trim())

  // Tell the page, so Preview, Send and Mark as signed wait for the save like the text does.
  useEffect(() => {
    onDirtyChange(dirty)
  }, [dirty, onDirtyChange])
  const change = (setter: (value: string) => void) => (event: { target: { value: string } }) => {
    setter(event.target.value)
    setFailure(null)
  }

  const save = async () => {
    if (emailProblem || emailBlank) return
    setSaving(true)
    setFailure(null)
    try {
      await onSave({ contactName: contactName.trim(), email: email.trim(), company: company.trim() })
    } catch (err) {
      setFailure({
        message: err instanceof ApiError ? err.message : 'Could not save who the letter is addressed to.',
        token: resetToken,
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="panel" role="group" aria-label="Addressed to">
      <h3>Addressed to</h3>
      <p className="muted-text">
        Who the letter goes to. The email is where Send addresses it; the name and company fill the letter&apos;s
        placeholders.
      </p>
      <label className="field">
        <span>Name</span>
        <input
          className="input"
          type="text"
          maxLength={200}
          aria-label="Addressed to name"
          disabled={disabled}
          value={contactName}
          onChange={change(setContactName)}
        />
      </label>
      <label className="field">
        <span>Email</span>
        <input
          className="input"
          type="email"
          maxLength={320}
          aria-label="Addressed to email"
          disabled={disabled}
          value={email}
          onChange={change(setEmail)}
        />
      </label>
      {emailProblem ? (
        <p className="form-error" role="alert">
          Type one email address, like name@company.com.
        </p>
      ) : null}
      {emailBlank ? (
        <p className="form-error" role="alert">
          The letter needs an email address to go to.
        </p>
      ) : null}
      <label className="field">
        <span>Company</span>
        <input
          className="input"
          type="text"
          maxLength={200}
          aria-label="Addressed to company"
          disabled={disabled}
          value={company}
          onChange={change(setCompany)}
        />
      </label>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="button-row">
        <button
          type="button"
          className="secondary-action"
          disabled={disabled || !dirty || saving || emailProblem || emailBlank}
          onClick={() => void save()}
        >
          Save address
        </button>
      </div>
    </div>
  )
}
