import { useRef, useState } from 'react'
import { saveQuestionnaireAnswersRequest, submitQuestionnaireRequest } from '../../lib/api'
import {
  ApiError,
  type ProposalQuestionnaire,
  type QuestionnaireAnswers,
  type QuestionnaireQuestion,
} from '../../lib/types'
import type { QuestionnaireDraftResult } from '../../lib/api'

type Values = Record<string, string | string[]>

/** The saved answers as the strings and lists the inputs hold. */
function valuesFrom(answers: QuestionnaireAnswers): Values {
  const values: Values = {}
  for (const [id, answer] of Object.entries(answers)) {
    values[id] = Array.isArray(answer) ? answer : String(answer)
  }
  return values
}

/** What goes to the server: only what was filled in. The server decides what is valid. */
function answersFrom(values: Values): QuestionnaireAnswers {
  const answers: QuestionnaireAnswers = {}
  for (const [id, value] of Object.entries(values)) {
    if (Array.isArray(value) ? value.length > 0 : value.trim() !== '') answers[id] = value
  }
  return answers
}

const inputType = (question: QuestionnaireQuestion) =>
  question.type === 'email' ? 'email' : question.type === 'phone' ? 'tel' : question.type === 'number' ? 'number' : 'text'

/**
 * "Fill in on the call" (featreq-8f139178): the questionnaire Brittany works
 * through with a prospect on the phone. Every question is here, including the
 * ones a prospect could not answer alone (marked), and it saves as she goes so a
 * call can be picked up again. Submitting takes the answers once and starts a
 * DRAFT proposal from them - nothing is selected or priced until she does it.
 */
export function QuestionnaireSheet({
  questionnaire,
  onSubmitted,
  onWithdraw,
}: {
  questionnaire: ProposalQuestionnaire
  onSubmitted: (result: QuestionnaireDraftResult) => void
  onWithdraw: () => void
}) {
  const [values, setValues] = useState<Values>(() => valuesFrom(questionnaire.answers))
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  // The newest values, so a save that fires from a blur always sends what is on
  // screen now rather than what this render closed over.
  const latest = useRef(values)

  const change = (id: string, value: string | string[]) => {
    const next = { ...latest.current, [id]: value }
    latest.current = next
    setValues(next)
    setSaveState('idle')
  }

  const persist = () => {
    setSaveState('saving')
    void saveQuestionnaireAnswersRequest(questionnaire.id, answersFrom(latest.current))
      .then(() => setSaveState('saved'))
      .catch(() => setSaveState('error'))
  }

  const submit = async () => {
    setSubmitting(true)
    setError('')
    try {
      const result = await submitQuestionnaireRequest(questionnaire.id, answersFrom(latest.current))
      onSubmitted(result)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not submit the questionnaire.')
      setSubmitting(false)
    }
  }

  const field = (question: QuestionnaireQuestion) => {
    const value = values[question.id]
    if (question.type === 'multi') {
      const picked = Array.isArray(value) ? value : []
      return (
        <fieldset className="field questionnaire-multi" key={question.id}>
          <legend>{question.label}</legend>
          {question.help ? <small className="muted-text">{question.help}</small> : null}
          {(question.options ?? []).map((option) => (
            <label className="checkbox-row" key={option.value}>
              <input
                type="checkbox"
                checked={picked.includes(option.value)}
                onChange={(event) => {
                  change(
                    question.id,
                    event.target.checked
                      ? [...picked, option.value]
                      : picked.filter((entry) => entry !== option.value),
                  )
                  // A checkbox has no blur worth waiting for.
                  window.setTimeout(persist, 0)
                }}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </fieldset>
      )
    }
    const text = typeof value === 'string' ? value : ''
    return (
      <label className="field" key={question.id}>
        <span>
          {question.label}
          {question.callOnly ? <em className="questionnaire-call-only"> (ask on the call)</em> : null}
        </span>
        {question.type === 'longtext' ? (
          <textarea
            className="input"
            rows={3}
            aria-label={question.label}
            value={text}
            onChange={(event) => change(question.id, event.target.value)}
          />
        ) : question.type === 'choice' ? (
          <select
            className="input"
            aria-label={question.label}
            value={text}
            onChange={(event) => {
              change(question.id, event.target.value)
              window.setTimeout(persist, 0)
            }}
          >
            <option value="">-</option>
            {(question.options ?? []).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            className="input"
            type={inputType(question)}
            min={question.type === 'number' ? '0' : undefined}
            aria-label={question.label}
            value={text}
            onChange={(event) => change(question.id, event.target.value)}
          />
        )}
        {question.help ? <small className="muted-text">{question.help}</small> : null}
      </label>
    )
  }

  return (
    <section className="panel questionnaire-sheet" aria-label="Call sheet">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Fill in on the call</p>
          <h3>Questionnaire</h3>
          <p className="section-subtitle">{questionnaire.questions.welcome}</p>
        </div>
        <span className="muted-text" role="status">
          {saveState === 'saving'
            ? 'Saving...'
            : saveState === 'saved'
              ? 'Saved'
              : saveState === 'error'
                ? 'Could not save - your answers are still here'
                : ''}
        </span>
      </div>

      {/* A blur anywhere in the sheet saves what is on screen. */}
      <div onBlur={persist}>
        {questionnaire.questions.sections.map((section) => (
          <div key={section.id} className="questionnaire-section">
            <h4>{section.title}</h4>
            <div className="form-grid two-col">{section.questions.map(field)}</div>
          </div>
        ))}
      </div>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="button-row">
        <button
          className="primary-action"
          type="button"
          disabled={submitting}
          onClick={() => void submit()}
        >
          Submit and start the draft
        </button>
        <button className="ghost-action" type="button" disabled={submitting} onClick={onWithdraw}>
          Discard this sheet
        </button>
      </div>
    </section>
  )
}
