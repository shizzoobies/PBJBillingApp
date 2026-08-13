import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CompletedWaits } from '../components/CompletedWaits'
import {
  completedWaits,
  describeWaitProvenance,
  shortDate,
  stepIsWaiting,
  WAITING_CLEAR_PATCH,
  WAITING_DONE_PATCH,
} from '../lib/utils'
import { waitingStepConcernsUser } from '../../lib/waiting-on-state.js'
import type { Employee, WaitingOn } from '../lib/types'

/**
 * "Person A created the waiting task, it sent it to Person B — B completed the
 * task and marked it done — A received the notification and clicked Confirmed
 * on the waiting task and it disappeared. The waiting and information in it
 * needs to stay as a sub task shown as completed like other tasks are when you
 * click the box." — the firm owner, featreq-b05a2f3a.
 *
 * ROOT CAUSE, for anyone reading this in six months: nothing was ever deleted.
 * `markWaitingOnVerified` keeps the row, and always did. The record only ever
 * RENDERED inside the amber waiting editor, and that editor is mounted on
 * `stepIsWaiting(...)` — which goes false the instant the last wait is
 * confirmed (a verified entry stops counting as open, by design, or every
 * finished hand-off would leave its step amber forever). Confirm therefore
 * unmounted the only thing drawing the record.
 *
 * The fix is a second home for it, outside the editor and outside all of its
 * conditions: {@link CompletedWaits}.
 */

const A = 'emp-brit' // asked for the help
const B = 'emp-lisa' // was waited on
const EMPLOYEES = [
  { id: A, name: 'Brittany Fox', role: 'owner' },
  { id: B, name: 'Lisa Chen', role: 'Bookkeeper' },
] as Employee[]

const CREATED = '2026-08-05T15:00:00.000Z'
const RESOLVED = '2026-08-07T15:00:00.000Z'
const VERIFIED = '2026-08-08T15:00:00.000Z'
/** Formatted the way the app formats every other date — never a hard-coded string. */
const on = (iso: string) => shortDate.format(new Date(iso))

const waiting = (over: Partial<WaitingOn> = {}): WaitingOn => ({
  id: 'wo-1',
  blockerId: B,
  requestedBy: A,
  createdAt: CREATED,
  ...over,
})
const resolved = (over: Partial<WaitingOn> = {}) =>
  waiting({ resolvedAt: RESOLVED, resolvedBy: B, ...over })
const verified = (over: Partial<WaitingOn> = {}) =>
  resolved({ verifiedAt: VERIFIED, verifiedBy: A, ...over })

describe('completedWaits', () => {
  it('is exactly the confirmed ones — the editor still owns the live ones', () => {
    expect(completedWaits([waiting({ id: 'wo-a' })])).toEqual([])
    // Marked done but not yet confirmed: still a live hand-off, still the
    // editor's ("awaiting your OK"), so not here.
    expect(completedWaits([resolved({ id: 'wo-b' })])).toEqual([])
    expect(completedWaits([verified({ id: 'wo-c' })]).map((entry) => entry.id)).toEqual(['wo-c'])
  })

  it('copes with a step that never had any', () => {
    expect(completedWaits(undefined)).toEqual([])
    expect(completedWaits([])).toEqual([])
  })
})

describe('describeWaitProvenance', () => {
  it('names all three people and both dates', () => {
    expect(
      describeWaitProvenance(verified(), { employees: EMPLOYEES, clientLabel: 'Acme Dental' }),
    ).toBe(
      `asked by Brittany Fox ${on(CREATED)} · done by Lisa Chen ${on(RESOLVED)} · confirmed by Brittany Fox ${on(VERIFIED)}`,
    )
  })

  it('names the CLIENT on a client wait, not a stranger from the employee list', () => {
    // `blockerId` points at the client record here — resolving it against
    // employees is what used to print "Unassigned" for the one name that mattered.
    const entry = verified({ blockerId: 'client-acme', blockerType: 'client', resolvedBy: undefined })
    const line = describeWaitProvenance(entry, {
      employees: EMPLOYEES,
      clientLabel: 'Acme Dental',
    })
    expect(line).toContain(`done by Acme Dental ${on(RESOLVED)}`)
    expect(line).toContain('confirmed by Brittany Fox')
  })
})

