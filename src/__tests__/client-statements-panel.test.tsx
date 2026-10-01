import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ClientStatementsPanel } from '../components/ClientStatementsPanel'
import { ApiError } from '../lib/types'
import type { AppContextValue } from '../AppContext'
import type { AppData, ChecklistTemplate } from '../lib/types'

/**
 * Statement dates box (featreq-11ffb3a6): a reference-only per-client list of
 * accounts and the day of the month each one's statement usually appears.
 *
 * Covers the original shape (loads and renders saved rows, the "From the
 * reconciliation checklist" chip adds a prefilled row, a named row with no
 * day is refused rather than silently saved, a save sends sortOrder as the
 * array index) plus the two staleness guards from the fix review:
 *  - a failed GET must not leave Save armed over an empty `rows` — Save, Add
 *    account and the chips stay disabled until a Retry succeeds (Important 1).
 *  - a 409 `stale_statement_accounts` on save shows the server's message with
 *    a Reload button instead of the generic save-failed error (Important 2a).
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
    dataRefreshCount: 0,
  } as unknown as AppContextValue
  return render(<ClientStatementsPanel clientId={clientId} />)
}

/** The live-sync signal: bump `dataRefreshCount` and re-render, as App.tsx does. */
function signalDataChanged(view: ReturnType<typeof renderPanel>, count: number) {
  contextValue = { ...contextValue, dataRefreshCount: count } as unknown as AppContextValue
  view.rerender(<ClientStatementsPanel clientId="c1" />)
}

/** A promise a test settles by hand, to hold a request in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/** Lets already-resolved promises run their continuations. */
const flush = () => act(async () => {})

const LOADED = {
  accounts: [{ id: 'stmt-1', clientId: 'c1', name: 'TD Bank 4920', dayOfMonth: 12, sortOrder: 0 }],
  version: 'v0',
}

beforeEach(() => {
  listAccounts = vi.fn(async () => ({ accounts: [], version: 'v0' }))
  saveAccounts = vi.fn(async (_id: string, accounts: unknown[]) => ({
    accounts: (accounts as Array<{ name: string; dayOfMonth: number }>).map((row, index) => ({
      id: `stmt-${index}`,
      clientId: 'c1',
      name: row.name,
      dayOfMonth: row.dayOfMonth,
      sortOrder: index,
    })),
    version: 'v1',
  }))
})

