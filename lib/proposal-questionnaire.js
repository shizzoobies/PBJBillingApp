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

import {
  PROPOSAL_TIERS,
  SOFTWARE_GROUP,
  cleanProposalInputs,
  cleanProposalProspect,
  cleanProposalSelections,
  proposalSelectionDefaults,
} from './proposal-pricing.js'

/** Brittany's words, verbatim (featreq-8f139178, answer 3). */
export const QUESTIONNAIRE_WELCOME =
  'Thank you for your interest in PB&J Strategic Accounting. We look forward to helping you keep the perfect books. Before we get started, tell us a little about what you are looking for.'

/** A link stops working this many days after it is made (decided, not asked). */
export const QUESTIONNAIRE_EXPIRY_DAYS = 30

/**
 * What every note she gets from a questionnaire starts with. The letter prompt
 * reads it to know the notes are the PROSPECT's words and fences them that way.
 */
export const QUESTIONNAIRE_NOTES_MARKER = 'From the questionnaire:'

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

/**
 * The counts (catalog input keys) each service group needs from a prospect - what
 * the SECOND step of a sent questionnaire asks once they have ticked services
 * (Brittany, 2026-10-10: "ask questions based off what they said they needed").
 * Only keys a prospect can answer: what only someone looking at the books knows
 * (accounts, the sales tax review amount) stays call-only and is never mapped.
 * Clean-up asks the transactions too, because its lines price per transaction
 * per month behind.
 */
export const GROUP_INPUTS = Object.freeze({
  Monthly: Object.freeze(['transactions']),
  Reconciliations: Object.freeze([]),
  AR: Object.freeze(['invoicesPerWeekAR']),
  AP: Object.freeze(['invoicesPerWeekAP']),
  Payroll: Object.freeze(['employees']),
  'Sales tax': Object.freeze(['states']),
  Reports: Object.freeze(['reportsNeeded', 'clientCallHours']),
  'Additional reports': Object.freeze(['reportsNeeded', 'clientCallHours']),
  'Annual and one-time': Object.freeze(['forms']),
  'Clean-up': Object.freeze(['transactions', 'cleanupMonths']),
})

/** What step 2 asks when no service was ticked: the counts that size almost any job. */
const GENERAL_INPUTS = Object.freeze(['transactions', 'cleanupMonths'])

/** The sections on step 1 of a sent questionnaire (every required answer is here). */
const STEP_ONE_SECTIONS = new Set(['about', 'basics', 'services', 'software'])

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

/**
 * Step 1 of the SENT questionnaire: About you, Business basics, the services
 * they want and their current software. Every required answer is on it, so a
 * step 1 that is accepted can always be sent.
 */
export function questionnaireStepOne(questionnaire) {
  const view = publicQuestionnaire(questionnaire)
  return { ...view, sections: view.sections.filter((section) => STEP_ONE_SECTIONS.has(section.id)) }
}

/**
 * The service groups ticked in `answers`, in the order the page offered them,
 * as `{ value, label }` - only groups the frozen services question offered.
 */
function pickedServiceGroups(questionnaire, answers) {
  const servicesQuestion = flattenQuestions(questionnaire).find(
    (item) => item.id === 'services' && item.type === 'multi',
  )
  const raw = answers && typeof answers === 'object' ? answers.services : null
  const ticked = new Set(Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [])
  return (servicesQuestion?.options ?? [])
    .filter((entry) => ticked.has(entry.value))
    .map((entry) => ({ value: entry.value, label: entry.label }))
}

/**
 * Step 2 of the SENT questionnaire, from step 1's `answers`: only the counts the
 * ticked groups need (`GROUP_INPUTS`), "How far behind the books are" only when
 * Clean-up was ticked, and Anything else always. Nothing ticked asks the general
 * counts (transactions, how far behind). `picked` is the ticked groups, for the
 * "You picked" line.
 */
