import { fireEvent, render, screen } from '@testing-library/react'
import { act, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { defaultProposalPricing, sanitizeProposalPricing } from '../../lib/proposal-pricing.js'
import { ProposalPricingSection } from '../pages/SettingsPage'
import { DEFAULT_FIRM_SETTINGS, type FirmSettings, type ProposalPricing } from '../lib/types'

/**
 * The Settings page's "Proposal pricing" section (featreq-311473e2, spec §4.1).
 * Every edit hands the WHOLE catalog to the save, and what it hands over has to
 * survive `sanitizeProposalPricing` — the function both store backends run.
 */

function renderSection(pricing: ProposalPricing = defaultProposalPricing()) {
  const onCommit = vi.fn()
  const settings: FirmSettings = { ...DEFAULT_FIRM_SETTINGS, proposalPricing: pricing }
  render(<ProposalPricingSection settings={settings} onCommit={onCommit} />)
  return onCommit
}

/** The catalog the last save sent, after the server's sanitizer. */
function lastSaved(onCommit: ReturnType<typeof vi.fn>): ProposalPricing {
  const patch = onCommit.mock.calls.at(-1)?.[0] as Partial<FirmSettings>
  return sanitizeProposalPricing(patch.proposalPricing)
}

/**
 * Unlike `renderSection`, this feeds each save back into `settings` — the way
 * the real Settings page does via `commit()` — so a SECOND interaction sees
 * the result of the first. Needed to reproduce the two review-fix bugs, which
 * are both about what a later save builds on top of.
 */
function renderStatefulSection(pricing: ProposalPricing = defaultProposalPricing()) {
  const onCommit = vi.fn()
  function Wrapper() {
    const [settings, setSettings] = useState<FirmSettings>({
      ...DEFAULT_FIRM_SETTINGS,
      proposalPricing: pricing,
    })
    return (
      <ProposalPricingSection
        settings={settings}
        onCommit={(patch) => {
          onCommit(patch)
          setSettings((prev) => ({ ...prev, ...patch }))
        }}
      />
    )
  }
  render(<Wrapper />)
  return onCommit
}

describe('Proposal pricing in Settings', () => {
  it('says the rates are for proposals, not the team’s bill rates', () => {
    renderSection()
    expect(screen.getByText(/they are not your team’s bill rates/)).toBeTruthy()
  })

  it('saves a role rate', () => {
    const onCommit = renderSection()
    const input = screen.getByLabelText('Bookkeeper (B) rate')
    fireEvent.change(input, { target: { value: '80' } })
    fireEvent.blur(input)
    expect(lastSaved(onCommit).rates.bookkeeper).toBe(80)
  })

  it('edits a factor, and the edit round-trips through the sanitizer', () => {
    const onCommit = renderSection()
    const input = screen.getByLabelText('Factor for Monthly Weekly transactions Basic')
    fireEvent.change(input, { target: { value: '0.08' } })
    fireEvent.blur(input)
    const saved = lastSaved(onCommit)
    expect(saved.services.find((row) => row.id === 'monthly-weekly-transactions-basic')?.factor).toBe(0.08)
    expect(saved.services).toHaveLength(41)
  })

  it('retires a row without deleting it', () => {
    const onCommit = renderSection()
    fireEvent.click(screen.getByRole('button', { name: 'Retire Additional reports Budget vs actual' }))
    const saved = lastSaved(onCommit)
    const row = saved.services.find((service) => service.id === 'budget-vs-actual')
    expect(row?.active).toBe(false)
  })

  it('restores a retired row', () => {
    const pricing = defaultProposalPricing()
    pricing.services.find((row) => row.id === 'kpi-reports')!.active = false
    const onCommit = renderSection(pricing)
    fireEvent.click(screen.getByRole('button', { name: 'Restore Additional reports KPI reports' }))
    expect(lastSaved(onCommit).services.find((row) => row.id === 'kpi-reports')?.active).toBe(true)
  })

  it('adds a row to a group that the sanitizer keeps', () => {
    const onCommit = renderSection()
    fireEvent.click(screen.getByRole('button', { name: 'Add row to Payroll' }))
    const saved = lastSaved(onCommit)
    expect(saved.services).toHaveLength(42)
    const added = saved.services.at(-1)!
    expect(added).toMatchObject({ group: 'Payroll', name: 'New service', active: true })
    expect(added.id).toMatch(/^custom-/)
  })

  it('offers the Annual / One-time split only on the Annual and one-time rows', () => {
    const onCommit = renderSection()
    fireEvent.change(screen.getByLabelText('Billed for Annual and one-time Business return'), {
      target: { value: 'one-time' },
    })
    expect(lastSaved(onCommit).services.find((row) => row.id === 'business-return')?.cadence).toBe(
      'one-time',
    )
    expect(screen.queryByLabelText('Billed for Reconciliations Reconciliations')).toBeNull()
  })

  // Code review fix: `rowLabel` used to ignore `group`, so a service sharing
  // name+tier across groups (Monthly/Clean-up "Monthly transactions Basic",
  // Reconciliations/Clean-up "Reconciliations") produced duplicate aria-labels.
  it('gives every row a group-qualified label, even when two groups share a service name', () => {
    renderSection()
    expect(screen.getByLabelText('Factor for Clean-up Reconciliations')).toBeTruthy()
    expect(screen.getByLabelText('Factor for Reconciliations Reconciliations')).toBeTruthy()
    expect(screen.getByLabelText('Factor for Monthly Monthly transactions Basic')).toBeTruthy()
    expect(screen.getByLabelText('Factor for Clean-up Monthly transactions Basic')).toBeTruthy()
  })

  // Code review fix: a new row's id was `custom-${Date.now().toString(36)}`,
  // which can collide when Add row is double-clicked (same millisecond). Each
  // click's save has to build on the PRIOR save's result (renderStatefulSection),
  // or the second click would just re-add "row 42" on top of the original 41
  // and never expose a collision either way.
  it('gives two quick Add-row clicks distinct ids', () => {
    const onCommit = renderStatefulSection()
    const addButton = screen.getByRole('button', { name: 'Add row to Payroll' })
    fireEvent.click(addButton)
    fireEvent.click(addButton)
    const saved = lastSaved(onCommit)
    expect(saved.services).toHaveLength(43)
    const added = saved.services.slice(-2)
    expect(added[0]!.id).not.toBe(added[1]!.id)
    expect(added[0]!.id).toMatch(/^custom-/)
    expect(added[1]!.id).toMatch(/^custom-/)
  })

  // Code review fix: every save used to build from a per-render `pricing`
  // const, so two edits inside the 700ms debounce window overwrote each other
  // — the second save dropped the first edit. `pricingRef` fixes it: both
  // rates must survive once both debounces have fired. The two edits are
  // spaced 300ms apart (both still inside the OTHER field's own 700ms window)
  // so the bookkeeper save, and the re-render it causes, lands BEFORE the
  // accountant field's own debounce fires and builds its save.
  it('keeps both edits when two rates are changed inside the debounce window', async () => {
    vi.useFakeTimers()
    try {
      const onCommit = vi.fn()
      function Wrapper() {
        const [settings, setSettings] = useState<FirmSettings>({
          ...DEFAULT_FIRM_SETTINGS,
          proposalPricing: defaultProposalPricing(),
        })
        return (
          <ProposalPricingSection
            settings={settings}
            onCommit={(patch) => {
              onCommit(patch)
              setSettings((prev) => ({ ...prev, ...patch }))
            }}
          />
        )
      }
      render(<Wrapper />)
      fireEvent.change(screen.getByLabelText('Bookkeeper (B) rate'), { target: { value: '75' } })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300)
      })
      fireEvent.change(screen.getByLabelText('Accountant (A) rate'), { target: { value: '95' } })
      // Two separate act() scopes, so React commits the bookkeeper save (and
      // re-renders with it) BEFORE the accountant field's own timer — due
      // 300ms later — gets to fire.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400)
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300)
      })
      const saved = lastSaved(onCommit)
      expect(saved.rates.bookkeeper).toBe(75)
      expect(saved.rates.accountant).toBe(95)
    } finally {
      vi.useRealTimers()
    }
  })

  // featreq-311473e2 pt 2: standard values (Brittany's sheet blanks - client
  // call, budget/forecast counts, payroll setup amount, tax return rate).
  it("saves an input's standard value, keyed on the input's key", () => {
    const onCommit = renderSection()
    const input = screen.getByLabelText('Standard value for transactions')
    fireEvent.change(input, { target: { value: '80' } })
    fireEvent.blur(input)
    const saved = lastSaved(onCommit)
    expect(saved.inputs.find((row) => row.key === 'transactions')?.defaultValue).toBe(80)
  })

  it("clears an input's standard value back to null", () => {
    const pricing = defaultProposalPricing()
    pricing.inputs.find((row) => row.key === 'transactions')!.defaultValue = 80
    const onCommit = renderSection(pricing)
    const input = screen.getByLabelText('Standard value for transactions')
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)
    const saved = lastSaved(onCommit)
    expect(saved.inputs.find((row) => row.key === 'transactions')?.defaultValue).toBeNull()
  })

  it("saves a flat row's standard amount", () => {
    const onCommit = renderSection()
    const input = screen.getByLabelText(
      'Standard amount for Annual and one-time Payroll setup',
    )
    fireEvent.change(input, { target: { value: '450' } })
    fireEvent.blur(input)
    const saved = lastSaved(onCommit)
    expect(saved.services.find((row) => row.id === 'payroll-setup')?.defaultAmount).toBe(450)
  })

  it("saves a per-count row's standard count, and shows neither control for a row that reads no typed figure", () => {
    const onCommit = renderSection()
    const input = screen.getByLabelText('Standard count for Annual and one-time Budget')
    fireEvent.change(input, { target: { value: '2' } })
    fireEvent.blur(input)
    const saved = lastSaved(onCommit)
    expect(saved.services.find((row) => row.id === 'budget')?.defaultQuantity).toBe(2)
    expect(
      screen.queryByLabelText('Standard amount for Reconciliations Reconciliations'),
    ).toBeNull()
    expect(
      screen.queryByLabelText('Standard count for Reconciliations Reconciliations'),
    ).toBeNull()
  })

  it('nulls a stale standard amount when a flat row stops being flat', () => {
    const pricing = defaultProposalPricing()
    pricing.services.find((row) => row.id === 'payroll-setup')!.defaultAmount = 450
    const onCommit = renderSection(pricing)
    fireEvent.change(
      screen.getByLabelText('Pricing for Annual and one-time Payroll setup'),
      { target: { value: 'formula' } },
    )
    const saved = lastSaved(onCommit)
    expect(saved.services.find((row) => row.id === 'payroll-setup')?.defaultAmount).toBeNull()
  })

  it('nulls a stale standard count when a per-count row stops being per-count', () => {
    const pricing = defaultProposalPricing()
    pricing.services.find((row) => row.id === 'budget')!.defaultQuantity = 2
    const onCommit = renderSection(pricing)
    fireEvent.change(
      screen.getByLabelText('Multiplier for Annual and one-time Budget'),
      { target: { value: 'none' } },
    )
    const saved = lastSaved(onCommit)
    expect(saved.services.find((row) => row.id === 'budget')?.defaultQuantity).toBeNull()
  })

  it('warns beside a $0 rate and nowhere else', () => {
    renderSection({ ...defaultProposalPricing(), rates: { bookkeeper: 75, accountant: 0, controller: 125 } })
    const warnings = screen.getAllByText(/Proposal rate not set/)
    expect(warnings).toHaveLength(1)
    expect(warnings[0].closest('label')?.textContent).toContain('Accountant (A) rate')
  })

  it('shows no rate warning at the confirmed seed rates', () => {
    renderSection()
    expect(screen.queryByText(/Proposal rate not set/)).toBeNull()
  })

  it('shows the standard-values hint under the section', () => {
    renderSection()
    expect(
      screen.getByText(
        "Input standards fill in a new proposal; a row's standard fills in when you first pick it.",
      ),
    ).toBeTruthy()
  })
})
