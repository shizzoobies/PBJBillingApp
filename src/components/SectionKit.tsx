import { Check, ChevronDown, ChevronRight, Lock, Pencil } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useSaveFlash, type SaveFlashState } from '../lib/useSaveFlash'

/* -------------------------------------------------------------------------- */
/* Per-field save confirmation                                                */
/* -------------------------------------------------------------------------- */

export function SaveBadge({ state }: { state: SaveFlashState }) {
  if (state === 'idle') return null
  if (state === 'saving') {
    return <span className="save-badge save-badge-saving">Saving…</span>
  }
  if (state === 'saved') {
    return (
      <span className="save-badge save-badge-saved">
        <Check size={11} /> Saved
      </span>
    )
  }
  return <span className="save-badge save-badge-error">Couldn’t save</span>
}

/* -------------------------------------------------------------------------- */
/* Collapsible + (optionally) lockable section                                */
/* -------------------------------------------------------------------------- */

/**
 * Wraps a settings panel with two conveniences:
 *  - Collapse: every section can be collapsed (expanded by default).
 *  - Lock: editable sections start UNLOCKED (open / editable). The owner can
 *    click "Lock" to protect a section from accidental edits, then "Edit" to
 *    unlock again. When locked, the body is rendered `inert` so every control
 *    inside is non-interactive without threading `disabled` everywhere.
 */
export function CollapsibleSection({
  kicker,
  title,
  headerAction,
  lockable = false,
  defaultCollapsed = false,
  defaultLocked = false,
  bodyClassName,
  children,
}: {
  kicker?: string
  title: string
  headerAction?: ReactNode
  lockable?: boolean
  defaultCollapsed?: boolean
  defaultLocked?: boolean
  bodyClassName?: string
  children: ReactNode
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  const [locked, setLocked] = useState(defaultLocked)

  return (
    <section className={`panel client-section${collapsed ? ' collapsed' : ''}`}>
      <div className="section-heading client-section-heading">
        <button
          type="button"
          className="section-collapse-btn"
          aria-expanded={!collapsed}
          aria-label={collapsed ? `Expand ${title}` : `Collapse ${title}`}
          title={collapsed ? 'Expand section' : 'Collapse section'}
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? <ChevronRight size={18} /> : <ChevronDown size={18} />}
        </button>
        <div className="client-section-title">
          {kicker ? <p className="section-kicker">{kicker}</p> : null}
          <h2>{title}</h2>
        </div>
        <div className="client-section-actions">
          {headerAction}
          {lockable ? (
            <button
              type="button"
              className={`section-lock-btn${locked ? '' : ' unlocked'}`}
              onClick={() => setLocked((value) => !value)}
              title={locked ? 'Unlock to edit these fields' : 'Lock to prevent accidental edits'}
            >
              {locked ? (
                <>
                  <Pencil size={13} /> Edit
                </>
              ) : (
                <>
                  <Lock size={13} /> Lock
                </>
              )}
            </button>
          ) : null}
        </div>
      </div>
      {collapsed ? null : (
        <div
          className={`client-section-body${lockable && locked ? ' locked' : ''}${
            bodyClassName ? ` ${bodyClassName}` : ''
          }`}
          inert={lockable && locked ? true : undefined}
        >
          {lockable && locked ? (
            <p className="section-locked-hint">
              <Lock size={12} /> Locked — click <strong>Edit</strong> to make changes.
            </p>
          ) : null}
          {children}
        </div>
      )}
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/* Low-level inputs: commit on debounce + Enter + blur, resync when idle        */
/* -------------------------------------------------------------------------- */

// Commit shortly after typing stops (in addition to blur + Enter) so a value
// reliably saves even if the field is left without an explicit blur (e.g. a
// quick refresh or navigation). Resyncs to the canonical value when it changes
// upstream AND the field isn't being actively edited.
const COMMIT_DEBOUNCE_MS = 700

export function SavingTextInput({
  canonical,
  onCommit,
  placeholder,
  type = 'text',
  className = 'input',
  ariaLabel,
}: {
  canonical: string
  onCommit: (value: string) => void
  placeholder?: string
  type?: string
  className?: string
  ariaLabel?: string
}) {
  const [draft, setDraft] = useState(canonical)
  const [prev, setPrev] = useState(canonical)
  const [focused, setFocused] = useState(false)
  const timerRef = useRef<number | null>(null)

  if (canonical !== prev) {
    setPrev(canonical)
    if (!focused) setDraft(canonical)
  }

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current)
    }
  }, [])

  const fire = (value: string) => {
    if (value !== canonical) onCommit(value)
  }

  return (
    <input
      aria-label={ariaLabel}
      className={className}
      type={type}
      placeholder={placeholder}
      value={draft}
      onFocus={() => setFocused(true)}
      onChange={(event) => {
        const next = event.target.value
        setDraft(next)
        if (timerRef.current) window.clearTimeout(timerRef.current)
        timerRef.current = window.setTimeout(() => fire(next), COMMIT_DEBOUNCE_MS)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
      }}
      onBlur={() => {
        setFocused(false)
        if (timerRef.current) window.clearTimeout(timerRef.current)
        fire(draft)
      }}
    />
  )
}

