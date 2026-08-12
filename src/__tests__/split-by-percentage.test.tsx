import { fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { GroupSplitModal } from '../pages/TimePage'
import type { Client, TimeEntry } from '../lib/types'

/**
 * Splitting BY PERCENTAGE. The firm's complaint was that dividing a block meant
 * typing a number of minutes per client and doing the arithmetic yourself, so
 * the modal now leads with "Evenly" and "By percentage" — exact minutes is still
 * there (an adjustment reopens on it, and a seconds-precision correction can
 * only be said in minutes), just demoted.
 *
 * A percentage split is saved as an ordinary CUSTOM split: the percentages are
 * converted to exact seconds here and the server re-checks that they account for
 * every second of the block. These tests pin that hand-off.
 */

const CLIENTS = [
  { id: 'client-1', name: 'Acme Dental' },
  { id: 'client-2', name: 'Bright Books' },
] as Client[]

const ENTRY = {
  id: 'time-1',
  employeeId: 'emp-me',
  clientId: 'client-1',
  date: '2026-08-12',
  minutes: 60,
  description: 'Quarter-end review.',
  billable: true,
} as TimeEntry

type SplitModalProps = ComponentProps<typeof GroupSplitModal>

function renderSplit(overrides: { entry?: TimeEntry; groupSlices?: TimeEntry[] } = {}) {
  const onSplit = vi.fn<SplitModalProps['onSplit']>().mockResolvedValue(undefined)
  const onAdjust = vi.fn<SplitModalProps['onAdjust']>().mockResolvedValue(undefined)
  render(
    <GroupSplitModal
      entry={overrides.entry ?? ENTRY}
      groupSlices={overrides.groupSlices ?? []}
      clients={CLIENTS}
      billableClients={CLIENTS}
      onSplit={onSplit}
      onAdjust={onAdjust}
      onClose={vi.fn()}
    />,
  )
  return { onSplit, onAdjust }
}

const byPercentage = () => screen.getByRole('radio', { name: /by percentage/i })
const percentBox = (name: string) => screen.getByLabelText(`${name} percentage`)
const confirmButton = () => screen.getByRole('button', { name: /split & bill|save split/i })

/** Tick the second client so there is something to split across. */
function addBrightBooks() {
  fireEvent.click(screen.getByRole('checkbox', { name: 'Bright Books' }))
}

describe('splitting by percentage', () => {
  it('offers Evenly and By percentage, with exact minutes demoted but present', () => {
    renderSplit()
    expect(screen.getByRole('radio', { name: /evenly/i })).toBeChecked()
    expect(byPercentage()).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /exact minutes/i })).toBeInTheDocument()
    // 'full' is a different billing semantic and is untouched.
    expect(screen.getByRole('radio', { name: /full duration to each/i })).toBeInTheDocument()
  })

  it('opens on an even percentage each and shows what that means in time', () => {
    renderSplit()
    addBrightBooks()
    fireEvent.click(byPercentage())

    expect(percentBox('Acme Dental')).toHaveValue(50)
    expect(percentBox('Bright Books')).toHaveValue(50)
    expect(screen.getAllByText('30m')).toHaveLength(2)
    expect(screen.getByText(/adds up to 100%/i)).toBeInTheDocument()
  })

  it('converts the percentages to exact minutes and submits a custom split', async () => {
    const { onSplit } = renderSplit()
    addBrightBooks()
    fireEvent.click(byPercentage())

    fireEvent.change(percentBox('Acme Dental'), { target: { value: '70' } })
    fireEvent.change(percentBox('Bright Books'), { target: { value: '30' } })
    // The preview says what 70% of an hour actually is, before she commits.
    expect(screen.getByText('42m')).toBeInTheDocument()
    expect(screen.getByText('18m')).toBeInTheDocument()

    fireEvent.click(confirmButton())
    await vi.waitFor(() => expect(onSplit).toHaveBeenCalledTimes(1))
    expect(onSplit).toHaveBeenCalledWith(
      ENTRY,
      // Percentages are an input method, not a stored mode.
      'custom',
      { 'client-1': 42, 'client-2': 18 },
      ['client-1', 'client-2'],
    )
  })

  it('splits an awkward block to the second — the parts still make the whole', async () => {
    const { onSplit } = renderSplit({ entry: { ...ENTRY, minutes: 2701 / 60 } })
    addBrightBooks()
    fireEvent.click(byPercentage())
    fireEvent.change(percentBox('Acme Dental'), { target: { value: '33.33' } })
    fireEvent.change(percentBox('Bright Books'), { target: { value: '66.67' } })

    fireEvent.click(confirmButton())
    await vi.waitFor(() => expect(onSplit).toHaveBeenCalledTimes(1))
    const allocations = onSplit.mock.calls[0][2] as Record<string, number>
    const seconds = Object.values(allocations).reduce((sum, m) => sum + Math.round(m * 60), 0)
    expect(seconds).toBe(2701)
  })

  it('will not submit until the percentages add up to exactly 100', () => {
    const { onSplit } = renderSplit()
    addBrightBooks()
    fireEvent.click(byPercentage())

    fireEvent.change(percentBox('Bright Books'), { target: { value: '45' } })
    expect(screen.getByText(/adds up to 95% — 5% left/i)).toBeInTheDocument()
    expect(confirmButton()).toBeDisabled()

    fireEvent.change(percentBox('Bright Books'), { target: { value: '60' } })
    expect(screen.getByText(/adds up to 110% — 10% over/i)).toBeInTheDocument()
    expect(confirmButton()).toBeDisabled()

    fireEvent.change(percentBox('Bright Books'), { target: { value: '50' } })
    expect(confirmButton()).toBeEnabled()
    expect(onSplit).not.toHaveBeenCalled()
  })

  it('reseeds an even share when another client joins the split', () => {
    renderSplit()
    fireEvent.click(byPercentage())
    expect(percentBox('Acme Dental')).toHaveValue(100)

    addBrightBooks()
    expect(percentBox('Acme Dental')).toHaveValue(50)
    expect(percentBox('Bright Books')).toHaveValue(50)
  })
})

