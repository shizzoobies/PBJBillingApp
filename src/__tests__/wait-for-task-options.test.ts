import { describe, expect, it } from 'vitest'
import { waitForTaskOptions } from '../lib/waitForTaskOptions'
import { checklistsVisibleTo } from '../lib/checklistVisibility'
import { isChecklistSkipped } from '../../lib/checklist-skip.js'
import type { Checklist, Client } from '../lib/types'

/**
 * The "waiting for another task to finish" picker (featreq-5dd514b8).
 *
 * The fixtures mirror the real caller on purpose: `offerable` is built the way
 * `App.tsx` builds `visibleChecklists` (unskipped, then narrowed to the viewer),
 * and `all` is the store's two arrays concatenated — actives plus the recycle
 * bin. Feeding the function one undifferentiated list would prove nothing about
 * either half of the rule.
 */

const LISA = 'emp-lisa'

const ACME: Client = { id: 'acme', name: 'Acme Dental' } as Client
const GLOBEX: Client = { id: 'globex', name: 'Globex Freight' } as Client
const CLIENTS = [ACME, GLOBEX]

const task = (over: Partial<Checklist>): Checklist =>
  ({
    id: 'x',
    title: 't',
    clientId: ACME.id,
    assigneeId: LISA,
    dueDate: '2026-08-20',
    viewerIds: [],
    editorIds: [],
    items: [],
    ...over,
  }) as Checklist

/** Exactly App.tsx's derivation: drop skips, then narrow to the viewer. */
const offerableFor = (
  actives: Checklist[],
  { viewerId = LISA, isOwner = true }: { viewerId?: string; isOwner?: boolean } = {},
) =>
  checklistsVisibleTo(
    actives.filter((entry) => !isChecklistSkipped(entry)),
    { viewerId, isOwner },
  )

/** The picker as the page calls it, from the store's two arrays. */
const optionsFor = (
  { actives, recycled = [] }: { actives: Checklist[]; recycled?: Checklist[] },
  args: { checklistId: string; selectedId?: string | null; viewerId?: string; isOwner?: boolean },
) =>
  waitForTaskOptions({
    offerable: offerableFor(actives, { viewerId: args.viewerId, isOwner: args.isOwner }),
    all: [...actives, ...recycled],
    clients: CLIENTS,
    checklistId: args.checklistId,
    selectedId: args.selectedId,
  })

const ids = (options: Array<{ id: string }>) => options.map((option) => option.id)

describe('waitForTaskOptions — what it offers', () => {
  it('offers the other tasks on the same client', () => {
    const actives = [
      task({ id: 'a1', title: 'Acme payroll' }),
      task({ id: 'a2', title: 'Acme bank rec' }),
      task({ id: 'a3', title: 'Acme sales tax' }),
    ]
    expect(optionsFor({ actives }, { checklistId: 'a1' })).toEqual([
      { id: 'a2', title: 'Acme bank rec' },
      { id: 'a3', title: 'Acme sales tax' },
    ])
  })

  it('excludes every task belonging to another client', () => {
    const actives = [
      task({ id: 'a1' }),
      task({ id: 'a2' }),
      task({ id: 'b1', clientId: GLOBEX.id }),
      task({ id: 'b2', clientId: GLOBEX.id }),
    ]
    expect(ids(optionsFor({ actives }, { checklistId: 'a1' }))).toEqual(['a2'])
  })

  it('never offers the task itself', () => {
    const actives = [task({ id: 'a1' }), task({ id: 'a2' })]
    expect(ids(optionsFor({ actives }, { checklistId: 'a1' }))).toEqual(['a2'])
  })

  it('excludes a skipped occurrence — it would never complete, so the ping never fires', () => {
    const actives = [
      task({ id: 'a1' }),
      task({ id: 'a2' }),
      task({ id: 'a3', skippedAt: '2026-08-13T12:00:00.000Z', skippedBy: LISA }),
    ]
    expect(ids(optionsFor({ actives }, { checklistId: 'a1' }))).toEqual(['a2'])
  })

  it("excludes a same-client task the viewer can't open", () => {
    const actives = [
      task({ id: 'a1' }),
      task({ id: 'a2' }),
      task({ id: 'a3', assigneeId: 'emp-avery' }),
    ]
    expect(
      ids(optionsFor({ actives }, { checklistId: 'a1', viewerId: LISA, isOwner: false })),
    ).toEqual(['a2'])
  })

  it('excludes a recycled task — it is not in the active feed at all', () => {
    const actives = [task({ id: 'a1' })]
    const recycled = [task({ id: 'a2', deletedAt: '2026-08-01T00:00:00.000Z' })]
    expect(optionsFor({ actives, recycled }, { checklistId: 'a1' })).toEqual([])
  })
})

