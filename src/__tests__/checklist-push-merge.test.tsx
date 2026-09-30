import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import App from '../App'
import { createSeedData } from '../lib/seed'
import { installFetchMock, OWNER_SESSION } from './helpers'
import type { Checklist } from '../lib/types'

/**
 * `App.tsx`'s `pushChecklistOccurrence` merge, end to end (featreq-fbab3370).
 *
 * The server hands back `{ checklist, completed }` on a SPLIT push: `checklist`
 * carries the open work under a brand-new id, `completed` is the done-only
 * original left behind. Merging that response has to do two different things
 * to `current.checklists` at once — REPLACE the original row in place (its id
 * was already there) and ADD the new row (its id was not) — which is exactly
 * the bug a naive `.map()` alone would miss: it can update an existing entry
 * but it can never grow the array. This mounts the REAL `<App>` against a
 * mocked network and drives a real push through the real dialog, so it proves
 * the actual merge code, not a stand-in for it.
 *
 * Both due dates are kept inside the default "This month" report period
 * (ChecklistsPage's In-progress list is period-scoped by due date — see
 * `filterInProgressChecklists`): a row that fell outside it would be filtered
 * out of the list entirely, which would look identical to a merge bug from
 * this test's vantage point and is not what it is testing.
 *
 * Every query below is scoped to THIS render's own `container` via `within`,
 * never the bare `screen` (which queries the whole `document.body`) — this
 * suite runs alongside 200+ other files that also mount `<App>`, and a global
 * query is only as reliable as every other file's cleanup.
 */

const MIXED_ID = 'cl-mixed'
const SPLIT_ID = 'cl-split'

const MIXED_CHECKLIST: Checklist = {
  id: MIXED_ID,
  title: 'Mixed close',
  clientId: 'client-clover',
  assigneeId: 'emp-patrice',
  dueDate: '2026-09-25',
  viewerIds: [],
  editorIds: [],
  items: [
    { id: 'item-done', label: 'Reconcile', done: true },
    { id: 'item-open', label: 'Send statements', done: false },
  ],
} as unknown as Checklist

const SPLIT_CHECKLIST: Checklist = {
  ...MIXED_CHECKLIST,
  id: SPLIT_ID,
  // Later than the original's due date (a push has to move it forward) but
  // still inside September, so the default report period keeps it in view.
  dueDate: '2026-09-30',
  cycleDueDate: '2026-09-25',
  pushedAt: '2026-09-26T12:00:00.000Z',
  pushedBy: 'emp-patrice',
  pushedFromChecklistId: MIXED_ID,
  items: [{ id: 'item-open', label: 'Send statements', done: false }],
} as unknown as Checklist

const COMPLETED_ORIGINAL: Checklist = {
  ...MIXED_CHECKLIST,
  pushedAt: '2026-09-26T12:00:00.000Z',
  pushedBy: 'emp-patrice',
  pushedToChecklistId: SPLIT_ID,
  items: [{ id: 'item-done', label: 'Reconcile', done: true }],
} as unknown as Checklist

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('adds the new checklist AND keeps the done-only original — not a replace, an add', async () => {
  // Boot at '/', like app-boot.test.tsx and the preview-scope suite — the app
  // redirects on boot, and a URL set ahead of time to a deep route gets
  // yanked back the moment that redirect lands.
  window.history.pushState({}, '', '/')

  installFetchMock({
    sessionUser: OWNER_SESSION,
    appData: { ...createSeedData(), checklists: [MIXED_CHECKLIST] },
    extraRoutes: [
      (path, method) => {
        if (method === 'POST' && path.endsWith(`/api/checklists/${MIXED_ID}/push`)) {
          return new Response(
            JSON.stringify({ checklist: SPLIT_CHECKLIST, completed: COMPLETED_ORIGINAL }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        return undefined
      },
    ],
  })

  const { container } = render(<App />)
  const page = within(container)
  await page.findByRole('navigation')
  fireEvent.click(page.getByRole('link', { name: 'Checklists' }))

  const card = (await page.findByText('Mixed close')).closest(
    'article, li, section',
  ) as HTMLElement
  fireEvent.click(within(card).getByText('Push to a new date'))

  const dialog = within(page.getByRole('group', { name: /Push Mixed close to a new date/i }))
  fireEvent.change(dialog.getByRole('combobox'), { target: { value: 'client' } })
  fireEvent.change(dialog.getByRole('textbox'), { target: { value: 'Statements are late.' } })
  fireEvent.change(dialog.getByLabelText('New due date'), { target: { value: '2026-09-30' } })
  fireEvent.click(dialog.getByRole('button', { name: 'Push to this date' }))

  // The new checklist's open step lands in an expanded-by-default group ("Due
  // this week"), so it appears without any further clicks.
  await waitFor(() => expect(page.getAllByText('Send statements')).toHaveLength(1))

  // The done-only original lands in the "Completed" GROUP inside this same
  // tab (ChecklistsPage's `ChecklistGroup`, class `checklist-group-header`),
  // which starts collapsed — expand it to see its one remaining step. Scoped
  // to that class rather than `getByRole('button', { name: /Completed/i })`
  // because the "Completed" TASK-AREA TAB elsewhere on the page would also
  // match that name and switch views instead of expanding this group.
  const completedToggle = Array.from(
    container.querySelectorAll<HTMLButtonElement>('.checklist-group-header'),
  ).find((button) => within(button).queryByText('Completed'))
  expect(completedToggle).toBeTruthy()
  fireEvent.click(completedToggle as HTMLButtonElement)

  // Both items now render SOMEWHERE on the page: "Send statements" only ever
  // belonged to the new checklist's open step, "Reconcile" only ever belonged
  // to the original's done step. Finding both, each exactly once, is only
  // possible if `current.checklists` ended up with BOTH rows — a merge that
  // replaced instead of added would lose one of the two entirely.
  expect(page.getAllByText('Reconcile')).toHaveLength(1)

  // And the title renders twice — once per row — confirming the checklist
  // COUNT grew by one rather than staying flat.
  expect(page.getAllByText('Mixed close')).toHaveLength(2)
})
