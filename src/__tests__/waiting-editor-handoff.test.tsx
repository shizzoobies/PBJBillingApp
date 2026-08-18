import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WaitingEditor } from '../pages/ChecklistsPage'
import { CompletedWaits } from '../components/CompletedWaits'
import type { Employee, WaitingOn } from '../lib/types'

/**
 * The waiting editor on a checklist step, against the firm owner's fourth round
 * (featreq-b05a2f3a). Two instructions drive this whole file:
 *
 *   "At the beginning of set up the current done button should be save - So when
 *    you click waiting you choose the name of person you are waiting on put in
 *    the note and then click save or clear should you accidentally have clicked
 *    waiting - there should be no additional edits available once it is created."
 *
 *   "On the checklist tab ... When it is pending it just looks like a sub task
 *    shows waiting on X - if completed then we just need one button to approve
 *    and mark completed or a button to not approve and send back with another
 *    note."
 *
 * Picking a name used to POST immediately with no note attached, so the note she
 * describes had nowhere to go and a misclick created a real wait somebody had to
 * cancel. Now the pick is held until Save, and the note travels WITH the wait.
 */

// The editor's "Saved" badge reads `dataSyncState` off the context; nothing
// else in this component touches it.
vi.mock('../AppContext', () => ({ useAppContext: () => ({ dataSyncState: 'idle' }) }))

const A = 'emp-brit' // asked for the help
const B = 'emp-lisa' // is being waited on
const C = 'emp-avery' // a third party, for steps carrying more than one wait
const EMPLOYEES = [
  { id: A, name: 'Brittany Fox', role: 'owner' },
  { id: B, name: 'Lisa Chen', role: 'Bookkeeper' },
  { id: C, name: 'Avery Diaz', role: 'Bookkeeper' },
] as Employee[]

const waiting = (over: Partial<WaitingOn> = {}): WaitingOn => ({
  id: 'wo-1',
  blockerId: B,
  requestedBy: A,
  note: 'the bank statements',
  createdAt: '2026-08-05T15:00:00.000Z',
  ...over,
})
const resolved = (over: Partial<WaitingOn> = {}) =>
  waiting({ resolvedAt: '2026-08-07T15:00:00.000Z', resolvedBy: B, ...over })
const verified = (over: Partial<WaitingOn> = {}) =>
  resolved({ verifiedAt: '2026-08-08T15:00:00.000Z', verifiedBy: A, ...over })

const handlers = {
  onSetNote: vi.fn(),
  onSetWaitingFor: vi.fn(),
  onClear: vi.fn(),
  onDone: vi.fn(),
  onAddWaitingOn: vi.fn(),
  onDoneWaitingOn: vi.fn(),
  onVerifyWaitingOn: vi.fn(),
  onSendBackWaitingOn: vi.fn(),
}

function renderEditor(options: { viewerId?: string; waitingOns?: WaitingOn[] } = {}) {
  return render(
    <WaitingEditor
      note=""
      employees={EMPLOYEES}
      availableTasks={[]}
      waitingOns={options.waitingOns ?? []}
      activeEmployeeId={options.viewerId ?? A}
      isOwner={false}
      stepAssigneeId={A}
      clientName="Acme Dental"
      {...handlers}
    />,
  )
}

