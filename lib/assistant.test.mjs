import { describe, expect, it, vi } from 'vitest'
import {
  buildActionProposal,
  buildSpitballContext,
  confirmOwnerFeedback,
  fallbackSpitballSummary,
  planSpitballCompaction,
  spitballChat,
  summarizeSpitballSession,
  executeAssistantAction,
  refineFeatureRequest,
  runAssistantChat,
  sanitizeReport,
  validateAssistantAction,
  SPITBALL_CAPACITY_MESSAGE,
  SPITBALL_COMPACT_THRESHOLD,
  SPITBALL_CONTEXT_CAPS,
  SPITBALL_KEEP_RECENT,
} from './assistant.js'

// A fake Anthropic client. `messages.create` shifts scripted responses off a
// queue; `messages.stream` does the same but emits text deltas to the
// registered handler before resolving finalMessage().
function fakeClient(responses) {
  const queue = [...responses]
  return {
    messages: {
      create: vi.fn(async () => {
        if (queue.length === 0) throw new Error('no scripted response left')
        return queue.shift()
      }),
      stream: vi.fn((/* params */) => {
        const response = queue.shift()
        let textHandler = null
        return {
          on(event, handler) {
            if (event === 'text') textHandler = handler
            return this
          },
          async finalMessage() {
            const deltas = response.__deltas ?? []
            for (const delta of deltas) textHandler?.(delta)
            return response
          },
        }
      }),
    },
  }
}

const callbacks = (client) => ({
  client,
  getSnapshot: async () => ({ clients: [], recurringTemplates: [] }),
  getUsagePatterns: async () => ([]),
})

const textResponse = (text, deltas) => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text }],
  __deltas: deltas,
})

describe('runAssistantChat', () => {
  it('returns a plain text reply with no drafts or actions', async () => {
    const client = fakeClient([textResponse('Use the timer on the Time page.')])
    const result = await runAssistantChat(
      [{ role: 'user', text: 'How do I track time?' }],
      callbacks(client),
    )
    expect(result.reply).toBe('Use the timer on the Time page.')
    expect(result.featureRequestDraft).toBeNull()
    expect(result.actionProposals).toEqual([])
  })

  it('captures an action proposal but does not execute it', async () => {
    const client = fakeClient([
      {
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'tu_1',
            name: 'make_template_recurring',
            input: { templateTitle: 'Payroll', clientName: 'Clover', frequency: 'monthly' },
          },
        ],
      },
      textResponse('Review the card to make it recurring.'),
    ])
    const result = await runAssistantChat(
      [{ role: 'user', text: 'Make payroll recurring for Clover' }],
      callbacks(client),
    )
    expect(result.actionProposals).toHaveLength(1)
    const [proposal] = result.actionProposals
    expect(proposal.tool).toBe('make_template_recurring')
    expect(proposal.params).toEqual({
      templateTitle: 'Payroll',
      clientName: 'Clover',
      frequency: 'monthly',
    })
    expect(proposal.summary).toContain('monthly')
    expect(result.reply).toContain('Review the card')
  })

  it('captures an email_report draft without sending', async () => {
    const client = fakeClient([
      {
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'tu_2',
            name: 'email_report',
            input: { subject: 'June profitability', body: 'Clover: $145/h…' },
          },
        ],
      },
      textResponse('Review the card to email it to yourself.'),
    ])
    const result = await runAssistantChat(
      [{ role: 'user', text: 'email me the profitability report' }],
      callbacks(client),
    )
    expect(result.emailReportDraft).toEqual({
      subject: 'June profitability',
      body: 'Clover: $145/h…',
    })
    expect(result.reply).toContain('Review the card')
  })

  it('streams text deltas to onDelta and still returns the full reply', async () => {
    const client = fakeClient([textResponse('Hello there', ['Hello', ' there'])])
    const deltas = []
    const result = await runAssistantChat(
      [{ role: 'user', text: 'hi' }],
      callbacks(client),
      (delta) => deltas.push(delta),
    )
    expect(deltas).toEqual(['Hello', ' there'])
    expect(result.reply).toBe('Hello there')
    expect(client.messages.stream).toHaveBeenCalled()
    expect(client.messages.create).not.toHaveBeenCalled()
  })
})

describe('runAssistantChat — build_report', () => {
  it('captures a sanitized report from the build_report tool', async () => {
    const client = fakeClient([
      {
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'tu_r',
            name: 'build_report',
            input: {
              title: 'Q2 Profitability',
              subtitle: 'Apr–Jun 2026',
              sections: [
                {
                  heading: 'Summary',
                  paragraphs: ['Clover is the strongest client.'],
                  stats: [{ label: 'Revenue', value: '$1,500' }],
                  table: { columns: ['Client', 'Margin'], rows: [['Clover', '$920']] },
                },
              ],
            },
          },
        ],
      },
      textResponse('Your report is ready — open it to read or save a PDF.'),
    ])
    const result = await runAssistantChat([{ role: 'user', text: 'Q2 profitability report' }], callbacks(client))
    expect(result.report.title).toBe('Q2 Profitability')
    expect(result.report.subtitle).toBe('Apr–Jun 2026')
    expect(result.report.sections).toHaveLength(1)
    expect(result.report.sections[0].stats[0]).toEqual({ label: 'Revenue', value: '$1,500' })
    expect(result.report.sections[0].table.rows[0]).toEqual(['Clover', '$920'])
  })
})

