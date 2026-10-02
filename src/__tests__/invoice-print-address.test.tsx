import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoicesPage } from '../pages/InvoicesPage'
import type { Client } from '../lib/types'

/**
 * The printed sheet's bill-to block shows the client's mailing address through
 * `mailingAddressLines` — the same rule the emailed PDF uses (pinned beside the
 * PDF in lib/invoice-pdf.test.mjs). This is the sheet's half: the lines, their
 * order, and nothing at all for a client with no address.
 */

vi.mock('../lib/api', () => ({
  createInvoicePaymentLinkRequest: vi.fn(),
  fetchRateVersions: vi.fn(async () => ({ billRateVersions: [], costRateVersions: [] })),
  generateInvoicesRequest: vi.fn(),
  listInvoicesRequest: vi.fn(async () => []),
  regenerateInvoicesRequest: vi.fn(),
  sendInvoiceRequest: vi.fn(),
  updateInvoiceRequest: vi.fn(),
}))

vi.mock('../components/ReimbursementsCard', () => ({
  ReimbursementsCard: () => null,
}))

const baseClient = {
  id: 'client-acme',
  name: 'Acme',
  contact: '',
  contactName: 'Ann Acme',
  email: 'ann@acme.test',
  phone: '615-555-0142',
  billingMode: 'hourly',
  hourlyRate: 100,
  planIds: [],
  contactIds: [],
}

let currentClient = baseClient as unknown as Client

vi.mock('../AppContext', () => ({
  useAppContext: () => ({
    data: {
      clients: [currentClient],
      timeEntries: [],
      plans: [],
      reimbursements: [],
      recurringReimbursements: [],
      employees: [],
    },
    selectedClientId: 'client-acme',
    setSelectedClientId: vi.fn(),
    billingPeriod: '2026-08',
    printInvoice: vi.fn(),
    ownerMode: true,
    firmSettings: {
      name: 'PB&J Strategic Accounting',
      addressLine1: '1 Firm Plaza',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      clientDefaults: { hourlyRate: 0 },
    },
  }),
}))

/** The bill-to block's lines, top to bottom. */
function billToLines() {
  const block = document.querySelector('.print-sheet .print-meta > div')
  if (!block) throw new Error('the bill-to block is not on the sheet')
  return Array.from(block.children).map((node) => node.textContent)
}

beforeEach(() => {
  currentClient = baseClient as unknown as Client
})

/** The firm's letterhead lines on the sheet. */
function firmLines() {
  const block = document.querySelector('.print-sheet header > div')
  if (!block) throw new Error('the letterhead is not on the sheet')
  return Array.from(block.children).map((node) => node.textContent)
}

describe('the printed invoice sheet — the client mailing address', () => {
  // One sheet, two address blocks, one rule: the firm's city line and the
  // client's are written alike.
  it('writes the firm letterhead and the client block the same way', () => {
    currentClient = {
      ...baseClient,
      addressLine1: '12 Main St',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
    } as unknown as Client
    render(<InvoicesPage />)

    expect(firmLines()).toEqual(['PB&J Strategic Accounting', '1 Firm Plaza', 'Austin, TX 78701'])
    expect(billToLines().slice(-1)).toEqual(['Austin, TX 78701'])
  })

  it('prints street, second line and one city line, after the contact details', () => {
    currentClient = {
      ...baseClient,
      addressLine1: '12 Main St',
      addressLine2: 'Suite 4',
      city: 'Nashville',
      state: 'TN',
      postalCode: '37201',
    } as unknown as Client
    render(<InvoicesPage />)

    expect(billToLines()).toEqual([
      'Bill to',
      'Acme',
      'Ann Acme',
      'ann@acme.test',
      '615-555-0142',
      '12 Main St',
      'Suite 4',
      'Nashville, TN 37201',
    ])
  })

  it('drops the parts a partial address does not have', () => {
    currentClient = {
      ...baseClient,
      addressLine1: '12 Main St',
      addressLine2: '  ',
      city: 'Nashville',
      postalCode: '37201',
    } as unknown as Client
    render(<InvoicesPage />)

    expect(billToLines().slice(5)).toEqual(['12 Main St', 'Nashville 37201'])
  })

  it('prints no address lines for a client with no address', () => {
    render(<InvoicesPage />)

    expect(billToLines()).toEqual(['Bill to', 'Acme', 'Ann Acme', 'ann@acme.test', '615-555-0142'])
  })
})
