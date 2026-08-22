import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_INVOICE_AI_MODEL,
  bandForScore,
  buildQuestionEntries,
  buildRatingMessage,
  linesFingerprint,
  rateInvoiceDraft,
  resolveInvoiceModel,
} from './invoice-confidence.js'

// Same harness shape as lib/assistant.test.mjs: `messages.create` shifts
// scripted responses off a queue. Rating never streams, so `create` is enough.
function fakeClient(responses) {
  const queue = [...responses]
  return {
    messages: {
      create: vi.fn(async () => {
        if (queue.length === 0) throw new Error('no scripted response left')
        const next = queue.shift()
        if (next instanceof Error) throw next
        return next
      }),
    },
  }
}

const jsonResponse = (value) => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
})

const goodVerdict = {
  confidence: 'high',
  score: 92,
  summary: 'The hours and rates reconcile against the August summary and nothing looks off.',
  concerns: [],
  questions: [],
}

const invoice = {
  number: 'INV-1042',
  period: '2026-08',
  dueDate: '2026-09-30',
  subtotal: 1250,
  total: 1250,
  blurb: 'August bookkeeping',
  scopeFlags: [],
  lineItems: [
    { kind: 'hourly', label: 'Billable hours — Lisa', detail: '10.0 at $95.00/hr', amount: 950 },
    {
      kind: 'recurring',
      label: 'Software reimbursement',
      detail: 'Aug 1 – Aug 31',
      amount: 300,
      coverageStart: '2026-08-01',
      coverageEnd: '2026-08-31',
      needsCoverageConfirmation: false,
    },
  ],
}

const client = {
  name: 'Clover Farms',
  billingMode: 'hourly',
  paymentTerms: 'Net 30',
  estimatedBookkeeperHours: 12,
}

