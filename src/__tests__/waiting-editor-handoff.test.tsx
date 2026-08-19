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
  onAskWaitingOn: vi.fn(),
}

function renderEditor(
  options: {
    viewerId?: string
    waitingOns?: WaitingOn[]
    availableTasks?: Array<{ id: string; title: string }>
    waitingForChecklistId?: string
    stepDone?: boolean
  } = {},
) {
  return render(
    <WaitingEditor
      note=""
      employees={EMPLOYEES}
      availableTasks={options.availableTasks ?? []}
      waitingForChecklistId={options.waitingForChecklistId}
      waitingOns={options.waitingOns ?? []}
      activeEmployeeId={options.viewerId ?? A}
      isOwner={false}
      stepAssigneeId={A}
      clientName="Acme Dental"
      stepDone={options.stepDone ?? false}
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

    // `undefined`, not null: the task picker was never touched, so Save says
    // nothing about the link and the step keeps whatever it had.
    expect(handlers.onAddWaitingOn).toHaveBeenCalledWith(B, 'the bank statements', undefined)
  })

  it('saves a wait on the CLIENT the same way', () => {
    renderEditor()
    fireEvent.change(picker(), { target: { value: 'client' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(handlers.onAddWaitingOn).toHaveBeenCalledWith('client', '', undefined)
  })

  it('says nothing about the task link when the picker was never touched', () => {
    renderEditor({
      availableTasks: [{ id: 'cl-a2', title: 'Acme bank rec' }],
      waitingForChecklistId: 'cl-a2',
    })
    fireEvent.change(picker(), { target: { value: B } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(handlers.onAddWaitingOn).toHaveBeenCalledWith(B, '', undefined)
  })

  it('sends an explicit null when the draft clears the task', () => {
    renderEditor({
      availableTasks: [{ id: 'cl-a2', title: 'Acme bank rec' }],
      waitingForChecklistId: 'cl-a2',
    })
    fireEvent.change(picker(), { target: { value: B } })
    fireEvent.change(screen.getByRole('combobox', { name: /Waiting for another task/i }), {
      target: { value: '' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(handlers.onAddWaitingOn).toHaveBeenCalledWith(B, '', null)
  })

  /**
   * The third field of the same draft (featreq-8b7d06d7). It used to save
   * itself the instant the select changed, which meant a task link could
   * outlive a wait that was never created — and, now that a saved wait is
   * locked, a link that half-saved would be unrepairable.
   */
  it('carries the waited-for task in the same Save, writing nothing before it', () => {
    renderEditor({ availableTasks: [{ id: 'cl-a2', title: 'Acme bank rec' }] })
    fireEvent.change(picker(), { target: { value: B } })
    fireEvent.change(screen.getByRole('combobox', { name: /Waiting for another task/i }), {
      target: { value: 'cl-a2' },
    })
    // Nothing has been written yet — not the wait, and not the task link.
    expect(handlers.onSetWaitingFor).not.toHaveBeenCalled()
    expect(handlers.onAddWaitingOn).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(handlers.onAddWaitingOn).toHaveBeenCalledWith(B, '', 'cl-a2')
    expect(handlers.onSetWaitingFor).not.toHaveBeenCalled()
  })

  /**
   * The back door: composing a SECOND wait re-opened the editor, and the draft
   * carried a freely-changeable copy of a task link the first wait had already
   * locked. Save would then write the very field the PATCH route 409s. The
   * picker belongs to the FIRST wait only; the server refuses the change too.
   */
  it('offers no task picker at all while a saved wait is live', () => {
    renderEditor({
      waitingOns: [waiting()],
      availableTasks: [{ id: 'cl-a2', title: 'Acme bank rec' }],
      waitingForChecklistId: 'cl-a2',
    })
    fireEvent.change(picker(), { target: { value: C } })

    expect(
      screen.queryByRole('combobox', { name: /Waiting for another task/i }),
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    // …and the create says nothing about the locked link.
    expect(handlers.onAddWaitingOn).toHaveBeenCalledWith(C, '', undefined)
  })

  it('throws the whole draft away on Clear, task link included', () => {
    renderEditor({ availableTasks: [{ id: 'cl-a2', title: 'Acme bank rec' }] })
    fireEvent.change(picker(), { target: { value: B } })
    fireEvent.change(screen.getByRole('combobox', { name: /Waiting for another task/i }), {
      target: { value: 'cl-a2' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))

    expect(handlers.onAddWaitingOn).not.toHaveBeenCalled()
    expect(handlers.onSetWaitingFor).not.toHaveBeenCalled()
    expect(handlers.onClear).not.toHaveBeenCalled()
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
 * SAVE LOCKS EVERYTHING — her annotated screenshots (featreq-8b7d06d7): "all
 * info is locked and cannot be changed." This deliberately REVERSES the earlier
 * round where the step's note stayed editable beside a saved wait; her email is
 * the newer word.
 *
 * So while a wait is live the editor has no note box, no task picker, no Clear
 * and no Done. What is left is the wait's own chip, which carries the only
 * actions there are — and on an "awaiting your OK" wait that is exactly the
 * Approve / Send back pair she drew, with the Done she crossed out gone.
 *
 * The lock LIFTS once every wait is approved, or a step whose hand-offs are all
 * finished would sit amber forever with nothing left to quiet it.
 */
describe('a saved wait locks the step', () => {
  const surfaces = () => ({
    note: screen.queryByPlaceholderText('e.g. the client to send statements (free-text note)'),
    taskPicker: screen.queryByRole('combobox', { name: /Waiting for another task/i }),
    clear: screen.queryByRole('button', { name: 'Clear' }),
    done: screen.queryByRole('button', { name: 'Done' }),
  })

  it('takes the note box, the task picker, Clear and Done away', () => {
    renderEditor({
      viewerId: A,
      waitingOns: [waiting()],
      availableTasks: [{ id: 'cl-a2', title: 'Acme bank rec' }],
    })
    const found = surfaces()
    expect(found.note).toBeNull()
    expect(found.taskPicker).toBeNull()
    expect(found.clear).toBeNull()
    expect(found.done).toBeNull()
  })

  it('locks it for the person being waited on too, not just whoever asked', () => {
    renderEditor({ viewerId: B, waitingOns: [waiting()] })
    expect(surfaces().clear).toBeNull()
    expect(surfaces().done).toBeNull()
  })

  // Her item 4, verbatim in shape: READ-ONLY, and exactly two actions.
  it('leaves an AWAITING YOUR OK wait with Approve and Send back, and nothing else', () => {
    renderEditor({
      viewerId: A,
      waitingOns: [resolved()],
      availableTasks: [{ id: 'cl-a2', title: 'Acme bank rec' }],
    })
    expect(surfaces().done).toBeNull()
    expect(surfaces().note).toBeNull()
    expect(surfaces().taskPicker).toBeNull()
    expect(
      screen.getAllByRole('button').map((button) => button.textContent),
    ).toEqual(['Approve', 'Send back'])
  })

  it('still says what task the step is waiting for, without offering to change it', () => {
    renderEditor({
      viewerId: A,
      waitingOns: [waiting()],
      availableTasks: [{ id: 'cl-a2', title: 'Acme bank rec' }],
      waitingForChecklistId: 'cl-a2',
    })
    expect(screen.getByText('Waiting for: Acme bank rec')).toBeInTheDocument()
    expect(surfaces().taskPicker).toBeNull()
  })

  it('gives the step its controls back once every wait is approved', () => {
    renderEditor({
      viewerId: A,
      waitingOns: [verified()],
      availableTasks: [{ id: 'cl-a2', title: 'Acme bank rec' }],
    })
    const found = surfaces()
    expect(found.note).not.toBeNull()
    expect(found.clear).not.toBeNull()
    expect(found.done).not.toBeNull()
    expect(found.taskPicker).not.toBeNull()
  })

  // Adding ANOTHER wait is not editing the saved one — the picker stays, and it
  // brings the draft's own Save and Clear back with it.
  it('still lets a second wait be composed, with its own Save and Clear', () => {
    renderEditor({ viewerId: A, waitingOns: [waiting()] })
    fireEvent.change(picker(), { target: { value: C } })

    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    // The escape hatch discarded the draft and touched nothing that was saved.
    expect(handlers.onAddWaitingOn).not.toHaveBeenCalled()
    expect(handlers.onClear).not.toHaveBeenCalled()
  })
})

/**
 * Her fifth round, still standing: "User should not be able to remove the
 * information once it is saved, we don't want to lose the data and we don't
 * want to impact other people interacting with it."
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

  // The whole editor, not just the chip: nothing anywhere on it erases a wait.
  it('offers nothing that erases one anywhere else on the editor either', () => {
    renderEditor({ viewerId: A, waitingOns: [waiting()] })
    const labels = screen.queryAllByRole('button').map((button) => button.textContent)
    expect(labels.join(' ')).not.toMatch(/cancel|remove|delete|clear/i)
  })
})

/**
 * The question B sends back WITHOUT finishing (featreq-8b7d06d7). It is asked
 * from the Delayed page — see delayed-tabs.test.tsx — but A reads it here, on
 * the step, which is the only reason it is rendered at all.
 */
describe('a question on a live wait', () => {
  const asked = waiting({
    questions: [{ at: '2026-08-08T09:00:00.000Z', by: B, note: 'which account?' }],
  })

  it('reads on the chip, attributed, beside the original ask', () => {
    renderEditor({ viewerId: A, waitingOns: [asked] })
    expect(chip()).toHaveTextContent('the bank statements')
    expect(chip()).toHaveTextContent('Question from Lisa Chen — which account?')
  })

  it('changes nothing about the stage — it is still theirs to finish', () => {
    renderEditor({ viewerId: A, waitingOns: [asked] })
    // Still PENDING, so A has nothing to press: a question is not an approval.
    expect(within(chip()).queryAllByRole('button')).toHaveLength(0)
    expect(screen.getByText('Waiting on Lisa Chen')).toBeInTheDocument()
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

/**
 * The task picker (featreq-5dd514b8). The list itself is built and unit-tested
 * in `src/lib/waitForTaskOptions.ts`; what is pinned here is that whatever it
 * returns actually reaches the select AND that a saved cross-client link shows
 * as the chosen row rather than silently reading "not waiting on a task".
 */
describe('the waiting-for-a-task picker', () => {
  const OTHER_CLIENT = { id: 'cl-globex', title: 'Globex close (Globex Freight)' }

  it('renders exactly the options it is handed', () => {
    renderEditor({ availableTasks: [{ id: 'cl-a2', title: 'Acme bank rec' }] })
    const names = within(screen.getByRole('combobox', { name: /Waiting for another task/i }))
      .getAllByRole('option')
      .map((option) => option.textContent)
    expect(names).toEqual(['— not waiting on a task —', 'Acme bank rec'])
  })

  it('shows an appended cross-client link as the selected task', () => {
    renderEditor({
      availableTasks: [{ id: 'cl-a2', title: 'Acme bank rec' }, OTHER_CLIENT],
      waitingForChecklistId: OTHER_CLIENT.id,
    })
    const select = screen.getByRole('combobox', {
      name: /Waiting for another task/i,
    }) as HTMLSelectElement
    expect(select.value).toBe(OTHER_CLIENT.id)
    expect(within(select).getByRole('option', { name: OTHER_CLIENT.title })).toBeInTheDocument()
  })

  it('hides the row entirely when there is nothing to wait on', () => {
    renderEditor({ availableTasks: [] })
    expect(
      screen.queryByRole('combobox', { name: /Waiting for another task/i }),
    ).not.toBeInTheDocument()
  })
})

/**
 * Save is a REQUEST, and it has to be treated like one. It was fired and
 * forgotten: the draft was wiped before the create landed, so a refusal threw
 * away everything typed and surfaced nowhere, and the button re-enabled
 * immediately — a second press on a slow connection creating a second wait that
 * can never be removed.
 */
describe('Save waits for the server', () => {
  it('keeps the draft, and says why, when the create is refused', async () => {
    handlers.onAddWaitingOn.mockRejectedValueOnce(
      new Error('This wait was saved, so who it names is fixed.'),
    )
    renderEditor({ availableTasks: [{ id: 'cl-a2', title: 'Acme bank rec' }] })
    fireEvent.change(picker(), { target: { value: B } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Note for this wait' }), {
      target: { value: 'the bank statements' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: /Waiting for another task/i }), {
      target: { value: 'cl-a2' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('who it names is fixed')
    // Everything typed is still on screen, beside the reason.
    expect(screen.getByRole('textbox', { name: 'Note for this wait' })).toHaveValue(
      'the bank statements',
    )
    expect(picker()).toHaveValue(B)
    expect(screen.getByRole('combobox', { name: /Waiting for another task/i })).toHaveValue('cl-a2')
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
  })

  it('stays disabled until the create lands, so one click is one wait', async () => {
    let land = () => {}
    handlers.onAddWaitingOn.mockImplementationOnce(
      () => new Promise<void>((resolve) => { land = resolve }),
    )
    renderEditor()
    fireEvent.change(picker(), { target: { value: B } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    const saving = await screen.findByRole('button', { name: 'Saving…' })
    expect(saving).toBeDisabled()
    // A second press while it is in flight cannot reach the handler.
    fireEvent.click(saving)
    expect(handlers.onAddWaitingOn).toHaveBeenCalledTimes(1)

    land()
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Saving…' })).not.toBeInTheDocument(),
    )
    // The draft is discarded only now, on success.
    expect(picker()).toHaveValue('')
  })
})

/**
 * The blocker's Question, on the step (featreq-8b7d06d7). Mark done has always
 * been reachable from the checklist; asking should not require a trip to the
 * Delayed page to answer "which account?".
 */
describe('the Question button on the chip', () => {
  it('is offered to the person being waited on, beside Mark done', () => {
    renderEditor({ viewerId: B, waitingOns: [waiting()] })
    const labels = within(chip())
      .getAllByRole('button')
      .map((button) => button.textContent)
    expect(labels).toEqual(['Mark done', 'Question'])
  })

  it('is not offered to the person who asked — they have Send back', () => {
    renderEditor({ viewerId: A, waitingOns: [resolved()] })
    const labels = within(chip())
      .getAllByRole('button')
      .map((button) => button.textContent)
    expect(labels).not.toContain('Question')
  })

  it('sends the message and finishes nothing', async () => {
    renderEditor({ viewerId: B, waitingOns: [waiting()] })
    fireEvent.click(within(chip()).getByRole('button', { name: 'Question' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Question for Brittany Fox' }), {
      target: { value: '  which account?  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() =>
      expect(handlers.onAskWaitingOn).toHaveBeenCalledWith('wo-1', 'which account?'),
    )
    expect(handlers.onDoneWaitingOn).not.toHaveBeenCalled()
    expect(handlers.onVerifyWaitingOn).not.toHaveBeenCalled()
  })

  it('never appears on a client wait — a client has no login to read it', () => {
    renderEditor({
      viewerId: A,
      waitingOns: [waiting({ blockerId: 'client-acme', blockerType: 'client' })],
    })
    const labels = within(chip())
      .getAllByRole('button')
      .map((button) => button.textContent)
    expect(labels).toEqual(['Heard back'])
  })
})

/**
 * Ticking the step off used to unmount this editor outright — including a wait
 * that was still LIVE, which stayed on the Delayed page with no Approve left on
 * the step. The step is done; the hand-off is not.
 */
describe('a ticked step with a wait still open', () => {
  it('keeps the chip and its actions', () => {
    renderEditor({ viewerId: A, waitingOns: [resolved()], stepDone: true })
    expect(screen.getByText(/This step is checked off/)).toBeInTheDocument()
    const labels = within(chip())
      .getAllByRole('button')
      .map((button) => button.textContent)
    expect(labels).toEqual(['Approve', 'Send back'])
  })

  it('offers nothing that starts, edits or un-flags anything', () => {
    renderEditor({
      viewerId: A,
      waitingOns: [resolved()],
      availableTasks: [{ id: 'cl-a2', title: 'Acme bank rec' }],
      stepDone: true,
    })
    expect(screen.queryByRole('combobox', { name: 'Waiting on a person' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument()
    expect(
      screen.queryByPlaceholderText('e.g. the client to send statements (free-text note)'),
    ).not.toBeInTheDocument()
  })
})

/**
 * A refused question must not eat what was typed — the same rule Save follows.
 * The composer can only manage that if the rejection actually reaches it, which
 * is why the editor rethrows for this one caller after showing the reason.
 */
describe('a question the server refuses', () => {
  it('keeps the message on screen and says why', async () => {
    handlers.onAskWaitingOn.mockRejectedValueOnce(
      new Error('This wait has already been marked done'),
    )
    renderEditor({ viewerId: B, waitingOns: [waiting()] })
    fireEvent.click(within(chip()).getByRole('button', { name: 'Question' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Question for Brittany Fox' }), {
      target: { value: 'which account?' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('already been marked done')
    expect(screen.getByRole('textbox', { name: 'Question for Brittany Fox' })).toHaveValue(
      'which account?',
    )
  })

  it('closes the composer once it lands', async () => {
    renderEditor({ viewerId: B, waitingOns: [waiting()] })
    fireEvent.click(within(chip()).getByRole('button', { name: 'Question' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Question for Brittany Fox' }), {
      target: { value: 'which account?' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() =>
      expect(
        screen.queryByRole('textbox', { name: 'Question for Brittany Fox' }),
      ).not.toBeInTheDocument(),
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
