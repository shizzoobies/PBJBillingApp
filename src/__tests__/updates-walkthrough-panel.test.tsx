import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UpdatesPage } from '../pages/UpdatesPage'
import type { AppContextValue } from '../AppContext'
import type { AppData, FeatureRequest } from '../lib/types'

/**
 * "Walk me through it" on the Updates review interface — featreq-cb1c5f95.
 *
 * Brittany approves or sends back a shipped change from this card, and until
 * now the only thing on it explaining the change was the request SHE wrote,
 * months earlier. The button gives her the developer's account of what actually
 * landed, in her own terms, without leaving the card.
 *
 * The load-bearing assertion in here is the last one in each block: pressing
 * it, reading it, and even failing to generate it must leave the item's STATUS
 * exactly where it was. A review aid that could quietly approve something would
 * be worse than no aid at all.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))

vi.mock('../lib/api', () => ({
  confirmRejectFeedbackRequest: vi.fn(),
  spitballNewSessionRequest: vi.fn(),
  spitballRequest: vi.fn(),
  spitballSessionRequest: vi.fn(),
  walkthroughFeatureRequestRequest: vi.fn(),
}))

import { walkthroughFeatureRequestRequest } from '../lib/api'

const WALKTHROUGH = [
  '**What changed**',
  'The Send card now shows the address an invoice is about to go to.',
  '**Where to find it**',
  'Invoices → open the month run → Send.',
  '**Try it**',
  '1. Open Invoices. 2. Pick a client. 3. Press Send and read the line under the name.',
  '**What did NOT change**',
  'Nothing about how invoices are priced or emailed changed.',
].join('\n')

const item = (over: Partial<FeatureRequest> = {}): FeatureRequest =>
  ({
    id: 'featreq-cb1c5f95',
    userId: 'emp-patrice',
    title: 'Show the billing email on the Send card',
    description: 'I can never tell which address an invoice is about to go to.',
    type: 'feature',
    status: 'shipped',
    priority: 'medium',
    priorityRank: 0,
    shippedAt: '2026-09-22T14:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
    ...over,
  }) as FeatureRequest

const data = { employees: [{ id: 'emp-patrice', name: 'Brittany' }] } as unknown as AppData

let contextValue: AppContextValue
let updateFeatureRequest: ReturnType<typeof vi.fn>

function mountUpdates(requests: FeatureRequest[]) {
  updateFeatureRequest = vi.fn()
  contextValue = {
    ownerMode: true,
    data,
    featureRequests: requests,
    addFeatureRequest: vi.fn(),
    updateFeatureRequest,
    reorderFeatureRequests: vi.fn(),
    removeFeatureRequest: vi.fn(),
    refineFeatureRequest: vi.fn(),
  } as unknown as AppContextValue
  return render(<UpdatesPage />)
}

const walkButton = () => screen.getByRole('button', { name: /Walk me through it/ })

beforeEach(() => {
  vi.mocked(walkthroughFeatureRequestRequest).mockReset()
  vi.mocked(walkthroughFeatureRequestRequest).mockResolvedValue({
    walkthrough: WALKTHROUGH,
    walkthroughAt: '2026-09-22T15:00:00.000Z',
  })
})

describe('where the button lives', () => {
  it('sits with the two review controls on a shipped card', () => {
    const { container } = mountUpdates([item()])
    const meta = container.querySelector('.updates-card-meta')
    expect(meta).not.toBeNull()
    const controls = within(meta as HTMLElement)
    expect(controls.getByRole('button', { name: /Mark approved/ })).toBeInTheDocument()
    expect(controls.getByRole('button', { name: /Not approved/ })).toBeInTheDocument()
    expect(controls.getByRole('button', { name: /Walk me through it/ })).toBeInTheDocument()
  })

  it('is absent where the review controls are — an item nobody is approving yet', () => {
    mountUpdates([item({ status: 'planned' })])
    // The Planned tab holds the item; Shipped is empty, so neither set shows.
    fireEvent.click(screen.getByRole('tab', { name: 'Planned 1' }))
    expect(screen.queryByRole('button', { name: /Mark approved/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Walk me through it/ })).toBeNull()
  })
})

describe('pressing it', () => {
  it('opens an inline panel, asks the API once, and renders the four sections', async () => {
    const { container } = mountUpdates([item()])
    fireEvent.click(walkButton())

    // The waiting state she sees first.
    expect(screen.getByText('Preparing your walkthrough…')).toBeInTheDocument()

    await waitFor(() => expect(screen.getByText(/What changed/)).toBeInTheDocument())
    expect(walkthroughFeatureRequestRequest).toHaveBeenCalledTimes(1)
    expect(walkthroughFeatureRequestRequest).toHaveBeenCalledWith('featreq-cb1c5f95', {})

    const panel = container.querySelector('.updates-walkthrough-panel')
    expect(panel).not.toBeNull()
    expect(panel?.textContent).toContain('Where to find it')
    expect(panel?.textContent).toContain('Try it')
    expect(panel?.textContent).toContain('What did NOT change')
    // On the card, not over it — the title she is judging stays visible.
    expect(screen.getByText('Show the billing email on the Send card')).toBeInTheDocument()
    expect(panel?.textContent).toContain('Generated')
  })

  it('never touches the item’s status', async () => {
    mountUpdates([item()])
    fireEvent.click(walkButton())
    await waitFor(() => expect(screen.getByText(/What changed/)).toBeInTheDocument())
    expect(updateFeatureRequest).not.toHaveBeenCalled()

    // And the approve button beside it still does exactly its own job.
    fireEvent.click(screen.getByRole('button', { name: /Mark approved/ }))
    expect(updateFeatureRequest).toHaveBeenCalledTimes(1)
    expect(updateFeatureRequest).toHaveBeenCalledWith('featreq-cb1c5f95', { status: 'done' })
  })

  it('closes again on a second press', async () => {
    mountUpdates([item()])
    fireEvent.click(walkButton())
    await waitFor(() => expect(screen.getByText(/What changed/)).toBeInTheDocument())
    fireEvent.click(walkButton())
    expect(screen.queryByText(/What changed/)).toBeNull()
  })
})

describe('a walkthrough that is already stored', () => {
  it('shows immediately, without asking for another one', () => {
    mountUpdates([item({ walkthrough: WALKTHROUGH, walkthroughAt: '2026-09-22T15:00:00.000Z' })])
    fireEvent.click(walkButton())
    expect(screen.getByText(/What changed/)).toBeInTheDocument()
    expect(walkthroughFeatureRequestRequest).not.toHaveBeenCalled()
  })

  it('Regenerate is the one thing that asks for a new one', async () => {
    mountUpdates([item({ walkthrough: WALKTHROUGH, walkthroughAt: '2026-09-22T15:00:00.000Z' })])
    fireEvent.click(walkButton())
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }))

    await waitFor(() => expect(walkthroughFeatureRequestRequest).toHaveBeenCalledTimes(1))
    expect(walkthroughFeatureRequestRequest).toHaveBeenCalledWith('featreq-cb1c5f95', {
      regenerate: true,
    })
    expect(updateFeatureRequest).not.toHaveBeenCalled()
  })
})

describe('when the AI is unavailable', () => {
  it('says so in a sentence and leaves both review buttons working', async () => {
    vi.mocked(walkthroughFeatureRequestRequest).mockRejectedValue(
      new Error('The AI could not put a walkthrough together right now. Please try again.'),
    )
    mountUpdates([item()])
    fireEvent.click(walkButton())

    await waitFor(() =>
      expect(
        screen.getByText(/The AI could not put a walkthrough together right now/),
      ).toBeInTheDocument(),
    )
    expect(updateFeatureRequest).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /Mark approved/ }))
    expect(updateFeatureRequest).toHaveBeenCalledWith('featreq-cb1c5f95', { status: 'done' })
  })
})