describe('sanitizeReport', () => {
  it('keeps a well-formed report and drops empty sections', () => {
    const report = sanitizeReport({
      title: 'Report',
      sections: [
        { heading: 'A', paragraphs: ['hello', '  '] },
        { heading: '', paragraphs: [], stats: [], table: null }, // empty -> dropped
      ],
    })
    expect(report.title).toBe('Report')
    expect(report.sections).toHaveLength(1)
    expect(report.sections[0].paragraphs).toEqual(['hello'])
  })

  it('returns null without a title or any usable section', () => {
    expect(sanitizeReport({ sections: [{ heading: 'A' }] })).toBeNull()
    expect(sanitizeReport({ title: 'X', sections: [] })).toBeNull()
    expect(sanitizeReport({ title: 'X', sections: [{ heading: '', paragraphs: [''] }] })).toBeNull()
  })
})

describe('executeAssistantAction', () => {
  const data = {
    clients: [{ id: 'client-clover', name: 'Clover' }],
    checklistTemplates: [{ id: 'tmpl-payroll', title: 'Payroll', clientId: 'client-std' }],
    employees: [
      { id: 'emp-avery', name: 'Avery', role: 'Bookkeeper' },
      { id: 'owner-1', name: 'Brittany', role: 'Owner' },
    ],
  }

  it('assigns a client by resolving names to ids', async () => {
    const store = { grantClientVisibility: vi.fn(async () => null) }
    const result = await executeAssistantAction(
      'assign_client',
      { clientName: 'clover', bookkeeperName: 'avery' },
      store,
      data,
    )
    expect(store.grantClientVisibility).toHaveBeenCalledWith('client-clover', 'emp-avery')
    expect(result.ok).toBe(true)
  })

  it('refuses to assign to the owner', async () => {
    const store = { grantClientVisibility: vi.fn() }
    const result = await executeAssistantAction(
      'assign_client',
      { clientName: 'Clover', bookkeeperName: 'Brittany' },
      store,
      data,
    )
    expect(result.ok).toBe(false)
    expect(store.grantClientVisibility).not.toHaveBeenCalled()
  })

  it('returns a friendly miss for an unknown client', async () => {
    const store = { grantClientVisibility: vi.fn() }
    const result = await executeAssistantAction(
      'assign_client',
      { clientName: 'Nope', bookkeeperName: 'Avery' },
      store,
      data,
    )
    expect(result.ok).toBe(false)
    expect(result.message).toContain('Nope')
    expect(store.grantClientVisibility).not.toHaveBeenCalled()
  })

  it('validateAssistantAction resolves names without mutating anything', () => {
    expect(
      validateAssistantAction(
        'assign_client',
        { clientName: 'Clover', bookkeeperName: 'Avery' },
        data,
      ).ok,
    ).toBe(true)
    expect(
      validateAssistantAction(
        'assign_client',
        { clientName: 'Nope Inc', bookkeeperName: 'Avery' },
        data,
      ),
    ).toMatchObject({ ok: false, message: expect.stringContaining('Nope Inc') })
    expect(
      validateAssistantAction(
        'assign_client',
        { clientName: 'Clover', bookkeeperName: 'Brittany' },
        data,
      ).ok,
    ).toBe(false)
    expect(
      validateAssistantAction(
        'make_template_recurring',
        { templateTitle: 'Payroll', clientName: 'Clover', frequency: 'monthly' },
        data,
      ).ok,
    ).toBe(true)
    expect(validateAssistantAction('drop_tables', {}, data).ok).toBe(false)
  })

  it('buildActionProposal is exported and rejects incomplete input', () => {
    expect(
      buildActionProposal('assign_client', { clientName: 'Clover', bookkeeperName: 'Avery' }),
    ).toMatchObject({ tool: 'assign_client', summary: expect.stringContaining('Clover') })
    expect(buildActionProposal('assign_client', { clientName: 'Clover' })).toBeNull()
    expect(buildActionProposal('unknown_tool', {})).toBeNull()
  })

  it('makes a template recurring via copyTemplateToClient', async () => {
    const store = {
      copyTemplateToClient: vi.fn(async () => ({ title: 'Payroll', frequency: 'monthly' })),
    }
    const result = await executeAssistantAction(
      'make_template_recurring',
      { templateTitle: 'Payroll', clientName: 'Clover', frequency: 'monthly' },
      store,
      data,
    )
    expect(store.copyTemplateToClient).toHaveBeenCalledWith('tmpl-payroll', {
      clientId: 'client-clover',
      frequency: 'monthly',
      firstDueDate: undefined,
    })
    expect(result.ok).toBe(true)
  })
})

