import { useState } from 'react'
import type { LetterPlaceholderInfo } from '../../lib/types'

/** The placeholder chips and the B button every letter editor shares (helpers in ./letterEditing). */

/** One chip per placeholder; a click inserts it into the named box. */
export function PlaceholderChips({
  placeholders,
  fieldWord,
  onInsert,
  disabled = false,
}: {
  placeholders: ReadonlyArray<LetterPlaceholderInfo>
  /** "subject", "email", "letter", "section body"... for the group's label. */
  fieldWord: string
  onInsert: (key: string) => void
  disabled?: boolean
}) {
  return (
    <div className="letters-chips" role="group" aria-label={`Insert a placeholder into the ${fieldWord}`}>
      {placeholders.map((placeholder) => (
        <button
          key={placeholder.key}
          type="button"
          className="letters-chip"
          title={placeholder.description}
          disabled={disabled || undefined}
          onClick={() => onInsert(placeholder.key)}
        >
          {`{{${placeholder.key}}}`}
        </button>
      ))}
    </div>
  )
}

/**
 * The chips folded behind a small "Placeholders (N)" toggle, closed by default: the
 * engagement list is long, and three boxes of it at once buried the letter.
 */
export function PlaceholderChipsToggle({
  placeholders,
  fieldWord,
  onInsert,
}: {
  placeholders: ReadonlyArray<LetterPlaceholderInfo>
  fieldWord: string
  onInsert: (key: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="letters-chips-toggle">
      <button
        type="button"
        className="ghost-action letters-chips-button"
        aria-expanded={open}
        aria-label={`Placeholders for the ${fieldWord} (${placeholders.length})`}
        onClick={() => setOpen((value) => !value)}
      >
        {`Placeholders (${placeholders.length})`}
      </button>
      {open ? <PlaceholderChips placeholders={placeholders} fieldWord={fieldWord} onInsert={onInsert} /> : null}
    </div>
  )
}

/** The B button above a body box. */
export function BoldBar({
  fieldWord,
  disabled,
  onBold,
}: {
  fieldWord: string
  disabled: boolean
  onBold: () => void
}) {
  return (
    <div className="letters-format" role="toolbar" aria-label={`Format the ${fieldWord}`}>
      <button
        type="button"
        aria-label={`Bold in the ${fieldWord}`}
        title="Bold (Ctrl+B): puts ** around the selected words"
        disabled={disabled}
        // Keep the selection in the box: a click would otherwise move the focus first.
        onMouseDown={(event) => event.preventDefault()}
        onClick={onBold}
      >
        B
      </button>
    </div>
  )
}

