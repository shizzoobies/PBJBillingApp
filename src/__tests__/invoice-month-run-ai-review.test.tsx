import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoiceMonthRun } from '../components/InvoiceMonthRun'
import type { Client, InvoiceAiReview, PersistedInvoice } from '../lib/types'

/**
 * The AI confidence rating in the month run.
 *
 * Everything pinned here follows from one decision: the rating is ADVISORY.
 * It annotates an invoice and never argues with it — no button is disabled by
 * it, no row moves because of it, and both buttons on the at-approve panel
 * approve. The tests that matter most are therefore the negative ones: that a
 * failed answer still approves, and that an invoice with nothing to ask
 * approves on the first click exactly as it did before this existed.
 */

vi.mock('../lib/api', () => ({
  answerInvoiceAiReviewQuestionRequest: vi.fn(),
  confirmInvoiceCoverageRequest: vi.fn(),
  createInvoicePaymentLinkRequest: vi.fn(),
  generateInvoicesRequest: vi.fn(),
  listInvoiceAiReviewsRequest: vi.fn(async () => []),
  listInvoicesRequest: vi.fn(),
  listUnappliedRetainersRequest: vi.fn(async () => []),
  rateInvoiceRequest: vi.fn(),
  regenerateInvoicesRequest: vi.fn(),
  sendInvoiceRequest: vi.fn(),
  updateInvoiceRequest: vi.fn(),
}))

import {
  answerInvoiceAiReviewQuestionRequest,
  generateInvoicesRequest,
  listInvoiceAiReviewsRequest,
  listInvoicesRequest,
  rateInvoiceRequest,
  updateInvoiceRequest,
} from '../lib/api'
import { ApiError } from '../lib/types'

const mockList = vi.mocked(listInvoicesRequest)
const mockGenerate = vi.mocked(generateInvoicesRequest)
const mockReviews = vi.mocked(listInvoiceAiReviewsRequest)
const mockRate = vi.mocked(rateInvoiceRequest)
const mockAnswer = vi.mocked(answerInvoiceAiReviewQuestionRequest)
const mockUpdate = vi.mocked(updateInvoiceRequest)

const clients = [
  {
    id: 'client-acme',
    name: 'Acme',
    contact: '',
    billingMode: 'subscription',
    hourlyRate: 0,
    planIds: [],
    contactIds: [],
  },
] as unknown as Client[]

const baseInvoice: PersistedInvoice = {
  id: 'inv-1',
  clientId: 'client-acme',
  period: '2026-11',
  kind: 'monthly',
  number: 'INV-2026-11-001',
  status: 'draft',
  lineItems: [
    { kind: 'plan', label: 'Monthly service', detail: 'Monthly service', amount: 500 },
    { kind: 'hourly', label: 'Cleanup work', detail: '4.00 hrs', amount: 340 },
  ],
  subtotal: 840,
  total: 840,
  dueDate: null,
  blurb: '',
  scopeFlags: [],
  sentAt: null,
  paidAt: null,
  paymentMethod: null,
  appliedToInvoiceId: null,
  createdAt: '2026-11-30T00:00:00.000Z',
  updatedAt: '2026-11-30T00:00:00.000Z',
}

const baseReview: InvoiceAiReview = {
  id: 'rev-1',
  invoiceId: 'inv-1',
  clientId: 'client-acme',
  period: '2026-11',
  model: 'claude-opus-5',
  confidence: 'high',
  score: 92,
  summary: 'The lines match the month’s hours and last month’s invoice.',
  concerns: [],
  questions: [],
  linesFingerprint: 'abc123',
  createdAt: '2026-12-01T00:00:00.000Z',
}

/** Medium, with two concerns and one question still outstanding. */
const askingReview: InvoiceAiReview = {
  ...baseReview,
  confidence: 'medium',
  score: 71,
  summary: 'Two lines are worth a second look before this goes out.',
  concerns: [
    { line: 'Cleanup work', issue: 'Four hours is double the usual month.', severity: 'warn' },
    { line: 'Monthly service', issue: 'Same as last month.', severity: 'info' },
  ],
  questions: [
    {
      id: 'q-1',
      question: 'Was the cleanup work agreed with Acme in advance?',
      answer: null,
      skipped: false,
      answeredAt: null,
    },
  ],
}