describe('reenable_recurring_template — the one Tier 0 config action', () => {
  const data = {
    clients: [
      { id: 'client-clover', name: 'Clover' },
      { id: 'client-acme', name: 'Acme' },
    ],
    checklistTemplates: [
      { id: 'tmpl-off', title: 'Annual Reports', clientId: 'client-clover', active: false },
      { id: 'tmpl-on', title: 'Monthly Bookkeeping', clientId: 'client-clover', active: true },
      { id: 'tmpl-dupe', title: 'Annual Reports', clientId: 'client-acme', active: false },
    ],
    employees: [],
  }
  // Only the switched-off Clover template; the duplicate title needs a client.
  const oneOff = { ...data, checklistTemplates: data.checklistTemplates.slice(0, 2) }

  it('proposes rather than acts, and says the change is reversible', () => {
    const proposal = buildActionProposal('reenable_recurring_template', {
      templateTitle: 'Annual Reports',
      clientName: 'Clover',
    })
    expect(proposal).toMatchObject({
      tool: 'reenable_recurring_template',
      params: { templateTitle: 'Annual Reports', clientName: 'Clover' },
    })
    expect(proposal.summary).toContain('back ON')
    expect(proposal.summary).toContain('undoes this')
    expect(buildActionProposal('reenable_recurring_template', {})).toBeNull()
  })

  it('turns a switched-off template back on', async () => {
    const store = {
      setChecklistTemplateActive: vi.fn(async () => ({ id: 'tmpl-off', active: true })),
    }
    const result = await executeAssistantAction(
      'reenable_recurring_template',
      { templateTitle: 'annual reports' },
      store,
      oneOff,
    )
    expect(store.setChecklistTemplateActive).toHaveBeenCalledWith('tmpl-off', true)
    expect(result).toMatchObject({ ok: true, message: expect.stringContaining('switched back on') })
  })

  it('refuses a template that is already on, without touching the store', async () => {
    const store = { setChecklistTemplateActive: vi.fn() }
    const result = await executeAssistantAction(
      'reenable_recurring_template',
      { templateTitle: 'Monthly Bookkeeping' },
      store,
      oneOff,
    )
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('already switched on') })
    expect(store.setChecklistTemplateActive).not.toHaveBeenCalled()
  })

  it('asks which client when a title is ambiguous, and resolves once told', async () => {
    const store = { setChecklistTemplateActive: vi.fn(async () => ({ id: 'tmpl-dupe' })) }
    const ambiguous = await executeAssistantAction(
      'reenable_recurring_template',
      { templateTitle: 'Annual Reports' },
      store,
      data,
    )
    expect(ambiguous.ok).toBe(false)
    expect(ambiguous.message).toContain('which client')
    expect(store.setChecklistTemplateActive).not.toHaveBeenCalled()

    await executeAssistantAction(
      'reenable_recurring_template',
      { templateTitle: 'Annual Reports', clientName: 'Acme' },
      store,
      data,
    )
    expect(store.setChecklistTemplateActive).toHaveBeenCalledWith('tmpl-dupe', true)
  })

  it('validates at propose time with the same rules as execution', () => {
    expect(
      validateAssistantAction('reenable_recurring_template', { templateTitle: 'Annual Reports' }, oneOff).ok,
    ).toBe(true)
    expect(
      validateAssistantAction('reenable_recurring_template', { templateTitle: 'Nope' }, oneOff),
    ).toMatchObject({ ok: false, message: expect.stringContaining('Nope') })
    expect(
      validateAssistantAction(
        'reenable_recurring_template',
        { templateTitle: 'Monthly Bookkeeping' },
        oneOff,
      ).ok,
    ).toBe(false)
    expect(
      validateAssistantAction('reenable_recurring_template', { templateTitle: 'Annual Reports' }, data).ok,
    ).toBe(false)
  })

  it('files a confirm card from the chat loop instead of running anything', async () => {
    const client = fakeClient([
      {
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'tu_1',
            name: 'reenable_recurring_template',
            input: { templateTitle: 'Annual Reports', clientName: 'Clover' },
          },
        ],
      },
      textResponse('Review the card to switch it back on.'),
    ])
    const result = await runAssistantChat(
      [{ role: 'user', text: 'Turn Annual Reports back on for Clover' }],
      callbacks(client),
    )
    expect(result.actionProposals).toHaveLength(1)
    expect(result.actionProposals[0].tool).toBe('reenable_recurring_template')
  })
})

