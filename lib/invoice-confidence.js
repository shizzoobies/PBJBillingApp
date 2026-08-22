/**
 * Rating a DRAFT INVOICE for accuracy before the owner reviews it.
 *
 * This is an advisory annotation and nothing else. It never feeds
 * `lib/invoice-lines.js` (the one money calculator), never changes a status,
 * never blocks a send. The plan of record is
 * `docs/plans/invoice-confidence-2026-08.md`.
 *
 * The lib is a pure function of its inputs plus one model call: no store
 * reads, no env checks beyond the key check `getClient()` already does. The
 * caller loads the draft, the client, the month's hours, the prior invoice and
 * the learning context and passes them in; the caller persists what comes back.
 *
 * Model: `INVOICE_AI_MODEL` or `claude-opus-5`, with `modelFallback: false`.
 * A wrong-but-confident rating out of a weaker model is worse than no rating —
 * on an overload the invoice just stays "Not rated" and can be re-rated.
 */

import { createHash, randomUUID } from 'node:crypto'
import { getClient, jsonSchema, runStructuredModel, US_ENGLISH_RULE } from './assistant.js'

/** The model that rates invoices when nothing is configured. */
export const DEFAULT_INVOICE_AI_MODEL = 'claude-opus-5'

/** Same output ceiling the assistant's other structured endpoints use. */
const STRUCTURED_MAX_TOKENS = 16000

/**
 * Blunt-flag doctrine (`lib/invoice-draft.js:75`): a flag that fires often gets
 * ignored. The caps are in the schema AND enforced again on the way out.
 */
export const MAX_CONCERNS = 4
export const MAX_QUESTIONS = 3

/**
 * Defensive caps on everything injected as context.
 *
 * The two learning caps are 12 for a reason: the store hands back a CLIENT
 * slice (up to 8) followed by a FIRM-WIDE slice (up to 4), client-first
 * (`db/store.js` listInvoiceLearningContext). Any cap below 12 silently eats
 * the firm-wide tail once a client has a full history of its own — the
 * cross-client lessons would stop reaching the model exactly when there is
 * enough history for them to matter.
 */
const CONTEXT_CAPS = {
  lineItems: 80,
  answeredQuestions: 12,
  corrections: 12,
  text: 600,
  entryChars: 500,
}

/** Which model this call will use. */
export function resolveInvoiceModel() {
  return String(process.env.INVOICE_AI_MODEL || '').trim() || DEFAULT_INVOICE_AI_MODEL
}

/** The band a score belongs to. High ≥ 85, medium 60–84, low < 60. */
export function bandForScore(score) {
  if (score >= 85) return 'high'
  if (score >= 60) return 'medium'
  return 'low'
}

/**
 * Every string carries a `minLength` floor.
 *
 * Why (the house rule, `lib/assistant.js:1169`): under grammar-constrained
 * decoding a bare `{ type: 'string' }` has a legal empty-ish output, so a model
 * that balks emits the SHORTEST legal string — a "," — and we would file that
 * as a real concern on a real invoice. The floors sit far below anything a true
 * answer produces:
 *  - summary 20  — one short sentence; a real one is always longer.
 *  - concern line 2 — a line label, not a stray character.
 *  - concern issue 15 — "the hours don't match" is already past this.
 *  - question 12 — a question for the owner, not "why?".
 */
export const INVOICE_CONFIDENCE_SCHEMA = {
  type: 'object',
  properties: {
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    score: { type: 'integer', minimum: 0, maximum: 100 },
    summary: { type: 'string', minLength: 20 },
    concerns: {
      type: 'array',
      maxItems: MAX_CONCERNS,
      items: {
        type: 'object',
        properties: {
          line: { type: 'string', minLength: 2 },
          issue: { type: 'string', minLength: 15 },
          severity: { type: 'string', enum: ['info', 'warn'] },
        },
        required: ['line', 'issue', 'severity'],
        additionalProperties: false,
      },
    },
    questions: {
      type: 'array',
      maxItems: MAX_QUESTIONS,
      items: { type: 'string', minLength: 12 },
    },
  },
  required: ['confidence', 'score', 'summary', 'concerns', 'questions'],
  additionalProperties: false,
}