export function questionnaireStepTwo(questionnaire, answers) {
  const view = publicQuestionnaire(questionnaire)
  const picked = pickedServiceGroups(view, answers)
  const needed = new Set(
    picked.length > 0 ? picked.flatMap((entry) => GROUP_INPUTS[entry.value] ?? []) : GENERAL_INPUTS,
  )
  const asksBehind = picked.length === 0 || picked.some((entry) => entry.value === 'Clean-up')
  const sections = view.sections
    .filter((section) => !STEP_ONE_SECTIONS.has(section.id))
    .filter((section) => section.id !== 'behind' || asksBehind)
    .map((section) =>
      section.id === 'behind'
        ? section
        : {
            ...section,
            questions: section.questions.filter((item) => !item.inputKey || needed.has(item.inputKey)),
          },
    )
    .filter((section) => section.questions.length > 0)
  return { welcome: view.welcome, sections, picked }
}

const textOf =(value, max) =>
  typeof value === 'string' || typeof value === 'number' ? String(value).trim().slice(0, max) : ''

/** A single-line answer: every run of whitespace (a newline a crafted post slipped in) is one space. */
const lineOf = (value, max) =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value).replace(/\s+/g, ' ').trim().slice(0, max).trim()
    : ''

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
        const text = lineOf(value, 320)
        // Someone typing on a call keeps what they typed, however it looks; a
        // link must be an address we could actually write to.
        if (text && (lenient || EMAIL_PATTERN.test(text))) out[item.id] = text
        break
      }
      case 'phone': {
        const text = lineOf(value, 60)
        if (text) out[item.id] = text
        break
      }
      case 'longtext': {
        const text = textOf(value, LONG_TEXT_MAX)
        if (text) out[item.id] = text
        break
      }
      case 'choice': {
        const text = lineOf(value, SHORT_TEXT_MAX)
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
        const text = lineOf(value, SHORT_TEXT_MAX)
        if (text) out[item.id] = text
      }
    }
  }
  return out
}

/**
 * What a prospect must answer on the LINK, in page order, with the sentence shown
 * when it is missing. A name and an email from the start; the business, phone,
 * street address, city, state, ZIP and the two business basics added at
 * Brittany's request (2026-10-10). Suite / unit stays optional, and the call
 * sheet - which she fills in partly on a call - requires none of these.
 */
export const QUESTIONNAIRE_LINK_REQUIRED = Object.freeze([
  ['company', 'Please tell us your business name.'],
  ['contactName', 'Please tell us your name.'],
  ['email', 'Please give us an email address we can reach you at.'],
  ['phone', 'Please give us a phone number.'],
  ['addressLine1', 'Please enter your street address.'],
  ['city', 'Please enter your city.'],
  ['state', 'Please enter your state.'],
  ['postalCode', 'Please enter your ZIP code.'],
  ['whatTheyDo', 'Please tell us what your business does.'],
  ['entityType', 'Please choose how your business is set up.'],
])

/** The two a link has always needed, even on a question list that lacks them. */
const ALWAYS_REQUIRED_ON_LINK = new Set(['contactName', 'email'])

/** True when this question must be answered on the public link. */
export const isRequiredOnLink = (id) => QUESTIONNAIRE_LINK_REQUIRED.some(([key]) => key === id)

/**
 * What is still missing before a questionnaire counts, one `{ id, message }` per
 * question, in page order. A link must leave us a way to reach and set up the
 * prospect (`QUESTIONNAIRE_LINK_REQUIRED`) - but only a question the record's
 * FROZEN list actually asks can be required, so an older link is never stuck on
 * a question its page never showed. A call, where Brittany is the one typing,
 * only needs to know who it was.
 *
 * `answers` is expected to have been through `cleanQuestionnaireAnswers`, so an
 * email that is not an address or a choice that is not an option is missing.
 */
export function questionnaireMissingAnswers(questions, answers, { mode = 'link' } = {}) {
  const has = (id) => typeof answers?.[id] === 'string' && answers[id].trim() !== ''
  if (mode === 'call') {
    return !has('company') && !has('contactName')
      ? [{ id: 'company', message: 'Enter a business name or a contact name.' }]
      : []
  }
  const asked = new Set(
    (Array.isArray(questions) ? questions : [])
      .filter((item) => item && !item.callOnly)
      .map((item) => item.id),
  )
  return QUESTIONNAIRE_LINK_REQUIRED.filter(
    ([id]) => (ALWAYS_REQUIRED_ON_LINK.has(id) || asked.has(id)) && !has(id),
  ).map(([id, message]) => ({ id, message }))
}