describe('runAssistantChat — diagnostic read tools', () => {
  it('passes a diagnostic tool result back to the model as JSON', async () => {
    const diagnose = vi.fn(async () => ({
      canLogTime: false,
      summary: "Lisa's timesheet is LOCKED for July 2026.",
    }))
    const client = fakeClient([
      {
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'tu_1',
            name: 'diagnose_time_logging',
            input: { person: 'Lisa' },
          },
        ],
      },
      textResponse('July is locked on her timesheet — unlock it and she can log time.'),
    ])
    const result = await runAssistantChat([{ role: 'user', text: "Why can't Lisa log time?" }], {
      ...callbacks(client),
      readTools: { diagnose_time_logging: diagnose },
    })
    expect(diagnose).toHaveBeenCalledWith({ person: 'Lisa' })
    expect(result.reply).toContain('July is locked')
    expect(result.actionProposals).toEqual([])
  })
})

describe('runAssistantChat — model fallback on overload', () => {
  it('falls back to the secondary model when the primary returns 529', async () => {
    let calls = 0
    const client = {
      messages: {
        create: vi.fn(async (params) => {
          calls += 1
          if (calls === 1) {
            throw Object.assign(new Error('Overloaded'), { status: 529 })
          }
          return { stop_reason: 'end_turn', content: [{ type: 'text', text: `ok from ${params.model}` }] }
        }),
      },
    }
    const result = await runAssistantChat([{ role: 'user', text: 'hi' }], callbacks(client))
    // Default fallback model is Haiku (less loaded per Anthropic guidance).
    expect(result.reply).toBe('ok from claude-haiku-4-5')
    expect(client.messages.create).toHaveBeenCalledTimes(2)
  })

  it('does NOT fall back on a non-retryable error (e.g. 400)', async () => {
    const client = {
      messages: {
        create: vi.fn(async () => {
          throw Object.assign(new Error('bad request'), { status: 400 })
        }),
      },
    }
    await expect(
      runAssistantChat([{ role: 'user', text: 'hi' }], callbacks(client)),
    ).rejects.toThrow()
    expect(client.messages.create).toHaveBeenCalledTimes(1)
  })
})

describe('confirmOwnerFeedback', () => {
  const item = { title: 'Board chips', description: 'Chips on the board', devNotes: 'Shipped in abc123' }

  it('returns the confirmation and dev-ready note from valid JSON', async () => {
    const client = fakeClient([
      textResponse(
        '{"confirmation": "So the chips should show on collapsed rows too?", "forDeveloper": "Show status chips on collapsed client rows on the Board."}',
      ),
    ])
    const result = await confirmOwnerFeedback(item, 'chips missing when rows are closed', { client })
    expect(result.confirmation).toMatch(/collapsed rows/)
    expect(result.forDeveloper).toMatch(/Board/)
  })

  it('throws the 502 error contract on an unparseable reply', async () => {
    const client = fakeClient([textResponse('sorry, no JSON here')])
    await expect(
      confirmOwnerFeedback(item, 'still broken', { client }),
    ).rejects.toMatchObject({ statusCode: 502 })
  })

  it('throws the 502 error contract when a field is missing', async () => {
    const client = fakeClient([textResponse('{"confirmation": "only half"}')])
    await expect(
      confirmOwnerFeedback(item, 'still broken', { client }),
    ).rejects.toMatchObject({ statusCode: 502 })
  })
})

