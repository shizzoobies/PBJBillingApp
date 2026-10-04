/**
 * The proposal questionnaire (featreq-8f139178): what a prospect is asked
 * before anything is priced, and how the answers become a DRAFT proposal.
 *
 * Two ways to fill it in - a link the prospect completes alone, and a sheet
 * Brittany works through on a call - and both use the SAME frozen question list
 * (`buildQuestionnaire`, copied onto the record when it is created) so an answer
 * always means what the page said when it was asked, even after the calculator's
 * catalog changes underneath it.
 *
 * Pure: no store, no clock. The routes and the store call into it.
 */

import { cleanProposalInputs, cleanProposalProspect } from './proposal-pricing.js'

/** Brittany's words, verbatim (featreq-8f139178, answer 3). */
export const QUESTIONNAIRE_WELCOME =
  'Thank you for your interest in PB&J Strategic Accounting. We look forward to helping you keep the perfect books. Before we get started, tell us a little about what you are looking for.'

/** A link stops working this many days after it is made (decided, not asked). */
export const QUESTIONNAIRE_EXPIRY_DAYS = 30

/** The cap on `prospect.notes` - the same one `cleanProposalProspect` applies. */
const NOTES_MAX_CHARS = 4000
const SHORT_TEXT_MAX = 200
const LONG_TEXT_MAX = 2000
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Plain-English wording for the calculator's seed inputs, as a question a
 * prospect can answer. `callOnly` marks what only someone looking at the books
 * can know - the question is then shown on a call, never on the public link.
 * An input that is not here (a custom one the owner added) is call-only too,
 * under the catalog's own label.
 */
const COUNT_WORDING = {
  transactions: {
    label: 'About how many bank and credit card transactions do you have in a month?',
  },
  balanceSheetAccounts: { label: 'Balance sheet accounts', callOnly: true },
  plAccounts: { label: 'Profit and loss accounts', callOnly: true },
  totalAccounts: { label: 'Total accounts', callOnly: true },
  invoicesPerWeekAR: {
    label: 'About how many invoices do you send to customers each week?',
  },
  invoicesPerWeekAP: {
    label: 'About how many bills do you get from vendors each week?',
  },
  employees: { label: 'How many employees are on your payroll?' },
  salesTaxReviewAmount: { label: 'Sales tax review amount (dollars)', callOnly: true },
  states: { label: 'How many states do you collect sales tax in?' },
  cleanupMonths: {
    label: 'About how many months of your books are behind or need clean-up?',
  },
  reportsNeeded: { label: 'How many different reports would you like to receive?' },
  forms: { label: 'How many forms are on your individual tax return?' },
  accountsNeedingAttention: { label: 'Accounts needing detailed attention', callOnly: true },
  chartAccountsToClean: { label: 'Chart of accounts entries to clean up', callOnly: true },
  clientCallHours: { label: 'About how many hours a month would you like to spend on calls with us?' },
}

/** The service groups, in words a prospect uses. */
const GROUP_WORDING = {
  Monthly: 'Monthly bookkeeping (categorizing your transactions)',
  Reconciliations: 'Bank and credit card reconciliations',
  AR: 'Invoicing customers and following up on payments',
  AP: 'Entering and paying vendor bills',
  Payroll: 'Payroll',
  'Sales tax': 'Sales tax filing',
  Reports: 'Monthly or quarterly financial reports',
  'Additional reports': 'Budget, cash flow and KPI reports',
  'Annual and one-time': 'Tax returns, budgets and forecasts',
  'Clean-up': 'Clean-up of past books',
}

const ENTITY_TYPES = [
  'Sole proprietor',
  'LLC',
  'S corporation',
  'C corporation',
  'Partnership',
  'Nonprofit',
  'Not sure',
]

const SOFTWARE_CHOICES = [
  'QuickBooks Online',
  'QuickBooks Desktop',
  'Spreadsheets',
  'Nothing yet',
  'Something else',
]

const option = (value, label = value) => ({ value, label })

/** One question. `prospect` maps the answer onto the proposal's prospect block. */
function question(id, label, type, extra = {}) {
  return { id, label, type, ...extra }
}

/**
 * The questions for a catalog: sections of questions, under the welcome text.
 *
 * @param {{ inputs?: Array<{key: string, label?: string, help?: string}>,
 *           services?: Array<{group: string, active?: boolean}> }} catalog
 */
