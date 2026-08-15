import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DelayedPage } from '../pages/DelayedPage'
import type { AppContextValue } from '../AppContext'
import type { AppData, Checklist, WaitingOn } from '../lib/types'

/**
 * The Delayed page's two halves, from the firm owner's fourth round on the
 * waiting-on flow (featreq-b05a2f3a), verbatim:
 *
 *   "On the Delayed tab when person A sends it to Person B - Person B should be
 *    able to click done on their delayed tab and it goes away. On Person A's
 *    delayed tab it should show as delayed but no button to push done just so
 *    they can see and remember it (maybe a waiting on me and a I am waiting on
 *    others tabs within delayed to keep it organized). Then when person B
 *    pushes done it should show in Person A's delayed where they can push
 *    complete."
 *
 * So this file is about one thing: WHO sees WHAT, and which buttons they get.
 * The state machine underneath is pinned in lib/waiting-on-state.test.mjs and
 * the persistence in db/store-staleness.test.mjs; here it is the page.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))

const A = 'emp-brit' // asked for the help
const B = 'emp-lisa' // is being waited on
const C = 'emp-avery' // uninvolved
const CLIENT = { id: 'client-acme', name: 'Acme Dental' }

const wait = (over: Partial<WaitingOn> = {}): WaitingOn => ({
  id: 'wo-1',
  blockerId: B,
  requestedBy: A,
  note: 'the bank statements',
  createdAt: '2026-08-05T15:00:00.000Z',
  ...over,
})
const resolved = (over: Partial<WaitingOn> = {}) =>
  wait({ resolvedAt: '2026-08-07T15:00:00.000Z', resolvedBy: B, ...over })
const verified = (over: Partial<WaitingOn> = {}) =>
  resolved({ verifiedAt: '2026-08-08T15:00:00.000Z', verifiedBy: A, ...over })

const checklistWith = (items: Checklist['items']): Checklist =>
  ({
    id: 'cl-1',
    clientId: CLIENT.id,
    title: 'August close',
    dueDate: '2026-08-31',
    items,
  }) as Checklist

const step = (waitingOns: WaitingOn[], over: Record<string, unknown> = {}) => ({
  id: 'it-1',
  label: 'Bank rec',
  done: false,
  assigneeId: A,
  waitingOns,
  subItems: [],
  ...over,
})

let contextValue: AppContextValue
const waitingOnDone = vi.fn()
const waitingOnVerify = vi.fn()
const waitingOnSendBack = vi.fn()
const toggleChecklistItem = vi.fn()
const toggleSubItem = vi.fn()

function signInAs(viewerId: string, checklists: Checklist[]) {
  contextValue = {
    data: {
      clients: [CLIENT],
      employees: [
        { id: A, name: 'Brittany Fox', role: 'owner' },
        { id: B, name: 'Lisa Chen', role: 'Bookkeeper' },
        { id: C, name: 'Avery Stone', role: 'Bookkeeper' },
      ],
      checklists,
    } as unknown as AppData,
    activeEmployeeId: viewerId,
    toggleChecklistItem,
    toggleSubItem,
    waitingOnDone,
    waitingOnVerify,
    waitingOnSendBack,
  } as unknown as AppContextValue
}

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/delayed']}>
      <DelayedPage />
    </MemoryRouter>,
  )

const tab = (name: RegExp) => screen.getByRole('tab', { name })
/** The one wait line inside a Delayed row — where the per-role buttons live. */
const waitLine = (text: RegExp) => {
  const found = screen.getByText(text).closest('li.delayed-wait')
  if (!found) throw new Error(`no wait line matching ${text}`)
  return found as HTMLElement
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('routing by role', () => {
  it('puts an open wait on the blocker "Waiting on me"', () => {
    signInAs(B, [checklistWith([step([wait()])])])
    renderPage()

    expect(tab(/Waiting on me/)).toHaveAttribute('aria-selected', 'true')
    expect(tab(/Waiting on me/)).toHaveTextContent('1')
    expect(tab(/I'm waiting on others/)).toHaveTextContent('0')
    expect(screen.getByText(/Waiting on Lisa Chen/)).toBeInTheDocument()
  })

  it('puts the same wait on the requester "I\'m waiting on others"', () => {
    signInAs(A, [checklistWith([step([wait()])])])
    renderPage()

    expect(tab(/I'm waiting on others/)).toHaveAttribute('aria-selected', 'true')
    expect(tab(/I'm waiting on others/)).toHaveTextContent('1')
    expect(tab(/Waiting on me/)).toHaveTextContent('0')
  })

  it('shows it to nobody else', () => {
    signInAs(C, [checklistWith([step([wait()])])])
    renderPage()

    expect(tab(/Waiting on me/)).toHaveTextContent('0')
    expect(tab(/I'm waiting on others/)).toHaveTextContent('0')
    expect(screen.queryByText(/Waiting on Lisa Chen/)).not.toBeInTheDocument()
  })

  /**
   * The case the split exists for: one person owes work on one step and is
   * owed work on another. Both tabs have exactly one item, and neither leaks
   * into the other.
   */
  it('splits a person who is BOTH, on different items', () => {
    signInAs(B, [
      checklistWith([
        step([wait({ id: 'wo-owed', blockerId: B, requestedBy: A })]),
        step([wait({ id: 'wo-asked', blockerId: C, requestedBy: B })], {
          id: 'it-2',
          label: 'Payroll journal',
          assigneeId: B,
        }),
      ]),
    ])
    renderPage()

    expect(tab(/Waiting on me/)).toHaveTextContent('1')
    expect(tab(/I'm waiting on others/)).toHaveTextContent('1')

    // Blocking tab: only the one owed BY them.
    expect(screen.getByText(/Waiting on Lisa Chen/)).toBeInTheDocument()
    expect(screen.queryByText(/Waiting on Avery Stone/)).not.toBeInTheDocument()

    fireEvent.click(tab(/I'm waiting on others/))
    expect(screen.getByText(/Waiting on Avery Stone/)).toBeInTheDocument()
    expect(screen.queryByText(/Waiting on Lisa Chen/)).not.toBeInTheDocument()
  })

  it('defaults to whichever tab has work, and an explicit click still wins', () => {
    signInAs(A, [checklistWith([step([wait()])])])
    renderPage()

    // Only "others" has anything, so that is where it lands.
    expect(tab(/I'm waiting on others/)).toHaveAttribute('aria-selected', 'true')
    // ...and clicking the quiet tab must not bounce straight back.
    fireEvent.click(tab(/Waiting on me/))
    expect(tab(/Waiting on me/)).toHaveAttribute('aria-selected', 'true')
  })
})

describe('the blocker side', () => {
  it('gets a plain Done that resolves the WAIT, not the step', () => {
    signInAs(B, [checklistWith([step([wait()])])])
    renderPage()

    const done = within(waitLine(/Waiting on Lisa Chen/)).getByRole('button', { name: /Done/ })
    fireEvent.click(done)

    expect(waitingOnDone).toHaveBeenCalledWith('cl-1', 'wo-1')
    // The invariant from every prior round: nothing here completes the step.
    expect(toggleChecklistItem).not.toHaveBeenCalled()
    expect(toggleSubItem).not.toHaveBeenCalled()
  })

  it('loses it from their list the moment it is resolved', () => {
    signInAs(B, [checklistWith([step([resolved()])])])
    renderPage()

    expect(tab(/Waiting on me/)).toHaveTextContent('0')
    expect(tab(/I'm waiting on others/)).toHaveTextContent('0')
    expect(screen.queryByText(/Waiting on Lisa Chen/)).not.toBeInTheDocument()
  })
})

describe('the requester side', () => {
  it('is a read-only reminder while the wait is still open', () => {
    signInAs(A, [checklistWith([step([wait()])])])
    renderPage()

    const line = waitLine(/Waiting on Lisa Chen/)
    // Her words: "no button to push done just so they can see and remember it".
    expect(within(line).queryAllByRole('button')).toHaveLength(0)
    expect(line).toHaveTextContent('the bank statements')
  })

  it('gains exactly two buttons once the blocker reports done', () => {
    signInAs(A, [checklistWith([step([resolved()])])])
    renderPage()

    const line = waitLine(/Waiting on Lisa Chen/)
    const buttons = within(line).getAllByRole('button')
    expect(buttons.map((button) => button.textContent)).toEqual(['Approve', 'Send back'])
    expect(line).toHaveTextContent('Lisa Chen says done')
  })

  it('Approve closes it out through the existing verified state', () => {
    signInAs(A, [checklistWith([step([resolved()])])])
    renderPage()

    fireEvent.click(within(waitLine(/Waiting on Lisa Chen/)).getByRole('button', { name: 'Approve' }))
    expect(waitingOnVerify).toHaveBeenCalledWith('cl-1', 'wo-1')
  })

  it('leaves BOTH lists once approved, and the step is never ticked off', () => {
    for (const viewer of [A, B]) {
      signInAs(viewer, [checklistWith([step([verified()])])])
      const view = renderPage()
      expect(tab(/Waiting on me/)).toHaveTextContent('0')
      expect(tab(/I'm waiting on others/)).toHaveTextContent('0')
      view.unmount()
    }
    expect(toggleChecklistItem).not.toHaveBeenCalled()
  })
})

describe('send back', () => {
  it('asks for a note before it will go anywhere', () => {
    signInAs(A, [checklistWith([step([resolved()])])])
    renderPage()

    fireEvent.click(within(waitLine(/Waiting on Lisa Chen/)).getByRole('button', { name: 'Send back' }))

    // The composer replaces the pair; sending is refused until it says something.
    expect(screen.getByRole('button', { name: 'Send it back' })).toBeDisabled()
    expect(waitingOnSendBack).not.toHaveBeenCalled()
  })

  it('sends the new note back to the blocker', () => {
    signInAs(A, [checklistWith([step([resolved()])])])
    renderPage()

    fireEvent.click(within(waitLine(/Waiting on Lisa Chen/)).getByRole('button', { name: 'Send back' }))
    fireEvent.change(screen.getByRole('textbox', { name: /Note for Lisa Chen/ }), {
      target: { value: '  the March page is missing  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send it back' }))

    expect(waitingOnSendBack).toHaveBeenCalledWith('cl-1', 'wo-1', 'the March page is missing')
  })

  it('can be backed out of without sending anything', () => {
    signInAs(A, [checklistWith([step([resolved()])])])
    renderPage()

    const line = waitLine(/Waiting on Lisa Chen/)
    fireEvent.click(within(line).getByRole('button', { name: 'Send back' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(waitingOnSendBack).not.toHaveBeenCalled()
    expect(within(waitLine(/Waiting on Lisa Chen/)).getAllByRole('button')).toHaveLength(2)
  })

  /**
   * After the send-back the wait is B's move again: back on B's tab, with a
   * Done, and carrying BOTH notes. A is back to a read-only reminder until B
   * re-resolves it.
   */
  const sentBack = wait({
    sendBacks: [
      {
        at: '2026-08-08T09:00:00.000Z',
        by: A,
        note: 'the March page is missing',
        resolvedAt: '2026-08-07T15:00:00.000Z',
        resolvedBy: B,
      },
    ],
  })

  it('returns to the blocker tab with a Done and the reason', () => {
    signInAs(B, [checklistWith([step([sentBack])])])
    renderPage()

    expect(tab(/Waiting on me/)).toHaveTextContent('1')
    const line = waitLine(/Waiting on Lisa Chen/)
    expect(within(line).getByRole('button', { name: /Done/ })).toBeInTheDocument()
    // Both notes survive: the original ask and the rejection.
    expect(line).toHaveTextContent('the bank statements')
    expect(line).toHaveTextContent('Sent back by Brittany Fox — the March page is missing')
  })

  it('takes the requester back to a read-only reminder', () => {
    signInAs(A, [checklistWith([step([sentBack])])])
    renderPage()

    expect(tab(/I'm waiting on others/)).toHaveTextContent('1')
    expect(within(waitLine(/Waiting on Lisa Chen/)).queryAllByRole('button')).toHaveLength(0)
  })
})

/**
 * The one place the step's own done-toggle survives on this page: an OLD
 * free-text wait, which has no wait record to resolve. Removing it would strand
 * every pre-structured wait on the page with no way to clear it.
 */
describe('an old free-text wait', () => {
  const legacyStep = {
    id: 'it-legacy',
    label: 'Chase the client',
    done: false,
    assigneeId: A,
    waiting: true,
    waitingOn: 'client to send statements',
    waitingOns: [],
    subItems: [],
  }

  it('sits under "I\'m waiting on others" and keeps its step Done', () => {
    signInAs(A, [checklistWith([legacyStep] as unknown as Checklist['items'])])
    renderPage()

    expect(tab(/I'm waiting on others/)).toHaveTextContent('1')
    expect(screen.getByText('client to send statements')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Done/ }))
    expect(toggleChecklistItem).toHaveBeenCalledWith('cl-1', 'it-legacy')
  })
})
