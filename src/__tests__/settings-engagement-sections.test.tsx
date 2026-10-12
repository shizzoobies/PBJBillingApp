import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { EngagementSectionsSection } from '../components/EngagementSectionsSection'
import { defaultProposalPricing } from '../../lib/proposal-pricing.js'
import { ApiError, type EngagementSection } from '../lib/types'

/**
 * Settings > Engagement sections (docs/plans/engagements-2026-10.md, stage 2C): the
 * library engagement letters are assembled from. Save all hands the whole list to
 * the server, in the page's order; nothing is deleted, only switched off.
 */

vi.mock('../lib/api', () => ({
  listEngagementSectionsRequest: (...args: unknown[]) => api.listEngagementSectionsRequest(...args),
  saveEngagementSectionsRequest: (...args: unknown[]) => api.saveEngagementSectionsRequest(...args),
}))

const api: Record<string, Mock> = {}

const section = (over: Partial<EngagementSection>): EngagementSection => ({
  id: `esec-${over.key}`,
  key: 'intro',
  title: '',
  body: '',
  trigger: {},
  sortOrder: 0,
  active: true,
  role: 'letter',
  createdAt: null,
  updatedAt: null,
  ...over,
})

const LIBRARY: EngagementSection[] = [
  section({ key: 'email', title: 'Email', body: 'Hi {{contact_first_name}},', trigger: { always: true }, sortOrder: 1, role: 'email' }),
  section({ key: 'intro', title: 'Introduction', body: 'Dear {{contact_name}},', trigger: { always: true }, sortOrder: 2 }),
  section({ key: 'payroll', title: 'Payroll', body: 'We run payroll.', trigger: { groups: ['Payroll'] }, sortOrder: 3 }),
]

/** The list the last Save all sent. */
const lastSaved = () => api.saveEngagementSectionsRequest.mock.calls.at(-1)?.[0] as Array<Record<string, unknown>>

async function renderSection() {
  render(<EngagementSectionsSection pricing={defaultProposalPricing()} />)
  await screen.findByRole('group', { name: 'Section Payroll' })
}

beforeEach(() => {
  window.localStorage.clear()
  api.listEngagementSectionsRequest = vi.fn(async () => LIBRARY)
  api.saveEngagementSectionsRequest = vi.fn(async (sections: EngagementSection[]) =>
    sections.map((entry) => section({ ...entry, id: `esec-${entry.key}` })),
  )
})

afterEach(() => {
  cleanup()
})