const picker = () => screen.getByRole('combobox', { name: 'Waiting on a person' })
/** The one live-wait chip in the editor — where the per-stage buttons live. */
const chip = () => {
  const found = document.querySelectorAll('li.waiting-blocker-chip')
  if (found.length !== 1) throw new Error(`expected one waiting chip, found ${found.length}`)
  return found[0] as HTMLElement
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('creating a wait is Save, and it is final', () => {
  it('does not create anything the moment a name is picked', () => {
    renderEditor()
    fireEvent.change(picker(), { target: { value: B } })
    expect(handlers.onAddWaitingOn).not.toHaveBeenCalled()
  })

  it('relabels the primary button Done -> Save while a name is held', () => {
    renderEditor()
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()

    fireEvent.change(picker(), { target: { value: B } })

    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument()
  })

  it('saves the person AND the note together', () => {
    renderEditor()
    fireEvent.change(picker(), { target: { value: B } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Note for this wait' }), {
      target: { value: '  the bank statements  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(handlers.onAddWaitingOn).toHaveBeenCalledWith(B, 'the bank statements')
  })

  it('saves a wait on the CLIENT the same way', () => {
    renderEditor()
    fireEvent.change(picker(), { target: { value: 'client' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(handlers.onAddWaitingOn).toHaveBeenCalledWith('client', '')
  })

  // "or clear should you accidentally have clicked waiting"
  it('Clear discards a misclick without creating anything', () => {
    renderEditor()
    fireEvent.change(picker(), { target: { value: B } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Note for this wait' }), {
      target: { value: 'oops' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))

    expect(handlers.onAddWaitingOn).not.toHaveBeenCalled()
    // ...and it did NOT erase the step, which is what Clear means otherwise.
    expect(handlers.onClear).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument()
  })

  // The Clear that erases is still there — it is only borrowed while composing.
  it('Clear still erases the step note when nothing is being composed', () => {
    renderEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(handlers.onClear).toHaveBeenCalled()
  })

  it('offers no way to edit the person or note of a wait that exists', () => {
    renderEditor({ waitingOns: [waiting()] })
    // The chip is text and buttons — no inputs anywhere near it.
    expect(within(chip()).queryAllByRole('textbox')).toHaveLength(0)
    expect(within(chip()).queryAllByRole('combobox')).toHaveLength(0)
    expect(chip()).toHaveTextContent('the bank statements')
  })
})

describe('the three states, read off the step', () => {
  it('PENDING reads "Waiting on <name>" with the note', () => {
    renderEditor({ waitingOns: [waiting()] })
    expect(screen.getByText('Waiting on Lisa Chen')).toBeInTheDocument()
    expect(chip()).toHaveTextContent('the bank statements')
  })

  // Her fifth round: "User should not be able to remove the information once it
  // is saved." The × that erased the wait outright lived here, and it is gone —
  // the requester now has nothing to press until the blocker reports done.
  it('PENDING gives the requester nothing to press at all', () => {
    renderEditor({ viewerId: A, waitingOns: [waiting()] })
    expect(within(chip()).queryAllByRole('button')).toHaveLength(0)
  })

  it('PENDING gives the blocker their Mark done', () => {
    renderEditor({ viewerId: B, waitingOns: [waiting()] })
    fireEvent.click(within(chip()).getByRole('button', { name: 'Mark done' }))
    expect(handlers.onDoneWaitingOn).toHaveBeenCalledWith('wo-1')
  })

  // "if completed then we just need one button to approve and mark completed or
  // a button to not approve and send back with another note." Exactly two, and
  // neither of them removes anything.
  it('RESOLVED gives the requester exactly Approve and Send back', () => {
    renderEditor({ viewerId: A, waitingOns: [resolved()] })
    const labels = within(chip())
      .getAllByRole('button')
      .map((button) => button.textContent)
    expect(labels).toEqual(['Approve', 'Send back'])
  })

  it('RESOLVED shows the blocker nothing to press — their turn is over', () => {
    renderEditor({ viewerId: B, waitingOns: [resolved()] })
    expect(within(chip()).queryAllByRole('button')).toHaveLength(0)
  })

  it('Approve routes to the existing verify transition', () => {
    renderEditor({ viewerId: A, waitingOns: [resolved()] })
    fireEvent.click(within(chip()).getByRole('button', { name: 'Approve' }))
    expect(handlers.onVerifyWaitingOn).toHaveBeenCalledWith('wo-1')
  })

  it('Send back carries a new note and leaves the original alone', () => {
    renderEditor({ viewerId: A, waitingOns: [resolved()] })
    fireEvent.click(within(chip()).getByRole('button', { name: 'Send back' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Note for Lisa Chen' }), {
      target: { value: 'the March page is missing' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send it back' }))

    expect(handlers.onSendBackWaitingOn).toHaveBeenCalledWith('wo-1', 'the March page is missing')
    // Nothing rewrote the wait's own note.
    expect(handlers.onSetNote).not.toHaveBeenCalled()
  })

  it('shows the rejection on the chip once it has been sent back', () => {
    renderEditor({
      viewerId: B,
      waitingOns: [
        waiting({
          sendBacks: [{ at: '2026-08-08T09:00:00.000Z', by: A, note: 'the March page is missing' }],
        }),
      ],
    })
    expect(chip()).toHaveTextContent('the bank statements')
    expect(chip()).toHaveTextContent('Sent back by Brittany Fox — the March page is missing')
  })

  /**
   * VERIFIED already had a home from the previous round — the struck-through
   * completed sub-item. It must stay OUT of the editor (which unmounts once the
   * last wait closes) and IN {@link CompletedWaits}.
   */
  it('VERIFIED leaves the editor entirely and renders as the completed record', () => {
    renderEditor({ viewerId: A, waitingOns: [verified()] })
    expect(screen.queryByText(/Waiting on Lisa Chen/)).not.toBeInTheDocument()

    render(
      <CompletedWaits waitingOns={[verified()]} employees={EMPLOYEES} clientLabel="Acme Dental" />,
    )
    expect(
      screen.getByRole('checkbox', { name: 'Waited on Lisa Chen — completed' }),
    ).toBeChecked()
  })
})

/**
 * Her fifth round (the send-back that produced this file's second pass):
 *
 *   "User should not be able to remove the information once it is saved, we
 *    don't want to lose the data and we don't want to impact other people
 *    interacting with it."
 *
 * The × was one of two ways to erase a saved wait from this editor. The other
 * was the primary Done, which used to CANCEL any blocker that wasn't yours to
 * finish — the quiet one, because it deleted somebody else's record as a side
 * effect of tidying your own step.
 */
describe('a saved wait cannot be removed from the editor', () => {
  it('offers no removal control at any stage, to anyone', () => {
    for (const viewerId of [A, B]) {
      for (const entry of [waiting(), resolved()]) {
        const view = renderEditor({ viewerId, waitingOns: [entry] })
        const labels = within(chip())
          .queryAllByRole('button')
          .map((button) => button.textContent)
        expect(labels).not.toContain('×')
        expect(labels.join(' ')).not.toMatch(/cancel|remove|delete/i)
        view.unmount()
      }
    }
  })

  it("Done leaves a colleague's open wait alone and says whose move it is", async () => {
    renderEditor({ viewerId: A, waitingOns: [waiting()] })
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Still waiting on Lisa Chen — only they can mark their part done.',
    )
    // Nothing was retired on her behalf, and the step was not un-flagged either:
    // it is genuinely still blocked.
    expect(handlers.onDoneWaitingOn).not.toHaveBeenCalled()
    expect(handlers.onVerifyWaitingOn).not.toHaveBeenCalled()
    expect(handlers.onDone).not.toHaveBeenCalled()
  })

  it('Done still retires the waits that ARE yours to finish', async () => {
    renderEditor({ viewerId: B, waitingOns: [waiting()] })
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))

    await waitFor(() => expect(handlers.onDoneWaitingOn).toHaveBeenCalledWith('wo-1'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('Done still confirms one the other side has reported done', async () => {
    renderEditor({ viewerId: A, waitingOns: [resolved()] })
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))

    await waitFor(() => expect(handlers.onVerifyWaitingOn).toHaveBeenCalledWith('wo-1'))
  })

  /**
   * The blocker clearing her own amber. Her wait is reported done and sitting
   * with whoever asked, so Done is not hers to press — but it used to be planned
   * as `verify`, which the server answers "You cannot confirm this waiting-on
   * request". The refusal is now stated before the request is made, in terms of
   * the person she is actually waiting on.
   */
  it('tells the blocker whose approval it is sitting with, without a 403', async () => {
    renderEditor({ viewerId: B, waitingOns: [resolved()] })
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent("Waiting on Brittany Fox's approval.")
    expect(alert).not.toHaveTextContent('cannot')
    expect(handlers.onVerifyWaitingOn).not.toHaveBeenCalled()
    expect(handlers.onDone).not.toHaveBeenCalled()
  })

  // An OWNER gets what the chip offers them, not a lecture about whose move it
  // is: `canMarkWaitingOnDone` says yes for an owner at the amber stage.
  it('lets an owner press Done on a colleague’s wait, as the chip does', async () => {
    render(
      <WaitingEditor
        note=""
        employees={EMPLOYEES}
        availableTasks={[]}
        waitingOns={[waiting()]}
        activeEmployeeId={C}
        isOwner
        stepAssigneeId={null}
        clientName="Acme Dental"
        {...handlers}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))

    await waitFor(() => expect(handlers.onDoneWaitingOn).toHaveBeenCalledWith('wo-1'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  /**
   * THE contract for a step carrying more than one wait: the half that is yours
   * moves, the half that isn't stays put and is named. A future tidy-up that
   * made Done all-or-nothing would break this silently in either direction —
   * either stranding your own wait or reaching for someone else's again.
   */
  it('on a mixed step, retires only my own wait and names the other', async () => {
    renderEditor({
      viewerId: B,
      waitingOns: [
        waiting({ id: 'wo-mine', blockerId: B, requestedBy: A }),
        waiting({ id: 'wo-avery', blockerId: C, requestedBy: B }),
      ],
    })
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))

    await waitFor(() => expect(handlers.onDoneWaitingOn).toHaveBeenCalledWith('wo-mine'))
    expect(handlers.onDoneWaitingOn).toHaveBeenCalledTimes(1)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Still waiting on Avery Diaz')
    expect(alert).not.toHaveTextContent('Lisa Chen')
    // The step is still blocked on Avery, so it is NOT un-flagged.
    expect(handlers.onDone).not.toHaveBeenCalled()
  })

  it('names each person once, however many of their waits are on the step', async () => {
    renderEditor({
      viewerId: A,
      waitingOns: [
        waiting({ id: 'wo-1', blockerId: B }),
        waiting({ id: 'wo-2', blockerId: B }),
      ],
    })
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent?.match(/Lisa Chen/g)).toHaveLength(1)
    // …and never the placeholder `employeeName` hands back for an unknown id.
    expect(alert).not.toHaveTextContent('Unassigned')
  })

  // The scope guard: this round is about the saved wait, not the step's own
  // free-text note, which keeps its editor and its Clear exactly as they were.
  it('leaves the free-text note section untouched', () => {
    renderEditor({ waitingOns: [waiting()] })
    expect(
      screen.getByPlaceholderText('e.g. the client to send statements (free-text note)'),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(handlers.onClear).toHaveBeenCalled()
  })
})

/** "it should either be waiting on another employee or the client" — ANOTHER. */
describe('you cannot wait on yourself', () => {
  it('leaves you out of the picker', () => {
    renderEditor({ viewerId: A })
    const names = within(picker())
      .getAllByRole('option')
      .map((option) => option.textContent)
    expect(names).not.toContain('Brittany Fox')
    expect(names).toContain('Lisa Chen')
    expect(names).toContain('Acme Dental')
  })

  it('leaves the OTHER person out when they are the one looking', () => {
    renderEditor({ viewerId: B })
    const names = within(picker())
      .getAllByRole('option')
      .map((option) => option.textContent)
    expect(names).not.toContain('Lisa Chen')
    expect(names).toContain('Brittany Fox')
  })
})
