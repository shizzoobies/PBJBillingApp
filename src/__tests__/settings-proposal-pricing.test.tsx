import { fireEvent, render, screen } from '@testing-library/react'
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

describe('Proposal pricing in Settings', () => {
  it('says the rates are for proposals, not the team’s bill rates', () => {
    renderSection()
    expect(screen.getByText(/they are not your team’s bill rates/)).toBeTruthy()
  })

  it('saves a role rate', () => {
    const onCommit = renderSection()
    const input = screen.getByLabelText('Bookkeeper (B) rate')
    fireEvent.change(input, { target: { value: '75' } })
    fireEvent.blur(input)
    expect(lastSaved(onCommit).rates.bookkeeper).toBe(75)
  })

  it('edits a factor, and the edit round-trips through the sanitizer', () => {
    const onCommit = renderSection()
    const input = screen.getByLabelText('Factor for Weekly transactions Basic')
    fireEvent.change(input, { target: { value: '0.08' } })
    fireEvent.blur(input)
    const saved = lastSaved(onCommit)
    expect(saved.services.find((row) => row.id === 'monthly-weekly-transactions-basic')?.factor).toBe(0.08)
    expect(saved.services).toHaveLength(41)
  })

  it('retires a row without deleting it', () => {
    const onCommit = renderSection()
    fireEvent.click(screen.getByRole('button', { name: 'Retire Budget vs actual' }))
    const saved = lastSaved(onCommit)
    const row = saved.services.find((service) => service.id === 'budget-vs-actual')
    expect(row?.active).toBe(false)
  })

  it('restores a retired row', () => {
    const pricing = defaultProposalPricing()
    pricing.services.find((row) => row.id === 'kpi-reports')!.active = false
    const onCommit = renderSection(pricing)
    fireEvent.click(screen.getByRole('button', { name: 'Restore KPI reports' }))
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
    fireEvent.change(screen.getByLabelText('Billed for Business return'), {
      target: { value: 'one-time' },
    })
    expect(lastSaved(onCommit).services.find((row) => row.id === 'business-return')?.cadence).toBe(
      'one-time',
    )
    expect(screen.queryByLabelText('Billed for Reconciliations')).toBeNull()
  })
})