describe('the statement dates box', () => {
  it('loads and renders the saved rows', async () => {
    listAccounts = vi.fn(async () => ({
      accounts: [
        { id: 'stmt-1', clientId: 'c1', name: 'TD Bank 4920', dayOfMonth: 12, sortOrder: 0 },
        { id: 'stmt-2', clientId: 'c1', name: 'Amex 1108', dayOfMonth: 3, sortOrder: 1 },
      ],
      version: 'v0',
    }))
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
    listAccounts = vi.fn(async () => ({
      accounts: [
        { id: 'stmt-1', clientId: 'c1', name: 'TD Bank 4920', dayOfMonth: 12, sortOrder: 0 },
      ],
      version: 'v0',
    }))
    renderPanel('c1', [
      reconciliationTemplate('c1', ['TD Bank 4920', 'Chase 7712']),
    ])
    expect(await screen.findByRole('button', { name: 'Chase 7712' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'TD Bank 4920' })).not.toBeInTheDocument()
  })

  it('dedupes chip labels case-insensitively, keeping the first spelling', async () => {
    renderPanel('c1', [reconciliationTemplate('c1', ['Chase 7712', 'chase 7712', 'CHASE 7712'])])
    expect(await screen.findByRole('button', { name: 'Chase 7712' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'chase 7712' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'CHASE 7712' })).not.toBeInTheDocument()
  })

  it('clicking a chip adds a row with that name and no day picked', async () => {
    renderPanel('c1', [reconciliationTemplate('c1', ['Chase 7712'])])
    fireEvent.click(await screen.findByRole('button', { name: 'Chase 7712' }))
    expect(await screen.findByDisplayValue('Chase 7712')).toBeInTheDocument()
    expect(screen.getByLabelText('Day for Chase 7712')).toHaveValue('')
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
    fireEvent.change(screen.getByLabelText('Day for TD Bank 4920'), { target: { value: '12' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(saveAccounts).toHaveBeenCalled())
    expect(saveAccounts).toHaveBeenCalledWith(
      'c1',
      [{ name: 'TD Bank 4920', dayOfMonth: 12 }],
      'v0',
    )
  })

  it('saves with sortOrder implied by array position (first row, then second)', async () => {
    listAccounts = vi.fn(async () => ({
      accounts: [
        { id: 'stmt-1', clientId: 'c1', name: 'TD Bank 4920', dayOfMonth: 12, sortOrder: 0 },
      ],
      version: 'v0',
    }))
    renderPanel()
    await screen.findByDisplayValue('TD Bank 4920')
    fireEvent.click(screen.getByRole('button', { name: /Add account/i }))
    const names = screen.getAllByPlaceholderText('Account name')
    fireEvent.change(names[names.length - 1], { target: { value: 'Amex 1108' } })
    const days = screen.getAllByLabelText(/^Day for /)
    fireEvent.change(days[days.length - 1], { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(saveAccounts).toHaveBeenCalled())
    expect(saveAccounts).toHaveBeenCalledWith(
      'c1',
      [
        { id: 'stmt-1', name: 'TD Bank 4920', dayOfMonth: 12 },
        { name: 'Amex 1108', dayOfMonth: 3 },
      ],
      'v0',
    )
  })
})

describe('a failed load leaves Save disarmed instead of armed over an empty list', () => {
  it('disables Save (and never lets it call saveAccounts), and Retry re-loads', async () => {
    listAccounts = vi.fn(async () => {
      throw new Error('network down')
    })
    renderPanel()
    expect(await screen.findByText('Could not load statement dates.')).toBeInTheDocument()
    const saveButton = screen.getByRole('button', { name: /^Save$/ })
    expect(saveButton).toBeDisabled()
    fireEvent.click(saveButton)
    expect(saveAccounts).not.toHaveBeenCalled()

    // Add account is disabled too — nothing to add a row TO while the list
    // failed to load.
    expect(screen.getByRole('button', { name: /Add account/i })).toBeDisabled()

    listAccounts = vi.fn(async () => ({
      accounts: [{ id: 'stmt-1', clientId: 'c1', name: 'TD Bank 4920', dayOfMonth: 12, sortOrder: 0 }],
      version: 'v0',
    }))
    fireEvent.click(screen.getByRole('button', { name: /Retry/i }))
    expect(await screen.findByDisplayValue('TD Bank 4920')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Save$/ })).not.toBeDisabled()
  })

  it('disables the reconciliation chips after a failed load', async () => {
    listAccounts = vi.fn(async () => {
      throw new Error('network down')
    })
    renderPanel('c1', [reconciliationTemplate('c1', ['Chase 7712'])])
    expect(await screen.findByText('Could not load statement dates.')).toBeInTheDocument()
    const chip = screen.getByRole('button', { name: 'Chase 7712' })
    expect(chip).toBeDisabled()
    fireEvent.click(chip)
    expect(screen.queryByDisplayValue('Chase 7712')).not.toBeInTheDocument()
  })

  it('keeps Add account, Save and the chips disabled while the first load is pending', async () => {
    const pending = deferred<typeof LOADED>()
    listAccounts = vi.fn(() => pending.promise)
    renderPanel('c1', [reconciliationTemplate('c1', ['Chase 7712'])])
    expect(screen.getByRole('button', { name: /Add account/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /^Save$/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Chase 7712' })).toBeDisabled()

    pending.resolve(LOADED)
    expect(await screen.findByDisplayValue('TD Bank 4920')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Add account/i })).not.toBeDisabled()
  })
})

describe('a background refetch never locks the box or eats what she typed', () => {
  it('never flips the controls to loading, and applies a clean result', async () => {
    listAccounts = vi.fn(async () => LOADED)
    const view = renderPanel()
    await screen.findByDisplayValue('TD Bank 4920')

    const pending = deferred<typeof LOADED>()
    listAccounts = vi.fn(() => pending.promise)
    signalDataChanged(view, 1)
    await waitFor(() => expect(listAccounts).toHaveBeenCalledTimes(1))
    // In flight: no Loading flicker, controls stay enabled.
    expect(screen.getByRole('button', { name: /^Save$/ })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: /Add account/i })).not.toBeDisabled()

    pending.resolve({
      accounts: [{ id: 'stmt-1', clientId: 'c1', name: 'Amex 1108', dayOfMonth: 5, sortOrder: 0 }],
      version: 'v2',
    })
    expect(await screen.findByDisplayValue('Amex 1108')).toBeInTheDocument()
  })

  it('drops the result when she typed while it was in flight, and Save stays enabled', async () => {
    listAccounts = vi.fn(async () => LOADED)
    const view = renderPanel()
    const input = await screen.findByDisplayValue('TD Bank 4920')

    const pending = deferred<typeof LOADED>()
    listAccounts = vi.fn(() => pending.promise)
    signalDataChanged(view, 1)
    await waitFor(() => expect(listAccounts).toHaveBeenCalledTimes(1))
    fireEvent.change(input, { target: { value: 'TD Bank 4920 (old)' } })

    pending.resolve({
      accounts: [{ id: 'stmt-1', clientId: 'c1', name: 'Amex 1108', dayOfMonth: 5, sortOrder: 0 }],
      version: 'v2',
    })
    await flush()
    expect(screen.getByDisplayValue('TD Bank 4920 (old)')).toBeInTheDocument()
    expect(screen.queryByDisplayValue('Amex 1108')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Save$/ })).not.toBeDisabled()

    // The version stays what she loaded, so a real conflict still 409s.
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(saveAccounts).toHaveBeenCalled())
    expect(saveAccounts).toHaveBeenCalledWith(
      'c1',
      [{ id: 'stmt-1', name: 'TD Bank 4920 (old)', dayOfMonth: 12 }],
      'v0',
    )
  })

  it('ignores a failed background refetch: the rows stay, no Retry block', async () => {
    listAccounts = vi.fn(async () => LOADED)
    const view = renderPanel()
    await screen.findByDisplayValue('TD Bank 4920')

    listAccounts = vi.fn(async () => {
      throw new Error('network down')
    })
    signalDataChanged(view, 1)
    await waitFor(() => expect(listAccounts).toHaveBeenCalledTimes(1))
    await flush()
    expect(screen.getByDisplayValue('TD Bank 4920')).toBeInTheDocument()
    expect(screen.queryByText('Could not load statement dates.')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Retry/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Save$/ })).not.toBeDisabled()
  })

  it('two data-changed signals in a row with a dirty panel never leave the controls disabled', async () => {
    listAccounts = vi.fn(async () => LOADED)
    const view = renderPanel()
    const input = await screen.findByDisplayValue('TD Bank 4920')

    const first = deferred<typeof LOADED>()
    const second = deferred<typeof LOADED>()
    listAccounts = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    signalDataChanged(view, 1)
    await waitFor(() => expect(listAccounts).toHaveBeenCalledTimes(1))
    fireEvent.change(input, { target: { value: 'Typed' } })
    signalDataChanged(view, 2)
    await waitFor(() => expect(listAccounts).toHaveBeenCalledTimes(2))

    second.resolve(LOADED)
    first.resolve(LOADED)
    await flush()
    expect(screen.getByDisplayValue('Typed')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Save$/ })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: /Add account/i })).not.toBeDisabled()
  })
})