/** The same rating with the question answered. */
const answeredReview: InvoiceAiReview = {
  ...askingReview,
  questions: [
    {
      ...askingReview.questions[0],
      answer: 'Yes — they asked for it on the 3rd.',
      answeredAt: '2026-12-02T00:00:00.000Z',
    },
  ],
}

async function openRun(invoices: PersistedInvoice[], reviews: InvoiceAiReview[] = []) {
  mockList.mockResolvedValue(invoices)
  mockReviews.mockResolvedValue(reviews)
  render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
  // The list and the reviews are two requests; wait for both, so a missing
  // badge is a missing badge rather than one that has not arrived.
  await screen.findByRole('tablist')
  await waitFor(() => expect(mockReviews).toHaveBeenCalled())
}

/** `tab` is only needed for an invoice that does not land in To review. */
async function openEditor(
  invoices: PersistedInvoice[],
  reviews: InvoiceAiReview[] = [],
  tab?: RegExp,
) {
  await openRun(invoices, reviews)
  if (tab) fireEvent.click(screen.getByRole('tab', { name: tab }))
  fireEvent.click(screen.getByText(invoices[0].number as string))
}

const reviewButton = () => screen.getByRole('button', { name: 'Mark reviewed' })

beforeEach(() => {
  mockList.mockReset()
  mockReviews.mockReset()
  mockRate.mockReset()
  mockAnswer.mockReset()
  mockUpdate.mockReset()
  mockGenerate.mockReset()
  mockUpdate.mockResolvedValue({ ...baseInvoice, status: 'reviewed' })
  vi.stubGlobal('confirm', vi.fn(() => true))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('InvoiceMonthRun — the confidence badge', () => {
  it('says high confidence in the row', async () => {
    await openRun([baseInvoice], [baseReview])

    expect(await screen.findByText('AI: high confidence')).toBeInTheDocument()
  })

  it('names how many things to check on a medium rating', async () => {
    await openRun([baseInvoice], [askingReview])

    expect(await screen.findByText('AI: check 2 things')).toBeInTheDocument()
  })

  // A medium rating with nothing listed still means "look again" — "check 0
  // things" would read as a bug.
  it('never says check 0 things', async () => {
    await openRun([baseInvoice], [{ ...askingReview, concerns: [] }])

    expect(await screen.findByText('AI: check 1 thing')).toBeInTheDocument()
  })

  it('says low confidence without counting anything', async () => {
    await openRun([baseInvoice], [{ ...askingReview, confidence: 'low', score: 40 }])

    expect(await screen.findByText('AI: low confidence')).toBeInTheDocument()
  })

  // Every invoice from before this shipped is unrated, and that is not a
  // failure state worth a badge.
  it('shows nothing at all for an unrated invoice', async () => {
    await openRun([baseInvoice], [])

    expect(screen.queryByText(/^AI:/)).not.toBeInTheDocument()
  })

  // A voided invoice drops its scope flags too — there is nothing left to
  // decide about an invoice that is not going out.
  it('shows nothing on a voided row', async () => {
    const voided: PersistedInvoice = { ...baseInvoice, status: 'void' }
    mockList.mockResolvedValue([voided])
    mockReviews.mockResolvedValue([{ ...baseReview, invoiceId: voided.id }])
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
    await waitFor(() => expect(mockReviews).toHaveBeenCalled())

    // It sits in Voided, which is not where the run opens.
    fireEvent.click(await screen.findByRole('tab', { name: /Voided/ }))
    expect(screen.getByText('INV-2026-11-001')).toBeInTheDocument()
    expect(screen.queryByText(/^AI:/)).not.toBeInTheDocument()
  })
})

describe('InvoiceMonthRun — the AI review card', () => {
  it('renders the summary, the concerns and the question', async () => {
    await openEditor([baseInvoice], [askingReview])

    expect(
      screen.getByText('Two lines are worth a second look before this goes out.'),
    ).toBeInTheDocument()
    expect(screen.getByText('Four hours is double the usual month.')).toBeInTheDocument()
    expect(screen.getByText('Same as last month.')).toBeInTheDocument()
    expect(
      screen.getByLabelText('Was the cleanup work agreed with Acme in advance?'),
    ).toBeInTheDocument()
  })

  it('keeps an answered question as the record of what was decided', async () => {
    await openEditor([baseInvoice], [answeredReview])

    expect(
      screen.getByText(
        'Q: Was the cleanup work agreed with Acme in advance? — A: Yes — they asked for it on the 3rd.',
      ),
    ).toBeInTheDocument()
    // Answered means answered: no box asking again.
    expect(
      screen.queryByLabelText('Was the cleanup work agreed with Acme in advance?'),
    ).not.toBeInTheDocument()
  })

  it('says when the rating predates the edits on screen', async () => {
    await openEditor(
      [{ ...baseInvoice, updatedAt: '2026-12-05T00:00:00.000Z' }],
      [askingReview],
    )

    expect(
      screen.getByText('Rated before your latest edits — re-rate to refresh.'),
    ).toBeInTheDocument()
  })

  it('stays quiet when the rating is newer than the invoice', async () => {
    await openEditor([baseInvoice], [askingReview])

    expect(
      screen.queryByText('Rated before your latest edits — re-rate to refresh.'),
    ).not.toBeInTheDocument()
  })
})

describe('InvoiceMonthRun — answering the AI', () => {
  it('posts what she typed and re-renders from the answer', async () => {
    mockAnswer.mockResolvedValue(answeredReview)
    await openEditor([baseInvoice], [askingReview])

    fireEvent.change(
      screen.getByLabelText('Was the cleanup work agreed with Acme in advance?'),
      { target: { value: 'Yes — they asked for it on the 3rd.' } },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }))

    await waitFor(() => {
      expect(mockAnswer).toHaveBeenCalledWith('inv-1', {
        questionId: 'q-1',
        answer: 'Yes — they asked for it on the 3rd.',
      })
    })
    expect(
      await screen.findByText(
        'Q: Was the cleanup work agreed with Acme in advance? — A: Yes — they asked for it on the 3rd.',
      ),
    ).toBeInTheDocument()
  })

  // A skip is a DECISION and is stored as one — it is not the same fact as a
  // question nobody has reached yet.
  it('records a skip rather than dropping the question', async () => {
    mockAnswer.mockResolvedValue({
      ...askingReview,
      questions: [{ ...askingReview.questions[0], skipped: true }],
    })
    await openEditor([baseInvoice], [askingReview])

    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))

    await waitFor(() => {
      expect(mockAnswer).toHaveBeenCalledWith('inv-1', { questionId: 'q-1', skipped: true })
    })
    expect(
      await screen.findByText(
        'Q: Was the cleanup work agreed with Acme in advance? — skipped',
      ),
    ).toBeInTheDocument()
  })

  it('says so in the card when the answer will not save', async () => {
    mockAnswer.mockRejectedValue(new Error('Could not save that answer (500).'))
    await openEditor([baseInvoice], [askingReview])

    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))

    expect(await screen.findByText('Could not save that answer (500).')).toBeInTheDocument()
  })
})

