import { useMemo, useState } from 'react'
import { CollapsibleSection } from './SectionKit'
import { defaultProposalPricing } from '../../lib/proposal-pricing.js'
import {
  ANY_ANSWER,
  CUSTOM_QUESTION_TYPES,
  buildQuestionnaire,
  cleanCustomQuestions,
  customConditionAnswers,
  customQuestionProblems,
  flattenQuestions,
  newCustomQuestionId,
  publicQuestionnaire,
  type CustomQuestionType,
  type QuestionnaireCustomQuestion,
} from '../../lib/proposal-questionnaire.js'
import type { FirmSettings } from '../lib/types'

const TYPE_LABELS: Record<CustomQuestionType, string> = {
  yes_no: 'Yes or no',
  short_text: 'Short answer',
  long_text: 'Long answer',
  choice: 'Pick one from a list',
}

/** The editor's working copy of one question. */
type Draft = {
  id: string
  label: string
  help: string
  type: CustomQuestionType
  optionsText: string
  required: boolean
  active: boolean
  whenQuestionId: string
  whenAnswer: string
}

const blankDraft = (): Draft => ({
  id: newCustomQuestionId(),
  label: '',
  help: '',
  type: 'yes_no',
  optionsText: '',
  required: false,
  active: true,
  whenQuestionId: '',
  whenAnswer: ANY_ANSWER,
})

const draftOf = (entry: QuestionnaireCustomQuestion): Draft => ({
  id: entry.id,
  label: entry.label,
  help: entry.help ?? '',
  type: entry.type,
  optionsText: (entry.options ?? []).join('\n'),
  required: entry.required,
  active: entry.active,
  whenQuestionId: entry.when?.questionId ?? '',
  whenAnswer: entry.when?.answer ?? ANY_ANSWER,
})

function entryOf(draft: Draft): QuestionnaireCustomQuestion {
  const entry: QuestionnaireCustomQuestion = {
    id: draft.id,
    label: draft.label.trim(),
    type: draft.type,
    required: draft.required,
    active: draft.active,
  }
  if (draft.help.trim()) entry.help = draft.help.trim()
  if (draft.type === 'choice') {
    entry.options = draft.optionsText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  }
  if (draft.whenQuestionId) entry.when = { questionId: draft.whenQuestionId, answer: draft.whenAnswer }
  return entry
}

/**
 * "Questionnaire" on Settings (featreq-fccf901f): the questions the app always
 * asks, read-only, and Brittany's own follow-up questions - each optionally
 * asked only when another question was answered a certain way. Every change
 * saves the WHOLE list through `PUT /api/firm-settings`, after the same check
 * the server runs (`customQuestionProblems`). A questionnaire freezes the list
 * when it is made, so a change here never alters a link already sent.
 */
