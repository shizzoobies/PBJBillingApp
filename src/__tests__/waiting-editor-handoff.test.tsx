import { fireEvent, render, screen, within } from '@testing-library/react'
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
const EMPLOYEES = [
  { id: A, name: 'Brittany Fox', role: 'owner' },
  { id: B, name: 'Lisa Chen', role: 'Bookkeeper' },
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
  onCancelWaitingOn: vi.fn(),
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

  it('PENDING gives the requester nothing to press but cancel', () => {
    renderEditor({ viewerId: A, waitingOns: [waiting()] })
    const labels = within(chip())
      .getAllByRole('button')
      .map((button) => button.textContent)
    expect(labels).toEqual(['×'])
  })

  it('PENDING gives the blocker their Mark done', () => {
    renderEditor({ viewerId: B, waitingOns: [waiting()] })
    fireEvent.click(within(chip()).getByRole('button', { name: 'Mark done' }))
    expect(handlers.onDoneWaitingOn).toHaveBeenCalledWith('wo-1')
  })

  // "if completed then we just need one button to approve and mark completed or
  // a button to not approve and send back with another note." Exactly two —
  // which is why the × is gone at this stage.
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
