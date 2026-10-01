import { render, renderHook, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AttachedClientNotes } from '../pages/ChecklistsPage'
import { useAttachedClientNotes } from '../hooks/useAttachedClientNotes'
import type { AppContextValue } from '../AppContext'
import type { ClientPendingNote } from '../lib/types'

/**
 * "Notes from the client page" (featreq-b688e73c): the read-only block a
 * checklist shows for kind-'note' pending notes attached to it. Kind 'task'
 * is excluded here; it already landed as an ordinary item, so showing it again
 * would double it up.
 *
 * The card never fetches: a PAGE asks once, for every card it renders
 * (`useAttachedClientNotes` -> GET /api/pending-notes/attached), and hands each
 * card its own notes.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))
vi.mock('../lib/api', () => ({
  listAttachedPendingNotesRequest: (...args: unknown[]) => listNotes(...args),
}))

let listNotes = vi.fn()
let contextValue: AppContextValue

const note = (over: Partial<ClientPendingNote> = {}): ClientPendingNote => ({
  id: 'pnote-1',
  clientId: 'c1',
  templateId: 'tmpl-payroll',
  kind: 'note',
  body: 'New hire starting this cycle',
  authorId: 'emp-lisa',
  authorName: 'Lisa',
  createdAt: '2026-09-20T12:00:00.000Z',
  attachedChecklistId: 'chk-1',
  attachedItemId: null,
  attachedAt: '2026-09-25T00:00:00.000Z',
  ...over,
})

beforeEach(() => {
  listNotes = vi.fn(async () => [])
  contextValue = { dataRefreshCount: 0 } as unknown as AppContextValue
})

describe('AttachedClientNotes', () => {
  it('renders nothing when there are no attached notes', () => {
    const { container } = render(<AttachedClientNotes notes={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows a kind-"note" note, with its author', () => {
    render(<AttachedClientNotes notes={[note()]} />)
    expect(screen.getByText('Notes from the client page')).toBeInTheDocument()
    expect(screen.getByText('New hire starting this cycle')).toBeInTheDocument()
    expect(screen.getByText('Lisa')).toBeInTheDocument()
  })

  it('excludes a kind-"task" note — it is already an ordinary item', () => {
    const { container } = render(
      <AttachedClientNotes notes={[note({ id: 'pnote-task', kind: 'task' })]} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders both when a checklist has one of each kind', () => {
    render(
      <AttachedClientNotes
        notes={[
          note({ id: 'pnote-note', kind: 'note', body: 'Shown note' }),
          note({ id: 'pnote-task', kind: 'task', body: 'Hidden task note' }),
        ]}
      />,
    )
    expect(screen.getByText('Shown note')).toBeInTheDocument()
    expect(screen.queryByText('Hidden task note')).not.toBeInTheDocument()
  })

  it('never fetches by itself — the card only displays what the page handed it', () => {
    render(<AttachedClientNotes notes={[note()]} />)
    expect(listNotes).not.toHaveBeenCalled()
  })
})

describe('useAttachedClientNotes (the one fetch a page makes for all its cards)', () => {
  it('asks ONCE for every id and hands each card its own notes', async () => {
    listNotes = vi.fn(async () => [
      note({ id: 'pnote-a', attachedChecklistId: 'chk-a', body: 'For A' }),
      note({ id: 'pnote-c', attachedChecklistId: 'chk-c', body: 'For C' }),
    ])
    const { result } = renderHook(() => useAttachedClientNotes(['chk-c', 'chk-a', 'chk-b']))
    await waitFor(() => expect(result.current('chk-a').map((n) => n.body)).toEqual(['For A']))

    expect(listNotes).toHaveBeenCalledTimes(1)
    expect(listNotes).toHaveBeenCalledWith(['chk-a', 'chk-b', 'chk-c'])
    expect(result.current('chk-c').map((n) => n.body)).toEqual(['For C'])
    expect(result.current('chk-b')).toEqual([])
  })

  it('does not refetch when the same ids arrive in another order or as a new array', async () => {
    const { result, rerender } = renderHook(({ ids }) => useAttachedClientNotes(ids), {
      initialProps: { ids: ['chk-a', 'chk-b'] },
    })
    await waitFor(() => expect(listNotes).toHaveBeenCalledTimes(1))
    rerender({ ids: ['chk-b', 'chk-a'] })
    rerender({ ids: ['chk-a', 'chk-b', 'chk-a'] })
    expect(listNotes).toHaveBeenCalledTimes(1)
    expect(result.current('chk-a')).toEqual([])
  })

  it('refetches when the set of ids changes', async () => {
    const { rerender } = renderHook(({ ids }) => useAttachedClientNotes(ids), {
      initialProps: { ids: ['chk-a'] },
    })
    await waitFor(() => expect(listNotes).toHaveBeenCalledTimes(1))
    rerender({ ids: ['chk-a', 'chk-b'] })
    await waitFor(() => expect(listNotes).toHaveBeenCalledTimes(2))
  })

  it('refetches on the data-changed signal, so a note that attached elsewhere shows up', async () => {
    const { result, rerender } = renderHook(() => useAttachedClientNotes(['chk-1']))
    await waitFor(() => expect(listNotes).toHaveBeenCalledTimes(1))
    expect(result.current('chk-1')).toEqual([])

    listNotes = vi.fn(async () => [note({ body: 'Attached while you were here' })])
    contextValue = { dataRefreshCount: 1 } as unknown as AppContextValue
    rerender()
    await waitFor(() =>
      expect(result.current('chk-1').map((n) => n.body)).toEqual(['Attached while you were here']),
    )
    expect(listNotes).toHaveBeenCalledTimes(1)
  })

  it('keeps what is on screen when a refetch fails', async () => {
    listNotes = vi.fn(async () => [note({ body: 'Still here' })])
    const { result, rerender } = renderHook(() => useAttachedClientNotes(['chk-1']))
    await waitFor(() => expect(result.current('chk-1')).toHaveLength(1))

    listNotes = vi.fn(async () => {
      throw new Error('offline')
    })
    contextValue = { dataRefreshCount: 1 } as unknown as AppContextValue
    rerender()
    await waitFor(() => expect(listNotes).toHaveBeenCalledTimes(1))
    expect(result.current('chk-1').map((n) => n.body)).toEqual(['Still here'])
  })

  it('does not fetch at all for an empty page', () => {
    renderHook(() => useAttachedClientNotes([]))
    expect(listNotes).not.toHaveBeenCalled()
  })
})