describe('InvoiceMonthRun — re-rating', () => {
  it('says it is working, then shows the new verdict', async () => {
    let settle: (review: InvoiceAiReview) => void = () => {}
    mockRate.mockReturnValue(
      new Promise<InvoiceAiReview>((resolve) => {
        settle = resolve
      }),
    )
    await openEditor([baseInvoice], [askingReview])

    fireEvent.click(screen.getByRole('button', { name: 'Re-rate' }))

    // The row badge, the card badge and the button that started it. The row
    // matters most: the card is one click away from being closed.
    expect(await screen.findAllByText('Rating…')).toHaveLength(3)
    expect(screen.getByRole('button', { name: 'Rating…' })).toBeDisabled()

    settle({ ...baseReview, summary: 'Checked again — this looks right.' })

    expect(await screen.findByText('Checked again — this looks right.')).toBeInTheDocument()
    expect(await screen.findAllByText('AI: high confidence')).toHaveLength(2)
    expect(mockRate).toHaveBeenCalledWith('inv-1')
  })

  it('renders the 503 in the card when the AI is not configured', async () => {
    mockRate.mockRejectedValue(
      new ApiError(503, 'The AI reviewer is not configured on this server.'),
    )
    await openEditor([baseInvoice], [askingReview])

    fireEvent.click(screen.getByRole('button', { name: 'Re-rate' }))

    expect(
      await screen.findByText('The AI reviewer is not configured on this server.'),
    ).toBeInTheDocument()
    // Advisory: a failed rating does not touch the invoice or the button.
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(reviewButton()).not.toBeDisabled()
  })
})

