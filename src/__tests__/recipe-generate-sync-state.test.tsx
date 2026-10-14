import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import App from '../App'
import { createSeedData } from '../lib/seed'
import { localDateOnly } from '../lib/utils'
import { installFetchMock, openNavLink, OWNER_SESSION } from './helpers'
import type { Checklist, ChecklistTemplate } from '../lib/types'

/**
 * "Start now" on a recipe (the generate flow) must not claim "All changes
 * saved" while a save pass has failed. It used to set `synced` unconditionally
 * when its own request finished, hiding the "not saved" banner a failing
 * autosave pass had just raised. The edit here is a plan added on another page,
 * so the workspace is dirty and every save pass is refused with a 500.
 */

const TODAY = localDateOnly()
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const template = {
  id: 'tmpl-1',
  title: 'Bank rec close',
  clientId: 'client-clover',
  assigneeId: 'emp-patrice',
  frequency: 'monthly',
  nextDueDate: '2099-01-31',
  active: true,
  isStandard: false,
  viewerIds: [],
  editorIds: [],
  stages: [
    {
      id: 'stage-a',
      name: 'Prep',
      assigneeId: 'emp-patrice',
      offsetDays: 0,
      viewerIds: [],
      editorIds: [],
      items: [{ id: 'ti-0', label: 'Reconcile' }],
    },
  ],
} as unknown as ChecklistTemplate

const generated = {
  id: 'cl-gen',
  title: 'Bank rec close',
  clientId: 'client-clover',
  assigneeId: 'emp-patrice',
  templateId: 'tmpl-1',
  stageId: 'stage-a',
  stageIndex: 0,
  stageCount: 1,
  dueDate: TODAY,
  viewerIds: [],
  editorIds: [],
  items: [{ id: 'item-g1', label: 'Reconcile', done: false }],
} as unknown as Checklist

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/**
 * Boot the app with a dirty workspace whose every save pass is refused with
 * `saveStatus` / `saveBody`, open the recipe, press "Start now", and return the
 * banner texts seen from just before the press.
 */
async function startNowWhileSaveFails(saveStatus: number, saveBody: unknown) {
  window.history.pushState({}, '', '/checklists?area=repeating')
  let puts = 0
  let generateCalls = 0
  installFetchMock({
    sessionUser: OWNER_SESSION,
    appData: { ...createSeedData(), checklists: [], checklistTemplates: [template] },
    extraRoutes: [
      (path, method) => {
        if (method === 'PUT' && path.endsWith('/api/app-data')) {
          puts += 1
          return json(saveBody, saveStatus)
        }
        if (method === 'POST' && path.endsWith('/api/checklist-templates/tmpl-1/generate')) {
          generateCalls += 1
          return json(generated)
        }
        if (method === 'GET' && path.endsWith('/api/checklists/item-deletions')) return json({ requests: [] })
        if (method === 'GET' && path.endsWith('/api/checklists/pending-edits')) return json({ edits: [] })
        if (method === 'GET' && path.endsWith('/api/waiting-on-me')) return json({ items: [] })
        if (method === 'GET' && path.endsWith('/api/checklists/skips')) return json({ skips: [] })
        if (method === 'GET' && path.endsWith('/api/pending-notes/attached')) return json({ notes: [] })
        return undefined
      },
    ],
  })
  const { container } = render(<App />)
  const page = within(container)

  // A local edit on another page: the workspace is dirty and its save is refused.
  await openNavLink(page, 'Plans')
  fireEvent.click(await page.findByRole('button', { name: 'Add plan' }))
  fireEvent.click(page.getAllByRole('button', { name: 'Add plan' }).at(-1) as HTMLElement)
  await waitFor(() => expect(puts).toBeGreaterThan(0), { timeout: 4000 })

  // Now to the recipe, and start it.
  await openNavLink(page, 'Checklists')
  fireEvent.click(await page.findByRole('tab', { name: /^Repeating/ }))
  // The client's group starts collapsed.
  fireEvent.click(await page.findByRole('button', { name: /Clover Ridge Dental/ }))
  fireEvent.click(await page.findByRole('button', { name: /Bank rec close/ }))

  // Record every banner text from here on.
  const banner = () => container.querySelector('.sync-banner')
  const seen: string[] = []
  const observer = new MutationObserver(() => seen.push(banner()?.textContent ?? ''))
  observer.observe(container, { subtree: true, childList: true, characterData: true })
  seen.push(banner()?.textContent ?? '')

  fireEvent.click(await page.findByRole('button', { name: /Start now/ }))
  await waitFor(() => expect(generateCalls).toBe(1))
  // Let the request settle and the autosave retry (250 ms debounce) run its pass.
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 700))
  })
  observer.disconnect()
  return { seen, banner }
}

describe('Start now on a recipe while a save pass is failing', () => {
  it('never shows "All changes saved", and the "Couldn’t save" banner is what settles', async () => {
    const { seen, banner } = await startNowWhileSaveFails(500, { error: 'Save failed' })
    expect(seen).not.toContain('All changes saved')
    await waitFor(() => expect(banner()?.textContent).toBe('Couldn’t save — retrying'), { timeout: 4000 })
  })

  it('a tab latched as stale (saves refused for good) says "Couldn’t save", not "Saving…" forever', async () => {
    const { seen, banner } = await startNowWhileSaveFails(409, { error: 'stale_workspace', message: 'Reload.' })
    expect(seen).not.toContain('All changes saved')
    await waitFor(() => expect(banner()?.textContent).toBe('Couldn’t save — retrying'), { timeout: 4000 })
  })
})