export function SavingTextarea({
  canonical,
  onCommit,
  rows = 3,
  placeholder,
  ariaLabel,
  className = 'input',
}: {
  canonical: string
  onCommit: (value: string) => void
  rows?: number
  placeholder?: string
  ariaLabel?: string
  className?: string
}) {
  const [draft, setDraft] = useState(canonical)
  const [prev, setPrev] = useState(canonical)
  const [focused, setFocused] = useState(false)
  const timerRef = useRef<number | null>(null)

  if (canonical !== prev) {
    setPrev(canonical)
    if (!focused) setDraft(canonical)
  }

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current)
    }
  }, [])

  const fire = (value: string) => {
    if (value !== canonical) onCommit(value)
  }

  return (
    <textarea
      aria-label={ariaLabel}
      className={className}
      rows={rows}
      placeholder={placeholder}
      value={draft}
      onFocus={() => setFocused(true)}
      onChange={(event) => {
        const next = event.target.value
        setDraft(next)
        if (timerRef.current) window.clearTimeout(timerRef.current)
        timerRef.current = window.setTimeout(() => fire(next), COMMIT_DEBOUNCE_MS)
      }}
      onBlur={() => {
        setFocused(false)
        if (timerRef.current) window.clearTimeout(timerRef.current)
        fire(draft)
      }}
    />
  )
}

export function SavingNumberInput({
  canonical,
  min,
  step,
  placeholder,
  onCommit,
  className = 'input',
  ariaLabel,
}: {
  canonical: number | null
  min?: string
  step?: string
  placeholder?: string
  onCommit: (value: number | null) => void
  className?: string
  ariaLabel?: string
}) {
  const [draft, setDraft] = useState(canonical === null ? '' : String(canonical))
  const [prev, setPrev] = useState(canonical)
  const [focused, setFocused] = useState(false)
  const timerRef = useRef<number | null>(null)

  if (canonical !== prev) {
    setPrev(canonical)
    if (!focused) setDraft(canonical === null ? '' : String(canonical))
  }

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current)
    }
  }, [])

  const fire = (raw: string) => {
    const trimmed = raw.trim()
    if (trimmed === '') {
      if (canonical !== null) onCommit(null)
      return
    }
    const parsed = Number(trimmed)
    if (Number.isNaN(parsed)) return
    if (parsed !== canonical) onCommit(parsed)
  }

  return (
    <input
      aria-label={ariaLabel}
      className={className}
      min={min ?? '0'}
      step={step ?? '0.01'}
      type="number"
      placeholder={placeholder}
      value={draft}
      onFocus={() => setFocused(true)}
      onChange={(event) => {
        const next = event.target.value
        setDraft(next)
        if (timerRef.current) window.clearTimeout(timerRef.current)
        timerRef.current = window.setTimeout(() => fire(next), COMMIT_DEBOUNCE_MS)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
      }}
      onBlur={() => {
        setFocused(false)
        if (timerRef.current) window.clearTimeout(timerRef.current)
        const trimmed = draft.trim()
        if (trimmed === '') {
          if (canonical !== null) onCommit(null)
          return
        }
        const parsed = Number(trimmed)
        if (Number.isNaN(parsed)) {
          setDraft(canonical === null ? '' : String(canonical))
          return
        }
        if (parsed !== canonical) onCommit(parsed)
      }}
    />
  )
}