const SYSTEM_PROMPT = `You are checking a DRAFT INVOICE for accuracy before the
owner of PB&J Strategic Accounting — a small bookkeeping firm — reviews it. She
reviews every invoice herself; you are the pass before hers. Your rating is
advisory: it never changes the invoice and never blocks anything.

What to check, in order:
1. ARITHMETIC. Each hourly line should equal the hours printed on the line
   times that employee's bill rate, and the hours should reconcile against the
   month's billable-hours summary. Say which line and which number is off.
2. PLAN-VS-HOURLY CONSISTENCY. A subscription or annual client's flat fee
   already covers their scoped work, so unexplained hourly charges on one are a
   real problem. The draft's scope flags are the app's own version of this
   check — if a scope flag is present, address it rather than ignoring it.
3. RECURRING REIMBURSEMENT COVERAGE WINDOWS. The window should be contiguous
   with the prior month's (no gap, no overlap), name the right month, and
   contain no unfilled template tokens such as {range} or {month}. Lines marked
   needsCoverageConfirmation are ALREADY held for the owner by the app —
   acknowledge them if relevant, never re-raise them as your own finding.
4. AD HOC LINES. Each one should carry an explicit disposition (billed,
   omitted, or written off). Call out anything surprising — a large amount, a
   description that does not read like client work, a disposition that does not
   match the rest of the month.
5. DESCRIPTIONS. Line text should name the month actually being billed.
6. MONTH-OVER-MONTH ANOMALIES against the prior invoice: a large swing in the
   total, a line that appeared from nowhere, a recurring line that vanished. An
   anomaly is something to FLAG, not necessarily an error — say what changed
   and let her judge.
7. THE LEARNING CONTEXT is how the owner has corrected drafts like this one
   before, in her own words. Weight it heavily: a pattern she has already
   corrected is much more likely to be wrong again than anything you infer.

How to answer:
- "score" is 0-100 and "confidence" must match it: high is 85 or more, medium
  is 60 to 84, low is under 60.
- "summary" is one or two plain sentences addressed to the owner, saying what
  you found. No preamble, no jargon.
- "concerns" are FEW and SPECIFIC — at most four, and fewer is better. This
  firm's doctrine is that a flag which fires often gets ignored, so a concern
  has to be worth interrupting her for. "line" names the line it is about
  ("Billable hours — Lisa", "Software reimbursement"), "issue" says what looks
  wrong in one sentence, "severity" is "warn" when the number or the coverage
  may actually be wrong and "info" when it is merely worth a look.
- "questions" are at most three and are ONLY things the owner alone can answer:
  client-relationship knowledge, intent, what she agreed to with the client.
  Never ask something the draft or the hours summary already answers. Address
  her directly ("Did you agree to cover the extra cleanup for Clover in
  August?"), never rhetorically.
- If the draft checks out, say so plainly, return high confidence, no concerns
  worth raising, and NO questions. A clean invoice is the normal case.` +
  US_ENGLISH_RULE

/** Trim a value to a string, capped, or '' when there is nothing there. */
function text(value, cap = CONTEXT_CAPS.text) {
  const out = String(value ?? '').trim()
  return out ? out.slice(0, cap) : ''
}

/** Drop undefined/null keys so the JSON blocks stay compact and readable. */
function compact(object) {
  const out = {}
  for (const [key, value] of Object.entries(object)) {
    if (value === undefined || value === null || value === '') continue
    out[key] = value
  }
  return out
}

/**
 * One of `summarizeLineItemChange`'s label lists ("Software ($40)",
 * "Billable hours — Lisa: $950 → $900"), or undefined when it is empty so
 * `compact` drops the key entirely.
 */
function labelList(value) {
  const list = (Array.isArray(value) ? value : [])
    .map((entry) => text(entry, 200))
    .filter(Boolean)
    .slice(0, 4)
  return list.length > 0 ? list : undefined
}

/** One line item as the model sees it: the numbers plus its provenance. */
function compactLine(line) {
  if (!line || typeof line !== 'object') return {}
  return compact({
    kind: line.kind,
    label: text(line.label, 200),
    detail: text(line.detail, 300),
    amount: Number.isFinite(Number(line.amount)) ? Number(line.amount) : undefined,
    adhocMode: line.adhocMode,
    adhocAmount: Number.isFinite(Number(line.adhocAmount)) ? Number(line.adhocAmount) : undefined,
    coverageStart: line.coverageStart,
    coverageEnd: line.coverageEnd,
    needsCoverageConfirmation: line.needsCoverageConfirmation === true ? true : undefined,
    coverageReason: line.coverageReason,
    retainerInvoiceId: line.retainerInvoiceId,
    quantity: line.quantity,
    rate: line.rate,
  })
}

function compactLines(lineItems) {
  return (Array.isArray(lineItems) ? lineItems : [])
    .slice(0, CONTEXT_CAPS.lineItems)
    .map(compactLine)
}

function compactInvoice(invoice) {
  if (!invoice || typeof invoice !== 'object') return null
  return compact({
    number: invoice.number,
    period: invoice.period,
    dueDate: invoice.dueDate,
    subtotal: invoice.subtotal,
    total: invoice.total,
    status: invoice.status,
    blurb: text(invoice.blurb),
    scopeFlags: Array.isArray(invoice.scopeFlags) && invoice.scopeFlags.length > 0
      ? invoice.scopeFlags
      : undefined,
    lineItems: compactLines(invoice.lineItems),
  })
}

