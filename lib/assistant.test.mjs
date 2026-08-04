import { describe, expect, it, vi } from 'vitest'
import {
  buildActionProposal,
  confirmOwnerFeedback,
  spitballChat,
  executeAssistantAction,
  runAssistantChat,
  sanitizeReport,
  validateAssistantAction,
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
        '{"reply": "I think we have it!", "draft": {"title": "Client-visible checklists", "description": "The idea: let clients see progress.\nOpen questions: which clients?"}}',
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
