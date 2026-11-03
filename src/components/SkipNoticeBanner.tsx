import { useState } from 'react'
import { skipNoticeLine, type SkipNotice } from '../../lib/checklist-skip.js'

/** Longer than this and the note is cut, with Show more. */
const CLAMP_CHARS = 160

/**
 * Skip a step (featreq-7e1827e0): "Step 1 skipped by Lisa Mockabee (they could not
 * get to it): <note>" on the step the skip opened, under the card's meta line - the
 * same quiet place "Pushed · was ..." sits. A long note is clamped with Show more.
 */
export function SkipNoticeBanner({ notice }: { notice: SkipNotice | null | undefined }) {
  const [expanded, setExpanded] = useState(false)
  if (!notice) return null
  const line = skipNoticeLine(notice)
  const long = line.length > CLAMP_CHARS
  const shown = long && !expanded ? `${line.slice(0, CLAMP_CHARS).trimEnd()}…` : line
  return (
    <span className="checklist-meta-line checklist-skip-notice" role="note">
      {shown}
      {long ? (
        <button type="button" className="link-button" onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </span>
  )
}
