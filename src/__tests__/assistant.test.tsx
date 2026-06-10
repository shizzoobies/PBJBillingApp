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
}))

import {
  assistantChatRequest,
  assistantDismissSuggestion,
  assistantFeatureRequestSend,
  assistantInsightsRequest,
} from '../lib/api'

const mockedChat = vi.mocked(assistantChatRequest)
const mockedSend = vi.mocked(assistantFeatureRequestSend)
const mockedInsights = vi.mocked(assistantInsightsRequest)
const mockedDismiss = vi.mocked(assistantDismissSuggestion)

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
    mockedInsights.mockResolvedValue({ suggestions: [] })
    mockedDismiss.mockResolvedValue({ ok: true })
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
    })
    openPanel()

    fireEvent.change(screen.getByPlaceholderText('Ask about the app…'), {
      target: { value: 'Can I track time?' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() =>
      expect(screen.getByText('Yes — use the timer on the Time page.')).toBeInTheDocument(),
    )
    expect(mockedChat).toHaveBeenCalledWith([{ role: 'user', text: 'Can I track time?' }])
  })

  it('shows a confirmation card for a feature-request draft and only sends on confirm', async () => {
    mockedChat.mockResolvedValue({
      reply: "We can't do that yet — here's a draft for Alex.",
      featureRequestDraft: {
        title: 'Client portal',
        description: 'Owner wants clients to view their invoices online.',
      },
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
