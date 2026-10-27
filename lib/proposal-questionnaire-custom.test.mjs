import { describe, expect, it } from 'vitest'
import { defaultProposalPricing } from './proposal-pricing.js'
import {
  CUSTOM_QUESTION_SECTION_ID,
  answersToProposalSeed,
  buildQuestionnaire,
  cleanCustomQuestions,
  cleanQuestionnaireAnswers,
  customConditionAnswers,
  customQuestionProblems,
  flattenQuestions,
  newCustomQuestionId,
  questionConditionMet,
  questionnaireMissingAnswers,
  questionnaireStepOne,
  questionnaireStepTwo,
  withCustomQuestions,
} from './proposal-questionnaire.js'

/**
 * Brittany's own follow-up questions (featreq-fccf901f): questions she writes on
 * the Settings page, each optionally asked only when another question was
 * answered a certain way. Frozen onto a questionnaire when it is made.
 */

const catalog = defaultProposalPricing()
const base = () => buildQuestionnaire(catalog)

const yesNo = (extra = {}) => ({
  id: 'cq-0000000a',
  label: 'Do you have a bookkeeper today?',
  type: 'yes_no',
  required: false,
  active: true,
  ...extra,
})

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

const ids = (view) => flattenQuestions(view).map((question) => question.id)

describe('cleanCustomQuestions (what both store backends keep)', () => {
  it('keeps a well-formed list and drops junk', () => {
    const cleaned = cleanCustomQuestions([
      yesNo(),
      { id: 'cq-0000000b', label: '  Which bank?  ', type: 'choice', options: ['Chase', ' Chase ', '', 'PNC'], required: 1 },
      { id: 'not-an-id', label: 'x', type: 'yes_no' },
      { id: 'cq-0000000c', label: '', type: 'yes_no' },
      { id: 'cq-0000000d', label: 'Bad type', type: 'number' },
      { id: 'cq-0000000a', label: 'Duplicate id', type: 'yes_no' },
      { id: 'cq-0000000e', label: 'Choice with nothing to choose', type: 'choice', options: [] },
      'nonsense',
    ])
    expect(cleaned.map((entry) => entry.id)).toEqual(['cq-0000000a', 'cq-0000000b'])
    expect(cleaned[1]).toEqual({
      id: 'cq-0000000b',
      label: 'Which bank?',
      type: 'choice',
      options: ['Chase', 'PNC'],
      required: true,
      active: true,
    })
  })

  it('reads anything that is not a list as no questions', () => {
    expect(cleanCustomQuestions(null)).toEqual([])
    expect(cleanCustomQuestions({ id: 'cq-0000000a' })).toEqual([])
  })

  it('keeps a condition, and turns off a question whose condition is malformed', () => {
    const [kept, broken] = cleanCustomQuestions([
      yesNo({ when: { questionId: 'services', answer: 'Payroll' } }),
      yesNo({ id: 'cq-0000000b', when: { questionId: '', answer: 'yes' } }),
    ])
    expect(kept.when).toEqual({ questionId: 'services', answer: 'Payroll' })
    expect(broken.active).toBe(false)
    expect(broken.when).toBeUndefined()
  })

  it('makes ids in the cq-<8 hex> shape', () => {
    expect(newCustomQuestionId()).toMatch(/^cq-[0-9a-f]{8}$/)
  })
})