describe('InvoiceMonthRun — the questions at approve', () => {
  it('asks before approving when a question is outstanding', async () => {
    await openEditor([baseInvoice], [askingReview])

    fireEvent.click(reviewButton())

    expect(
      screen.getByText(
        'Before you approve — answering is optional, and either button marks this reviewed.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Answer & approve' })).toBeInTheDocument()
    // Nothing has been approved yet.
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Mark reviewed' })).not.toBeInTheDocument()
  })

  it('marks every unanswered question skipped, then approves', async () => {
    mockAnswer.mockResolvedValue(askingReview)
    await openEditor([baseInvoice], [askingReview])

    fireEvent.click(reviewButton())
    fireEvent.click(screen.getByRole('button', { name: 'Skip & approve' }))

    await waitFor(() => {
      expect(mockAnswer).toHaveBeenCalledWith('inv-1', { questionId: 'q-1', skipped: true })
    })
    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith('inv-1', { status: 'reviewed' })
    })
  })

  it('sends what she typed, then approves', async () => {
    mockAnswer.mockResolvedValue(answeredReview)
    await openEditor([baseInvoice], [askingReview])

    fireEvent.click(reviewButton())
    fireEvent.change(
      screen.getByLabelText('Was the cleanup work agreed with Acme in advance?'),
      { target: { value: 'Agreed on the 3rd.' } },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Answer & approve' }))

    await waitFor(() => {
      expect(mockAnswer).toHaveBeenCalledWith('inv-1', {
        questionId: 'q-1',
        answer: 'Agreed on the 3rd.',
      })
    })
    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith('inv-1', { status: 'reviewed' })
    })
  })

  // An empty box in the Answer & approve path is a skip, not an empty answer:
  // storing '' would poison the corpus with a non-answer.
  it('treats a box left blank as a skip', async () => {
    mockAnswer.mockResolvedValue(askingReview)
    await openEditor([baseInvoice], [askingReview])

    fireEvent.click(reviewButton())
    fireEvent.click(screen.getByRole('button', { name: 'Answer & approve' }))

    await waitFor(() => {
      expect(mockAnswer).toHaveBeenCalledWith('inv-1', { questionId: 'q-1', skipped: true })
    })
  })

  it('puts the button back when she cancels, having approved nothing', async () => {
    await openEditor([baseInvoice], [askingReview])

    fireEvent.click(reviewButton())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(reviewButton()).toBeInTheDocument()
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  // THE REGRESSION GUARD. Mark reviewed is what it always was on every invoice
  // this feature has nothing to ask about — rated with no questions, questions
  // already answered, or never rated at all.
  it('approves on the first click when the rating has no questions', async () => {
    await openEditor([baseInvoice], [baseReview])

    fireEvent.click(reviewButton())

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith('inv-1', { status: 'reviewed' })
    })
  })

  it('approves on the first click when every question is already answered', async () => {
    await openEditor([baseInvoice], [answeredReview])

    fireEvent.click(reviewButton())

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith('inv-1', { status: 'reviewed' })
    })
  })

  it('approves on the first click on an unrated invoice', async () => {
    await openEditor([baseInvoice], [])

    fireEvent.click(reviewButton())

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith('inv-1', { status: 'reviewed' })
    })
  })

  // The questions build a corpus. A corpus is not worth standing between her
  // and approving an invoice she has already read.
  it('approves anyway when the answer will not save', async () => {
    mockAnswer.mockRejectedValue(new Error('Could not save that answer (500).'))
    await openEditor([baseInvoice], [askingReview])

    fireEvent.click(reviewButton())
    fireEvent.click(screen.getByRole('button', { name: 'Skip & approve' }))

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith('inv-1', { status: 'reviewed' })
    })
  })
})

/**
 * Generate hands back invoices and the server rates them afterwards, one at a
 * time, out of band. Nothing pings this list when a rating lands, so the run
 * asks again on a timer — bounded at both ends, because a rating that never
 * arrives must not leave a tab polling until the laptop closes.
 */