/* -------------------------------------------------------------------------- */
/* Field wrappers (label + per-field Saved badge + control)                   */
/* -------------------------------------------------------------------------- */

export function SaveTextField({
  label,
  helper,
  onCommit,
  placeholder,
  type,
  value,
  fullRow,
}: {
  label: string
  helper?: string
  onCommit: (value: string) => void
  placeholder?: string
  type?: string
  value: string
  fullRow?: boolean
}) {
  const { state, flash } = useSaveFlash()
  return (
    <label className={`field${fullRow ? ' full-row' : ''}`}>
      <span className="field-label-row">
        {label}
        <SaveBadge state={state} />
      </span>
      <SavingTextInput
        canonical={value}
        onCommit={(next) => {
          onCommit(next)
          flash()
        }}
        placeholder={placeholder}
        type={type}
      />
      {helper ? <small className="field-helper">{helper}</small> : null}
    </label>
  )
}

export function SaveTextareaField({
  label,
  helper,
  onCommit,
  value,
  rows,
}: {
  label: string
  helper?: string
  onCommit: (value: string) => void
  value: string
  rows?: number
}) {
  const { state, flash } = useSaveFlash()
  return (
    <label className="field full-row">
      <span className="field-label-row">
        {label}
        <SaveBadge state={state} />
      </span>
      <SavingTextarea
        canonical={value}
        rows={rows}
        onCommit={(next) => {
          onCommit(next)
          flash()
        }}
      />
      {helper ? <small className="field-helper">{helper}</small> : null}
    </label>
  )
}

export function SaveNumberField({
  label,
  helper,
  min,
  step,
  value,
  onCommit,
}: {
  label: string
  helper?: string
  min?: string
  step?: string
  // Accepts null so the field can be cleared (the input shows blank for a
  // null value).
  value: number | null
  // Receives null when the field is cleared — callers decide whether that
  // means 0, undefined, etc. for their specific field.
  onCommit: (value: number | null) => void
}) {
  const { state, flash } = useSaveFlash()
  return (
    <label className="field">
      <span className="field-label-row">
        {label}
        <SaveBadge state={state} />
      </span>
      <SavingNumberInput
        canonical={value}
        min={min}
        step={step}
        onCommit={(next) => {
          onCommit(next)
          flash()
        }}
      />
      {helper ? <small className="field-helper">{helper}</small> : null}
    </label>
  )
}

export function SaveSelectField({
  label,
  value,
  options,
  onCommit,
}: {
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  onCommit: (value: string) => void
}) {
  const { state, flash } = useSaveFlash()
  return (
    <label className="field">
      <span className="field-label-row">
        {label}
        <SaveBadge state={state} />
      </span>
      <select
        className="input"
        value={value}
        onChange={(event) => {
          onCommit(event.target.value)
          flash()
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}

export function SaveToggleField({
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
  const { state, flash } = useSaveFlash()
  return (
    <label className="field toggle-field">
      <span className="toggle-label">
        <input
          checked={checked}
          onChange={(event) => {
            onChange(event.target.checked)
            flash()
          }}
          type="checkbox"
        />
        <strong>{label}</strong>
        <SaveBadge state={state} />
      </span>
      <small className="field-helper">{description}</small>
    </label>
  )
}