describe('a stale save (409) is told to reload, not shown the generic save error', () => {
  it('shows the server message with a Reload button, and Reload re-fetches', async () => {
    listAccounts = vi.fn(async () => ({
      accounts: [{ id: 'stmt-1', clientId: 'c1', name: 'TD Bank 4920', dayOfMonth: 12, sortOrder: 0 }],
      version: 'v0',
    }))
    saveAccounts = vi.fn(async () => {
      throw new ApiError(
        409,
        'Someone else changed these dates. Reload and try again.',
        'stale_statement_accounts',
      )
    })
    renderPanel()
    await screen.findByDisplayValue('TD Bank 4920')
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    expect(
      await screen.findByText('Someone else changed these dates. Reload and try again.'),
    ).toBeInTheDocument()
    const reloadButton = screen.getByRole('button', {
      name: 'Reload (discards your unsaved changes)',
    })

    listAccounts = vi.fn(async () => ({
      accounts: [{ id: 'stmt-1', clientId: 'c1', name: 'Amex 1108', dayOfMonth: 5, sortOrder: 0 }],
      version: 'v2',
    }))
    fireEvent.click(reloadButton)
    expect(await screen.findByDisplayValue('Amex 1108')).toBeInTheDocument()
  })

  it('an ordinary save failure still shows the generic error, with no Reload button', async () => {
    listAccounts = vi.fn(async () => ({ accounts: [], version: 'v0' }))
    saveAccounts = vi.fn(async () => {
      throw new Error('boom')
    })
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: /Add account/i }))
    fireEvent.change(screen.getByPlaceholderText('Account name'), {
      target: { value: 'TD Bank 4920' },
    })
    fireEvent.change(screen.getByLabelText('Day for TD Bank 4920'), { target: { value: '12' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    expect(
      await screen.findByText('Could not save statement dates — please try again.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Reload/i })).not.toBeInTheDocument()
  })
})

describe('an explicit Reload always takes, and a recovered load clears its error', () => {
  const staleOnce = () => {
    saveAccounts = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError(
          409,
          'Someone else changed these dates. Reload and try again.',
          'stale_statement_accounts',
        ),
      )
  }

  it('disables the row inputs and remove buttons while a Reload is loading', async () => {
    listAccounts = vi.fn(async () => LOADED)
    staleOnce()
    renderPanel()
    await screen.findByDisplayValue('TD Bank 4920')
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    const reloadButton = await screen.findByRole('button', {
      name: 'Reload (discards your unsaved changes)',
    })

    const pending = deferred<typeof LOADED>()
    listAccounts = vi.fn(() => pending.promise)
    fireEvent.click(reloadButton)
    await waitFor(() => expect(listAccounts).toHaveBeenCalledTimes(1))

    expect(screen.getByDisplayValue('TD Bank 4920')).toBeDisabled()
    expect(screen.getByLabelText('Day for TD Bank 4920')).toBeDisabled()
    expect(screen.getByRole('button', { name: /Remove TD Bank 4920/ })).toBeDisabled()

    pending.resolve(LOADED)
    await flush()
    expect(screen.getByDisplayValue('TD Bank 4920')).not.toBeDisabled()
  })

  it('applies the reloaded rows even when something was typed during the Reload, and the next Save does not 409', async () => {
    listAccounts = vi.fn(async () => LOADED)
    staleOnce()
    renderPanel()
    const input = await screen.findByDisplayValue('TD Bank 4920')
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    const reloadButton = await screen.findByRole('button', {
      name: 'Reload (discards your unsaved changes)',
    })

    const pending = deferred<{ accounts: typeof LOADED.accounts; version: string }>()
    listAccounts = vi.fn(() => pending.promise)
    fireEvent.click(reloadButton)
    await waitFor(() => expect(listAccounts).toHaveBeenCalledTimes(1))
    // Something still lands in the box while the Reload is in flight (the
    // inputs are disabled, but a change event can still arrive).
    fireEvent.change(input, { target: { value: 'typed during the reload' } })

    pending.resolve({
      accounts: [{ id: 'stmt-1', clientId: 'c1', name: 'Amex 1108', dayOfMonth: 5, sortOrder: 0 }],
      version: 'v2',
    })
    await flush()

    // The reloaded list wins: a Reload is a deliberate discard.
    expect(screen.getByDisplayValue('Amex 1108')).toBeInTheDocument()
    expect(screen.queryByDisplayValue('typed during the reload')).not.toBeInTheDocument()

    // And the box sits on the NEW version, so Save is sent under it (the
    // server would refuse the old one again).
    saveAccounts = vi.fn(async (_id: string, accounts: unknown[]) => ({
      accounts: accounts as typeof LOADED.accounts,
      version: 'v3',
    }))
    fireEvent.change(screen.getByDisplayValue('Amex 1108'), { target: { value: 'Amex 1108b' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(saveAccounts).toHaveBeenCalled())
    expect(saveAccounts).toHaveBeenCalledWith(
      'c1',
      [{ id: 'stmt-1', name: 'Amex 1108b', dayOfMonth: 5 }],
      'v2',
    )
  })

  it('a background refetch that recovers after a failed first load clears the error under the good rows', async () => {
    listAccounts = vi.fn(async () => {
      throw new Error('network down')
    })
    const view = renderPanel()
    expect(await screen.findByText('Could not load statement dates.')).toBeInTheDocument()

    listAccounts = vi.fn(async () => LOADED)
    signalDataChanged(view, 1)
    await waitFor(() => expect(listAccounts).toHaveBeenCalledTimes(1))
    await flush()

    // A failed first load leaves `loadFailed` set, so the Retry block shows; the
    // background load recovered it, so the rows AND no error text remain.
    expect(await screen.findByDisplayValue('TD Bank 4920')).toBeInTheDocument()
    expect(screen.queryByText('Could not load statement dates.')).not.toBeInTheDocument()
  })

  it('a foreground load retires a background fetch still in flight, so an older list cannot land after it', async () => {
    listAccounts = vi.fn(async () => LOADED)
    saveAccounts = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError(409, 'Someone else changed these dates.', 'stale_statement_accounts'),
      )
    const view = renderPanel()
    await screen.findByDisplayValue('TD Bank 4920')
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    const reloadButton = await screen.findByRole('button', {
      name: 'Reload (discards your unsaved changes)',
    })

    // A background fetch starts, then the Reload; the background one resolves LAST
    // with the older list.
    const background = deferred<typeof LOADED>()
    listAccounts = vi.fn(() => background.promise)
    signalDataChanged(view, 1)
    await waitFor(() => expect(listAccounts).toHaveBeenCalledTimes(1))

    const reloaded = deferred<typeof LOADED>()
    listAccounts = vi.fn(() => reloaded.promise)
    fireEvent.click(reloadButton)
    await waitFor(() => expect(listAccounts).toHaveBeenCalledTimes(1))

    reloaded.resolve({
      accounts: [{ id: 'stmt-1', clientId: 'c1', name: 'Amex 1108', dayOfMonth: 5, sortOrder: 0 }],
      version: 'v2',
    })
    await flush()
    background.resolve(LOADED)
    await flush()

    expect(screen.getByDisplayValue('Amex 1108')).toBeInTheDocument()
    expect(screen.queryByDisplayValue('TD Bank 4920')).not.toBeInTheDocument()
  })
})

describe('accessible names and preview mode', () => {
  it('names the account input and each Day select by the account they belong to', async () => {
    listAccounts = vi.fn(async () => ({
      accounts: [
        { id: 'stmt-1', clientId: 'c1', name: 'TD Bank 4920', dayOfMonth: 12, sortOrder: 0 },
        { id: 'stmt-2', clientId: 'c1', name: 'Amex 1108', dayOfMonth: 3, sortOrder: 1 },
      ],
      version: 'v0',
    }))
    renderPanel()
    await screen.findByDisplayValue('TD Bank 4920')
    expect(screen.getAllByLabelText('Account name')).toHaveLength(2)
    expect(screen.getByLabelText('Day for TD Bank 4920')).toHaveValue('12')
    expect(screen.getByLabelText('Day for Amex 1108')).toHaveValue('3')
  })

  it('disables Save, Add account and the chips with "Disabled in preview mode" while previewing', async () => {
    listAccounts = vi.fn(async () => LOADED)
    contextValue = {
      data: { checklistTemplates: [reconciliationTemplate('c1', ['Chase 7712'])] } as unknown as AppData,
      dataRefreshCount: 0,
      previewMode: true,
    } as unknown as AppContextValue
    render(<ClientStatementsPanel clientId="c1" />)
    await screen.findByDisplayValue('TD Bank 4920')
    for (const name of [/^Save$/, /Add account/i, 'Chase 7712']) {
      const button = screen.getByRole('button', { name })
      expect(button).toBeDisabled()
      expect(button).toHaveAttribute('title', 'Disabled in preview mode')
    }
  })
})
