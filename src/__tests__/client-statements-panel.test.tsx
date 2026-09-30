import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ClientStatementsPanel } from '../components/ClientStatementsPanel'
import type { AppContextValue } from '../AppContext'
import type { AppData, ChecklistTemplate } from '../lib/types'

/**
 * Statement dates box (featreq-11ffb3a6): a reference-only per-client list of
 * accounts and the day of the month each one's statement usually appears.
 * Pins four things: it loads and renders saved rows, the "From the
 * reconciliation checklist" chip adds a prefilled row, a named row with no
 * day is refused rather than silently saved, and a save sends sortOrder as
 * the array index.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))
vi.mock('../lib/api', () => ({
  listClientStatementAccountsRequest: (...args: unknown[]) => listAccounts(...args),
  saveClientStatementAccountsRequest: (...args: unknown[]) => saveAccounts(...args),
}))

let listAccounts = vi.fn()
let saveAccounts = vi.fn()
let contextValue: AppContextValue

function reconciliationTemplate(clientId: string, labels: string[]): ChecklistTemplate {
  return {
    id: 'tmpl-recon',
    title: 'Monthly Reconciliations',
    clientId,
    assigneeId: 'emp-1',
    frequency: 'monthly',
    nextDueDate: '2026-10-01',
    active: true,
    viewerIds: [],
    editorIds: [],
    stages: [
      {
        id: 'stage-1',
        name: 'Reconcile',
        assigneeId: 'emp-1',
        offsetDays: 0,
        viewerIds: [],
        editorIds: [],
        items: labels.map((label, index) => ({ id: `item-${index}`, label })),
      },
    ],
  } as unknown as ChecklistTemplate
}

function renderPanel(clientId = 'c1', templates: ChecklistTemplate[] = []) {
  contextValue = {
    data: { checklistTemplates: templates } as unknown as AppData,
  } as unknown as AppContextValue
  return render(<ClientStatementsPanel clientId={clientId} />)
}

beforeEach(() => {
  listAccounts = vi.fn(async () => [])
  saveAccounts = vi.fn(async (_id: string, accounts: unknown[]) =>
    (accounts as Array<{ name: string; dayOfMonth: number }>).map((row, index) => ({
      id: `stmt-${index}`,
      clientId: 'c1',
      name: row.name,
      dayOfMonth: row.dayOfMonth,
      sortOrder: index,
    })),
  )
})

describe('the statement dates box', () => {
  it('loads and renders the saved rows', async () => {
    listAccounts = vi.fn(async () => [
      { id: 'stmt-1', clientId: 'c1', name: 'TD Bank 4920', dayOfMonth: 12, sortOrder: 0 },
      { id: 'stmt-2', clientId: 'c1', name: 'Amex 1108', dayOfMonth: 3, sortOrder: 1 },
    ])
    renderPanel()
    expect(await screen.findByDisplayValue('TD Bank 4920')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Amex 1108')).toBeInTheDocument()
  })

  it('shows the empty-state copy when there are no rows yet', async () => {
    renderPanel()
    expect(await screen.findByText(/No statement dates yet/i)).toBeInTheDocument()
  })

  it('reference-only helper line is always shown', async () => {
    renderPanel()
    expect(
      await screen.findByText(/Reference only\. Nothing else in the app reads these\./i),
    ).toBeInTheDocument()
  })

  it('"Add account" appends an empty row', async () => {
    renderPanel()
    await screen.findByText(/No statement dates yet/i)
    fireEvent.click(screen.getByRole('button', { name: /Add account/i }))
    expect(await screen.findByPlaceholderText('Account name')).toBeInTheDocument()
  })

  it('suggests reconciliation checklist item labels as chips, minus names already in the box', async () => {
    listAccounts = vi.fn(async () => [
      { id: 'stmt-1', clientId: 'c1', name: 'TD Bank 4920', dayOfMonth: 12, sortOrder: 0 },
    ])
    renderPanel('c1', [
      reconciliationTemplate('c1', ['TD Bank 4920', 'Chase 7712']),
    ])
    expect(await screen.findByRole('button', { name: 'Chase 7712' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'TD Bank 4920' })).not.toBeInTheDocument()
  })

  it('clicking a chip adds a row with that name and no day picked', async () => {
    renderPanel('c1', [reconciliationTemplate('c1', ['Chase 7712'])])
    fireEvent.click(await screen.findByRole('button', { name: 'Chase 7712' }))
    expect(await screen.findByDisplayValue('Chase 7712')).toBeInTheDocument()
    expect(screen.getByLabelText('Day')).toHaveValue('')
  })

  it('ignores templates whose title does not mention reconciliation', async () => {
    renderPanel('c1', [
      {
        ...reconciliationTemplate('c1', ['Payroll item']),
        title: 'Payroll',
      } as ChecklistTemplate,
    ])
    await screen.findByText(/No statement dates yet/i)
    expect(screen.queryByRole('button', { name: 'Payroll item' })).not.toBeInTheDocument()
  })

  it('refuses to save a named row with no day picked', async () => {
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: /Add account/i }))
    fireEvent.change(screen.getByPlaceholderText('Account name'), {
      target: { value: 'TD Bank 4920' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    expect(await screen.findByText('Pick a day for TD Bank 4920')).toBeInTheDocument()
    expect(saveAccounts).not.toHaveBeenCalled()
  })

  it('drops a row with an empty name and saves the rest', async () => {
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: /Add account/i }))
    fireEvent.click(screen.getByRole('button', { name: /Add account/i }))
    const names = screen.getAllByPlaceholderText('Account name')
    fireEvent.change(names[1], { target: { value: 'TD Bank 4920' } })
    fireEvent.change(screen.getAllByLabelText('Day')[1], { target: { value: '12' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(saveAccounts).toHaveBeenCalled())
    expect(saveAccounts).toHaveBeenCalledWith('c1', [{ name: 'TD Bank 4920', dayOfMonth: 12 }])
  })

  it('saves with sortOrder implied by array position (first row, then second)', async () => {
    listAccounts = vi.fn(async () => [
      { id: 'stmt-1', clientId: 'c1', name: 'TD Bank 4920', dayOfMonth: 12, sortOrder: 0 },
    ])
    renderPanel()
    await screen.findByDisplayValue('TD Bank 4920')
    fireEvent.click(screen.getByRole('button', { name: /Add account/i }))
    const names = screen.getAllByPlaceholderText('Account name')
    fireEvent.change(names[names.length - 1], { target: { value: 'Amex 1108' } })
    const days = screen.getAllByLabelText('Day')
    fireEvent.change(days[days.length - 1], { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(saveAccounts).toHaveBeenCalled())
    expect(saveAccounts).toHaveBeenCalledWith('c1', [
      { id: 'stmt-1', name: 'TD Bank 4920', dayOfMonth: 12 },
      { name: 'Amex 1108', dayOfMonth: 3 },
    ])
  })
})