describe('a confirmed wait on the step', () => {
  const renderFor = (waitingOns: WaitingOn[]) =>
    render(
      <CompletedWaits
        waitingOns={waitingOns}
        employees={EMPLOYEES}
        clientLabel="Acme Dental"
      />,
    )

  it('stays put, as a checked-off sub-item with its full provenance', () => {
    renderFor([verified({ note: 'the bank statements' })])

    const row = screen.getByRole('checkbox', { name: 'Waited on Lisa Chen — completed' })
    expect(row).toBeChecked()
    expect(screen.getByText('Waited on Lisa Chen')).toBeInTheDocument()
    expect(screen.getByText(/the bank statements/)).toBeInTheDocument()
    // Who asked, who did it, who confirmed it — the whole receipt, readable.
    const trail = screen.getByText(/asked by/)
    expect(trail).toHaveTextContent('asked by Brittany Fox')
    expect(trail).toHaveTextContent('done by Lisa Chen')
    expect(trail).toHaveTextContent('confirmed by Brittany Fox')
  })

  it('is struck through, the way a ticked task is', () => {
    renderFor([verified()])
    expect(screen.getByText('Waited on Lisa Chen')).toHaveClass('waiting-record-label')
  })

  /**
   * The box belongs to the WAIT, never to the step. Prior rounds settled that
   * completing work is the checkboxes' job and a finishing wait must not tick
   * anything off — so this one cannot be clicked at all.
   */
  it('offers no way to complete anything from here', () => {
    renderFor([verified()])
    expect(screen.getByRole('checkbox')).toBeDisabled()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('renders nothing at all while the hand-off is still live', () => {
    const { container } = renderFor([waiting(), resolved({ id: 'wo-2' })])
    expect(container).toBeEmptyDOMElement()
  })

  it('lists several closed-out waits, oldest first', () => {
    renderFor([
      verified({ id: 'wo-1' }),
      verified({ id: 'wo-2', blockerId: 'client-acme', blockerType: 'client' }),
    ])

    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getByText('Waited on Lisa Chen')).toBeInTheDocument()
    expect(within(rows[1]).getByText('Waited on Acme Dental')).toBeInTheDocument()
  })
})

/**
 * The other half of her step 4: it leaves the Delayed queue. That is correct
 * and stays correct — resolved work is not stuck work — and it is precisely the
 * behavior that used to take the record with it.
 */
describe('after the confirmation', () => {
  it('the step stops being "waiting", so it drops off the Delayed page', () => {
    const step = { waiting: false, waitingOns: [verified()] }
    expect(stepIsWaiting(step)).toBe(false)
    expect(waitingStepConcernsUser(step, { userId: A, assigneeId: A })).toBe(false)
    expect(waitingStepConcernsUser(step, { userId: B, assigneeId: A })).toBe(false)
  })

  it('but the record is still on the step, which is the whole point', () => {
    expect(completedWaits([verified()])).toHaveLength(1)
  })
})

/**
 * Done and Clear are opposites and must stay that way: Done keeps the receipt,
 * Clear erases it. Neither ever completes the step.
 */
describe('the waiting editor buttons keep their meanings', () => {
  it('Clear erases the note', () => {
    expect(WAITING_CLEAR_PATCH).toEqual({
      waiting: false,
      waitingOn: null,
      waitingForChecklistId: null,
    })
  })

  it('Done keeps it', () => {
    expect(WAITING_DONE_PATCH).not.toHaveProperty('waitingOn')
  })

  it('neither checks the step off', () => {
    expect(WAITING_CLEAR_PATCH).not.toHaveProperty('done')
    expect(WAITING_DONE_PATCH).not.toHaveProperty('done')
  })
})