describe('spitballChat', () => {
  const chat = (text) => [{ role: 'user', text }]

  it('returns a reply with no draft while the idea is still forming', async () => {
    const client = fakeClient([
      textResponse('{"reply": "Ooh — tell me more. Who would use this?", "draft": null}'),
    ])
    const result = await spitballChat(chat('what if clients could see their own checklist'), { client })
    expect(result.reply).toMatch(/tell me more/i)
    expect(result.draft).toBeNull()
  })

  it('returns an organized draft when the model offers one', async () => {
    const client = fakeClient([
      textResponse(
        '{"reply": "I think we have it — here is the shape of it.", "draft": {"title": "Client-visible checklists", "description": "The idea: let clients see progress.\nOpen questions: which clients?"}}',
      ),
    ])
    const result = await spitballChat(chat('wrap it up'), { client })
    expect(result.draft?.title).toBe('Client-visible checklists')
    expect(result.draft?.description).toContain('Open questions:')
  })

  it('400s when there is no user message to respond to', async () => {
    const client = fakeClient([])
    await expect(spitballChat([], { client })).rejects.toMatchObject({ statusCode: 400 })
    await expect(
      spitballChat([{ role: 'assistant', text: 'hi' }], { client }),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('502s with the save-as-is hint on an unparseable reply', async () => {
    const client = fakeClient([textResponse('not json at all')])
    await expect(spitballChat(chat('hello'), { client })).rejects.toMatchObject({
      statusCode: 502,
    })
  })
})

/**
 * Brainstorm memory. The client reported that the assistant "stops partway
 * through a brainstorming session, and its memory does not persist across
 * separate conversations". Two defects, both here: a hard `.slice(-30)` that
 * silently dropped the START of a long session, and a stateless endpoint with
 * nothing to recall from earlier sessions.
 */
describe('spitballChat — session memory in the system prompt', () => {
  const chat = (text) => [{ role: 'user', text }]
  const systemOf = (client) => client.messages.create.mock.calls[0][0].system

  it('sends every stored turn — no silent window that forgets the start', async () => {
    const client = fakeClient([textResponse('{"reply": "Go on — what happens after they see it?", "draft": null}')])
    const long = Array.from({ length: 40 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      text: `turn ${index}`,
    }))
    long.push({ role: 'user', text: 'turn 40' })

    await spitballChat(long, { client })

    const [params] = client.messages.create.mock.calls[0]
    expect(params.messages).toHaveLength(41)
    expect(params.messages[0].content).toBe('turn 0')
  })

  it('carries the running summary, past sessions and Britt’s Brain titles', async () => {
    const client = fakeClient([textResponse('{"reply": "Yes — that one, the checklist idea from before.", "draft": null}')])

    await spitballChat(chat('like we talked about last time'), {
      client,
      summary: 'She was circling client-visible checklists.',
      pastSummaries: [{ summary: 'Reminder emails for late clients.' }],
      brainstormTitles: ['Client-visible checklists'],
    })

    const system = systemOf(client)
    expect(system).toContain('She was circling client-visible checklists.')
    expect(system).toContain('Reminder emails for late clients.')
    expect(system).toContain('Client-visible checklists')
    // The persona is unchanged — the draft still has to stay in HER words.
    expect(system).toContain('Keep the draft faithful to what SHE said')
  })

  it('adds nothing at all to a first-ever brainstorm', async () => {
    const client = fakeClient([textResponse('{"reply": "Tell me more about who would actually use it.", "draft": null}')])
    await spitballChat(chat('a brand new idea'), { client })
    expect(systemOf(client)).not.toContain('CONTEXT YOU CAN DRAW ON')
  })
})

describe('buildSpitballContext — caps', () => {
  it('returns nothing when there is nothing to remember', () => {
    expect(buildSpitballContext()).toBe('')
    expect(buildSpitballContext({ summary: '  ', pastSummaries: [], brainstormTitles: [] })).toBe('')
  })

  it('keeps at most 5 past summaries and 8 draft titles', () => {
    const block = buildSpitballContext({
      pastSummaries: Array.from({ length: 12 }, (_, index) => ({ summary: `past-${index}` })),
      brainstormTitles: Array.from({ length: 20 }, (_, index) => `title-${index}`),
    })
    expect(block).toContain('past-4')
    expect(block).not.toContain('past-5')
    expect(block).toContain('title-7')
    expect(block).not.toContain('title-8')
  })

  it('truncates each piece rather than letting one long note crowd out the rest', () => {
    const block = buildSpitballContext({
      summary: 'r'.repeat(5000),
      pastSummaries: ['p'.repeat(5000)],
      brainstormTitles: ['t'.repeat(5000)],
    })
    expect(block).not.toMatch(new RegExp(`r{${SPITBALL_CONTEXT_CAPS.runningSummary + 1}}`))
    expect(block).not.toMatch(new RegExp(`p{${SPITBALL_CONTEXT_CAPS.pastSummaryChars + 1}}`))
    expect(block).not.toMatch(new RegExp(`t{${SPITBALL_CONTEXT_CAPS.draftTitleChars + 1}}`))
  })

  it('labels the block as background, not as something she just said', () => {
    const block = buildSpitballContext({ summary: 'the gist' })
    expect(block).toMatch(/never recite it back at her/i)
  })
})

describe('planSpitballCompaction — the trigger', () => {
  const session = (count) =>
    Array.from({ length: count }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      text: `turn ${index}`,
    }))

  it('does nothing at or below the threshold', () => {
    expect(planSpitballCompaction(session(SPITBALL_COMPACT_THRESHOLD)).needed).toBe(false)
    expect(planSpitballCompaction([]).needed).toBe(false)
    expect(planSpitballCompaction(undefined).needed).toBe(false)
  })

  it('folds only the oldest turns once the session runs past it', () => {
    const messages = session(SPITBALL_COMPACT_THRESHOLD + 2)
    const plan = planSpitballCompaction(messages)

    expect(plan.needed).toBe(true)
    expect(plan.keepRecent).toBe(SPITBALL_KEEP_RECENT)
    expect(plan.older).toHaveLength(messages.length - SPITBALL_KEEP_RECENT)
    // The oldest turn is what gets summarized; the recent tail is untouched.
    expect(plan.older[0].text).toBe('turn 0')
    expect(plan.older.at(-1).text).toBe(`turn ${messages.length - SPITBALL_KEEP_RECENT - 1}`)
  })
})

