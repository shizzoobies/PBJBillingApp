import { describe, expect, it, vi } from 'vitest'
import {
  buildActionProposal,
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
