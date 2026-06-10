import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AssistantPanel } from '../components/AssistantPanel'

vi.mock('../lib/api', () => ({
  assistantChatRequest: vi.fn(),
  assistantFeatureRequestSend: vi.fn(),
  assistantInsightsRequest: vi.fn(),
  assistantDismissSuggestion: vi.fn(),
  assistantHistoryRequest: vi.fn(),
  assistantClearHistory: vi.fn(),
  assistantRunAction: vi.fn(),
}))

import {
  assistantChatRequest,
  assistantClearHistory,
  assistantDismissSuggestion,
  assistantFeatureRequestSend,
  assistantHistoryRequest,
  assistantInsightsRequest,
  assistantRunAction,
} from '../lib/api'

const mockedChat = vi.mocked(assistantChatRequest)
const mockedSend = vi.mocked(assistantFeatureRequestSend)
const mockedInsights = vi.mocked(assistantInsightsRequest)
const mockedDismiss = vi.mocked(assistantDismissSuggestion)
const mockedHistory = vi.mocked(assistantHistoryRequest)
const mockedClear = vi.mocked(assistantClearHistory)
const mockedRunAction = vi.mocked(assistantRunAction)

describe('capability manifest', () => {
  const manifest = readFileSync(
    path.join(process.cwd(), 'docs', 'capability-manifest.md'),
    'utf8',
  )

  it('covers every sidebar page', () => {
    for (const section of [
      '## Dashboard',
      '## Time tracking',
      '## Timesheet',
      '## Time Approvals',
      '## Checklists',
      '## Delayed',
      '## Clients',
      '## Contacts',
      '## Reports',
      '## Productivity',
      '## Gantt',
      '## Invoices',
      '## Plans',
      '## Team',
      '## Settings',
    ]) {
      expect(manifest).toContain(section)
    }
  })

  it('has the not-supported list the assistant relies on', () => {
    expect(manifest).toContain('## NOT supported (yet)')
    expect(manifest).toContain('feature request')
  })
})