describe('customQuestionProblems (what a save refuses)', () => {
  const app = flattenQuestions(base())

  it('accepts conditions on an app question and on another follow-up', () => {
    expect(
      customQuestionProblems(
        [
          yesNo({ when: { questionId: 'services', answer: 'Payroll' } }),
          yesNo({ id: 'cq-0000000b', label: 'Who?', type: 'short_text', when: { questionId: 'cq-0000000a', answer: 'yes' } }),
          yesNo({ id: 'cq-0000000c', label: 'Anything?', when: { questionId: 'whatTheyDo', answer: 'any' } }),
        ],
        app,
      ),
    ).toEqual([])
  })

  it('names a question that does not exist, an answer it cannot give, and a loop', () => {
    const problems = customQuestionProblems(
      [
        yesNo({ when: { questionId: 'nope', answer: 'yes' } }),
        yesNo({ id: 'cq-0000000b', label: 'B', when: { questionId: 'services', answer: 'Underwater basket weaving' } }),
        yesNo({ id: 'cq-0000000c', label: 'C', when: { questionId: 'cq-0000000d', answer: 'yes' } }),
        yesNo({ id: 'cq-0000000d', label: 'D', when: { questionId: 'cq-0000000c', answer: 'yes' } }),
        yesNo({ id: 'cq-0000000e', label: 'E', when: { questionId: 'whatTheyDo', answer: 'Widgets' } }),
      ],
      app,
    )
    expect(problems).toHaveLength(5)
    expect(problems[0]).toMatch(/Do you have a bookkeeper today\?/)
    expect(problems.join(' ')).toMatch(/Underwater basket weaving/)
  })

  it('needs a question and, for a choice, at least one option', () => {
    expect(
      customQuestionProblems(
        [
          { id: 'cq-0000000a', label: ' ', type: 'yes_no' },
          { id: 'cq-0000000b', label: 'Pick', type: 'choice', options: [] },
        ],
        app,
      ),
    ).toHaveLength(2)
  })

  // Review M3: a follow-up depending on one that is off would silently never be asked.
  it('refuses a condition on a follow-up that is turned off', () => {
    const problems = customQuestionProblems(
      [
        yesNo({ active: false }),
        yesNo({ id: 'cq-0000000b', label: 'Who?', type: 'short_text', when: { questionId: 'cq-0000000a', answer: 'yes' } }),
      ],
      app,
    )
    expect(problems).toEqual(['"Who?" asks only after a question that is turned off.'])
  })

  it('says a question cannot depend on itself', () => {
    expect(customQuestionProblems([yesNo({ when: { questionId: 'cq-0000000a', answer: 'yes' } })], app)).toEqual([
      '"Do you have a bookkeeper today?" cannot be asked only after itself. Pick another question.',
    ])
  })

  // Review LOW: everything the cleaner would drop silently is refused out loud instead.
  it('refuses what the cleaner would silently drop: too many, unreadable, bad or repeated ids, unknown types', () => {
    const many = Array.from({ length: 41 }, (_, index) =>
      yesNo({ id: `cq-${index.toString(16).padStart(8, '0')}`, label: `Q${index}` }),
    )
    expect(customQuestionProblems(many, app)).toEqual(['There can be at most 40 follow-up questions.'])
    const problems = customQuestionProblems(
      [
        'nonsense',
        yesNo({ id: 'bad' }),
        yesNo({ id: 'cq-0000000b', label: 'One' }),
        yesNo({ id: 'cq-0000000b', label: 'Two' }),
        yesNo({ id: 'cq-0000000c', label: 'Odd', type: 'number' }),
        yesNo({ id: 'cq-0000000d', label: 'Half', when: { questionId: 'services' } }),
      ],
      app,
    )
    expect(problems).toEqual([
      'Question 1 could not be read.',
      '"Do you have a bookkeeper today?" has no valid id. Reload the page and try again.',
      '"Two" is listed twice. Reload the page and try again.',
      '"Odd" has an answer type the app does not know.',
      '"Half" has an incomplete "Ask only when". Pick a question and an answer.',
      '"Half" asks only when "What would you like help with?" is "", but that question no longer offers that answer.',
    ])
    expect(customQuestionProblems({ not: 'a list' }, app)).toEqual(['The follow-up questions must be a list.'])
  })

  // Review LOW: "any" is the condition sentinel, so it cannot also be an option.
  it('refuses an option called "any", and the cleaner never keeps one', () => {
    const entry = { id: 'cq-0000000a', label: 'Pick', type: 'choice', options: ['any', 'Chase'], required: false, active: true }
    expect(customQuestionProblems([entry], app)).toEqual([
      '"Pick" has an option called "any", which the app keeps for "answered at all". Reword it.',
    ])
    expect(cleanCustomQuestions([entry])[0].options).toEqual(['Chase'])
  })

  it('does not check the condition of a question that is turned off', () => {
    expect(customQuestionProblems([yesNo({ active: false, when: { questionId: 'gone', answer: 'yes' } })], app)).toEqual([])
  })
})