describe('InvoiceMonthRun — waiting for the ratings Generate set going', () => {
  /** Build the month with fake timers running, and hand back the run. */
  async function generateMonth(invoices: PersistedInvoice[]) {
    vi.useFakeTimers()
    mockList.mockResolvedValue(invoices)
    mockReviews.mockResolvedValue([])
    mockGenerate.mockResolvedValue({ period: '2026-11', created: invoices, skipped: [] })
    const view = render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    return view
  }

  const tick = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps asking every few seconds until the rating lands', async () => {
    await generateMonth([baseInvoice])
    const afterGenerate = mockReviews.mock.calls.length

    await tick(5000)
    expect(mockReviews.mock.calls.length).toBe(afterGenerate + 1)
    await tick(5000)
    expect(mockReviews.mock.calls.length).toBe(afterGenerate + 2)

    // It lands.
    mockReviews.mockResolvedValue([baseReview])
    await tick(5000)
    expect(screen.getByText('AI: high confidence')).toBeInTheDocument()

    // …and the asking stops, because there is nothing left to wait for.
    const settled = mockReviews.mock.calls.length
    await tick(60000)
    expect(mockReviews.mock.calls.length).toBe(settled)
  })

  // The row says what it is waiting for. Without this, a freshly generated
  // month looks like a month the feature simply skipped.
  it('says Rating… on a row whose rating has not arrived', async () => {
    await generateMonth([baseInvoice])

    expect(screen.getByText('Rating…')).toBeInTheDocument()

    mockReviews.mockResolvedValue([baseReview])
    await tick(5000)

    expect(screen.queryByText('Rating…')).not.toBeInTheDocument()
  })

  // A retainer is never rated — one manual line, nothing to check — so a month
  // of nothing else is already finished waiting.
  it('never waits on a retainer', async () => {
    await generateMonth([{ ...baseInvoice, kind: 'retainer' }])
    const afterGenerate = mockReviews.mock.calls.length

    await tick(30000)

    expect(mockReviews.mock.calls.length).toBe(afterGenerate)
    expect(screen.queryByText('Rating…')).not.toBeInTheDocument()
  })

  it('gives up after about three minutes rather than asking forever', async () => {
    await generateMonth([baseInvoice])

    // Nothing ever lands.
    await tick(3 * 60 * 1000)
    const atTheCap = mockReviews.mock.calls.length
    expect(atTheCap).toBeGreaterThan(30)

    await tick(60000)
    expect(mockReviews.mock.calls.length).toBe(atTheCap)
  })

  // Generate is idempotent. Pressing it on a month that is already built
  // creates nothing and schedules no ratings — promising some for three
  // minutes would be describing work that is not happening.
  it('does not wait for ratings when nothing was built', async () => {
    vi.useFakeTimers()
    mockList.mockResolvedValue([baseInvoice])
    mockReviews.mockResolvedValue([])
    mockGenerate.mockResolvedValue({ period: '2026-11', created: [], skipped: [] })
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
    await tick(0)
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
    await tick(0)
    const afterGenerate = mockReviews.mock.calls.length

    await tick(30000)

    expect(mockReviews.mock.calls.length).toBe(afterGenerate)
    expect(screen.queryByText('Rating…')).not.toBeInTheDocument()
  })

  /**
   * The poll and her Re-rate button both write the same slot, and a tick that
   * read the list BEFORE she pressed it can land after the answer to her press.
   * Overwriting there would put the superseded rating back on screen — with its
   * old questions, whose ids the server has retired, so answering one would
   * 404. Newest wins, whatever order they arrive in.
   */
  it('does not let an older list undo a rating she just asked for', async () => {
    vi.useFakeTimers()
    const older: InvoiceAiReview = { ...askingReview, createdAt: '2026-12-01T00:00:00.000Z' }
    const newer: InvoiceAiReview = {
      ...baseReview,
      id: 'rev-2',
      createdAt: '2026-12-03T00:00:00.000Z',
      summary: 'Checked again — this looks right.',
    }
    // A second, still-unrated invoice is what keeps the poll running after her
    // re-rate — otherwise there would be nothing left to wait for and no tick
    // to arrive late.
    const other: PersistedInvoice = {
      ...baseInvoice,
      id: 'inv-2',
      number: 'INV-2026-11-002',
    }
    mockList.mockResolvedValue([baseInvoice, other])
    mockReviews.mockResolvedValue([older])
    mockGenerate.mockResolvedValue({
      period: '2026-11',
      created: [baseInvoice, other],
      skipped: [],
    })
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
    await tick(0)
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
    await tick(0)

    // Her re-rate lands first…
    mockRate.mockResolvedValue(newer)
    fireEvent.click(screen.getByText('INV-2026-11-001'))
    fireEvent.click(screen.getByRole('button', { name: 'Re-rate' }))
    await tick(0)
    expect(screen.getByText('Checked again — this looks right.')).toBeInTheDocument()

    // …and a tick still holding the older list lands after it.
    await tick(5000)

    expect(screen.getByText('Checked again — this looks right.')).toBeInTheDocument()
    expect(screen.getAllByText('AI: high confidence').length).toBeGreaterThan(0)
    expect(screen.queryByText('AI: check 2 things')).not.toBeInTheDocument()
  })

  it('stops asking when the month run goes away', async () => {
    const view = await generateMonth([baseInvoice])

    await tick(5000)
    const beforeUnmount = mockReviews.mock.calls.length
    view.unmount()

    await tick(30000)

    expect(mockReviews.mock.calls.length).toBe(beforeUnmount)
  })
})

