import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoiceMonthRun } from '../components/InvoiceMonthRun'
import { ApiError, type Client, type PersistedInvoice } from '../lib/types'

/**
 * The editor answers each refusal for what it is, and says it ONCE.
 *
 * The invoice PATCH route answers 409 with four different codes
 * (retainer_credit_refused, coverage_unconfirmed, invoice_locked,
 * entry_tag_refused). Only the first is about the retainer credit: it alone
 * takes that line back out of the editor. Any other refusal says its sentence
 * beside the Save / Mark reviewed buttons and leaves her work exactly as it was.
 */

vi.mock('../lib/api', () => ({
  createInvoicePaymentLinkRequest: vi.fn(),
  generateInvoicesRequest: vi.fn(),
  listInvoicesRequest: vi.fn(),
  listUnappliedRetainersRequest: vi.fn(),
  regenerateInvoicesRequest: vi.fn(),
  sendInvoiceRequest: vi.fn(),
  updateInvoiceRequest: vi.fn(),
}))

import {
  generateInvoicesRequest,
  listInvoicesRequest,
  listUnappliedRetainersRequest,
  updateInvoiceRequest,
} from '../lib/api'

const mockList = vi.mocked(listInvoicesRequest)
const mockRetainers = vi.mocked(listUnappliedRetainersRequest)
const mockUpdate = vi.mocked(updateInvoiceRequest)
const mockGenerate = vi.mocked(generateInvoicesRequest)

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
  kind: 'monthly',
  number: 'INV-2026-08-001',
  status: 'draft',
  lineItems: [{ kind: 'hourly', label: 'Billable hours — Lisa', detail: '', amount: 600 }],
  subtotal: 600,
  total: 600,
  dueDate: null,
  blurb: '',
  scopeFlags: [],
  sentAt: null,
  paidAt: null,
  paymentMethod: null,
  appliedToInvoiceId: null,
  createdAt: null,
  updatedAt: null,
}

const retainer: PersistedInvoice = {
  ...invoice,
  id: 'inv-ret',
  kind: 'retainer',
  number: 'INV-RET-2026-001',
  period: '2026-01',
  status: 'paid',
  lineItems: [{ kind: 'retainer', label: 'Retainer', detail: '', amount: 500 }],
  subtotal: 500,
  total: 500,
}

const applyButton = () => screen.queryByRole('button', { name: /Apply retainer/i })
const creditLine = () => screen.queryByDisplayValue('Retainer applied — credit')
const saveButton = () => screen.getByRole('button', { name: 'Save changes' })

/** The editor itself, so a sentence is found NEXT TO Save and not in the run's banner. */
const editor = () => {
  const node = document.querySelector('.invoice-run-editor')
  if (!node) throw new Error('the editor is not open')
  return within(node as HTMLElement)
}

/** Open the editor, take the retainer credit and edit the first line's wording. */
async function stageEdits() {
  render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
  fireEvent.click(await screen.findByText('INV-2026-08-001'))
  await waitFor(() => expect(applyButton()).toBeInTheDocument())
  fireEvent.click(applyButton()!)
  fireEvent.change(screen.getByDisplayValue('Billable hours — Lisa'), {
    target: { value: 'Billable hours — edited' },
  })
  fireEvent.click(saveButton())
}