const input = {
  invoice,
  client,
  hoursSummary: [{ employee: 'Lisa', hours: 10, billRate: 95 }],
  priorInvoice: null,
  learningContext: { answeredQuestions: [], corrections: [] },
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('rateInvoiceDraft', () => {
  it('returns the verdict and turns the questions into stored entries', async () => {
    const anthropic = fakeClient([
      jsonResponse({
        ...goodVerdict,
        confidence: 'medium',
        score: 72,
        concerns: [
          { line: 'Billable hours — Lisa', issue: 'Ten hours against a twelve-hour estimate.', severity: 'info' },
        ],
        questions: ['Did you agree to cover the extra cleanup for Clover in August?'],
      }),
    ])

    const result = await rateInvoiceDraft(input, { client: anthropic })

    expect(result.confidence).toBe('medium')
    expect(result.score).toBe(72)
    expect(result.summary).toMatch(/reconcile/)
    expect(result.model).toBe(DEFAULT_INVOICE_AI_MODEL)
    expect(result.concerns).toEqual([
      {
        line: 'Billable hours — Lisa',
        issue: 'Ten hours against a twelve-hour estimate.',
        severity: 'info',
      },
    ])
    expect(result.questions).toHaveLength(1)
    expect(result.questions[0]).toMatchObject({
      question: 'Did you agree to cover the extra cleanup for Clover in August?',
      answer: null,
      skipped: false,
      answeredAt: null,
    })
    expect(result.questions[0].id).toMatch(/^aiq-[0-9a-f]{8}$/)
    expect(result.linesFingerprint).toBe(linesFingerprint(invoice.lineItems))
    expect(anthropic.messages.create).toHaveBeenCalledTimes(1)
  })

  it('retries once when the band and the score disagree, with the repair hint', async () => {
    const anthropic = fakeClient([
      jsonResponse({ ...goodVerdict, confidence: 'high', score: 41 }),
      jsonResponse(goodVerdict),
    ])

    const result = await rateInvoiceDraft(input, { client: anthropic })

    expect(result.confidence).toBe('high')
    expect(result.score).toBe(92)
    expect(anthropic.messages.create).toHaveBeenCalledTimes(2)

    const [first] = anthropic.messages.create.mock.calls[0]
    const [second] = anthropic.messages.create.mock.calls[1]
    expect(first.system).not.toMatch(/did not fit the required shape/)
    expect(second.system).toMatch(/did not fit the required shape/)
    expect(second.system.startsWith(first.system)).toBe(true)
  })

  it('salvages JSON wrapped in prose', async () => {
    const anthropic = fakeClient([
      jsonResponse(`Here is the rating:\n${JSON.stringify(goodVerdict)}\nHope that helps.`),
    ])

    const result = await rateInvoiceDraft(input, { client: anthropic })

    expect(result.score).toBe(92)
    expect(anthropic.messages.create).toHaveBeenCalledTimes(1)
  })

  it('throws a 502 when the output is unusable twice', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const anthropic = fakeClient([
      jsonResponse('not json at all, sorry'),
      jsonResponse('still not json'),
    ])

    await expect(rateInvoiceDraft(input, { client: anthropic })).rejects.toMatchObject({
      statusCode: 502,
    })
    expect(anthropic.messages.create).toHaveBeenCalledTimes(2)
  })

  it('clamps the score, caps the arrays and trims the strings', async () => {
    const anthropic = fakeClient([
      jsonResponse({
        confidence: 'high',
        score: 250,
        summary: '   Everything reconciles for August.   ',
        concerns: Array.from({ length: 7 }, (_, index) => ({
          line: `  Line ${index}  `,
          issue: `  Issue number ${index} needs a look.  `,
          severity: index === 0 ? 'warn' : 'info',
        })),
        questions: ['  One?  ', 'Two?', 'Three?', 'Four?', 'Five?'],
      }),
    ])

    const result = await rateInvoiceDraft(input, { client: anthropic })

    expect(result.score).toBe(100)
    expect(result.confidence).toBe('high')
    expect(result.summary).toBe('Everything reconciles for August.')
    expect(result.concerns).toHaveLength(4)
    expect(result.concerns[0]).toEqual({
      line: 'Line 0',
      issue: 'Issue number 0 needs a look.',
      severity: 'warn',
    })
    expect(result.questions).toHaveLength(3)
    expect(result.questions[0].question).toBe('One?')
  })

  it('does not degrade to another model when the model is overloaded', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const anthropic = fakeClient([Object.assign(new Error('overloaded'), { status: 529 })])

    await expect(rateInvoiceDraft(input, { client: anthropic })).rejects.toMatchObject({
      statusCode: 503,
    })
    // One attempt, one model: no fallback call, no retry loop.
    expect(anthropic.messages.create).toHaveBeenCalledTimes(1)
    expect(anthropic.messages.create.mock.calls[0][0].model).toBe(DEFAULT_INVOICE_AI_MODEL)
  })

  it('asks for structured output and sends the draft as labelled sections', async () => {
    const anthropic = fakeClient([jsonResponse(goodVerdict)])

    await rateInvoiceDraft(input, { client: anthropic })

    const [params] = anthropic.messages.create.mock.calls[0]
    expect(params.output_config.format.type).toBe('json_schema')
    expect(params.output_config.format.schema.additionalProperties).toBe(false)
    expect(params.output_config.format.schema.properties.concerns.maxItems).toBe(4)
    expect(params.output_config.format.schema.properties.questions.maxItems).toBe(3)
    expect(params.max_tokens).toBe(16000)
    expect(params.system).toMatch(/AMERICAN English/)
    expect(params.messages[0].content).toMatch(/THE DRAFT INVOICE/)
    expect(params.messages[0].content).toMatch(/INV-1042/)
  })

  it('honors INVOICE_AI_MODEL and otherwise uses claude-opus-5', async () => {
    expect(resolveInvoiceModel()).toBe('claude-opus-5')

    vi.stubEnv('INVOICE_AI_MODEL', 'claude-sonnet-4-5')
    expect(resolveInvoiceModel()).toBe('claude-sonnet-4-5')

    const anthropic = fakeClient([jsonResponse(goodVerdict)])
    const result = await rateInvoiceDraft(input, { client: anthropic })
    expect(result.model).toBe('claude-sonnet-4-5')
    expect(anthropic.messages.create.mock.calls[0][0].model).toBe('claude-sonnet-4-5')
  })
})

