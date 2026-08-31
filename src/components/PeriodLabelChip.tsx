/**
 * The period a task's work covers, shown beside its title — featreq-81429ad1.
 *
 * Brittany asked for it "next to the title", and for it to be "purely a label
 * not to change anything we have already done". So this component does exactly
 * one thing and returns null the rest of the time: most tasks carry no label,
 * and an absent one has to render as NOTHING — not an empty chip, not a dash.
 *
 * It is deliberately its own component rather than three copies of a span, so
 * the label looks identical everywhere it appears and there is one place to
 * change if she wants it to read differently.
 */
export function PeriodLabelChip({ label }: { label?: string | null }) {
  const text = typeof label === 'string' ? label.trim() : ''
  if (!text) return null
  return (
    <span className="period-label-chip" title={`Covers ${text}`}>
      {text}
    </span>
  )
}