function compactClient(client) {
  if (!client || typeof client !== 'object') return null
  return compact({
    name: text(client.name, 200),
    planType: client.planType ?? client.billingMode ?? client.billingType,
    planName: client.planName,
    monthlyRate: client.monthlyRate,
    annualRate: client.annualRate,
    annualBillingMonth: client.annualBillingMonth,
    hourlyRate: client.hourlyRate,
    estimatedMonthlyHours: client.estimatedMonthlyHours,
    estimatedBookkeeperHours: client.estimatedBookkeeperHours,
    estimatedAccountantHours: client.estimatedAccountantHours,
    estimatedCfoHours: client.estimatedCfoHours,
    paymentTerms: text(client.paymentTerms, 200),
  })
}

/**
 * The learning context is capped HERE as well as at the call site — a caller
 * that forgets is otherwise one long client history away from crowding the
 * draft itself out of the prompt.
 */
function compactLearningContext(learningContext) {
  const source = learningContext && typeof learningContext === 'object' ? learningContext : {}
  const answeredQuestions = (
    Array.isArray(source.answeredQuestions) ? source.answeredQuestions : []
  )
    .map((entry) =>
      typeof entry === 'string'
        ? text(entry, CONTEXT_CAPS.entryChars)
        : compact({
            // 'firm' means the answer came from a DIFFERENT client. Unlabeled,
            // the model would read it as something she said about this one.
            scope: entry?.scope,
            period: entry?.period,
            question: text(entry?.question, CONTEXT_CAPS.entryChars),
            answer: text(entry?.answer, CONTEXT_CAPS.entryChars),
          }),
    )
    .filter((entry) =>
      typeof entry === 'string' ? entry !== '' : Boolean(entry.question) && Boolean(entry.answer),
    )
    .slice(0, CONTEXT_CAPS.answeredQuestions)

  const corrections = (Array.isArray(source.corrections) ? source.corrections : [])
    .map((entry) =>
      typeof entry === 'string'
        ? text(entry, CONTEXT_CAPS.entryChars)
        : compact({
            scope: entry?.scope,
            period: entry?.period,
            invoiceId: entry?.invoiceId,
            // The store has already reduced each edit to three label lists
            // (`summarizeLineItemChange`). Carrying THOSE is the whole point of
            // the section — a correction with only its month left says nothing.
            removed: labelList(entry?.removed),
            added: labelList(entry?.added),
            changed: labelList(entry?.changed),
          }),
    )
    // An edit that moved nothing on the lines has no lesson in it — and would
    // otherwise burn a slot that a real correction needed.
    .filter((entry) =>
      typeof entry === 'string'
        ? entry !== ''
        : Boolean(entry.removed || entry.added || entry.changed),
    )
    .slice(0, CONTEXT_CAPS.corrections)

  return { answeredQuestions, corrections }
}

/** A labelled section with a compact JSON block under it. */
function section(heading, value) {
  return `${heading}\n${JSON.stringify(value)}`
}

/**
 * The user message: the draft and everything it was derived from, as labelled
 * JSON blocks. Exported so the prompt can be inspected in a test without a
 * model call.
 */
export function buildRatingMessage({ invoice, client, hoursSummary, priorInvoice, learningContext }) {
  const learning = compactLearningContext(learningContext)
  const sections = [
    section('THE DRAFT INVOICE (the thing you are rating):', compactInvoice(invoice) ?? {}),
    section('THE CLIENT:', compactClient(client) ?? {}),
    section(
      "THE MONTH'S BILLABLE HOURS PER EMPLOYEE (what the hourly lines were derived from):",
      hoursSummary ?? null,
    ),
    section(
      "THE PRIOR MONTH'S INVOICE FOR THIS CLIENT (null when there is none):",
      compactInvoice(priorInvoice),
    ),
    section(
      'LEARNING CONTEXT — how the owner has corrected drafts before ' +
        '(her answers to earlier questions, and her actual edits):',
      learning,
    ),
  ]
  return sections.join('\n\n')
}

/**
 * Canonical sha256 of a set of line items — the staleness key.
 *
 * Object key order is normalized (a store round-trip reorders keys), array
 * order is NOT: the order of the lines is part of the invoice.
 */
export function linesFingerprint(lineItems) {
  const canonical = canonicalize(Array.isArray(lineItems) ? lineItems : [])
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) {
      const next = canonicalize(value[key])
      if (next === undefined) continue
      out[key] = next
    }
    return out
  }
  return value
}