describe('summarizeSpitballSession — never blocks a brainstorm', () => {
  const conversation = [
    { role: 'user', text: 'what if clients could see their own checklist progress' },
    { role: 'assistant', text: 'Who would look at it?' },
  ]

  it('returns the model summary when the call succeeds', async () => {
    const client = fakeClient([
      textResponse('{"summary": "She wants clients to watch their own checklist."}'),
    ])
    const summary = await summarizeSpitballSession(conversation, { client })
    expect(summary).toBe('She wants clients to watch their own checklist.')
  })

  it('uses the cheap model, not Opus', async () => {
    const client = fakeClient([textResponse('{"summary": "the gist"}')])
    await summarizeSpitballSession(conversation, { client })
    expect(client.messages.create.mock.calls[0][0].model).not.toMatch(/opus/i)
  })

  it('falls back to a truncated first message when the model call fails', async () => {
    // Two scripted failures: runStructuredModel retries once, then throws.
    const client = {
      messages: {
        create: vi.fn(async () => {
          throw Object.assign(new Error('overloaded'), { status: 529 })
        }),
      },
    }
    const summary = await summarizeSpitballSession(conversation, { client })
    expect(summary).toBe(
      'Brainstorm about: what if clients could see their own checklist progress',
    )
  })

  it('falls back to unusable output too, rather than throwing', async () => {
    const client = fakeClient([textResponse('not json'), textResponse('still not json')])
    const summary = await summarizeSpitballSession(conversation, { client })
    expect(summary).toMatch(/^Brainstorm about:/)
  })

  it('keeps an existing running summary when the model is down', async () => {
    const client = fakeClient([textResponse('nope'), textResponse('nope')])
    const summary = await summarizeSpitballSession(conversation, {
      client,
      priorSummary: 'Session so far: client-visible checklists.',
    })
    expect(summary).toBe('Session so far: client-visible checklists.')
  })

  it('has nothing to say about an empty stretch', async () => {
    expect(await summarizeSpitballSession([], {})).toBe('')
  })
})

describe('fallbackSpitballSummary', () => {
  it('prefers the running summary it already has', () => {
    expect(
      fallbackSpitballSummary([{ role: 'user', text: 'an idea' }], 'the gist so far'),
    ).toBe('the gist so far')
  })

  it('truncates her opening message when there is no running summary', () => {
    const summary = fallbackSpitballSummary([{ role: 'user', text: 'x'.repeat(900) }])
    expect(summary.startsWith('Brainstorm about: ')).toBe(true)
    expect(summary.length).toBe('Brainstorm about: '.length + 300)
  })

  it('returns an empty string when she never said anything', () => {
    expect(fallbackSpitballSummary([{ role: 'assistant', text: 'hello' }])).toBe('')
  })
})

// The three JSON endpoints ask the model for a schema-constrained object
// (structured outputs) instead of raw JSON in prose. These cover the request
// shape and every branch of the failure contract.
describe('structured outputs — spitballChat / confirmOwnerFeedback / refineFeatureRequest', () => {
  const chat = (text) => [{ role: 'user', text }]
  const stopResponse = (stopReason) => ({ stop_reason: stopReason, content: [{ type: 'text', text: '' }] })

  it('sends output_config.format json_schema and an uncapped max_tokens', async () => {
    const client = fakeClient([textResponse('{"reply": "Say more — who would use this, and when?", "draft": null}')])
    await spitballChat(chat('an idea'), { client })

    const [params] = client.messages.create.mock.calls[0]
    expect(params.output_config.format.type).toBe('json_schema')
    expect(params.output_config.format.schema).toMatchObject({
      type: 'object',
      required: ['reply', 'draft'],
      additionalProperties: false,
    })
    expect(params.max_tokens).toBe(16000)
  })

  it('sends the per-endpoint schema for the other two endpoints', async () => {
    const feedbackClient = fakeClient([
      textResponse('{"confirmation": "So the chips?", "forDeveloper": "Show chips."}'),
    ])
    await confirmOwnerFeedback({ title: 'T', description: 'D' }, 'note', {
      client: feedbackClient,
    })
    const [feedbackParams] = feedbackClient.messages.create.mock.calls[0]
    expect(feedbackParams.output_config.format.type).toBe('json_schema')
    expect(feedbackParams.output_config.format.schema.required).toEqual([
      'confirmation',
      'forDeveloper',
    ])
    expect(feedbackParams.max_tokens).toBe(16000)

    const refineClient = fakeClient([
      textResponse('{"title": "Add chips", "description": "Problem: ..."}'),
    ])
    await refineFeatureRequest({ title: 'chips', description: 'missing' }, { client: refineClient })
    const [refineParams] = refineClient.messages.create.mock.calls[0]
    expect(refineParams.output_config.format.schema.required).toEqual(['title', 'description'])
    expect(refineParams.max_tokens).toBe(16000)
  })

  it('retries once and succeeds when the first reply is unparseable', async () => {
    const client = fakeClient([
      textResponse('sorry, no JSON here'),
      textResponse('{"reply": "Second time lucky — tell me more about it.", "draft": null}'),
    ])
    const result = await spitballChat(chat('hello'), { client })
    expect(result.reply).toBe('Second time lucky — tell me more about it.')
    expect(client.messages.create).toHaveBeenCalledTimes(2)
  })

  it('throws the friendly 502 only after the retry also fails', async () => {
    const client = fakeClient([textResponse('not json'), textResponse('still not json')])
    await expect(spitballChat(chat('hello'), { client })).rejects.toMatchObject({
      statusCode: 502,
      message: 'The AI returned an unexpected response. Please try again.',
    })
    expect(client.messages.create).toHaveBeenCalledTimes(2)
  })

  it('retries a reply that parses but fails field validation', async () => {
    const client = fakeClient([
      textResponse('{"confirmation": "only half"}'),
      textResponse('{"confirmation": "So the chips?", "forDeveloper": "Show chips on the Board."}'),
    ])
    const result = await confirmOwnerFeedback({ title: 'T', description: 'D' }, 'note', { client })
    expect(result.forDeveloper).toContain('Board')
    expect(client.messages.create).toHaveBeenCalledTimes(2)
  })

  it('retries a refusal once, then surfaces the warm message', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const client = fakeClient([stopResponse('refusal'), stopResponse('refusal')])
      await expect(spitballChat(chat('hello'), { client })).rejects.toMatchObject({
        statusCode: 502,
        message:
          'The AI got tangled on that one — try saying it a different way, or break it into smaller pieces.',
      })
      expect(client.messages.create).toHaveBeenCalledTimes(2)
      // Both exits log, so the next report is diagnosable from the Railway logs.
      expect(errors).toHaveBeenCalledTimes(2)
      expect(errors.mock.calls.every(([line]) => /stop_reason=refusal/.test(line))).toBe(true)
    } finally {
      errors.mockRestore()
    }
  })

  it('surfaces a truncated reply without retrying', async () => {
    const client = fakeClient([stopResponse('max_tokens'), stopResponse('max_tokens')])
    await expect(
      refineFeatureRequest({ title: 'chips', description: 'missing' }, { client }),
    ).rejects.toMatchObject({
      statusCode: 502,
      message: 'The reply was too long to finish — try a shorter turn.',
    })
    expect(client.messages.create).toHaveBeenCalledTimes(1)
  })
})