export function buildQuestionnaire(catalog) {
  const inputs = Array.isArray(catalog?.inputs) ? catalog.inputs : []
  const services = Array.isArray(catalog?.services) ? catalog.services : []

  const countQuestion = (input) => {
    const wording = COUNT_WORDING[input.key]
    const asked = wording
      ? { label: wording.label, callOnly: Boolean(wording.callOnly) }
      : { label: String(input.label || input.key), callOnly: true }
    return question(`count:${input.key}`, asked.label, 'number', {
      inputKey: input.key,
      ...(asked.callOnly ? { callOnly: true } : {}),
      ...(!wording && input.help ? { help: String(input.help) } : {}),
    })
  }

  const hasCleanupCount = inputs.some((input) => input.key === 'cleanupMonths')
  const counts = inputs.filter((input) => input.key !== 'cleanupMonths').map(countQuestion)

  const activeGroups = new Set(
    services.filter((service) => service && service.active !== false).map((service) => service.group),
  )
  const serviceOptions = Object.keys(GROUP_WORDING)
    .filter((group) => activeGroups.has(group))
    .map((group) => option(group, GROUP_WORDING[group]))

  const sections = [
    {
      id: 'about',
      title: 'About you',
      questions: [
        question('company', 'Business name', 'text', { prospect: 'company' }),
        question('contactName', 'Your name', 'text', { prospect: 'contactName' }),
        question('title', 'Your title', 'text', { prospect: 'title' }),
        question('email', 'Email', 'email', { prospect: 'email' }),
        question('phone', 'Phone', 'phone', { prospect: 'phone' }),
        question('addressLine1', 'Street address', 'text', { prospect: 'addressLine1' }),
        question('addressLine2', 'Suite, unit or floor', 'text', { prospect: 'addressLine2' }),
        question('city', 'City', 'text', { prospect: 'city' }),
        question('state', 'State', 'text', { prospect: 'state' }),
        question('postalCode', 'ZIP code', 'text', { prospect: 'postalCode' }),
        question('website', 'Website', 'text'),
      ],
    },
    {
      id: 'basics',
      title: 'Business basics',
      questions: [
        question('whatTheyDo', 'What does your business do?', 'longtext'),
        question('entityType', 'How is your business set up?', 'choice', {
          options: ENTITY_TYPES.map((value) => option(value)),
        }),
        question('yearsInBusiness', 'How many years have you been in business?', 'number'),
        question('fiscalYearEnd', 'When does your fiscal year end?', 'text', {
          help: 'For most businesses this is December 31.',
        }),
      ],
    },
    { id: 'numbers', title: 'The numbers', questions: counts },
    {
      id: 'services',
      title: 'Services you are interested in',
      questions: [
        question('services', 'What would you like help with?', 'multi', {
          help: 'Check everything that sounds right. We will sort out the details with you.',
          options: serviceOptions,
        }),
      ],
    },
    {
      id: 'software',
      title: 'Current software',
      questions: [
        question('software', 'What do you use for your books today?', 'multi', {
          options: SOFTWARE_CHOICES.map((value) => option(value)),
        }),
        question('payrollSoftware', 'Which payroll service do you use, if any?', 'text'),
        question('timeTracking', 'Which time-tracking tool do you use, if any?', 'text'),
      ],
    },
    {
      id: 'behind',
      title: 'How far behind the books are',
      questions: [
        hasCleanupCount
          ? countQuestion(inputs.find((input) => input.key === 'cleanupMonths'))
          : question(
              'monthsBehind',
              COUNT_WORDING.cleanupMonths.label,
              'number',
            ),
      ],
    },
    {
      id: 'other',
      title: 'Anything else',
      questions: [
        question('anythingElse', 'Is there anything else you would like us to know?', 'longtext', {
          help: 'Please do not send passwords, EINs, Social Security numbers or bank account numbers here.',
        }),
      ],
    },
  ]

  return { welcome: QUESTIONNAIRE_WELCOME, sections }
}

/** Every question, in page order. */
export function flattenQuestions(questionnaire) {
  const sections = Array.isArray(questionnaire?.sections) ? questionnaire.sections : []
  return sections.flatMap((section) => (Array.isArray(section?.questions) ? section.questions : []))
}

/**
 * The questionnaire as a prospect sees it: call-only questions are removed
 * (and a section left with none disappears). Used to draw the public page.
 */
export function publicQuestionnaire(questionnaire) {
  const sections = (Array.isArray(questionnaire?.sections) ? questionnaire.sections : [])
    .map((section) => ({
      ...section,
      questions: (section.questions ?? []).filter((item) => !item.callOnly),
    }))
    .filter((section) => section.questions.length > 0)
  return { welcome: questionnaire?.welcome ?? QUESTIONNAIRE_WELCOME, sections }
}