describe('Engagement sections in Settings', () => {
  it('lists the library in order; the cover email has no trigger', async () => {
    await renderSection()
    expect(screen.getByText('1. Email')).toBeTruthy()
    expect(screen.getByText('2. Introduction')).toBeTruthy()
    expect(screen.getByText('3. Payroll')).toBeTruthy()
    const email = screen.getByRole('group', { name: 'Section Email' })
    expect(within(email).queryByRole('group', { name: 'When Email goes in' })).toBeNull()
    const payroll = screen.getByRole('group', { name: 'When Payroll goes in' })
    expect(within(payroll).getByRole('checkbox', { name: 'Payroll' })).toBeChecked()
    expect(within(payroll).getByRole('checkbox', { name: 'Always' })).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Save all' })).toBeDisabled()
  })

  it('saves the whole list with the trigger, title and text as edited', async () => {
    await renderSection()
    const payroll = screen.getByRole('group', { name: 'When Payroll goes in' })
    fireEvent.click(within(payroll).getByRole('checkbox', { name: 'Sales tax' }))
    fireEvent.change(within(payroll).getByLabelText('Add a service line to Payroll'), {
      target: { value: defaultProposalPricing().services[0].id },
    })
    fireEvent.change(screen.getByLabelText('Title of Payroll'), { target: { value: 'Payroll and taxes' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save all' }))
    await waitFor(() => expect(api.saveEngagementSectionsRequest).toHaveBeenCalledTimes(1))
    expect(lastSaved()).toEqual([
      { key: 'email', title: 'Email', body: 'Hi {{contact_first_name}},', trigger: { always: true }, sortOrder: 1, active: true },
      { key: 'intro', title: 'Introduction', body: 'Dear {{contact_name}},', trigger: { always: true }, sortOrder: 2, active: true },
      {
        key: 'payroll',
        title: 'Payroll and taxes',
        body: 'We run payroll.',
        trigger: { groups: ['Payroll', 'Sales tax'], serviceIds: [defaultProposalPricing().services[0].id] },
        sortOrder: 3,
        active: true,
      },
    ])
  })

  it('reorders with Up and Down, and the order is the sortOrder saved', async () => {
    await renderSection()
    fireEvent.click(screen.getByRole('button', { name: 'Move Payroll up' }))
    expect(screen.getByText('2. Payroll')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save all' }))
    await waitFor(() => expect(api.saveEngagementSectionsRequest).toHaveBeenCalled())
    expect(lastSaved().map((entry) => [entry.key, entry.sortOrder])).toEqual([
      ['email', 1],
      ['payroll', 2],
      ['intro', 3],
    ])
  })

  it('switches a section off rather than deleting it, and adds a new one', async () => {
    await renderSection()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Use Payroll' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add section' }))
    expect(screen.getByText('Nothing is ticked, so this section never goes into a letter.')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Key of New section'), { target: { value: 'Bad Key' } })
    expect(screen.getByRole('button', { name: 'Save all' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Key of New section'), { target: { value: 'consulting' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save all' }))
    await waitFor(() => expect(api.saveEngagementSectionsRequest).toHaveBeenCalled())
    const saved = lastSaved()
    expect(saved.find((entry) => entry.key === 'payroll')).toMatchObject({ active: false })
    expect(saved.at(-1)).toEqual({ key: 'consulting', title: 'New section', body: '', trigger: {}, sortOrder: 4, active: true })
    // A saved section's key cannot change.
    expect(screen.getByLabelText('Key of Payroll')).toHaveAttribute('readonly')
  })

  it('offers the engagement placeholders and warns on one the app does not fill in', async () => {
    await renderSection()
    fireEvent.click(screen.getByRole('button', { name: /^Placeholders for the text of Payroll \(\d+\)$/ }))
    const chips = screen.getByRole('group', { name: 'Insert a placeholder into the text of Payroll' })
    const keys = within(chips).getAllByRole('button').map((button) => button.textContent)
    expect(keys).toContain('{{client_name}}')
    expect(keys).toContain('{{retainer_sentence}}')
    fireEvent.change(screen.getByLabelText('Section text', { selector: '#engagement-section-body-esec-payroll' }), {
      target: { value: 'We run {{payroll_magic}}.' },
    })
    expect(screen.getByText(/\{\{payroll_magic\}\} is not a placeholder the app fills in/)).toBeTruthy()
  })

  it('shows the server sentence when the save is refused', async () => {
    api.saveEngagementSectionsRequest = vi.fn(async () => {
      throw new ApiError(400, 'A section title is too long.', 'sections_invalid')
    })
    await renderSection()
    fireEvent.change(screen.getByLabelText('Title of Payroll'), { target: { value: 'Payroll!' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save all' }))
    expect(await screen.findByText('A section title is too long.')).toBeTruthy()
  })
})

// QA round, 2026-10-11.
describe('Engagement sections after QA', () => {
  it('the cover email cannot be switched off', async () => {
    await renderSection()
    expect(screen.queryByRole('checkbox', { name: 'Use Email' })).toBeNull()
    expect(screen.getByRole('checkbox', { name: 'Use Payroll' })).toBeTruthy()
  })

  it('Always turns the group and service pickers off', async () => {
    await renderSection()
    const payroll = screen.getByRole('group', { name: 'When Payroll goes in' })
    fireEvent.click(within(payroll).getByRole('checkbox', { name: 'Always' }))
    expect(within(payroll).getByRole('checkbox', { name: 'Payroll' })).toBeDisabled()
    expect(within(payroll).getByLabelText('Add a service line to Payroll')).toBeDisabled()
  })

  it('shows a section keyed on a service line by that line', async () => {
    api.listEngagementSectionsRequest = vi.fn(async () => [
      ...LIBRARY,
      section({ key: 'consulting', title: 'Advisory and consulting', body: 'We meet.', trigger: { serviceIds: ['client-call'] }, sortOrder: 4 }),
    ])
    await renderSection()
    const lines = screen.getByRole('list', { name: 'Service lines Advisory and consulting follows' })
    expect(within(lines).getByText(/Additional reports: Client call/)).toBeTruthy()
    expect(screen.queryByText('Nothing is ticked, so this section never goes into a letter.')).toBeNull()
  })
})