/**
 * The "it refuses me" report. Two separate defects produced it:
 *   1. `reply` had no length floor, so a balking model under grammar-constrained
 *      decoding emitted the shortest legal string — one comma — which we saved
 *      as a real turn and then fed back to itself.
 *   2. Hard refusals fired on innocuous business turns (a named employee's
 *      missed checklist) and surfaced as a flat "the AI declined that request".
 * Both now retry with a corrective nudge before anything reaches her.
 */
describe('spitballChat — empty filler and refusals never reach her', () => {
  const chat = (text) => [{ role: 'user', text }]
  const stopResponse = (stopReason, text = '') => ({
    stop_reason: stopReason,
    content: [{ type: 'text', text }],
  })
  const good = '{"reply": "Say more about who would actually open that screen?", "draft": null}'

  // 19 letters — one short of the floor, and no punctuation to hide behind.
  const nineteenAlnum = 'abcdefghijklmnopqrs'

  it.each([
    ['a bare comma', '{"reply": ",", "draft": null}'],
    ['an ellipsis', '{"reply": "...", "draft": null}'],
    ['punctuation only', '{"reply": " — . , ! ", "draft": null}'],
    ['19 letters of content', `{"reply": "${nineteenAlnum}", "draft": null}`],
    ['a raw comma, not even JSON', ','],
  ])('retries %s and returns the good second reply', async (_label, degenerate) => {
    const client = fakeClient([textResponse(degenerate), textResponse(good)])
    const result = await spitballChat(chat('Lisa missed her checklist again'), { client })

    expect(result.reply).toMatch(/who would actually open/i)
    expect(client.messages.create).toHaveBeenCalledTimes(2)
  })

  it('appends the repair nudge to the system prompt on attempt 2 only', async () => {
    const client = fakeClient([textResponse('{"reply": ",", "draft": null}'), textResponse(good)])
    await spitballChat(chat('an idea'), { client })

    const [first] = client.messages.create.mock.calls[0]
    const [second] = client.messages.create.mock.calls[1]

    // Attempt 1 is byte-identical to what we send today.
    expect(first.system).not.toContain('empty filler')
    expect(second.system).toBe(
      `${first.system}\n\nYour previous reply was empty filler. Respond conversationally, in full sentences.`,
    )
    // Nothing else about the call changes.
    expect(second.model).toBe(first.model)
    expect(second.max_tokens).toBe(first.max_tokens)
    expect(second.messages).toEqual(first.messages)
  })

  it('502s with the friendly message when both attempts are filler', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const client = fakeClient([
        textResponse('{"reply": ",", "draft": null}'),
        textResponse('{"reply": "...", "draft": null}'),
      ])
      await expect(spitballChat(chat('hello'), { client })).rejects.toMatchObject({
        statusCode: 502,
        message: 'The AI returned an empty reply. Please try again.',
      })
      expect(client.messages.create).toHaveBeenCalledTimes(2)
    } finally {
      errors.mockRestore()
    }
  })

  it('recovers when the first attempt refuses and the second one engages', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const client = fakeClient([stopResponse('refusal'), textResponse(good)])
      const result = await spitballChat(chat('Lisa skipped her checklist on Tuesday'), { client })

      expect(result.reply).toMatch(/who would actually open/i)
      expect(client.messages.create).toHaveBeenCalledTimes(2)

      const [second] = client.messages.create.mock.calls[1]
      expect(second.system).toContain(
        'If you cannot engage with part of that, say so conversationally and continue with the rest.',
      )
      expect(errors).toHaveBeenCalledTimes(1)
    } finally {
      errors.mockRestore()
    }
  })

  it('tells her that her team’s day-to-day is fair game to talk about', async () => {
    const client = fakeClient([textResponse(good)])
    await spitballChat(chat('an idea'), { client })

    const { system } = client.messages.create.mock.calls[0][0]
    expect(system).toContain("Talking through her team's day-to-day")
    expect(system).toContain('never reply with empty or filler text')
    // The original persona is intact.
    expect(system).toContain('Keep the draft faithful to what SHE said')
  })
})