/**
 * Turn the model's questions into the stored question entries.
 *
 * Ids follow the local idiom (`prefix-${randomUUID().slice(0, 8)}`, as in
 * db/store.js). `opts.now` is accepted for call-site symmetry with the rest of
 * this module; `answeredAt` starts null by definition, so nothing reads a clock
 * here.
 */
export function buildQuestionEntries(questions, opts = {}) {
  void opts
  return (Array.isArray(questions) ? questions : [])
    .map((question) => text(question, CONTEXT_CAPS.entryChars))
    .filter(Boolean)
    .slice(0, MAX_QUESTIONS)
    .map((question) => ({
      id: `aiq-${randomUUID().slice(0, 8)}`,
      question,
      answer: null,
      skipped: false,
      answeredAt: null,
    }))
}

/** The nudge on the retry. Names the shape that failed, not "empty filler". */
const REPAIR_HINT =
  'Your previous reply did not fit the required shape. Return valid JSON where ' +
  '"confidence" matches "score" (high is 85 or more, medium is 60 to 84, low is ' +
  'under 60), the summary is a real sentence addressed to the owner, and there ' +
  'are at most four concerns and three questions.'

/**
 * Rate one draft invoice.
 *
 * @param {{
 *   invoice: object,
 *   client?: object,
 *   hoursSummary?: unknown,
 *   priorInvoice?: object|null,
 *   learningContext?: { answeredQuestions?: unknown[], corrections?: unknown[] },
 * }} input
 * @param {{ client?: object, now?: string|Date }} [opts]
 *   `opts.client` injects an Anthropic client (tests), same convention as
 *   lib/assistant.js.
 * @returns {Promise<{
 *   model: string, confidence: 'high'|'medium'|'low', score: number,
 *   summary: string,
 *   concerns: Array<{line: string, issue: string, severity: 'info'|'warn'}>,
 *   questions: Array<{id: string, question: string, answer: null, skipped: false, answeredAt: null}>,
 *   linesFingerprint: string,
 * }>}
 */
export async function rateInvoiceDraft(
  { invoice, client, hoursSummary, priorInvoice, learningContext } = {},
  opts = {},
) {
  const anthropic = opts.client || getClient()
  const model = resolveInvoiceModel()

  const verdict = await runStructuredModel(
    anthropic,
    {
      model,
      max_tokens: STRUCTURED_MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: buildRatingMessage({
            invoice,
            client,
            hoursSummary,
            priorInvoice,
            learningContext,
          }),
        },
      ],
      output_config: jsonSchema(INVOICE_CONFIDENCE_SCHEMA),
    },
    validateVerdict,
    {
      endpoint: 'rateInvoiceDraft',
      unavailable: 'The AI could not rate this invoice right now. Please try again.',
      invalid: 'The AI returned an unexpected rating. Please try again.',
      repairHint: REPAIR_HINT,
    },
    // No fallback model by design: a wrong-but-confident rating from a weaker
    // model is worse than no rating. On overload this throws a 503 and the
    // invoice stays unrated until someone re-rates it.
    { modelFallback: false },
  )

  return {
    model,
    ...verdict,
    questions: buildQuestionEntries(verdict.questions, { now: opts.now }),
    linesFingerprint: linesFingerprint(invoice?.lineItems),
  }
}

/** Shape and cross-field checks. A `{ ok: false }` sends the runner round again. */
function validateVerdict(parsed) {
  const confidence = String(parsed?.confidence ?? '').trim().toLowerCase()
  if (confidence !== 'high' && confidence !== 'medium' && confidence !== 'low') {
    return { ok: false }
  }

  const rawScore = Number(parsed?.score)
  if (!Number.isFinite(rawScore)) return { ok: false }
  const score = Math.min(100, Math.max(0, Math.round(rawScore)))

  // Band and score are both returned, so they can disagree — and a "high" band
  // sitting on a 40 would show her a green badge over a broken invoice. Send it
  // back rather than picking a winner.
  if (bandForScore(score) !== confidence) {
    return { ok: false, message: 'The AI returned an unexpected rating. Please try again.' }
  }

  const summary = text(parsed?.summary, 1000)
  if (!summary) return { ok: false }

  const concerns = (Array.isArray(parsed?.concerns) ? parsed.concerns : [])
    .map((concern) => ({
      line: text(concern?.line, 200),
      issue: text(concern?.issue, 500),
      severity: concern?.severity === 'warn' ? 'warn' : 'info',
    }))
    .filter((concern) => concern.line !== '' && concern.issue !== '')
    .slice(0, MAX_CONCERNS)

  const questions = (Array.isArray(parsed?.questions) ? parsed.questions : [])
    .map((question) => text(question, CONTEXT_CAPS.entryChars))
    .filter(Boolean)
    .slice(0, MAX_QUESTIONS)

  return { ok: true, value: { confidence, score, summary, concerns, questions } }
}
