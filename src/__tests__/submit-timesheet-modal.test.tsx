import { act, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SubmitTimesheetModal } from '../components/SubmitTimesheetModal'
import type { TimeEntry, TimesheetLock, WeeklySubmission } from '../lib/types'

/**
 * The guided submit prompt, as the client will read it.
 *
 * The rejected behavior was "clicking submit just sends the week on screen," so
 * these pin the two things she asked for: a past week that still needs
 * submitting is auto-selected and named, and the CURRENT week is never sent
 * without the explicit "are you finished?" yes.
 */

const ME = 'emp-me'
// Wednesday of the week of Sun Aug 9, 2026.
const TODAY = new Date('2026-08-12T12:00:00')

let seq = 0
function entry(date: string, minutes = 60): TimeEntry {
  seq += 1
  return {
    id: `time-${seq}`,
    employeeId: ME,
    clientId: 'client-1',
    date,
    minutes,
    description: 'Work',
    approvalStatus: 'pending',
  } as TimeEntry
}

function renderModal({
  entries = [] as TimeEntry[],
  submissions = [] as WeeklySubmission[],
  locks = [] as TimesheetLock[],
  onSubmit = vi.fn().mockResolvedValue(undefined),
  previewMode = false,
} = {}) {
  const onClose = vi.fn()
  render(
    <SubmitTimesheetModal
      employeeId={ME}
      entries={entries}
      submissions={submissions}
      locks={locks}
      previewMode={previewMode}
      onSubmit={onSubmit}
      onClose={onClose}
    />,
  )
  return { onSubmit, onClose }
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(TODAY)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('SubmitTimesheetModal', () => {
  it('auto-selects the oldest past week and counts the rest', () => {
    renderModal({
      entries: [entry('2026-07-21'), entry('2026-07-29'), entry('2026-08-04'), entry('2026-08-11')],
    })

    expect(screen.getByText(/Submitting week of/)).toBeInTheDocument()
    expect(screen.getByText('Sun Jul 19 – Sat Jul 25')).toBeInTheDocument()
    expect(
      screen.getByText('2 more past weeks still need submitting after this one.'),
    ).toBeInTheDocument()
    // The current week is NOT the question yet.
    expect(screen.queryByText(/Are you finished logging time/)).not.toBeInTheDocument()
  })

  it('submits the named past week, not the current one', async () => {
    const { onSubmit } = renderModal({
      entries: [entry('2026-07-21'), entry('2026-08-11')],
    })

    fireEvent.click(screen.getByRole('button', { name: 'Submit this week' }))
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit).toHaveBeenCalledWith('2026-07-19')
  })

  it('asks the completion question when no prior week is left', () => {
    renderModal({ entries: [entry('2026-08-11')] })

    expect(
      screen.getByText('All past weeks are submitted — nothing prior to submit.'),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'Are you finished logging time for the current week (Sun Aug 9 – Sat Aug 15)? Submitting sends it to the owner for approval.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Yes, submit this week' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Not yet' })).toBeInTheDocument()
  })

  it('sends the current week only on the explicit yes', async () => {
    const { onSubmit } = renderModal({ entries: [entry('2026-08-11')] })

    expect(onSubmit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Yes, submit this week' }))
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith('2026-08-09'))
  })

  it('"Not yet" closes without submitting', () => {
    const { onSubmit, onClose } = renderModal({ entries: [entry('2026-08-11')] })

    fireEvent.click(screen.getByRole('button', { name: 'Not yet' }))
    expect(onClose).toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('advances to the next oldest past week after a submit lands', async () => {
    // The parent owns the workspace data, so a successful submit shows up as a
    // new submission row — which is what moves the prompt along.
    function Harness() {
      const [submissions, setSubmissions] = useState<WeeklySubmission[]>([])
      return (
        <SubmitTimesheetModal
          employeeId={ME}
          entries={[entry('2026-07-21'), entry('2026-07-29'), entry('2026-08-11')]}
          submissions={submissions}
          locks={[]}
          previewMode={false}
          onSubmit={async (weekStart) => {
            setSubmissions((current) => [
              ...current,
              {
                id: `sub-${weekStart}`,
                userId: ME,
                weekStart,
                submittedAt: '2026-08-12T12:00:00.000Z',
                status: 'pending',
              },
            ])
          }}
          onClose={vi.fn()}
        />
      )
    }
    render(<Harness />)

    expect(screen.getByText('Sun Jul 19 – Sat Jul 25')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Submit this week' }))

    // Next oldest is now the target, with the one just sent confirmed above it.
    await screen.findByText('Sun Jul 26 – Sat Aug 1')
    expect(
      screen.getByText('Week of Sun Jul 19 – Sat Jul 25 submitted for approval.'),
    ).toBeInTheDocument()
    expect(screen.getByText('This is the last past week waiting on you.')).toBeInTheDocument()

    // And once that one lands too, the flow rolls into the current-week question.
    fireEvent.click(screen.getByRole('button', { name: 'Submit this week' }))
    await screen.findByText(/Are you finished logging time for the current week/)
  })

  it('says a past week was sent back rather than calling it a fresh submit', () => {
    renderModal({
      entries: [entry('2026-07-21')],
      submissions: [
        {
          id: 'sub-1',
          userId: ME,
          weekStart: '2026-07-19',
          submittedAt: '2026-07-26T12:00:00.000Z',
          status: 'rejected',
        },
      ],
    })

    expect(
      screen.getByText('An owner sent this week back. Submitting it again returns it for review.'),
    ).toBeInTheDocument()
  })

  it('offers no submit button when the current week is already pending', () => {
    renderModal({
      entries: [entry('2026-08-11')],
      submissions: [
        {
          id: 'sub-1',
          userId: ME,
          weekStart: '2026-08-09',
          submittedAt: '2026-08-11T12:00:00.000Z',
          status: 'pending',
        },
      ],
    })

    expect(
      screen.getByText(
        "The current week (Sun Aug 9 – Sat Aug 15) is already submitted and awaiting the owner's approval.",
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /submit this week/i })).not.toBeInTheDocument()
  })

  /**
   * featreq-cbb7efe8 asked for the page-level button to gray out once a week is
   * in. The in-flight half of "no duplicate submits" lives here instead: the
   * confirm button is the one that actually POSTs, so it has to close behind
   * itself while the request is open.
   */
  /**
   * The whole in-flight window, start to finish: the button closes behind
   * itself while the POST is open, exactly one POST goes out, and the flow
   * comes back rather than wedging on a stuck `submitting`.
   *
   * Note on what is NOT asserted here. `handleConfirm` opens with
   * `if (submitting || previewMode) return`, and there is no render test that
   * can reach it: React drops click events on any element whose props say
   * `disabled`, so while the request is open nothing gets through to the
   * handler at all — not even a hand-dispatched click on a node whose
   * attribute has been stripped. The disabled prop IS the mechanism; that
   * short-circuit is a backstop behind it. Asserting "the disabled button did
   * nothing when clicked" would only re-test the attribute, so this asserts the
   * behavior that actually matters: one click, one POST, and a live button
   * afterward.
   */
  it('disables the confirm button for the duration of one in-flight submit', async () => {
    let release: () => void = () => {}
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    renderModal({ entries: [entry('2026-08-11')], onSubmit })

    fireEvent.click(screen.getByRole('button', { name: 'Yes, submit this week' }))

    const pending = await screen.findByRole('button', { name: 'Submitting…' })
    expect(pending).toBeDisabled()
    expect(onSubmit).toHaveBeenCalledTimes(1)

    await act(async () => {
      release()
    })

    // The week landed, and the button is live again rather than stuck.
    expect(
      screen.getByText('Week of Sun Aug 9 – Sat Aug 15 submitted for approval.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Yes, submit this week' })).toBeEnabled()
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  /**
   * Reporting surfaces moved to two-decimal hours ("20.22h"). This is NOT one:
   * someone about to submit their own week reads "1h 20m", not "1.33h". The
   * split is deliberate, so it gets a test rather than a comment.
   */
  it('states the week total in hours and minutes, not decimal hours', () => {
    renderModal({ entries: [entry('2026-08-04', 80)] })
    expect(screen.getByText(/1h 20m logged\./)).toBeInTheDocument()
    expect(screen.queryByText(/1\.33h/)).not.toBeInTheDocument()
  })
})
