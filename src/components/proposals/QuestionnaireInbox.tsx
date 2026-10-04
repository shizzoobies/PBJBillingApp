import { Link } from 'react-router-dom'
import { proposalDate, questionnaireGroup, questionnaireName } from '../../lib/proposals'
import type { ProposalQuestionnaire } from '../../lib/types'

const GROUP_TITLES = { waiting: 'Waiting', answered: 'Answered', expired: 'Expired' } as const

/**
 * The Questionnaires block on the Proposals page (featreq-8f139178): what is
 * waiting for an answer, what came back (with its draft proposal, or a button to
 * start one when that did not happen), and what ran out.
 */
export function QuestionnaireInbox({
  questionnaires,
  busyId,
  onResume,
  onWithdraw,
  onStartDraft,
}: {
  questionnaires: ProposalQuestionnaire[]
  busyId: string | null
  onResume: (questionnaire: ProposalQuestionnaire) => void
  onWithdraw: (questionnaire: ProposalQuestionnaire) => void
  onStartDraft: (questionnaire: ProposalQuestionnaire) => void
}) {
  if (questionnaires.length === 0) return null
  return (
    <section className="questionnaire-inbox" aria-label="Questionnaires">
      <h3>Questionnaires</h3>
      {(['waiting', 'answered', 'expired'] as const).map((group) => {
        const rows = questionnaires.filter((entry) => questionnaireGroup(entry) === group)
        if (rows.length === 0) return null
        return (
          <div key={group} className="questionnaire-group">
            <h4>
              {GROUP_TITLES[group]} <span className="muted-text">({rows.length})</span>
            </h4>
            <ul className="questionnaire-list">
              {rows.map((entry) => (
                <li key={entry.id} className="questionnaire-row">
                  <span className="questionnaire-name">{questionnaireName(entry)}</span>
                  <span className="muted-text">
                    {entry.mode === 'call' ? 'Call sheet' : 'Link'} -{' '}
                    {proposalDate(entry.submittedAt ?? entry.createdAt)}
                  </span>
                  <span className="questionnaire-actions">
                    {group === 'waiting' && entry.mode === 'call' ? (
                      <button type="button" className="secondary-action" onClick={() => onResume(entry)}>
                        Resume
                      </button>
                    ) : null}
                    {group === 'waiting' ? (
                      <button
                        type="button"
                        className="ghost-action"
                        disabled={busyId === entry.id}
                        onClick={() => onWithdraw(entry)}
                      >
                        Withdraw
                      </button>
                    ) : null}
                    {group === 'answered' && entry.proposalId ? (
                      <Link to={`/proposals/${entry.proposalId}`}>Open the draft</Link>
                    ) : null}
                    {group === 'answered' && !entry.proposalId ? (
                      <>
                        <span className="form-error">The draft was not started.</span>
                        <button
                          type="button"
                          className="secondary-action"
                          disabled={busyId === entry.id}
                          onClick={() => onStartDraft(entry)}
                        >
                          Start draft
                        </button>
                      </>
                    ) : null}
                    {group === 'expired' ? (
                      <span className="status-pill">
                        {entry.status === 'withdrawn' ? 'Withdrawn' : 'Expired'}
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </section>
  )
}

/**
 * "From the questionnaire" on the Estimate tab: what the prospect (or the call)
 * said, read-only, grouped as it was asked. The counts and the contact block are
 * also in their own fields above and below - this is the whole record.
 */
export function QuestionnaireAnswersPanel({ questionnaire }: { questionnaire: ProposalQuestionnaire }) {
  const sections = questionnaire.questions.sections
    .map((section) => ({
      id: section.id,
      title: section.title,
      rows: section.questions
        .map((question) => {
          const answer = questionnaire.answers[question.id]
          if (answer === undefined || answer === '') return null
          const labels = new Map((question.options ?? []).map((option) => [option.value, option.label]))
          const text = Array.isArray(answer)
            ? answer.map((entry) => labels.get(entry) ?? entry).join(', ')
            : String(answer)
          return { id: question.id, label: question.label, text }
        })
        .filter((row): row is { id: string; label: string; text: string } => row !== null),
    }))
    .filter((section) => section.rows.length > 0)
  if (sections.length === 0) return null
  return (
    <section className="panel questionnaire-answers" aria-label="From the questionnaire">
      <h3>From the questionnaire</h3>
      <p className="muted-text">
        {questionnaire.mode === 'call' ? 'Filled in on a call' : 'Sent back by the prospect'}
        {questionnaire.submittedAt ? ` on ${proposalDate(questionnaire.submittedAt)}` : ''}.
      </p>
      {sections.map((section) => (
        <div key={section.id}>
          <h4>{section.title}</h4>
          <dl className="questionnaire-answer-list">
            {section.rows.map((row) => (
              <div key={row.id}>
                <dt>{row.label}</dt>
                <dd>{row.text}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </section>
  )
}