const textOf = (value, max) =>
  typeof value === 'string' || typeof value === 'number' ? String(value).trim().slice(0, max) : ''

/**
 * Only what the frozen questions ask, in the shape each one expects. A key that
 * is not a question is dropped, so is a call-only answer when the answers came
 * from the public link; text is capped, a count must be a finite number of at
 * least zero, a choice must be one of its options. Nothing throws.
 */
export function cleanQuestionnaireAnswers(
  questions,
  raw,
  { includeCallOnly = true, lenient = false } = {},
) {
  const out = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const item of Array.isArray(questions) ? questions : []) {
    if (item.callOnly && !includeCallOnly) continue
    if (!Object.hasOwn(raw, item.id)) continue
    const value = raw[item.id]
    switch (item.type) {
      case 'number': {
        if (typeof value !== 'number' && typeof value !== 'string') break
        if (typeof value === 'string' && value.trim() === '') break
        const n = Number(value)
        if (Number.isFinite(n) && n >= 0) out[item.id] = Math.min(n, 1e9)
        break
      }
      case 'email': {
        const text = textOf(value, 320)
        // Someone typing on a call keeps what they typed, however it looks; a
        // link must be an address we could actually write to.
        if (text && (lenient || EMAIL_PATTERN.test(text))) out[item.id] = text
        break
      }
      case 'phone': {
        const text = textOf(value, 60)
        if (text) out[item.id] = text
        break
      }
      case 'longtext': {
        const text = textOf(value, LONG_TEXT_MAX)
        if (text) out[item.id] = text
        break
      }
      case 'choice': {
        const text = textOf(value, SHORT_TEXT_MAX)
        if ((item.options ?? []).some((entry) => entry.value === text)) out[item.id] = text
        break
      }
      case 'multi': {
        const picked = (Array.isArray(value) ? value : [value]).filter(
          (entry) => typeof entry === 'string',
        )
        const allowed = new Set((item.options ?? []).map((entry) => entry.value))
        const kept = [...new Set(picked)].filter((entry) => allowed.has(entry))
        if (kept.length > 0) out[item.id] = kept
        break
      }
      default: {
        const text = textOf(value, SHORT_TEXT_MAX)
        if (text) out[item.id] = text
      }
    }
  }
  return out
}

/**
 * What is still missing before a questionnaire counts, as sentences. A link must
 * leave us a way to reach the prospect (a name and an email); a call, where
 * Brittany is the one typing, only needs to know who it was.
 */
export function questionnaireProblems(_questions, answers, { mode = 'link' } = {}) {
  const problems = []
  const has = (id) => typeof answers?.[id] === 'string' && answers[id].trim() !== ''
  if (mode === 'call') {
    if (!has('company') && !has('contactName')) problems.push('Enter a business name or a contact name.')
    return problems
  }
  if (!has('contactName')) problems.push('Please tell us your name.')
  if (!has('email')) problems.push('Please give us an email address we can reach you at.')
  return problems
}

/** "Monthly, Payroll" / "12" / the text itself - an answer as one line. The
 *  option VALUES are what she reads (the group names from her own catalog). */
function answerText(value) {
  return Array.isArray(value) ? value.join(', ') : String(value)
}

/**
 * The draft proposal's starting point from a set of answers: the contact block
 * on the prospect, every count under its catalog key on the inputs, and the rest
 * summarized into the prospect's notes (the editor shows them, the letter model
 * can read them). Nothing is selected and nothing is priced - that is hers.
 *
 * `answers` is expected to have been through `cleanQuestionnaireAnswers`.
 */
export function answersToProposalSeed(questions, answers) {
  const prospect = {}
  const inputs = {}
  const lines = []
  for (const item of Array.isArray(questions) ? questions : []) {
    const value = answers?.[item.id]
    if (value === undefined || value === null || value === '') continue
    if (item.prospect) {
      prospect[item.prospect] = String(value)
    } else if (item.inputKey) {
      inputs[item.inputKey] = value
    } else {
      lines.push(`${item.label.replace(/[?:]$/, '')}: ${answerText(value)}`)
    }
  }
  let notes = ''
  if (lines.length > 0) {
    notes = 'From the questionnaire:'
    for (const line of lines) {
      if (notes.length + 1 + line.length > NOTES_MAX_CHARS) {
        const room = NOTES_MAX_CHARS - notes.length - 2
        if (room > 0) notes += `\n${line.slice(0, room)}…`
        break
      }
      notes += `\n${line}`
    }
  }
  return {
    prospect: cleanProposalProspect({ ...prospect, notes }),
    inputs: cleanProposalInputs(inputs),
  }
}
