import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoiceMonthRun, type InvoiceMonthRunHandle } from '../components/InvoiceMonthRun'
import type { Client, PersistedInvoice } from '../lib/types'

/**
 * The unsaved-edits guard on a MONTH change.
 *
 * Changing months reloads the run, which unmounts the open editor and takes any
 * typed line edits with it — silently, and the row looks untouched when she
 * comes back. Switching tabs has asked about that for a while; these pin that
 * the two ways of changing the month now ask the same question, and that
 * "keep my edits" really does leave everything where it was.
 */

vi.mock('../lib/api', () => ({
  createInvoicePaymentLinkRequest: vi.fn(),
  generateInvoicesRequest: vi.fn(),
  listInvoicesRequest: vi.fn(),
  regenerateInvoicesRequest: vi.fn(),
  sendInvoiceRequest: vi.fn(),
  updateInvoiceRequest: vi.fn(),
}))

import { listInvoicesRequest } from '../lib/api'

const mockList = vi.mocked(listInvoicesRequest)

const clients = [
  {
    id: 'client-acme',
    name: 'Acme',
    contact: '',
    billingMode: 'hourly',
    hourlyRate: 0,
    planIds: [],
    contactIds: [],
  },
] as unknown as Client[]

const invoice: PersistedInvoice = {
  id: 'inv-1',
  clientId: 'client-acme',
  period: '2026-08',
  number: 'INV-2026-08-001',
  status: 'draft',
  lineItems: [{ kind: 'hourly', label: 'Billable hours', detail: '', amount: 400 }],
  subtotal: 400,
  total: 400,
  dueDate: null,
  blurb: '',
  scopeFlags: [],
  sentAt: null,
  paidAt: null,
  paymentMethod: null,
  createdAt: null,
  updatedAt: null,
}

/** Render the run, open its one invoice, and type into it so it is dirty. */
async function renderWithDirtyEditor() {
  const ref = createRef<InvoiceMonthRunHandle>()
  render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} ref={ref} />)

  fireEvent.click(await screen.findByText('INV-2026-08-001'))
  fireEvent.change(screen.getByLabelText('Line description'), {
    target: { value: 'Billable hours — corrected' },
  })
  // The editor only reports itself dirty once the typed value differs.
  await screen.findByText(/unsaved/)

  const monthInput = screen.getByLabelText('Billing month') as HTMLInputElement
  return { ref, monthInput, startingPeriod: monthInput.value }
}

// happy-dom ships no `window.confirm` at all, so `vi.spyOn(window, 'confirm')`
// fails outright — there is nothing to spy on. It is stubbed instead, which
// also gives a real teardown: a hand-assigned `window.confirm` would outlive
// this file and silently auto-answer any other suite's confirms.
let confirm: ReturnType<typeof vi.fn>

beforeEach(() => {
  mockList.mockReset()
  mockList.mockResolvedValue([invoice])
  confirm = vi.fn().mockReturnValue(true)
  vi.stubGlobal('confirm', confirm)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('InvoiceMonthRun — unsaved edits guard on a month change', () => {
  it('does not ask when nothing is unsaved', async () => {
    confirm.mockReturnValue(true)
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
    await screen.findByText('INV-2026-08-001')

    fireEvent.change(screen.getByLabelText('Billing month'), { target: { value: '2020-01' } })

    expect(confirm).not.toHaveBeenCalled()
    await waitFor(() => expect(mockList).toHaveBeenCalledWith('2020-01'))
  })

  it('asks before the month picker throws unsaved edits away, and obeys a no', async () => {
    confirm.mockReturnValue(false)
    const { monthInput, startingPeriod } = await renderWithDirtyEditor()
    mockList.mockClear()

    fireEvent.change(monthInput, { target: { value: '2020-01' } })

    // The month holding the edits is NAMED — this can be asked from History,
    // where the run is off screen. Matched loosely so the assertion does not
    // depend on what month the clock says it is.
    expect(confirm).toHaveBeenCalledWith(
      expect.stringMatching(
        /^You have unsaved invoice edits in \w+ \d{4}\. Discard them and change months\?$/,
      ),
    )
    // Nothing moved: the picker snaps back and no other month was fetched.
    expect(monthInput.value).toBe(startingPeriod)
    expect(mockList).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Line description')).toHaveValue('Billable hours — corrected')
  })

  it('changes the month when she agrees to discard them', async () => {
    confirm.mockReturnValue(true)
    const { monthInput } = await renderWithDirtyEditor()

    fireEvent.change(monthInput, { target: { value: '2020-01' } })

    expect(monthInput.value).toBe('2020-01')
    await waitFor(() => expect(mockList).toHaveBeenCalledWith('2020-01'))
  })

  it('guards showPeriod too, and answers false so History can stay put', async () => {
    confirm.mockReturnValue(false)
    const { ref, monthInput, startingPeriod } = await renderWithDirtyEditor()
    mockList.mockClear()

    let moved: boolean | undefined
    act(() => {
      moved = ref.current?.showPeriod('2020-01')
    })

    expect(confirm).toHaveBeenCalledOnce()
    expect(moved).toBe(false)
    expect(monthInput.value).toBe(startingPeriod)
    expect(mockList).not.toHaveBeenCalled()
  })

  it('answers true and moves when she agrees', async () => {
    confirm.mockReturnValue(true)
    const { ref, monthInput } = await renderWithDirtyEditor()

    let moved: boolean | undefined
    act(() => {
      moved = ref.current?.showPeriod('2020-01')
    })

    expect(moved).toBe(true)
    expect(monthInput.value).toBe('2020-01')
  })

  /**
   * The reason the guard does not clear `openDirty` itself. If it did, this
   * would pass silently the first time and lose her work the second: the
   * discard was agreed to, but it never actually happened, and the edits are
   * still sitting on screen.
   */
  it('still has unsaved edits to protect when the reload fails', async () => {
    confirm.mockReturnValue(true)
    const { monthInput } = await renderWithDirtyEditor()
    mockList.mockRejectedValueOnce(new Error('Network is down'))

    fireEvent.change(monthInput, { target: { value: '2020-01' } })
    await screen.findByText('Network is down')

    // The old month is still on screen because nothing replaced it, and her
    // typed line went nowhere.
    expect(screen.getByLabelText('Line description')).toHaveValue('Billable hours — corrected')

    // So the next month change has to ask again rather than assume they are gone.
    confirm.mockClear()
    fireEvent.change(monthInput, { target: { value: '2020-02' } })
    expect(confirm).toHaveBeenCalledOnce()
  })

  it('never prompts for the month already on screen, even with edits open', async () => {
    confirm.mockReturnValue(false)
    const { ref, startingPeriod } = await renderWithDirtyEditor()

    let moved: boolean | undefined
    act(() => {
      moved = ref.current?.showPeriod(startingPeriod)
    })

    expect(confirm).not.toHaveBeenCalled()
    expect(moved).toBe(true)
    // Her edits are still sitting there — nothing was reloaded out from under her.
    expect(screen.getByLabelText('Line description')).toHaveValue('Billable hours — corrected')
  })
})