describe('adjusting a split by percentage', () => {
  const SLICES = [
    { ...ENTRY, id: 'time-a', clientId: 'client-1', minutes: 36, groupId: 'grp-1', groupAllocation: 'custom' },
    { ...ENTRY, id: 'time-b', clientId: 'client-2', minutes: 24, groupId: 'grp-1', groupAllocation: 'custom' },
  ] as TimeEntry[]
  const SLICE = SLICES[0]

  it('opens the percentage view on what is billed today', () => {
    renderSplit({ entry: SLICE, groupSlices: SLICES })
    // A stored custom split reopens on the exact minutes that produced it...
    expect(screen.getByRole('radio', { name: /exact minutes/i })).toBeChecked()

    // ...and switching to percentages reads them off the current slices.
    fireEvent.click(byPercentage())
    expect(percentBox('Acme Dental')).toHaveValue(60)
    expect(percentBox('Bright Books')).toHaveValue(40)
  })

  it('saves the adjusted percentages as minutes on the same group', async () => {
    const { onAdjust } = renderSplit({ entry: SLICE, groupSlices: SLICES })
    fireEvent.click(byPercentage())
    fireEvent.change(percentBox('Acme Dental'), { target: { value: '25' } })
    fireEvent.change(percentBox('Bright Books'), { target: { value: '75' } })

    fireEvent.click(confirmButton())
    await vi.waitFor(() => expect(onAdjust).toHaveBeenCalledTimes(1))
    expect(onAdjust).toHaveBeenCalledWith('grp-1', 'custom', [
      { clientId: 'client-1', minutes: 15 },
      { clientId: 'client-2', minutes: 45 },
    ])
  })
})
