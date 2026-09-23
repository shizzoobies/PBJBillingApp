import { useState } from 'react'
import { formatProposalMoney } from '../../../lib/proposal-pricing.js'
import { SavingNumberInput, SavingTextarea, SavingTextInput } from '../SectionKit'
import {
  PROPOSAL_TOTAL_LABELS,
  pickerGroups,
  selectService,
  updateSelection,
  withInput,
  type PickerRow,
  type ProposalPatchBuilder,
} from '../../lib/proposals'
import type {
  PayrollRun,
  Proposal,
  ProposalPricing,
  ProposalProspect,
  ProposalSelection,
  ProposalService,
} from '../../lib/types'

const PROSPECT_FIELDS: Array<[Exclude<keyof ProposalProspect, 'notes'>, string]> = [
  ['company', 'Company'],
  ['contactName', 'Contact'],
  ['email', 'Email'],
  ['phone', 'Phone'],
]

// The multipliers whose factor comes from a typed count rather than the
// catalog's role rate math. 'per-count' (budget / forecast) never falls back
// to an input — landed fix pass, lib/proposal-pricing.js `multiplierOf`.
const PER_COUNT_MULTIPLIERS = new Set(['per-form', 'per-report', 'per-cleanup-month', 'per-count'])

// A short note for each flag the calculator can put on a line (landed fix
// pass to lib/proposal-pricing.js `priceLine` / `priceProposal`). 'retired'
// is left out — the line's own formula already says so (review M4).
const FLAG_NOTES: Record<string, string> = {
  'needs-count': 'needs a count',
  'invalid-input': 'invalid input — priced at $0.00',
  'unknown-input': 'names an input the catalog no longer has',
}

const serviceLabel = (service: Pick<ProposalService, 'name' | 'tier'>) =>
  service.tier ? `${service.name} ${service.tier}` : service.name

/** A negative override or quantity is not a price — treat it like blank (review M2). */
const nonNegative = (value: number | null): number | null => (value !== null && value < 0 ? null : value)

/**
 * A `SavingNumberInput` for a count/amount field that must never hold a
 * negative value. `SavingNumberInput` only resets its own draft text when its
 * `canonical` prop actually changes — but a rejected negative commit maps to
 * `null`, which the canonical often already was, so nothing would change and
 * the field would keep showing what she typed (e.g. "-3"). Bumping a local
 * key on rejection remounts the input so its draft reinitializes from
 * `canonical` instead (fix batch 2, E-e).
 */
function NonNegativeNumberInput({
  ariaLabel,
  canonical,
  placeholder,
  min,
  step,
  onCommit,
}: {
  ariaLabel: string
  canonical: number | null
  placeholder?: string
  min?: string
  step?: string
  onCommit: (value: number | null) => void
}) {
  const [resetNonce, setResetNonce] = useState(0)
  return (
    <SavingNumberInput
      key={resetNonce}
      ariaLabel={ariaLabel}
      canonical={canonical}
      placeholder={placeholder}
      min={min}
      step={step}
      onCommit={(value) => {
        if (value !== null && value < 0) setResetNonce((n) => n + 1)
        onCommit(nonNegative(value))
      }}
    />
  )
}

/**
 * The Estimate tab (spec §5.1): the prospect, the counts, the service picker,
 * and the lines the SERVER priced. Every change is a PATCH; the answer carries
 * the re-priced snapshot, so nothing on this page multiplies anything.
 *
 * `onSave` takes a BUILDER rather than a patch: it runs against the server's
 * latest confirmed proposal when its save reaches the front of the queue, not
 * against whatever this tab last rendered — so an override typed just before a
 * checkbox click can't be clobbered by it (review C1).
 */