describe('waitForTaskOptions — no-client (internal) tasks', () => {
  it('shows a no-client task only other no-client tasks', () => {
    const actives = [
      task({ id: 'i1', title: 'Team meeting notes', clientId: '' }),
      task({ id: 'i2', title: 'Internal training', clientId: '' }),
      task({ id: 'a1' }),
    ]
    expect(ids(optionsFor({ actives }, { checklistId: 'i1' }))).toEqual(['i2'])
  })

  it('does not offer a no-client task to a client task', () => {
    const actives = [task({ id: 'a1' }), task({ id: 'i1', clientId: '' })]
    expect(optionsFor({ actives }, { checklistId: 'a1' })).toEqual([])
  })
})

describe('waitForTaskOptions — a saved link is never dropped', () => {
  it('keeps a cross-client selection, named by its client', () => {
    const actives = [
      task({ id: 'a1' }),
      task({ id: 'a2' }),
      task({ id: 'b1', title: 'Globex close', clientId: GLOBEX.id }),
    ]
    expect(optionsFor({ actives }, { checklistId: 'a1', selectedId: 'b1' })).toEqual([
      { id: 'a2', title: 't' },
      { id: 'b1', title: 'Globex close (Globex Freight)' },
    ])
  })

  it('keeps a cross-client selection even when the client has no other tasks', () => {
    const actives = [task({ id: 'a1' }), task({ id: 'b1', clientId: GLOBEX.id })]
    // An empty list hides the row entirely, so the link could not be changed.
    expect(ids(optionsFor({ actives }, { checklistId: 'a1', selectedId: 'b1' }))).toEqual(['b1'])
  })

  it('keeps a selection the owner has since recycled', () => {
    const actives = [task({ id: 'a1' })]
    const recycled = [
      task({ id: 'a2', title: 'Deleted close', deletedAt: '2026-08-01T00:00:00.000Z' }),
    ]
    // Same client, so no name suffix — it is simply the task it has always been.
    expect(optionsFor({ actives, recycled }, { checklistId: 'a1', selectedId: 'a2' })).toEqual([
      { id: 'a2', title: 'Deleted close' },
    ])
  })

  it('keeps a selection that has since been skipped', () => {
    const actives = [
      task({ id: 'a1' }),
      task({ id: 'a2', title: 'Skipped close', skippedAt: '2026-08-13T12:00:00.000Z' }),
    ]
    expect(optionsFor({ actives }, { checklistId: 'a1', selectedId: 'a2' })).toEqual([
      { id: 'a2', title: 'Skipped close' },
    ])
  })

  it("keeps a selection the viewer can't otherwise open", () => {
    const actives = [
      task({ id: 'a1' }),
      task({ id: 'a2', title: "Avery's close", assigneeId: 'emp-avery' }),
    ]
    expect(
      optionsFor({ actives }, {
        checklistId: 'a1',
        selectedId: 'a2',
        viewerId: LISA,
        isOwner: false,
      }),
    ).toEqual([{ id: 'a2', title: "Avery's close" }])
  })

  it('does not duplicate a selection that already passes the filter', () => {
    const actives = [task({ id: 'a1' }), task({ id: 'a2' })]
    expect(ids(optionsFor({ actives }, { checklistId: 'a1', selectedId: 'a2' }))).toEqual(['a2'])
  })

  it('ignores a dangling selection that no longer exists anywhere', () => {
    const actives = [task({ id: 'a1' }), task({ id: 'a2' })]
    expect(ids(optionsFor({ actives }, { checklistId: 'a1', selectedId: 'gone' }))).toEqual(['a2'])
  })

  it('offers nothing when the task itself is unknown, but still keeps its selection', () => {
    const actives = [task({ id: 'b1', title: 'Globex close', clientId: GLOBEX.id })]
    expect(optionsFor({ actives }, { checklistId: 'missing' })).toEqual([])
    expect(optionsFor({ actives }, { checklistId: 'missing', selectedId: 'b1' })).toEqual([
      { id: 'b1', title: 'Globex close (Globex Freight)' },
    ])
  })
})