describe('customConditionAnswers (the "is" picker)', () => {
  const app = flattenQuestions(base())
  it('offers the service groups for the services question, yes/no for a yes/no, and "any" for text', () => {
    const services = customConditionAnswers('services', app, [])
    expect(services[0]).toEqual({ value: 'any', label: 'answered (any answer)' })
    expect(services.map((entry) => entry.value)).toContain('Payroll')
    expect(customConditionAnswers('cq-0000000a', app, [yesNo()]).map((entry) => entry.value)).toEqual([
      'any',
      'yes',
      'no',
    ])
    expect(customConditionAnswers('whatTheyDo', app, []).map((entry) => entry.value)).toEqual(['any'])
  })
})

describe('withCustomQuestions (frozen when a questionnaire is made)', () => {
  it('changes nothing when there are no active follow-ups', () => {
    expect(withCustomQuestions(base(), [])).toEqual(base())
    expect(withCustomQuestions(base(), [yesNo({ active: false })])).toEqual(base())
  })

  it('adds a "More about you" section just before Anything else', () => {
    const merged = withCustomQuestions(base(), [
      yesNo({ required: true, when: { questionId: 'services', answer: 'Payroll' } }),
      { id: 'cq-0000000b', label: 'Which bank?', type: 'choice', options: ['Chase', 'PNC'], required: false, active: true },
      { id: 'cq-0000000c', label: 'Notes', help: 'Optional', type: 'long_text', required: false, active: true },
      { id: 'cq-0000000d', label: 'Off', type: 'short_text', required: false, active: false },
    ])
    const sectionIds = merged.sections.map((section) => section.id)
    expect(sectionIds.slice(-2)).toEqual([CUSTOM_QUESTION_SECTION_ID, 'other'])
    const section = merged.sections.find((entry) => entry.id === CUSTOM_QUESTION_SECTION_ID)
    expect(section.title).toBe('More about you')
    expect(section.questions).toEqual([
      {
        id: 'cq-0000000a',
        label: 'Do you have a bookkeeper today?',
        type: 'choice',
        options: [
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
        ],
        custom: true,
        required: true,
        when: { questionId: 'services', answer: 'Payroll' },
      },
      {
        id: 'cq-0000000b',
        label: 'Which bank?',
        type: 'choice',
        options: [
          { value: 'Chase', label: 'Chase' },
          { value: 'PNC', label: 'PNC' },
        ],
        custom: true,
      },
      { id: 'cq-0000000c', label: 'Notes', type: 'longtext', help: 'Optional', custom: true },
    ])
  })

  it('never puts a follow-up on step 1', () => {
    const merged = withCustomQuestions(base(), [yesNo()])
    expect(ids(questionnaireStepOne(merged))).not.toContain('cq-0000000a')
  })
})

