/**
 * The engagement letter's SECTION LIBRARY (docs/plans/engagements-2026-10.md, stage 2A).
 *
 * An engagement letter is assembled from sections the owner edits in Settings. Each
 * section says when it belongs in a letter (its `trigger`): always, or when the Won
 * proposal has a line in one of the named service groups, or a line for one of the
 * named catalog services. `lib/engagement-assemble.js` turns the triggered sections
 * into the letter; the `email` section is the cover email, never part of the letter.
 *
 * Pure on purpose (no store, no env, no node built-ins, no clock) so the Settings page
 * and the server read the same library with the same rules.
 *
 * Section shape: `{key, title, body, trigger, sortOrder, role, active}`.
 *  - `key`    `^[a-z0-9_]+$`, at most 40 characters, unique in a library.
 *  - `title`  at most 120 characters. NOT part of the body: the assembler prints it
 *             as a `**Title**` line above the body (the intro prints no title).
 *  - `body`   at most 20,000 characters, `{{placeholders}}` and `**bold**` as in Letters.
 *  - `trigger` `{always?: true, groups?: string[], serviceIds?: string[]}`.
 *  - `role`   derived from the key, never stored: `email` for the key `email`, else
 *             `letter`. (The engagement_sections table has no role column.)
 *  - `active` false = kept in the library but never used (sections are never deleted).
 */

export const ENGAGEMENT_SECTION_KEY_MAX = 40
export const ENGAGEMENT_SECTION_TITLE_MAX = 120
export const ENGAGEMENT_SECTION_BODY_MAX = 20000
export const ENGAGEMENT_SECTION_TRIGGER_MAX = 20
/** A library holds at most this many sections (the seed has 11). */
export const ENGAGEMENT_SECTIONS_MAX = 60
/** The one section that is the cover email rather than part of the letter. */
export const EMAIL_SECTION_KEY = 'email'
/** The section printed without a title line (it opens the letter). */
export const INTRO_SECTION_KEY = 'intro'

const KEY_SHAPE = /^[a-z0-9_]+$/
/** A trigger entry (a group name or a catalog service id) is capped like a catalog name. */
const TRIGGER_ENTRY_MAX = 120
const SORT_ORDER_LIMIT = 1e6

/** Recursively Object.freeze arrays and plain objects. */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