/** The same, as the sentences shown to whoever submitted. */
export function questionnaireProblems(questions, answers, options = {}) {
  return questionnaireMissingAnswers(questions, answers, options).map((entry) => entry.message)
}

/** "Monthly, Payroll" / "12" / the text itself - an answer as one line. The
 *  option VALUES are what she reads (the group names from her own catalog). */
function answerText(value) {
  return Array.isArray(value) ? value.join(', ') : String(value)
}

/**
 * The proposal lines for the service groups a prospect ticked, from the CURRENT
 * catalog: ONE starter line per group - its active line with the lowest sort
 * order, and when that line is one tier of a family (rows sharing a group and a
 * name, each with a tier), the family's Basic tier (its lowest active tier when
 * Basic is switched off). Nothing else from the group: many of a group's lines
 * are alternatives (weekly vs monthly transactions, monthly / quarterly / yearly
 * sales tax), and picking them all would overprice the draft - she adds the rest
 * on the Estimate tab. Software is never selected. Each line starts from the
 * catalog's standard amount / count, as a line she picks in the editor does.
 * In catalog order.
 */
export function selectionsForServiceGroups(groups, catalog) {
  const wanted = new Set(
    (Array.isArray(groups) ? groups : []).filter((group) => typeof group === 'string' && group !== SOFTWARE_GROUP),
  )
  const services = Array.isArray(catalog?.services) ? catalog.services : []
  const rows = services
    .map((service, index) => ({ service, index }))
    .filter(({ service }) => service && service.active !== false && wanted.has(service.group))
    .sort(
      (a, b) =>
        (Number(a.service.sortOrder) || 0) - (Number(b.service.sortOrder) || 0) || a.index - b.index,
    )
    .map(({ service }) => service)
  const tiered = (service) => service.tier !== null && service.tier !== undefined
  const tierRank = (service) => {
    const rank = PROPOSAL_TIERS.indexOf(service.tier)
    return rank === -1 ? PROPOSAL_TIERS.length : rank
  }
  const starters = []
  const seenGroups = new Set()
  for (const first of rows) {
    if (seenGroups.has(first.group)) continue
    seenGroups.add(first.group)
    // A tiered first line starts at its family's Basic (or lowest active) tier.
    const starter = tiered(first)
      ? rows
          .filter((row) => row.group === first.group && row.name === first.name && tiered(row))
          .reduce((best, row) => (tierRank(row) < tierRank(best) ? row : best))
      : first
    starters.push(starter)
  }
  return cleanProposalSelections(
    starters.map((service) => ({ serviceId: service.id, ...proposalSelectionDefaults(service) })),
  )
}

/**
 * The draft proposal's starting point from a set of answers: the contact block
 * on the prospect, every count under its catalog key on the inputs, and the rest
 * summarized into the prospect's notes (the editor shows them, the letter model
 * can read them). With the `catalog`, each service group they ticked becomes one
 * starter line (`selectionsForServiceGroups`), so it arrives priced; she adds,
 * removes or swaps lines on the Estimate tab as before. The services answer stays
 * in the notes too.
 *
 * `answers` is expected to have been through `cleanQuestionnaireAnswers`.
 */
export function answersToProposalSeed(questions, answers, catalog = null) {
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
    notes = QUESTIONNAIRE_NOTES_MARKER
    for (const line of lines) {
      if (notes.length + 1 + line.length > NOTES_MAX_CHARS) {
        const room = NOTES_MAX_CHARS - notes.length - 2
        if (room > 0) notes += `\n${line.slice(0, room)}…`
        break
      }
      notes += `\n${line}`
    }
  }
  const servicesQuestion = (Array.isArray(questions) ? questions : []).find(
    (item) => item.id === 'services' && item.type === 'multi',
  )
  const ticked = servicesQuestion && Array.isArray(answers?.services) ? answers.services : []
  return {
    prospect: cleanProposalProspect({ ...prospect, notes }),
    inputs: cleanProposalInputs(inputs),
    selections: catalog ? selectionsForServiceGroups(ticked, catalog) : [],
  }
}