describe('AssistantPanel', () => {
  beforeEach(() => {
    mockedChat.mockReset()
    mockedSend.mockReset()
    mockedInsights.mockReset()
    mockedDismiss.mockReset()
    mockedHistory.mockReset()
    mockedClear.mockReset()
    mockedRunAction.mockReset()
    mockedInsights.mockResolvedValue({ suggestions: [] })
    mockedDismiss.mockResolvedValue({ ok: true })
    mockedHistory.mockResolvedValue({ messages: [] })
    mockedClear.mockResolvedValue({ ok: true })
  })

  const openPanel = () => {
    render(
      <MemoryRouter>
        <AssistantPanel />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open assistant' }))
  }

  it('shows watch-and-learn insight cards and dismisses permanently', async () => {
    mockedInsights.mockResolvedValue({
      suggestions: [
        {
          key: 'recurring_template:client-a:payroll',
          kind: 'recurring_template',
          title: 'Make “Payroll June” a recurring template?',
          body: "You've created this task by hand in 2 different months.",
          link: '/checklists',
        },
      ],
    })
    openPanel()

    await waitFor(() =>
      expect(screen.getByText('Make “Payroll June” a recurring template?')).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Don’t show again' }))

    await waitFor(() =>
      expect(mockedDismiss).toHaveBeenCalledWith('recurring_template:client-a:payroll'),
    )
    expect(screen.queryByText('Make “Payroll June” a recurring template?')).toBeNull()
  })

  it('sends a question and renders the reply', async () => {
    mockedChat.mockResolvedValue({
      reply: 'Yes — use the timer on the Time page.',
      featureRequestDraft: null,
      actionProposals: [],
    })
    openPanel()

    fireEvent.change(screen.getByPlaceholderText('Ask about the app…'), {
      target: { value: 'Can I track time?' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() =>
      expect(screen.getByText('Yes — use the timer on the Time page.')).toBeInTheDocument(),
    )
    expect(mockedChat).toHaveBeenCalledWith(
      [{ role: 'user', text: 'Can I track time?' }],
      expect.any(Function),
    )
  })

  it('proposes an action and only runs it on confirm', async () => {
    mockedChat.mockResolvedValue({
      reply: "Sure — I've set up a card to make that recurring.",
      featureRequestDraft: null,
      actionProposals: [
        {
          id: 'make_template_recurring:0',
          tool: 'make_template_recurring',
          label: 'Make a recurring template',
          summary: 'Attach “Payroll” to Clover as a monthly recurring template.',
          params: { templateTitle: 'Payroll', clientName: 'Clover', frequency: 'monthly' },
        },
      ],
    })
    mockedRunAction.mockResolvedValue({
      ok: true,
      message: '“Payroll” now recurs monthly for Clover.',
    })
    openPanel()

    fireEvent.change(screen.getByPlaceholderText('Ask about the app…'), {
      target: { value: 'Make payroll recurring for Clover' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() =>
      expect(
        screen.getByText('Attach “Payroll” to Clover as a monthly recurring template.'),
      ).toBeInTheDocument(),
    )
    // Nothing runs until the owner confirms.
    expect(mockedRunAction).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Run it' }))
    await waitFor(() =>
      expect(mockedRunAction).toHaveBeenCalledWith(
        expect.objectContaining({ tool: 'make_template_recurring' }),
      ),
    )
    await waitFor(() =>
      expect(screen.getByText('“Payroll” now recurs monthly for Clover. ✓')).toBeInTheDocument(),
    )
  })

  it('cancels an action without running it', async () => {
    mockedChat.mockResolvedValue({
      reply: 'Want me to assign that client?',
      featureRequestDraft: null,
      actionProposals: [
        {
          id: 'assign_client:0',
          tool: 'assign_client',
          label: 'Assign a client',
          summary: 'Give Avery access to Clover.',
          params: { clientName: 'Clover', bookkeeperName: 'Avery' },
        },
      ],
    })
    openPanel()

    fireEvent.change(screen.getByPlaceholderText('Ask about the app…'), {
      target: { value: 'Assign Clover to Avery' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(screen.getByText('Give Avery access to Clover.')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.getByText('Cancelled')).toBeInTheDocument())
    expect(mockedRunAction).not.toHaveBeenCalled()
  })

  it('shows a confirmation card for a feature-request draft and only sends on confirm', async () => {
    mockedChat.mockResolvedValue({
      reply: "We can't do that yet — here's a draft for Alex.",
      featureRequestDraft: {
        title: 'Client portal',
        description: 'Owner wants clients to view their invoices online.',
      },
      actionProposals: [],
    })
    mockedSend.mockResolvedValue({ ok: true, id: 'featreq-1', emailSent: true })
    openPanel()

    fireEvent.change(screen.getByPlaceholderText('Ask about the app…'), {
      target: { value: 'Can clients log in?' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(screen.getByText('Client portal')).toBeInTheDocument())
    // Nothing sent until the owner confirms.
    expect(mockedSend).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Send to Alex' }))
    await waitFor(() =>
      expect(mockedSend).toHaveBeenCalledWith({
        title: 'Client portal',
        description: 'Owner wants clients to view their invoices online.',
      }),
    )
    await waitFor(() => expect(screen.getByText('Sent to Alex ✓')).toBeInTheDocument())
  })

  it('keeps the draft unsent when dismissed', async () => {
    mockedChat.mockResolvedValue({
      reply: 'Want me to ask Alex?',
      featureRequestDraft: { title: 'Payroll', description: 'Run payroll in-app.' },
      actionProposals: [],
    })
    openPanel()

    fireEvent.change(screen.getByPlaceholderText('Ask about the app…'), {
      target: { value: 'Can I run payroll?' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(screen.getByText('Payroll')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Don’t send' }))

    await waitFor(() => expect(screen.getByText('Not sent')).toBeInTheDocument())
    expect(mockedSend).not.toHaveBeenCalled()
  })
})