const SEED = [
  {
    key: 'email',
    title: 'Email',
    trigger: { always: true },
    body: [
      'Hi {{contact_first_name}},',
      'Thank you for choosing {{firm_name}}. Attached is our engagement letter for {{client_name}}. It sets out the services we will provide, our fees, and the terms of our work together.',
      'Please review the letter, sign it, and reply to this email with the signed copy. If you have any questions or would like anything changed, just reply and let us know.',
      'Thank you,\n{{sender_name}}',
    ].join('\n\n'),
  },
  {
    key: 'intro',
    title: 'Introduction',
    trigger: { always: true },
    body: [
      'Dear {{contact_name}},',
      'Thank you for choosing {{firm_name}}. This letter confirms the services we will provide to {{client_name}}, the fees for those services, and the terms of our engagement. Our work under this letter begins in {{start_month}}.',
    ].join('\n\n'),
  },
  {
    key: 'services_monthly',
    title: 'Monthly services',
    trigger: {
      groups: ['Monthly', 'Reconciliations', 'AR', 'AP', 'Reports', 'Additional reports'],
    },
    body: [
      'Each month we will provide the following bookkeeping and accounting services:',
      '{{services_monthly}}',
      'The fee for this monthly work is {{monthly_fee}} per month. It is based on the volume of activity we discussed; if your volume or needs change significantly, we will talk with you before any change to the fee.',
    ].join('\n\n'),
  },
  {
    key: 'services_annual',
    title: 'Annual and one-time services',
    trigger: { groups: ['Annual and one-time'] },
    body: [
      'We will also provide the following annual and one-time services, at the fees shown:',
      '{{services_annual}}',
    ].join('\n\n'),
  },
  {
    key: 'cleanup',
    title: 'Clean-up',
    trigger: { groups: ['Clean-up'] },
    body:
      'We will bring your books up to date before our regular work begins. The clean-up covers {{cleanup_months}} of past records: we will categorize and correct transactions, reconcile your accounts, and tidy the chart of accounts as needed. The clean-up fee is {{cleanup_fee}}, a one-time fee.',
  },
  {
    key: 'payroll',
    title: 'Payroll',
    trigger: { groups: ['Payroll'] },
    body:
      'We will process payroll for your employees on the schedule we agreed and prepare the payroll tax filings that go with it. You are responsible for sending us accurate hours, pay changes, new hires, and departures before each payroll deadline, and for keeping enough funds in your account to cover wages and payroll taxes. Payroll is included in the monthly fee.',
  },
  {
    key: 'sales_tax',
    title: 'Sales tax',
    trigger: { groups: ['Sales tax'] },
    body:
      'We will prepare and file your sales tax returns in {{sales_tax_states}} on the schedule each state requires. You are responsible for telling us about new locations, new kinds of sales, and any notice you receive from a taxing authority, and for keeping funds available to pay the tax due. Sales tax filing is included in the monthly fee.',
  },
  {
    key: 'consulting',
    title: 'Advisory and consulting',
    // The catalog's "Client call" line (lib/proposal-pricing.js SEED_ROWS, group
    // Additional reports): there is no Consulting group, so this section keys on the line.
    trigger: { serviceIds: ['client-call'] },
    body:
      'We will meet with you regularly to review your financial results and answer your questions about the business, for the call hours included in the monthly fee. Advisory work beyond those hours, or a special project, will be agreed with you in advance.',
  },
  {
    key: 'fees',
    title: 'Fees and payment',
    trigger: { always: true },
    body: [
      'Our recurring fee is {{fee}}. Any annual, one-time, or clean-up fees are shown in the sections above. Payment terms: {{payment_terms}}.',
      '{{software_sentence}}',
      '{{retainer_sentence}}',
      'We will always discuss a change in our fees with you before it takes effect, and confirm it in writing.',
    ].join('\n\n'),
  },
  {
    key: 'terms',
    title: 'Terms of our engagement',
    trigger: { always: true },
    body: [
      '**Your responsibilities.** You are responsible for the accuracy and completeness of the records and information you give us, for your business decisions, and for reviewing the reports we prepare. We rely on the information you provide and do not audit or verify it.',
      '**Term and termination.** This engagement continues month to month until either of us ends it with 30 days of written notice. You will pay for the work completed through the end date.',
      '**Confidentiality.** We keep your information confidential and use it only to provide our services, except where the law requires us to disclose it.',
    ].join('\n\n'),
  },
  {
    key: 'closing',
    title: 'Agreement',
    trigger: { always: true },
    body: [
      'If this letter reflects your understanding of our engagement, please sign below and return a copy to us by replying to the email it came with. We look forward to working with you.',
      'Sincerely,\n{{sender_name}}, {{firm_name}}',
      'Agreed and accepted:\nSignature: ______________________\nName: {{contact_name}}\nDate: ______________',
    ].join('\n\n'),
  },
]

/**
 * The seed library, in letter order. Frozen deep; `sanitizeEngagementSections` (or a
 * spread) gives a mutable copy.
 *
 * @type {ReadonlyArray<{key: string, title: string, body: string, trigger: object, sortOrder: number, role: 'email'|'letter', active: boolean}>}
 */
export const DEFAULT_ENGAGEMENT_SECTIONS = deepFreeze(
  SEED.map((section, index) => ({
    key: section.key,
    title: section.title,
    body: section.body,
    trigger: section.trigger,
    sortOrder: (index + 1) * 10,
    role: section.key === EMAIL_SECTION_KEY ? 'email' : 'letter',
    active: true,
  })),
)

const ESCAPE_CR = /\r\n?/g