export function EstimateTab({
  proposal,
  pricing,
  clients,
  busy,
  onSave,
  onReprice,
}: {
  proposal: Proposal
  pricing: ProposalPricing
  clients: ReadonlyArray<{ id: string; name: string }>
  busy: boolean
  onSave: (build: ProposalPatchBuilder) => void
  onReprice: () => void
}) {
  const locked = proposal.status === 'accepted' || proposal.status === 'declined'
  const snapshot = proposal.pricingSnapshot
  const saveSelections = (updater: (selections: ProposalSelection[]) => ProposalSelection[]) =>
    onSave((latest) => ({ selections: updater(latest.selections) }))

  return (
    <div className="proposal-estimate">
      <fieldset className="proposal-fieldset" disabled={locked}>
        <section className="panel">
          <h3>Prospect</h3>
          <div className="form-grid two-col">
            {PROSPECT_FIELDS.map(([field, label]) => (
              <label className="field" key={field}>
                <span>{label}</span>
                <SavingTextInput
                  ariaLabel={label}
                  canonical={proposal.prospect[field]}
                  onCommit={(value) =>
                    onSave((latest) => ({ prospect: { ...latest.prospect, [field]: value } }))
                  }
                />
              </label>
            ))}
            <label className="field">
              <span>Existing client (optional)</span>
              <select
                className="input"
                aria-label="Existing client"
                value={proposal.clientId ?? ''}
                onChange={(event) => {
                  const clientId = event.target.value || null
                  onSave(() => ({ clientId }))
                }}
              >
                <option value="">A new prospect</option>
                {clients.map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field full-row">
              <span>Notes</span>
              <SavingTextarea
                ariaLabel="Notes"
                canonical={proposal.prospect.notes}
                onCommit={(value) =>
                  onSave((latest) => ({ prospect: { ...latest.prospect, notes: value } }))
                }
              />
            </label>
          </div>
        </section>

        <section className="panel">
          <h3>What they told you</h3>
          <div className="form-grid two-col">
            {pricing.inputs.map((input) => (
              <label className="field" key={input.key}>
                <span>{input.label}</span>
                <SavingNumberInput
                  ariaLabel={input.label}
                  canonical={proposal.inputs[input.key] ?? null}
                  min="0"
                  step="1"
                  onCommit={(value) =>
                    onSave((latest) => ({ inputs: withInput(latest.inputs, input.key, value) }))
                  }
                />
              </label>
            ))}
          </div>
        </section>

        <section className="panel">
          <h3>Services</h3>
          {pickerGroups(pricing.services, proposal.selections).map(({ group, rows }) => (
            <fieldset className="proposal-picker-group" key={group}>
              <legend>{group}</legend>
              {rows.map((row) => (
                <PickerRowControl
                  key={row.key}
                  row={row}
                  selections={proposal.selections}
                  onChange={saveSelections}
                />
              ))}
            </fieldset>
          ))}
        </section>
      </fieldset>

      <section className="panel">
        <div className="section-heading">
          <h3>Estimate</h3>
          {proposal.status === 'draft' ? (
            <button type="button" className="secondary-action" disabled={busy} onClick={onReprice}>
              Reprice at today’s catalog
            </button>
          ) : null}
        </div>
        {snapshot && snapshot.lines.length > 0 ? (
          <fieldset className="proposal-fieldset" disabled={locked}>
            <div className="table-wrap">
              <table className="report-table proposal-lines">
                <tbody>
                  {snapshot.lines.map((line, index) => {
                    const label = `${line.group ?? 'Retired'}: ${serviceLabel(line)}`
                    const selection = proposal.selections.find(
                      (entry) => entry.serviceId === line.serviceId,
                    )
                    const retired = line.flag === 'retired'
                    return (
                      <tr key={line.serviceId ?? index}>
                        <td>
                          <strong>{line.tier ? `${line.name} (${line.tier})` : line.name}</strong>
                          <div className="proposal-line-formula">{line.formula}</div>
                          {line.flag && !retired ? (
                            <div className="form-error">{FLAG_NOTES[line.flag] ?? line.flag}</div>
                          ) : null}
                        </td>
                        <td className="proposal-line-amount">{formatProposalMoney(line.amount)}</td>
                        <td>
                          {retired ? (
                            <button
                              type="button"
                              className="ghost-action"
                              onClick={() =>
                                onSave((latest) => ({
                                  selections: latest.selections.filter(
                                    (entry) => entry.serviceId !== line.serviceId,
                                  ),
                                }))
                              }
                            >
                              Remove
                            </button>
                          ) : (
                            <NonNegativeNumberInput
                              ariaLabel={`Override ${label}`}
                              canonical={selection?.override ?? null}
                              placeholder="Override"
                              min="0"
                              step="0.01"
                              onCommit={(value) =>
                                saveSelections((selections) =>
                                  updateSelection(selections, line.serviceId ?? '', {
                                    override: value,
                                  }),
                                )
                              }
                            />
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </fieldset>
        ) : (
          <p className="muted-text">Pick services above and fill in the counts to price them.</p>
        )}
        <dl className="proposal-totals">
          {PROPOSAL_TOTAL_LABELS.map(([key, label]) => (
            <div key={key}>
              <dt>{label}</dt>
              <dd>{formatProposalMoney(snapshot?.totals[key] ?? 0)}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  )
}

function PickerRowControl({
  row,
  selections,
  onChange,
}: {
  row: PickerRow
  selections: readonly ProposalSelection[]
  onChange: (updater: (selections: ProposalSelection[]) => ProposalSelection[]) => void
}) {
  const chosen = row.options.find((option) =>
    selections.some((entry) => entry.serviceId === option.id),
  )
  const selection = chosen ? selections.find((entry) => entry.serviceId === chosen.id) : undefined
  const pick = (serviceId: string | null) =>
    onChange((current) => selectService(current, row.options, serviceId))
  const rowLabel = `${row.group}: ${row.name}`
  const single = row.options.length === 1 && !row.options[0].tier

  return (
    <div className="proposal-picker-row">
      {single ? (
        <label className="toggle-label">
          <input
            type="checkbox"
            aria-label={rowLabel}
            checked={Boolean(chosen)}
            // A retired option that is currently chosen stays clickable so
            // she can un-choose it; only an unchosen retired option is
            // disabled (fix batch 2, E-d).
            disabled={!row.options[0].active && !chosen}
            onChange={(event) => pick(event.target.checked ? row.options[0].id : null)}
          />
          {row.name}
          {!row.options[0].active ? <span className="proposal-retired-tag">Retired</span> : null}
        </label>
      ) : (
        <div role="radiogroup" aria-label={rowLabel} className="proposal-picker-tiers">
          <span className="proposal-picker-name">{row.name}</span>
          <label>
            <input type="radio" name={row.key} checked={!chosen} onChange={() => pick(null)} /> None
          </label>
          {row.options.map((option) => (
            <label key={option.id}>
              <input
                type="radio"
                name={row.key}
                aria-label={option.tier ?? option.name}
                checked={chosen?.id === option.id}
                disabled={!option.active}
                onChange={() => pick(option.id)}
              />{' '}
              {option.tier ?? option.name}
              {!option.active ? <span className="proposal-retired-tag">Retired</span> : null}
            </label>
          ))}
        </div>
      )}
      {chosen && selection ? (
        <SelectionFields
          service={chosen}
          selection={selection}
          onChange={(patch) => onChange((current) => updateSelection(current, chosen.id, patch))}
        />
      ) : null}
    </div>
  )
}

/** The per-row extras a service needs: a count, a typed amount, the payroll run, the review. */
function SelectionFields({
  service,
  selection,
  onChange,
}: {
  service: ProposalService
  selection: ProposalSelection
  onChange: (patch: Partial<Record<Exclude<keyof ProposalSelection, 'serviceId'>, unknown>>) => void
}) {
  const label = `${service.group}: ${serviceLabel(service)}`
  const countLabel =
    service.multiplier === 'per-count' ? 'Count (required)' : 'Count (blank uses the input)'
  return (
    <div className="proposal-picker-extras">
      {PER_COUNT_MULTIPLIERS.has(service.multiplier) ? (
        <label className="field">
          <span>{countLabel}</span>
          <NonNegativeNumberInput
            ariaLabel={`Count for ${label}`}
            canonical={selection.quantity ?? null}
            min="0"
            step="1"
            onCommit={(value) => onChange({ quantity: value })}
          />
        </label>
      ) : null}
      {service.pricing === 'flat' ? (
        <label className="field">
          <span>Amount</span>
          <NonNegativeNumberInput
            ariaLabel={`Amount for ${label}`}
            canonical={selection.flatAmount ?? null}
            min="0"
            step="0.01"
            onCommit={(value) => onChange({ flatAmount: value })}
          />
        </label>
      ) : null}
      {service.pricing === 'payroll' ? (
        <>
          <label className="field">
            <span>Payroll run</span>
            <select
              className="input"
              aria-label={`Payroll run for ${label}`}
              value={selection.payrollRun ?? 'monthly'}
              onChange={(event) => onChange({ payrollRun: event.target.value as PayrollRun })}
            >
              <option value="weekly">Weekly</option>
              <option value="biweekly">Bi-weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </label>
          <label className="toggle-label">
            <input
              type="checkbox"
              aria-label={`Include bonus for ${label}`}
              checked={selection.includeBonus === true}
              onChange={(event) => onChange({ includeBonus: event.target.checked })}
            />
            Include bonus
          </label>
        </>
      ) : null}
      {service.pricing === 'sales-tax' ? (
        <label className="toggle-label">
          <input
            type="checkbox"
            aria-label={`Include the review for ${service.name}`}
            checked={selection.includeReview === true}
            onChange={(event) => onChange({ includeReview: event.target.checked })}
          />
          Include the review
        </label>
      ) : null}
    </div>
  )
}