describe('structured-output schemas — length floors', () => {
  const chat = (text) => [{ role: 'user', text }]

  const schemaFrom = (client) => client.messages.create.mock.calls[0][0].output_config.format.schema

  it('floors every user-facing string in the spitball schema', async () => {
    const client = fakeClient([
      textResponse('{"reply": "Tell me who would open that screen, and when?", "draft": null}'),
    ])
    await spitballChat(chat('an idea'), { client })

    const schema = schemaFrom(client)
    expect(schema.properties.reply.minLength).toBe(40)
    const draft = schema.properties.draft.anyOf.find((option) => option.type === 'object')
    expect(draft.properties.title.minLength).toBe(4)
    expect(draft.properties.description.minLength).toBe(60)
  })

  it('floors the owner-feedback and feature-spec schemas', async () => {
    const feedbackClient = fakeClient([
      textResponse('{"confirmation": "So the chips?", "forDeveloper": "Show chips."}'),
    ])
    await confirmOwnerFeedback({ title: 'T', description: 'D' }, 'note', { client: feedbackClient })
    expect(schemaFrom(feedbackClient).properties).toMatchObject({
      confirmation: { minLength: 20 },
      forDeveloper: { minLength: 20 },
    })

    const refineClient = fakeClient([
      textResponse('{"title": "Add chips", "description": "Problem: ..."}'),
    ])
    await refineFeatureRequest({ title: 'chips', description: 'missing' }, { client: refineClient })
    expect(schemaFrom(refineClient).properties).toMatchObject({
      title: { minLength: 4 },
      description: { minLength: 60 },
    })
  })

  it('floors the session summary, so a folded-away brainstorm can’t vanish', async () => {
    const client = fakeClient([textResponse('{"summary": "She wants client-visible checklists."}')])
    await summarizeSpitballSession([{ role: 'user', text: 'checklists for clients' }], { client })
    expect(schemaFrom(client).properties.summary.minLength).toBe(20)
  })
})

/**
 * The brainstorm declines the Haiku fallback on purpose: its replies are
 * PERSISTED into the session, and a degraded model's turn poisons every later
 * one as an in-context example (the 2026-08-18 garbled-turn incident, produced
 * by the fallback during an Anthropic 529 overload). She would rather wait a
 * minute than talk to a worse brain. The other structured endpoints keep the
 * fallback — their outputs are transient suggestions the owner reviews.
 */
describe('spitballChat under model overload', () => {
  it('surfaces the capacity message with a 503 and never tries the fallback model', async () => {
    const client = {
      messages: {
        create: vi.fn(async () => {
          throw Object.assign(new Error('Overloaded'), { status: 529 })
        }),
      },
    }
    const err = await spitballChat([{ role: 'user', text: 'new idea' }], { client }).catch(
      (error) => error,
    )
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe(SPITBALL_CAPACITY_MESSAGE)
    expect(err.statusCode).toBe(503)
    expect(client.messages.create).toHaveBeenCalledTimes(1)
  })

  it('refineFeatureRequest still falls back to Haiku on the same overload', async () => {
    let calls = 0
    const client = {
      messages: {
        create: vi.fn(async (params) => {
          calls += 1
          if (calls === 1) throw Object.assign(new Error('Overloaded'), { status: 529 })
          return {
            stop_reason: 'end_turn',
            content: [
              { type: 'text', text: JSON.stringify({ title: 'Titled', description: 'Described' }) },
            ],
          }
        }),
      },
    }
    const out = await refineFeatureRequest({ title: 'x', description: 'y' }, { client })
    expect(out.title).toBe('Titled')
    expect(client.messages.create).toHaveBeenCalledTimes(2)
    expect(client.messages.create.mock.calls[1][0].model).toBe('claude-haiku-4-5')
  })
})