/**
 * Ratings normally arrive behind Generate, which would leave the feature
 * invisible on drafts that already exist — including the ones she would want to
 * try it on first.
 */
describe('InvoiceMonthRun — rating an invoice by hand', () => {
  it('offers to rate an unrated draft', async () => {
    await openEditor([baseInvoice], [])

    expect(screen.getByText('This invoice hasn’t been rated.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Rate with AI' })).toBeInTheDocument()
    // Still nothing on the row — "not rated" is the state of every invoice
    // built before this shipped, and forty rows saying so would be noise.
    expect(screen.queryByText(/^AI:/)).not.toBeInTheDocument()
  })

  it('offers it on a reviewed invoice too', async () => {
    await openEditor([{ ...baseInvoice, status: 'reviewed' }], [], /Reviewed/)

    expect(screen.getByRole('button', { name: 'Rate with AI' })).toBeInTheDocument()
  })

  // Rating something the client is already holding would be asking the model to
  // second-guess a document that has gone out.
  it('does not offer it once the invoice has been sent', async () => {
    await openEditor([{ ...baseInvoice, status: 'sent' }], [], /Sent/)

    expect(screen.queryByRole('button', { name: 'Rate with AI' })).not.toBeInTheDocument()
    expect(screen.queryByText('This invoice hasn’t been rated.')).not.toBeInTheDocument()
  })

  it('does not offer it on a retainer', async () => {
    await openEditor([{ ...baseInvoice, kind: 'retainer' }], [])

    expect(screen.queryByRole('button', { name: 'Rate with AI' })).not.toBeInTheDocument()
  })

  it('does not offer it on a voided invoice', async () => {
    const voided: PersistedInvoice = { ...baseInvoice, status: 'void' }
    mockList.mockResolvedValue([voided])
    mockReviews.mockResolvedValue([])
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
    await waitFor(() => expect(mockReviews).toHaveBeenCalled())

    fireEvent.click(await screen.findByRole('tab', { name: /Voided/ }))
    fireEvent.click(screen.getByText('INV-2026-11-001'))

    expect(screen.queryByRole('button', { name: 'Rate with AI' })).not.toBeInTheDocument()
  })

  it('swaps the shell for the real card once the rating comes back', async () => {
    mockRate.mockResolvedValue(askingReview)
    await openEditor([baseInvoice], [])

    fireEvent.click(screen.getByRole('button', { name: 'Rate with AI' }))

    expect(
      await screen.findByText('Two lines are worth a second look before this goes out.'),
    ).toBeInTheDocument()
    expect(mockRate).toHaveBeenCalledWith('inv-1')
    expect(screen.queryByText('This invoice hasn’t been rated.')).not.toBeInTheDocument()
    // And now the row has something to say.
    expect(screen.getAllByText('AI: check 2 things').length).toBeGreaterThan(0)
  })

  it('renders a refusal in the shell without disturbing anything else', async () => {
    mockRate.mockRejectedValue(
      new ApiError(503, 'The AI reviewer is not configured on this server.'),
    )
    await openEditor([baseInvoice], [])

    fireEvent.click(screen.getByRole('button', { name: 'Rate with AI' }))

    expect(
      await screen.findByText('The AI reviewer is not configured on this server.'),
    ).toBeInTheDocument()
    expect(reviewButton()).not.toBeDisabled()
  })
})
