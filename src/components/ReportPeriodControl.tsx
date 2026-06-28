import { localDateOnly } from '../lib/utils'
import {
  REPORT_PRESETS,
  presetRange,
  reportPeriodLabel,
  type ReportPeriod,
  type ReportPreset,
} from '../lib/reportPeriod'

/**
 * The shared "Report period" control: a preset <select> plus From / To date
 * inputs. Fully presentational — value in, change out — with no app-context
 * coupling, so a future client-report feature can drive it the same way the
 * Time / Timesheet / Board / Checklists views do.
 *
 * For a non-custom preset the From/To inputs are read-only and show the derived
 * bounds; picking a preset recomputes them from today. Choosing "Custom"
 * unlocks From/To; editing either keeps preset='custom' and guards from<=to by
 * clamping the OTHER end to the edited value (so the range never inverts).
 */
export function ReportPeriodControl({
  value,
  onChange,
  className,
  idPrefix = 'report-period',
}: {
  value: ReportPeriod
  onChange: (period: ReportPeriod) => void
  className?: string
  idPrefix?: string
}) {
  const today = localDateOnly()
  const isCustom = value.preset === 'custom'
  const fromId = `${idPrefix}-from`
  const toId = `${idPrefix}-to`

  const handlePreset = (preset: ReportPreset) => {
    if (preset === 'custom') {
      // Keep the current bounds as the starting custom range so the inputs
      // don't jump when the user switches to fine-tune them.
      onChange({ preset: 'custom', from: value.from, to: value.to })
      return
    }
    const { from, to } = presetRange(preset, today)
    onChange({ preset, from, to })
  }

  const handleFrom = (from: string) => {
    if (!from) return
    // Guard from <= to: pushing `from` past `to` drags `to` along with it.
    const to = from > value.to ? from : value.to
    onChange({ preset: 'custom', from, to })
  }

  const handleTo = (to: string) => {
    if (!to) return
    // Guard from <= to: pulling `to` before `from` drags `from` back with it.
    const from = to < value.from ? to : value.from
    onChange({ preset: 'custom', from, to })
  }

  return (
    <div
      className={className ? `report-period ${className}` : 'report-period'}
      role="group"
      aria-label="Report period"
    >
      <span className="report-period-label">Report period</span>
      <select
        className="report-period-select"
        aria-label="Report period preset"
        value={value.preset}
        onChange={(event) => handlePreset(event.target.value as ReportPreset)}
      >
        {REPORT_PRESETS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      <span className="report-period-dates">
        <label className="report-period-field" htmlFor={fromId}>
          <span className="report-period-field-label">From</span>
          <input
            id={fromId}
            className="report-period-input"
            type="date"
            aria-label="Report period from"
            value={value.from}
            max={value.to || undefined}
            disabled={!isCustom}
            onChange={(event) => handleFrom(event.target.value)}
          />
        </label>
        <span className="report-period-sep" aria-hidden="true">
          –
        </span>
        <label className="report-period-field" htmlFor={toId}>
          <span className="report-period-field-label">To</span>
          <input
            id={toId}
            className="report-period-input"
            type="date"
            aria-label="Report period to"
            value={value.to}
            min={value.from || undefined}
            disabled={!isCustom}
            onChange={(event) => handleTo(event.target.value)}
          />
        </label>
      </span>

      {!isCustom ? (
        <span className="report-period-readout">{reportPeriodLabel(value)}</span>
      ) : null}
    </div>
  )
}