function cleanString(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

/** A trigger list: strings only, trimmed, non-blank, no repeats, at most 20. */
function cleanList(value) {
  const out = []
  for (const entry of Array.isArray(value) ? value : []) {
    if (typeof entry !== 'string') continue
    const clean = entry.trim().slice(0, TRIGGER_ENTRY_MAX)
    if (clean && !out.includes(clean)) out.push(clean)
    if (out.length >= ENGAGEMENT_SECTION_TRIGGER_MAX) break
  }
  return out
}

/**
 * `{always?, groups?, serviceIds?}` with only what is set: `always` only when it is
 * literally true, a list only when it has an entry. `{}` is a section that never fires.
 */
function cleanTrigger(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const trigger = {}
  if (src.always === true) trigger.always = true
  const groups = cleanList(src.groups)
  if (groups.length) trigger.groups = groups
  const serviceIds = cleanList(src.serviceIds)
  if (serviceIds.length) trigger.serviceIds = serviceIds
  return trigger
}

function cleanSortOrder(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return 0
  if (value === '') return 0
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.trunc(Math.min(Math.max(n, -SORT_ORDER_LIMIT), SORT_ORDER_LIMIT))
}

/**
 * One owner-edited section, cleaned; null when it cannot be one (no valid key).
 * Never throws. The key is trimmed and lower-cased before the shape check.
 *
 * @param {unknown} input
 * @returns {{key: string, title: string, body: string, trigger: object, sortOrder: number, role: 'email'|'letter', active: boolean} | null}
 */
export function sanitizeEngagementSection(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const key = typeof input.key === 'string' ? input.key.trim().toLowerCase() : ''
  if (!key || key.length > ENGAGEMENT_SECTION_KEY_MAX || !KEY_SHAPE.test(key)) return null
  const body =
    typeof input.body === 'string'
      ? input.body.replace(ESCAPE_CR, '\n').trim().slice(0, ENGAGEMENT_SECTION_BODY_MAX)
      : ''
  return {
    key,
    title: cleanString(input.title, ENGAGEMENT_SECTION_TITLE_MAX).replace(/\s+/g, ' '),
    body,
    trigger: cleanTrigger(input.trigger),
    sortOrder: cleanSortOrder(input.sortOrder),
    role: key === EMAIL_SECTION_KEY ? 'email' : 'letter',
    active: input.active !== false,
  }
}

/**
 * A whole library, cleaned: invalid entries dropped, keys unique (the FIRST wins),
 * at most 60, ordered by `sortOrder` (ties keep the order given). Not an array -> [].
 *
 * @param {unknown} list
 */
export function sanitizeEngagementSections(list) {
  const seen = new Set()
  const out = []
  for (const entry of Array.isArray(list) ? list : []) {
    const section = sanitizeEngagementSection(entry)
    if (!section || seen.has(section.key)) continue
    seen.add(section.key)
    out.push(section)
    if (out.length >= ENGAGEMENT_SECTIONS_MAX) break
  }
  return out
    .map((section, index) => ({ section, index }))
    .sort((a, b) => a.section.sortOrder - b.section.sortOrder || a.index - b.index)
    .map(({ section }) => section)
}

/** True when a section is the cover email (by key: the role is never stored). */
export function isEmailSection(section) {
  return section?.key === EMAIL_SECTION_KEY || section?.role === 'email'
}

/**
 * Does this section's trigger fire for these proposal lines?
 * `always`, or any line whose `group` is in `groups`, or whose `serviceId` is in
 * `serviceIds`. Every line counts - a flagged line (not yet priced, retired) still
 * means the service was chosen.
 */
export function sectionFires(section, snapshotLines) {
  const trigger = section?.trigger && typeof section.trigger === 'object' ? section.trigger : {}
  if (trigger.always === true) return true
  const groups = Array.isArray(trigger.groups) ? trigger.groups : []
  const serviceIds = Array.isArray(trigger.serviceIds) ? trigger.serviceIds : []
  if (!groups.length && !serviceIds.length) return false
  for (const line of Array.isArray(snapshotLines) ? snapshotLines : []) {
    if (!line || typeof line !== 'object') continue
    if (typeof line.group === 'string' && groups.includes(line.group)) return true
    if (typeof line.serviceId === 'string' && serviceIds.includes(line.serviceId)) return true
  }
  return false
}

/**
 * The LETTER sections (never the `email` one) that belong in a letter for these
 * proposal lines, active ones only, ordered by `sortOrder` (ties keep the order given).
 *
 * @param {ReadonlyArray<object>} sections   a library (stored rows or the seed)
 * @param {ReadonlyArray<{group?: string|null, serviceId?: string|null}>} snapshotLines
 */
export function triggeredSections(sections, snapshotLines) {
  return (Array.isArray(sections) ? sections : [])
    .map((section, index) => ({ section, index }))
    .filter(
      ({ section }) =>
        section &&
        typeof section === 'object' &&
        section.active !== false &&
        !isEmailSection(section) &&
        sectionFires(section, snapshotLines),
    )
    .sort((a, b) => (Number(a.section.sortOrder) || 0) - (Number(b.section.sortOrder) || 0) || a.index - b.index)
    .map(({ section }) => section)
}