beforeEach(() => {
  mockList.mockReset()
  mockList.mockResolvedValue([invoice])
  mockRetainers.mockReset()
  mockRetainers.mockResolvedValue([retainer])
  mockUpdate.mockReset()
  mockUpdate.mockResolvedValue(invoice)
  mockGenerate.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('InvoiceMonthRun — a refused save', () => {
  // The server wrote nothing and the credit was never the problem.
  it('says an entry_tag_refused sentence beside Save and leaves every edit alone', async () => {
    const sentence = 'Those hours are already on a sent invoice, so they cannot be re-tagged.'
    mockUpdate.mockRejectedValue(new ApiError(409, sentence, 'entry_tag_refused'))
    await stageEdits()

    expect(await editor().findByText(sentence)).toBeInTheDocument()
    expect(creditLine()).toBeInTheDocument()
    expect(screen.getByDisplayValue('Billable hours — edited')).toBeInTheDocument()
    expect(screen.getByText(/^Total \$100\.00/)).toBeInTheDocument()
    // Still dirty, so she can fix it and press Save again.
    expect(saveButton()).toBeEnabled()
    // Nothing about the retainer changed, so nothing re-asks about it.
    expect(mockRetainers).toHaveBeenCalledTimes(1)
  })

  it('still takes the credit back out when the retainer credit itself is refused', async () => {
    const sentence = 'That retainer has already been applied to another invoice.'
    mockUpdate.mockRejectedValue(new ApiError(409, sentence, 'retainer_credit_refused'))
    await stageEdits()

    expect(await editor().findByText(sentence)).toBeInTheDocument()
    expect(creditLine()).not.toBeInTheDocument()
    expect(screen.getByText(/^Total \$600\.00/)).toBeInTheDocument()
    await waitFor(() => expect(mockRetainers).toHaveBeenCalledTimes(2))
  })

  it('treats a 409 with a code it does not know as an ordinary error', async () => {
    const sentence = 'Something new the server refused.'
    mockUpdate.mockRejectedValue(new ApiError(409, sentence, 'some_future_code'))
    await stageEdits()

    expect(await editor().findByText(sentence)).toBeInTheDocument()
    expect(creditLine()).toBeInTheDocument()
    expect(screen.getByDisplayValue('Billable hours — edited')).toBeInTheDocument()
    expect(saveButton()).toBeEnabled()
  })

  it('treats a 409 with no code as an ordinary error', async () => {
    const sentence = 'The server refused that without saying which rule.'
    mockUpdate.mockRejectedValue(new ApiError(409, sentence))
    await stageEdits()

    expect(await editor().findByText(sentence)).toBeInTheDocument()
    expect(creditLine()).toBeInTheDocument()
    expect(saveButton()).toBeEnabled()
  })

  // Unchanged behavior: said in the editor, nothing edited under her.
  it('says an invoice_locked sentence in the editor and changes no line', async () => {
    const sentence = 'This invoice is locked because it has been paid.'
    mockUpdate.mockRejectedValue(new ApiError(409, sentence, 'invoice_locked'))
    await stageEdits()

    expect(await editor().findByText(sentence)).toBeInTheDocument()
    expect(creditLine()).toBeInTheDocument()
    expect(screen.getByDisplayValue('Billable hours — edited')).toBeInTheDocument()
    // Not also in the run's banner.
    expect(screen.getAllByText(sentence)).toHaveLength(1)
  })
})

describe('InvoiceMonthRun — a refused Mark reviewed', () => {
  it('says the coverage_unconfirmed sentence in the editor, and the invoice stays a draft', async () => {
    const sentence = 'Confirm the covered dates on the QuickBooks line before marking reviewed.'
    mockUpdate.mockRejectedValue(new ApiError(409, sentence, 'coverage_unconfirmed'))
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
    fireEvent.click(await screen.findByText('INV-2026-08-001'))

    fireEvent.click(await screen.findByRole('button', { name: 'Mark reviewed' }))

    expect(await editor().findByText(sentence)).toBeInTheDocument()
    expect(mockUpdate).toHaveBeenCalledWith('inv-1', { status: 'reviewed' })
    // Still in To review, still offering the button.
    expect(screen.getByRole('button', { name: 'Mark reviewed' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /^To review/ })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })

  it('says any other refusal too, rather than swallowing it', async () => {
    const sentence = 'Could not save that change — please try again.'
    mockUpdate.mockRejectedValue(new ApiError(500, sentence))
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
    fireEvent.click(await screen.findByText('INV-2026-08-001'))

    fireEvent.click(await screen.findByRole('button', { name: 'Mark reviewed' }))

    expect(await editor().findByText(sentence)).toBeInTheDocument()
  })
})

/**
 * ONE MESSAGE PER REFUSAL. A refusal to a Save, Mark reviewed, Back to draft or
 * Void is said in the open editor's slot beside the buttons; the run's banner
 * above the whole list does not repeat it. (Both are role="alert", so counting
 * the sentence on the page counts the copies.)
 */
describe('InvoiceMonthRun — a refusal is said once', () => {
  const sentence = 'Something the server would not do.'

  it('says a refused Save once, in the editor', async () => {
    mockUpdate.mockRejectedValue(new ApiError(500, sentence))
    await stageEdits()

    expect(await editor().findByText(sentence)).toBeInTheDocument()
    expect(screen.getAllByText(sentence)).toHaveLength(1)
  })

  it('says a refused Mark reviewed once, in the editor', async () => {
    mockUpdate.mockRejectedValue(new ApiError(409, sentence, 'coverage_unconfirmed'))
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
    fireEvent.click(await screen.findByText('INV-2026-08-001'))

    fireEvent.click(await screen.findByRole('button', { name: 'Mark reviewed' }))

    expect(await editor().findByText(sentence)).toBeInTheDocument()
    expect(screen.getAllByText(sentence)).toHaveLength(1)
  })

  it('says a refused Void once, in the editor', async () => {
    // happy-dom ships no window.confirm, so it is stubbed (as the void tests do).
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true))
    mockUpdate.mockRejectedValue(new ApiError(500, sentence))
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
    fireEvent.click(await screen.findByText('INV-2026-08-001'))

    fireEvent.click(await screen.findByRole('button', { name: 'Void' }))

    expect(await editor().findByText(sentence)).toBeInTheDocument()
    expect(screen.getAllByText(sentence)).toHaveLength(1)
  })

  it('says a refused Back to draft once, in the editor', async () => {
    mockList.mockResolvedValue([{ ...invoice, status: 'reviewed' }])
    mockUpdate.mockRejectedValue(new ApiError(500, sentence))
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
    fireEvent.click(await screen.findByRole('tab', { name: /^Reviewed/ }))
    fireEvent.click(await screen.findByText('INV-2026-08-001'))

    fireEvent.click(await screen.findByRole('button', { name: 'Back to draft' }))

    expect(await editor().findByText(sentence)).toBeInTheDocument()
    expect(screen.getAllByText(sentence)).toHaveLength(1)
  })

  // A failure with no open editor to speak in still reaches the banner: Generate
  // is a month-level action.
  it('still raises the banner for a month-level failure', async () => {
    mockGenerate.mockRejectedValue(new Error('Could not generate this month.'))
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
    await screen.findByText('INV-2026-08-001')

    fireEvent.click(screen.getByRole('button', { name: /^Generate/ }))

    expect(await screen.findByText('Could not generate this month.')).toBeInTheDocument()
  })
})

describe('InvoiceMonthRun — the editor message clears when she edits', () => {
  const sentence = 'Confirm the covered dates on the QuickBooks line before marking reviewed.'

  async function refusedReview() {
    mockUpdate.mockRejectedValue(new ApiError(409, sentence, 'coverage_unconfirmed'))
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
    fireEvent.click(await screen.findByText('INV-2026-08-001'))
    fireEvent.click(await screen.findByRole('button', { name: 'Mark reviewed' }))
    expect(await editor().findByText(sentence)).toBeInTheDocument()
  }

  it('clears when she changes a line', async () => {
    await refusedReview()

    fireEvent.change(screen.getByDisplayValue('Billable hours — Lisa'), {
      target: { value: 'Billable hours — edited' },
    })

    expect(screen.queryByText(sentence)).not.toBeInTheDocument()
  })

  it('clears when she types in the note', async () => {
    await refusedReview()

    fireEvent.change(screen.getByLabelText('Note to the client'), {
      target: { value: 'Thank you!' },
    })

    expect(screen.queryByText(sentence)).not.toBeInTheDocument()
  })

  it('clears when she adds a line', async () => {
    await refusedReview()

    fireEvent.click(screen.getByRole('button', { name: 'Add a line' }))

    expect(screen.queryByText(sentence)).not.toBeInTheDocument()
  })

  // The older message goes BEFORE the next request runs, not after it answers.
  it('clears an older message before Back to draft and Void run', async () => {
    mockList.mockResolvedValue([{ ...invoice, status: 'reviewed' }])
    // happy-dom ships no window.confirm, so it is stubbed (as the void tests do).
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true))
    mockUpdate.mockRejectedValueOnce(new ApiError(500, 'The first refusal.'))
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
    fireEvent.click(await screen.findByRole('tab', { name: /^Reviewed/ }))
    fireEvent.click(await screen.findByText('INV-2026-08-001'))
    fireEvent.click(await screen.findByRole('button', { name: 'Back to draft' }))
    expect(await editor().findByText('The first refusal.')).toBeInTheDocument()

    let answer: (value: PersistedInvoice) => void = () => {}
    mockUpdate.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
    fireEvent.click(screen.getByRole('button', { name: 'Void' }))

    expect(screen.queryByText('The first refusal.')).not.toBeInTheDocument()
    answer(invoice)
  })
})
