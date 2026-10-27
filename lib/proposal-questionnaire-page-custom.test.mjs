import { describe, expect, it } from 'vitest'
import { defaultProposalPricing } from './proposal-pricing.js'
import { buildQuestionnaire, withCustomQuestions } from './proposal-questionnaire.js'
import {
  QUESTIONNAIRE_RESPONSE_HEADERS,
  questionFieldName,
  questionnaireRefusalStep,
  readQuestionnaireForm,
  renderQuestionnairePage,
} from './proposal-questionnaire-page.js'

/**
 * Her follow-up questions on the public page (featreq-fccf901f). The page has
 * no script (its content policy allows none), so a follow-up that depends on
 * another step-2 question is shown and hidden by CSS alone, and the server
 * re-checks every condition on the send.
 */

const questionnaire = withCustomQuestions(buildQuestionnaire(defaultProposalPricing()), [
  { id: 'cq-0000000a', label: 'Do you run payroll in-house?', type: 'yes_no', required: true, active: true, when: { questionId: 'services', answer: 'Payroll' } },
  { id: 'cq-0000000b', label: 'Do you have a bookkeeper today?', type: 'yes_no', required: false, active: true },
  { id: 'cq-0000000c', label: 'Who is it?', type: 'short_text', required: true, active: true, when: { questionId: 'cq-0000000b', answer: 'yes' } },
  { id: 'cq-0000000d', label: 'Their email?', type: 'short_text', required: false, active: true, when: { questionId: 'cq-0000000c', answer: 'any' } },
])

const step1 = {
  company: 'Acme',
  contactName: 'Pat',
  email: 'pat@example.com',
  phone: '555',
  addressLine1: '1 Main',
  city: 'Town',
  state: 'VA',
  postalCode: '12345',
  whatTheyDo: 'Widgets',
  entityType: 'LLC',
}

const has = (page, id) => page.includes(`name="${questionFieldName(id)}"`)

describe('follow-ups on step 2', () => {
  it('a step-1 condition is settled on the server: shown when met, absent when not', () => {
    const payroll = renderQuestionnairePage({ questionnaire, step: 2, saved: { ...step1, services: ['Payroll'] } })
    const monthly = renderQuestionnairePage({ questionnaire, step: 2, saved: { ...step1, services: ['Monthly'] } })
    expect(payroll).toContain('<h2>More about you</h2>')
    expect(has(payroll, 'cq-0000000a')).toBe(true)
    expect(has(monthly, 'cq-0000000a')).toBe(false)
    // Settled and required: the browser requires it too, and it is starred.
    expect(payroll).toMatch(/Do you run payroll in-house\? \*<\/span><select name="q_cq-0000000a" required>/)
  })

  it('a step-2 condition is on the page, hidden until its answer is picked - by CSS, no script', () => {
    const page = renderQuestionnairePage({ questionnaire, step: 2, saved: step1 })
    expect(has(page, 'cq-0000000c')).toBe(true)
    expect(page).toMatch(/<div class="cq-live cq-live-\d+">[^]*name="q_cq-0000000c"/)
    expect(page).toContain('@supports selector(:has(*))')
    expect(page).toContain('.cq-live{display:none}')
    expect(page).toMatch(/form:has\(select\[name="q_cq-0000000b"\] option\[value="yes"\]:checked\) \.cq-live-\d+\{display:block\}/)
    // A hidden field cannot be browser-required (the form could never send).
    expect(page).not.toMatch(/name="q_cq-0000000c"[^>]* required/)
    expect(page).toContain('Who is it? *')
    expect(page).not.toMatch(/<script/i)
    expect(QUESTIONNAIRE_RESPONSE_HEADERS['Content-Security-Policy']).not.toMatch(/script-src/)
  })

  it('a chain needs every link: the third shows only when the second is shown AND answered', () => {
    const page = renderQuestionnairePage({ questionnaire, step: 2, saved: step1 })
    const rule = page.match(/form(:has\([^{]*\))+ \.cq-live-(\d+)\{display:block\}/g) ?? []
    const third = rule.find((line) => line.includes('q_cq-0000000c'))
    expect(third).toContain('select[name="q_cq-0000000b"] option[value="yes"]:checked')
    expect(third).toContain('[name="q_cq-0000000c"]:not(:placeholder-shown)')
    // The "any" trigger is a text box: it carries a blank placeholder so CSS can tell it is filled.
    expect(page).toMatch(/name="q_cq-0000000c" value="" maxlength="200" placeholder=" "/)
  })

  it('escapes a value inside the CSS so it cannot end the style', () => {
    const tricky = withCustomQuestions(buildQuestionnaire(defaultProposalPricing()), [
      { id: 'cq-0000000a', label: 'Pick', type: 'choice', options: ['a"]</style><b>x'], required: false, active: true },
      { id: 'cq-0000000b', label: 'Then', type: 'short_text', required: false, active: true, when: { questionId: 'cq-0000000a', answer: 'a"]</style><b>x' } },
    ])
    const page = renderQuestionnairePage({ questionnaire: tricky, step: 2, saved: step1 })
    // The page's own style and the follow-ups' - and nothing she typed closes either.
    expect(page.match(/<\/style>/g)).toHaveLength(2)
    expect(page).not.toContain('<b>x')
    const followUpStyle = page.match(/<style>@supports[^]*?<\/style>/)?.[0] ?? ''
    expect(followUpStyle).toContain('option[value="a\\22 \\5d \\3c \\2f style\\3e \\3c b\\3e x"]:checked')
  })

  it('reads a follow-up answer from the posted form', () => {
    const body = new URLSearchParams([['q_cq-0000000b', 'yes'], ['q_cq-0000000c', 'Jo']]).toString()
    expect(readQuestionnaireForm(body, questionnaire)).toEqual({ 'q_cq-0000000b': 'yes', 'q_cq-0000000c': 'Jo' })
  })

  it('a send refused for a step-2 answer comes back on step 2, flagged and re-filled', () => {
    const values = {
      ...Object.fromEntries(Object.entries(step1).map(([id, value]) => [questionFieldName(id), value])),
      'q_cq-0000000b': 'yes',
    }
    expect(questionnaireRefusalStep(questionnaire, values)).toBe(2)
    expect(questionnaireRefusalStep(questionnaire, { 'q_cq-0000000b': 'yes' })).toBe(1)
    const page = renderQuestionnairePage({
      questionnaire,
      step: 2,
      saved: step1,
      values,
      errors: ['Please answer: Who is it?'],
    })
    expect(page).toContain('Step 2 of 2')
    expect(page).toContain('<li>Please answer: Who is it?</li>')
    expect(page).toMatch(/<option value="yes" selected>Yes<\/option>/)
    expect(page).toMatch(/name="q_cq-0000000c"[^>]*aria-invalid="true"/)
  })
})
