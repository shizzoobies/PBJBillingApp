import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoicesPage } from '../pages/InvoicesPage'
import type { Client } from '../lib/types'

/**
 * A pinned client previews at its pin, not at today's rate.
 *
 * The generated invoice has priced a pinned client off its rate month since
 * `getInvoice` learned to resolve the pin. The browser did not: nothing on this
 * page fetched the versions, so the ninth argument defaulted to `[]` and the
 * preview fell through to the person's LIVE bill rate. Brittany would raise a
 * rate, look at a client she had not reviewed yet, and read the new number on
 * screen while the invoice she sent carried the old one.
 *
 * Avery bills $40 from June and $60 from September. Acme is pinned to June, so
 * an hour worked in September is $40 on this page — the same $40 the server
 * bills.
 */

vi.mock('../lib/api', () => ({
  answerInvoiceAiReviewQuestionRequest: vi.fn(),
  confirmInvoiceCoverageRequest: vi.fn(),
  createInvoicePaymentLinkRequest: vi.fn(),
  fetchRateVersions: vi.fn(),
  generateInvoicesRequest: vi.fn(),
  listInvoiceAiReviewsRequest: vi.fn(async () => []),
  listInvoicesRequest: vi.fn(async () => []),
  listUnappliedRetainersRequest: vi.fn(async () => []),
  rateInvoiceRequest: vi.fn(),
  regenerateInvoicesRequest: vi.fn(),
  sendInvoiceRequest: vi.fn(),
  updateInvoiceRequest: vi.fn(),
}))

// Not what is under test, and it reaches for its own data.
vi.mock('../components/ReimbursementsCard', () => ({
  ReimbursementsCard: () => null,
}))

const client = {
  id: 'client-acme',
  name: 'Acme',
  contact: '',
  billingMode: 'hourly',
  hourlyRate: 0,
  // Pinned to June: September's hours bill at June's rates.
  hourlyRatePeriod: '2026-06',
  planIds: [],
  contactIds: [],
} as unknown as Client

vi.mock('../AppContext', () => ({
  useAppContext: () => ({
    data: {
      clients: [client],
      timeEntries: [
        {
          id: 'entry-1',
          date: '2026-09-10',
          clientId: 'client-acme',
          employeeId: 'emp-avery',
          minutes: 60,
          billable: true,
          isAdministrative: false,
          taskId: null,
          taskLabel: 'Bookkeeping',
          description: 'Monthly close',
          workSessions: [],
        },
      ],
      plans: [],
      reimbursements: [],
      recurringReimbursements: [],
      // The LIVE rate mirrors the newest version — the number the preview used
      // to show for a client that had not been reviewed yet.
      employees: [{ id: 'emp-avery', name: 'Avery Stone', billRate: 60 }],
    },
    selectedClientId: 'client-acme',
    setSelectedClientId: vi.fn(),
    billingPeriod: '2026-09',
    printInvoice: vi.fn(),
    ownerMode: true,
    firmSettings: { name: 'PB&J Strategic Accounting', clientDefaults: { hourlyRate: 0 } },
  }),
}))

import { fetchRateVersions } from '../lib/api'

const mockRateVersions = vi.mocked(fetchRateVersions)

beforeEach(() => {
  mockRateVersions.mockReset()
  mockRateVersions.mockResolvedValue({
    billRateVersions: [
      { userId: 'emp-avery', effectivePeriod: '2026-06', rate: 40 },
      { userId: 'emp-avery', effectivePeriod: '2026-09', rate: 60 },
    ],
    costRateVersions: [],
  } as unknown as Awaited<ReturnType<typeof fetchRateVersions>>)
})

describe('InvoicesPage prices a pinned client at its pin', () => {
  it('shows June money for a June-pinned client working in September', async () => {
    render(<InvoicesPage />)

    expect(await screen.findAllByText('$40.00')).not.toHaveLength(0)
    expect(screen.queryByText('$60.00')).toBeNull()
  })
})