export function QuestionnaireQuestionsSection({
  settings,
  onCommit,
}: {
  settings: FirmSettings
  onCommit: (patch: Partial<FirmSettings>) => void | Promise<void>
}) {
  const pricing = settings.proposalPricing ?? defaultProposalPricing()
  const questionnaire = useMemo(() => buildQuestionnaire(pricing), [pricing])
  // Every app question, as the server checks a condition against them...
  const appQuestions = useMemo(() => flattenQuestions(questionnaire), [questionnaire])
  // ...and the ones a prospect sees, which are the ones offered to pick.
  const shownSections = useMemo(() => publicQuestionnaire(questionnaire).sections, [questionnaire])
  const list = cleanCustomQuestions(settings.questionnaireCustomQuestions ?? [])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [problems, setProblems] = useState<string[]>([])

  const save = (next: QuestionnaireCustomQuestion[]): boolean => {
    const found = customQuestionProblems(next, appQuestions)
    if (found.length > 0) {
      setProblems(found)
      return false
    }
    setProblems([])
    void onCommit({ questionnaireCustomQuestions: next })
    return true
  }

  const labelOf = (questionId: string) =>
    appQuestions.find((question) => question.id === questionId)?.label ??
    list.find((entry) => entry.id === questionId)?.label ??
    'a question that no longer exists'

  const conditionText = (entry: QuestionnaireCustomQuestion) => {
    if (!entry.when) return 'Always asked'
    const trigger = labelOf(entry.when.questionId)
    if (entry.when.answer === ANY_ANSWER) return `Asked only when “${trigger}” is answered`
    const answer =
      customConditionAnswers(entry.when.questionId, appQuestions, list).find(
        (option) => option.value === entry.when?.answer,
      )?.label ?? entry.when.answer
    return `Asked only when “${trigger}” is “${answer}”`
  }

  const submitDraft = () => {
    if (!draft) return
    const entry = entryOf(draft)
    const editing = list.some((item) => item.id === entry.id)
    const next = editing ? list.map((item) => (item.id === entry.id ? entry : item)) : [...list, entry]
    if (save(next)) setDraft(null)
  }

  const answerChoices = draft?.whenQuestionId
    ? customConditionAnswers(draft.whenQuestionId, appQuestions, list)
    : []

  return (
    <CollapsibleSection kicker="Proposals" title="Questionnaire" lockable>
      <p className="muted-text" style={{ marginTop: 0 }}>
        What a prospect is asked before a proposal. Add your own follow-up questions below; each
        can be asked only when another question was answered a certain way. Changes apply to
        questionnaires you send or start from now on - ones already sent keep their questions.
      </p>

      <details className="questionnaire-app-questions">
        <summary>The questions the app always asks</summary>
        {shownSections.map((section) => (
          <div key={section.id}>
            <h4>{section.title}</h4>
            <ul>
              {section.questions.map((question) => (
                <li key={question.id}>{question.label}</li>
              ))}
            </ul>
          </div>
        ))}
        <p className="muted-text">
          The service questions on step 2 are only asked for the services a prospect picks.
        </p>
      </details>

      <h4>Your follow-up questions</h4>
      <p className="muted-text">They are asked on step 2 of a sent link, under “More about you”.</p>
      {list.length === 0 ? <p className="muted-text">None yet.</p> : null}
      <ul className="questionnaire-follow-ups">
        {list.map((entry) => (
          <li key={entry.id} className="questionnaire-follow-up">
            <div>
              <strong>{entry.label}</strong>
              {entry.active ? null : <em className="muted-text"> (turned off)</em>}
              <div className="muted-text">
                {TYPE_LABELS[entry.type]}
                {entry.type === 'choice' ? `: ${(entry.options ?? []).join(', ')}` : ''}
                {' - '}
                {entry.required ? 'required when asked' : 'optional'}
                {' - '}
                {conditionText(entry)}
              </div>
            </div>
            <div className="button-row">
              <button
                type="button"
                className="secondary-action"
                aria-label={`Edit ${entry.label}`}
                onClick={() => {
                  setProblems([])
                  setDraft(draftOf(entry))
                }}
              >
                Edit
              </button>
              <button
                type="button"
                className="secondary-action"
                aria-label={`${entry.active ? 'Turn off' : 'Turn on'} ${entry.label}`}
                onClick={() =>
                  save(list.map((item) => (item.id === entry.id ? { ...item, active: !item.active } : item)))
                }
              >
                {entry.active ? 'Turn off' : 'Turn on'}
              </button>
              <button
                type="button"
                className="ghost-action"
                aria-label={`Delete ${entry.label}`}
                onClick={() => save(list.filter((item) => item.id !== entry.id))}
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>

      {problems.length > 0 ? (
        <div className="form-error" role="alert">
          <p>Not saved:</p>
          <ul>
            {problems.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {draft ? (
        <div className="questionnaire-follow-up-editor" role="group" aria-label="Follow-up question">
          <div className="form-grid two-col">
            <label className="field full-row">
              <span>Question</span>
              <input
                className="input"
                aria-label="Question"
                value={draft.label}
                maxLength={200}
                onChange={(event) => setDraft({ ...draft, label: event.target.value })}
              />
            </label>
            <label className="field full-row">
              <span>Help text (optional)</span>
              <input
                className="input"
                aria-label="Help text"
                value={draft.help}
                maxLength={300}
                onChange={(event) => setDraft({ ...draft, help: event.target.value })}
              />
            </label>
            <label className="field">
              <span>Answer type</span>
              <select
                className="input"
                aria-label="Answer type"
                value={draft.type}
                onChange={(event) => setDraft({ ...draft, type: event.target.value as CustomQuestionType })}
              >
                {CUSTOM_QUESTION_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field toggle-field">
              <span className="toggle-label">
                <input
                  type="checkbox"
                  checked={draft.required}
                  onChange={(event) => setDraft({ ...draft, required: event.target.checked })}
                />
                <strong>Required when asked</strong>
              </span>
            </label>
            {draft.type === 'choice' ? (
              <label className="field full-row">
                <span>Options, one per line</span>
                <textarea
                  className="input"
                  rows={4}
                  aria-label="Options, one per line"
                  value={draft.optionsText}
                  onChange={(event) => setDraft({ ...draft, optionsText: event.target.value })}
                />
              </label>
            ) : null}
            <label className="field">
              <span>Ask only when</span>
              <select
                className="input"
                aria-label="Ask only when"
                value={draft.whenQuestionId}
                onChange={(event) =>
                  setDraft({ ...draft, whenQuestionId: event.target.value, whenAnswer: ANY_ANSWER })
                }
              >
                <option value="">Always ask this question</option>
                {shownSections.map((section) => (
                  <optgroup key={section.id} label={section.title}>
                    {section.questions.map((question) => (
                      <option key={question.id} value={question.id}>
                        {question.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
                {list.some((entry) => entry.id !== draft.id) ? (
                  <optgroup label="Your follow-up questions">
                    {list
                      .filter((entry) => entry.id !== draft.id)
                      .map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.label}
                        </option>
                      ))}
                  </optgroup>
                ) : null}
              </select>
            </label>
            {draft.whenQuestionId ? (
              <label className="field">
                <span>is</span>
                <select
                  className="input"
                  aria-label="is"
                  value={draft.whenAnswer}
                  onChange={(event) => setDraft({ ...draft, whenAnswer: event.target.value })}
                >
                  {answerChoices.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
          <div className="button-row">
            <button type="button" className="primary-action" onClick={submitDraft}>
              Save question
            </button>
            <button
              type="button"
              className="ghost-action"
              onClick={() => {
                setProblems([])
                setDraft(null)
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="secondary-action"
          onClick={() => {
            setProblems([])
            setDraft(blankDraft())
          }}
        >
          Add a follow-up question
        </button>
      )}
    </CollapsibleSection>
  )
}
