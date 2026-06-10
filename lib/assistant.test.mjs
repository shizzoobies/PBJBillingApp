import { describe, expect, it, vi } from 'vitest'
import { executeAssistantAction, runAssistantChat } from './assistant.js'

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
