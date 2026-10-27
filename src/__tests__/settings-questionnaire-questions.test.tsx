import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { defaultProposalPricing } from '../../lib/proposal-pricing.js'
import {
  buildQuestionnaire,
  cleanCustomQuestions,
  customQuestionProblems,
  flattenQuestions,
  withCustomQuestions,
  type QuestionnaireCustomQuestion,
} from '../../lib/proposal-questionnaire.js'
import { QuestionnaireQuestionsSection } from '../components/QuestionnaireQuestionsSection'
import { QuestionnaireSheet } from '../components/proposals/QuestionnaireSheet'
import { QuestionnaireAnswersPanel } from '../components/proposals/QuestionnaireInbox'
import { ApiError, DEFAULT_FIRM_SETTINGS, type FirmSettings, type ProposalQuestionnaire } from '../lib/types'

vi.mock('../lib/api', () => ({
  saveQuestionnaireAnswersRequest: vi.fn(() => Promise.resolve({})),
  submitQuestionnaireRequest: vi.fn(() => Promise.resolve({})),
}))

/**
 * "Questionnaire" on Settings (featreq-fccf901f): Brittany writes her own
 * follow-up questions, each optionally asked only after another answer. Every
 * change saves the whole list, and what it saves must pass the same check and
 * cleaner the server runs.
 */

const appQuestions = flattenQuestions(buildQuestionnaire(defaultProposalPricing()))

/** Feeds each save back into `settings`, the way the Settings page's commit does. */
function renderCard(initial: QuestionnaireCustomQuestion[] = []) {
  const onCommit = vi.fn()
  function Wrapper() {
    const [settings, setSettings] = useState<FirmSettings>({
      ...DEFAULT_FIRM_SETTINGS,
      proposalPricing: defaultProposalPricing(),
      questionnaireCustomQuestions: initial,
    })
    return (
      <QuestionnaireQuestionsSection
        settings={settings}
        onCommit={(patch) => {
          onCommit(patch)
          setSettings((prev) => ({ ...prev, ...patch }))
        }}
      />
    )
  }
  render(<Wrapper />)
  return onCommit
}

function lastSaved(onCommit: ReturnType<typeof vi.fn>): QuestionnaireCustomQuestion[] {
  const patch = onCommit.mock.calls.at(-1)?.[0] as Partial<FirmSettings>
  return patch.questionnaireCustomQuestions ?? []
}