describe('linesFingerprint', () => {
  it('is stable across key order and a store round-trip', () => {
    const a = [{ kind: 'hourly', label: 'Billable hours — Lisa', amount: 950 }]
    const b = [{ amount: 950, label: 'Billable hours — Lisa', kind: 'hourly' }]
    expect(linesFingerprint(a)).toBe(linesFingerprint(b))
    expect(linesFingerprint(a)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('changes when a line amount changes', () => {
    const before = linesFingerprint(invoice.lineItems)
    const after = linesFingerprint([
      { ...invoice.lineItems[0], amount: 951 },
      invoice.lineItems[1],
    ])
    expect(after).not.toBe(before)
  })

  it('changes when the lines are reordered — line order is part of the invoice', () => {
    const reversed = [...invoice.lineItems].reverse()
    expect(linesFingerprint(reversed)).not.toBe(linesFingerprint(invoice.lineItems))
  })

  it('treats a missing line list as an empty one', () => {
    expect(linesFingerprint(undefined)).toBe(linesFingerprint([]))
  })
})

describe('buildQuestionEntries', () => {
  it('caps at three, drops blanks and gives each a unique id', () => {
    const entries = buildQuestionEntries(['  First?  ', '', '   ', 'Second?', 'Third?', 'Fourth?'], {
      now: '2026-08-22T12:00:00.000Z',
    })
    expect(entries.map((entry) => entry.question)).toEqual(['First?', 'Second?', 'Third?'])
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(3)
    expect(entries.every((entry) => entry.answer === null && entry.skipped === false)).toBe(true)
  })

  it('returns nothing for a missing list', () => {
    expect(buildQuestionEntries(undefined)).toEqual([])
  })
})

describe('bandForScore', () => {
  it('splits at 85 and 60', () => {
    expect(bandForScore(100)).toBe('high')
    expect(bandForScore(85)).toBe('high')
    expect(bandForScore(84)).toBe('medium')
    expect(bandForScore(60)).toBe('medium')
    expect(bandForScore(59)).toBe('low')
    expect(bandForScore(0)).toBe('low')
  })
})

// The shape db/store.js listInvoiceLearningContext actually emits: scope +
// provenance, then summarizeLineItemChange's three label lists spread on top.
const storeCorrection = (index, scope = 'client') => ({
  scope,
  period: `2026-0${(index % 9) + 1}`,
  clientId: scope === 'client' ? 'client-clover' : 'client-other',
  invoiceId: `inv-${index}`,
  at: '2026-08-01T00:00:00.000Z',
  removed: [`Software reimbursement ($40)`],
  added: [],
  changed: [`Billable hours — Lisa: $950 → $900`],
})

const storeAnswer = (index, scope = 'client') => ({
  scope,
  period: '2026-07',
  clientId: scope === 'client' ? 'client-clover' : 'client-other',
  question: `Q${index}?`,
  answer: `A${index}`,
  answeredAt: '2026-07-15T00:00:00.000Z',
})

/** The learning block is the last JSON object in the built message. */
const learningBlock = (message) => JSON.parse(message.slice(message.lastIndexOf('\n{')))

describe('buildRatingMessage', () => {
  it("carries the store's correction diffs into the prompt", () => {
    const message = buildRatingMessage({
      invoice,
      client,
      learningContext: { answeredQuestions: [], corrections: [storeCorrection(1)] },
    })

    expect(message).toMatch(/Billable hours — Lisa: \$950 → \$900/)
    expect(message).toMatch(/Software reimbursement \(\$40\)/)

    const [correction] = learningBlock(message).corrections
    expect(correction).toEqual({
      scope: 'client',
      period: '2026-02',
      invoiceId: 'inv-1',
      removed: ['Software reimbursement ($40)'],
      changed: ['Billable hours — Lisa: $950 → $900'],
    })
    // An empty list is omitted rather than shipped as `"added": []`.
    expect(correction).not.toHaveProperty('added')
  })

  it('drops an edit that moved nothing on the lines', () => {
    const message = buildRatingMessage({
      invoice,
      client,
      learningContext: {
        corrections: [{ ...storeCorrection(1), removed: [], added: [], changed: [] }],
      },
    })
    expect(learningBlock(message).corrections).toEqual([])
  })

  it('keeps room for the firm-wide tail the store appends after the client slice', () => {
    // The store hands back up to 8 client entries THEN up to 4 firm-wide ones.
    const message = buildRatingMessage({
      invoice,
      client,
      learningContext: {
        answeredQuestions: [
          ...Array.from({ length: 8 }, (_, index) => storeAnswer(index, 'client')),
          ...Array.from({ length: 4 }, (_, index) => storeAnswer(100 + index, 'firm')),
        ],
        corrections: [
          ...Array.from({ length: 8 }, (_, index) => storeCorrection(index, 'client')),
          ...Array.from({ length: 4 }, (_, index) => storeCorrection(100 + index, 'firm')),
        ],
      },
    })

    const learning = learningBlock(message)
    expect(learning.answeredQuestions).toHaveLength(12)
    expect(learning.corrections).toHaveLength(12)
    expect(learning.answeredQuestions.filter((entry) => entry.scope === 'firm')).toHaveLength(4)
    expect(learning.corrections.filter((entry) => entry.scope === 'firm')).toHaveLength(4)
  })

  it('caps the learning context even when the caller did not', () => {
    const message = buildRatingMessage({
      invoice,
      client,
      hoursSummary: [],
      priorInvoice: null,
      learningContext: {
        answeredQuestions: Array.from({ length: 40 }, (_, index) => storeAnswer(index)),
        corrections: Array.from({ length: 40 }, (_, index) => storeCorrection(index)),
      },
    })
    const learning = learningBlock(message)
    expect(learning.answeredQuestions).toHaveLength(12)
    expect(learning.corrections).toHaveLength(12)
  })

  it('says plainly when there is no prior invoice', () => {
    const message = buildRatingMessage({ invoice, client, priorInvoice: null })
    expect(message).toMatch(/PRIOR MONTH'S INVOICE[^\n]*\nnull/)
  })
})