describe('when a follow-up is asked', () => {
  const merged = withCustomQuestions(base(), [
    yesNo({ id: 'cq-0000000a', label: 'Payroll follow-up', required: true, when: { questionId: 'services', answer: 'Payroll' } }),
    yesNo({ id: 'cq-0000000b', label: 'Always asked' }),
    yesNo({ id: 'cq-0000000c', label: 'Any service', when: { questionId: 'services', answer: 'any' } }),
    yesNo({ id: 'cq-0000000d', label: 'After a yes', type: 'short_text', required: true, when: { questionId: 'cq-0000000b', answer: 'yes' } }),
    yesNo({ id: 'cq-0000000e', label: 'After the payroll count', when: { questionId: 'count:employees', answer: 'any' } }),
    yesNo({ id: 'cq-0000000f', label: 'Inactive', active: false }),
  ])
  const all = flattenQuestions(merged)

  it('a step-1 trigger is settled by the kept step 1', () => {
    const payroll = questionnaireStepTwo(merged, { ...step1, services: ['Payroll'] })
    expect(ids(payroll)).toEqual(expect.arrayContaining(['cq-0000000a', 'cq-0000000b', 'cq-0000000c']))
    const monthly = questionnaireStepTwo(merged, { ...step1, services: ['Monthly'] })
    expect(ids(monthly)).not.toContain('cq-0000000a')
    expect(ids(monthly)).toContain('cq-0000000c')
    const none = questionnaireStepTwo(merged, step1)
    expect(ids(none)).not.toContain('cq-0000000a')
    expect(ids(none)).not.toContain('cq-0000000c')
    expect(ids(none)).toContain('cq-0000000b')
  })

  it('a step-2 trigger keeps the follow-up on step 2 for the page to show or hide', () => {
    expect(ids(questionnaireStepTwo(merged, step1))).toContain('cq-0000000d')
    // The payroll count is only on step 2 when Payroll was picked; without it the
    // follow-up could never be answered, so it is not on the page at all.
    expect(ids(questionnaireStepTwo(merged, { ...step1, services: ['Payroll'] }))).toContain('cq-0000000e')
    expect(ids(questionnaireStepTwo(merged, { ...step1, services: ['Monthly'] }))).not.toContain('cq-0000000e')
  })

  it('an inactive follow-up is never frozen, so never asked', () => {
    expect(all.map((question) => question.id)).not.toContain('cq-0000000f')
  })

  it('evaluates yes/no, any and chains', () => {
    const byId = (id) => all.find((question) => question.id === id)
    expect(questionConditionMet(byId('cq-0000000a'), all, { services: ['Payroll', 'AR'] })).toBe(true)
    expect(questionConditionMet(byId('cq-0000000a'), all, { services: ['AR'] })).toBe(false)
    expect(questionConditionMet(byId('cq-0000000c'), all, { services: [] })).toBe(false)
    expect(questionConditionMet(byId('cq-0000000d'), all, { 'cq-0000000b': 'yes' })).toBe(true)
    expect(questionConditionMet(byId('cq-0000000d'), all, { 'cq-0000000b': 'no' })).toBe(false)
    expect(questionConditionMet(byId('cq-0000000e'), all, { 'count:employees': 0 })).toBe(true)
    expect(questionConditionMet(byId('cq-0000000b'), all, {})).toBe(true)
  })

  it('a required follow-up is required only when it is asked', () => {
    const missing = (answers) =>
      questionnaireMissingAnswers(all, cleanQuestionnaireAnswers(all, answers), { mode: 'link' }).map(
        (entry) => entry.id,
      )
    expect(missing({ ...step1, services: ['Monthly'] })).toEqual([])
    expect(missing({ ...step1, services: ['Payroll'] })).toEqual(['cq-0000000a'])
    expect(missing({ ...step1, services: ['Payroll'], 'cq-0000000a': 'no' })).toEqual([])
    expect(missing({ ...step1, 'cq-0000000b': 'yes' })).toEqual(['cq-0000000d'])
    expect(missing({ ...step1, 'cq-0000000b': 'yes', 'cq-0000000d': 'Jo' })).toEqual([])
    // A call sheet still requires only a name.
    expect(
      questionnaireMissingAnswers(all, { company: 'Acme', services: ['Payroll'] }, { mode: 'call' }),
    ).toEqual([])
  })

  it('drops the answer to a follow-up whose condition is not met (a hidden field still posts)', () => {
    const cleaned = cleanQuestionnaireAnswers(all, {
      services: ['AR'],
      'cq-0000000a': 'yes',
      'cq-0000000b': 'no',
      'cq-0000000d': 'stale',
    })
    expect(cleaned).toEqual({ services: ['AR'], 'cq-0000000b': 'no' })
  })

  it('a follow-up answer reaches the notes under its label, a yes/no as Yes or No', () => {
    const answers = cleanQuestionnaireAnswers(all, { ...step1, 'cq-0000000b': 'yes', 'cq-0000000d': 'Jo Smith' })
    const seed = answersToProposalSeed(all, answers)
    expect(seed.prospect.notes).toContain('Always asked: Yes')
    expect(seed.prospect.notes).toContain('After a yes: Jo Smith')
  })
})

describe('a questionnaire frozen before follow-ups existed', () => {
  it('behaves exactly as before', () => {
    const frozen = JSON.parse(JSON.stringify(base()))
    const answers = { ...step1, services: ['Payroll'], 'count:employees': 4 }
    expect(cleanQuestionnaireAnswers(flattenQuestions(frozen), answers)).toEqual(answers)
    expect(questionnaireStepTwo(frozen, answers).sections.map((section) => section.id)).toEqual(
      questionnaireStepTwo(base(), answers).sections.map((section) => section.id),
    )
    expect(ids(frozen).some((id) => id.startsWith('cq-'))).toBe(false)
  })
})