/** Save the open editor and wait for the awaited save to close it. */
async function saveDraft() {
  fireEvent.click(screen.getByRole('button', { name: 'Save question' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Save question' })).toBeNull())
}

async function addQuestion(label: string, type: string, when?: { question: string; answer: string }, required = false) {
  fireEvent.click(screen.getByRole('button', { name: 'Add a follow-up question' }))
  fireEvent.change(screen.getByLabelText('Question'), { target: { value: label } })
  fireEvent.change(screen.getByLabelText('Answer type'), { target: { value: type } })
  if (required) fireEvent.click(screen.getByRole('checkbox', { name: 'Required when asked' }))
  if (when) {
    fireEvent.change(screen.getByLabelText('Ask only when'), { target: { value: when.question } })
    fireEvent.change(screen.getByLabelText('is'), { target: { value: when.answer } })
  }
  await saveDraft()
}

describe('the Questionnaire card on Settings', () => {
  it("lists the app's own questions read-only, by section, without their ids", () => {
    renderCard()
    const app = screen.getByText('The questions the app always asks').closest('details') as HTMLElement
    expect(within(app).getByText('What would you like help with?')).toBeTruthy()
    expect(within(app).getByText('Business basics')).toBeTruthy()
    expect(app.textContent).not.toMatch(/count:/)
    // A count only someone looking at the books can give is never on a link.
    expect(app.textContent).not.toContain('Balance sheet accounts')
    expect(within(app).queryByRole('button')).toBeNull()
  })

  it('adds a required follow-up asked only when a service was picked, and saves what the server keeps', async () => {
    const onCommit = renderCard()
    await addQuestion('Do you run payroll in-house?', 'yes_no', { question: 'services', answer: 'Payroll' }, true)
    const saved = lastSaved(onCommit)
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({
      label: 'Do you run payroll in-house?',
      type: 'yes_no',
      required: true,
      active: true,
      when: { questionId: 'services', answer: 'Payroll' },
    })
    expect(saved[0].id).toMatch(/^cq-[0-9a-f]{8}$/)
    expect(cleanCustomQuestions(saved)).toEqual(saved)
    expect(customQuestionProblems(saved, appQuestions)).toEqual([])
    expect(screen.getByText(/Asked only when “What would you like help with\?” is “Payroll”/)).toBeTruthy()
  })

  it('offers the picked question’s answers, and can depend on another follow-up', async () => {
    const onCommit = renderCard()
    await addQuestion('Do you have a bookkeeper today?', 'yes_no')
    const first = lastSaved(onCommit)[0]
    fireEvent.click(screen.getByRole('button', { name: 'Add a follow-up question' }))
    fireEvent.change(screen.getByLabelText('Ask only when'), { target: { value: first.id } })
    const answers = within(screen.getByLabelText('is')).getAllByRole('option').map((option) => option.textContent)
    expect(answers).toEqual(['answered (any answer)', 'Yes', 'No'])
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Who is it?' } })
    fireEvent.change(screen.getByLabelText('Answer type'), { target: { value: 'short_text' } })
    fireEvent.change(screen.getByLabelText('is'), { target: { value: 'yes' } })
    await saveDraft()
    expect(lastSaved(onCommit)[1].when).toEqual({ questionId: first.id, answer: 'yes' })
    expect(screen.getByText(/Asked only when “Do you have a bookkeeper today\?” is “Yes”/)).toBeTruthy()
  })

  it('a pick-one question saves its options, and is refused without any', async () => {
    const onCommit = renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Add a follow-up question' }))
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Which bank?' } })
    fireEvent.change(screen.getByLabelText('Answer type'), { target: { value: 'choice' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save question' }))
    expect(onCommit).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toMatch(/needs at least one option/)
    fireEvent.change(screen.getByLabelText('Options, one per line'), { target: { value: 'Chase\n\nPNC\n' } })
    await saveDraft()
    expect(lastSaved(onCommit)[0].options).toEqual(['Chase', 'PNC'])
  })

  it('turns a question off and on, edits it, and deletes it', async () => {
    const onCommit = renderCard([
      { id: 'cq-0000000a', label: 'Old wording', type: 'short_text', required: false, active: true },
    ])
    fireEvent.click(screen.getByRole('button', { name: 'Turn off Old wording' }))
    expect(lastSaved(onCommit)[0].active).toBe(false)
    expect(screen.getByText('(turned off)')).toBeTruthy()
    const turnOn = await screen.findByRole('button', { name: 'Turn on Old wording' })
    await waitFor(() => expect((turnOn as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(turnOn)
    await waitFor(() => expect(lastSaved(onCommit)[0].active).toBe(true))
    const edit = screen.getByRole('button', { name: 'Edit Old wording' })
    fireEvent.click(edit)
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'New wording' } })
    await saveDraft()
    expect(lastSaved(onCommit)).toEqual([
      { id: 'cq-0000000a', label: 'New wording', type: 'short_text', required: false, active: true },
    ])
    const del = screen.getByRole('button', { name: 'Delete New wording' })
    await waitFor(() => expect((del as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(del)
    await waitFor(() => expect(lastSaved(onCommit)).toEqual([]))
  })

  // Review M3: switching off a question another one depends on is refused.
  it('will not turn off a question an active one depends on', () => {
    const onCommit = renderCard([
      { id: 'cq-0000000a', label: 'Bookkeeper?', type: 'yes_no', required: false, active: true },
      { id: 'cq-0000000b', label: 'Who?', type: 'short_text', required: false, active: true, when: { questionId: 'cq-0000000a', answer: 'yes' } },
    ])
    fireEvent.click(screen.getByRole('button', { name: 'Turn off Bookkeeper?' }))
    expect(onCommit).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('"Who?" asks only after a question that is turned off.')
  })

  // Review LOW: the save is awaited; a refusal keeps what she typed and shows the server's reasons.
  it('keeps the editor open with the server’s reasons when the save is refused', async () => {
    const refusal = new ApiError(400, 'first reason', 'invalid_custom_questions')
    refusal.problems = ['first reason', 'second reason']
    const onCommit = vi.fn(() => Promise.reject(refusal))
    render(
      <QuestionnaireQuestionsSection
        settings={{ ...DEFAULT_FIRM_SETTINGS, proposalPricing: defaultProposalPricing(), questionnaireCustomQuestions: [] }}
        onCommit={onCommit}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add a follow-up question' }))
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Kept wording' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save question' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('first reason')
    expect(alert.textContent).toContain('second reason')
    expect((screen.getByLabelText('Question') as HTMLInputElement).value).toBe('Kept wording')
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('will not delete a question another one depends on', () => {
    const onCommit = renderCard([
      { id: 'cq-0000000a', label: 'Bookkeeper?', type: 'yes_no', required: false, active: true },
      { id: 'cq-0000000b', label: 'Who?', type: 'short_text', required: false, active: true, when: { questionId: 'cq-0000000a', answer: 'yes' } },
    ])
    fireEvent.click(screen.getByRole('button', { name: 'Delete Bookkeeper?' }))
    expect(onCommit).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toMatch(/"Who\?" asks only after a question that no longer exists/)
  })
})

const followUps: QuestionnaireCustomQuestion[] = [
  { id: 'cq-0000000a', label: 'Do you have a bookkeeper today?', type: 'yes_no', required: false, active: true },
  { id: 'cq-0000000b', label: 'Who is it?', type: 'short_text', required: false, active: true, when: { questionId: 'cq-0000000a', answer: 'yes' } },
]

const record = (answers: ProposalQuestionnaire['answers'] = {}): ProposalQuestionnaire => ({
  id: 'pq-1',
  mode: 'call',
  status: 'open',
  expired: false,
  questions: withCustomQuestions(buildQuestionnaire(defaultProposalPricing()), followUps),
  answers,
  emailLog: [],
  proposalId: null,
  sentTo: null,
  expiresAt: null,
  submittedAt: null,
  createdBy: null,
  createdAt: '2026-10-26T12:00:00.000Z',
  updatedAt: null,
})

describe('her follow-ups on the call sheet and the answers panel', () => {
  it('the sheet shows a follow-up only once the answer it depends on is given', () => {
    render(<QuestionnaireSheet questionnaire={record()} onSubmitted={() => {}} onWithdraw={() => {}} />)
    expect(screen.getByText('More about you')).toBeTruthy()
    expect(screen.queryByLabelText('Who is it?')).toBeNull()
    fireEvent.change(screen.getByLabelText('Do you have a bookkeeper today?'), { target: { value: 'yes' } })
    expect(screen.getByLabelText('Who is it?')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Do you have a bookkeeper today?'), { target: { value: 'no' } })
    expect(screen.queryByLabelText('Who is it?')).toBeNull()
  })

  it('the answers panel labels a follow-up by its words and a yes as Yes', () => {
    render(
      <QuestionnaireAnswersPanel
        questionnaire={{ ...record({ company: 'Acme', 'cq-0000000a': 'yes', 'cq-0000000b': 'Jo' }), status: 'submitted' }}
      />,
    )
    expect(screen.getByText('Do you have a bookkeeper today?').nextSibling?.textContent).toBe('Yes')
    expect(screen.getByText('Who is it?').nextSibling?.textContent).toBe('Jo')
  })
})
