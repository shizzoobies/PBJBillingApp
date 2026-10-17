import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error - plain-JS module without type declarations
import { notify } from '../../lib/notify.js'
import { blockerWaitLink } from '../../lib/waiting-on-state.js'
import { checklistsVisibleTo } from '../lib/checklistVisibility'
import type { Checklist } from '../lib/types'

/**
 * featreq-4fd52a3c: "Lisa has a delayed to Allison but Allison is unable to see
 * the delay to mark it complete."
 *
 * Every link aimed at the BLOCKER of a wait used to open
 * `/checklists?focus=<checklist>`. The Checklists page lists only the tasks the
 * viewer is assignee or viewer on, so a blocker who is not on the task landed
 * on her own list with nothing focused. The page that does show her the wait,
 * with its Done button, is Delayed -> "Waiting on me". These tests pin the link
 * to that page, and pin it in ONE helper, so the bell (two server sites) and the
 * Dashboard row cannot drift apart again.
 *
 * Same shape as waiting-lock-routes.test.ts for the server half: `server.js`
 * calls `server.listen()` at module scope and exports nothing, so the route glue
 * is pinned by reading its source.
 */

const serverSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.js'),
  'utf8',
)

function routeBlock(startPattern: RegExp, length: number): string {
  const at = serverSource.search(startPattern)
  expect(at, `route not found: ${startPattern}`).toBeGreaterThan(-1)
  return serverSource.slice(at, at + length)
}

const LISA = 'emp-lisa' // asked for the help, owns the task
const ALLISON = 'emp-allison' // is being waited on, NOT on the task

describe('the blocker link', () => {
  it('opens the Delayed page on the Waiting on me tab, focused on the wait', () => {
    expect(blockerWaitLink('wo-820da051')).toBe('/delayed?tab=blocking&focus=wo-820da051')
  })

  it('encodes the id, so an odd one cannot break out of the query', () => {
    expect(blockerWaitLink('wo a&b')).toBe('/delayed?tab=blocking&focus=wo%20a%26b')
  })

  it('still opens the tab when there is no id to focus', () => {
    expect(blockerWaitLink('')).toBe('/delayed?tab=blocking')
    expect(blockerWaitLink(undefined)).toBe('/delayed?tab=blocking')
  })

  // WHY the checklist was the wrong target: the blocker is not shown the task.
  it('is needed because the Checklists page does not list a task the blocker is not on', () => {
    const lisasTask = { id: 'check-2a32fae2', assigneeId: LISA, viewerIds: [] } as unknown as Checklist
    expect(checklistsVisibleTo([lisasTask], { viewerId: ALLISON, isOwner: false })).toEqual([])
  })
})

describe('the server sends the blocker to the Delayed page', () => {
  it('on create: the waiting_on_requested bell names the new wait', () => {
    const block = routeBlock(/await notify\(appDataStore, blockerId, 'waiting_on_requested', \{/, 500)
    expect(block).toContain('link: blockerWaitLink(result.entry.id)')
    expect(block).not.toContain('/checklists?focus=')
  })

  it('on send-back: the bell back to the blocker names the same wait', () => {
    const block = routeBlock(
      /await notify\(appDataStore, resolved\.entry\.blockerId, 'waiting_on_requested', \{/,
      500,
    )
    expect(block).toContain('link: blockerWaitLink(resolved.entry.id)')
    expect(block).not.toContain('/checklists?focus=')
  })

  // The requester side owns the task, so the checklist is still the right page.
  it('leaves the requester-facing notices on the checklist', () => {
    for (const event of ["'waiting_on_done'", "'waiting_on_question'"]) {
      const block = routeBlock(new RegExp(`await notify\\(appDataStore, recipientId, ${event}, \\{`), 500)
      expect(block).toContain('link: `/checklists?focus=${encodeURIComponent(checklistId)}`')
    }
  })

  it('imports the one shared helper', () => {
    const imports = serverSource.slice(0, serverSource.indexOf("} from './lib/waiting-on-state.js'"))
    expect(imports.slice(imports.lastIndexOf('import {'))).toContain('blockerWaitLink,')
  })
})

describe('the notification itself', () => {
  let sentHtml: string | null

  beforeEach(() => {
    sentHtml = null
    process.env.RESEND_API_KEY = 'test-key'
    process.env.EMAIL_FROM = 'noreply@firm.test'
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        sentHtml = JSON.parse(init.body).html
        return { ok: true, text: async () => '' }
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.RESEND_API_KEY
    delete process.env.EMAIL_FROM
  })

  it('stores the Delayed link on the bell; the email still opens the app root', async () => {
    const store = {
      createNotification: vi.fn(async () => ({ id: 'n1' })),
      getTeamMember: vi.fn(async () => ({ id: ALLISON, email: 'allison@firm.test' })),
      getClientNameForChecklist: vi.fn(async () => 'Saylor Grace Plumbing'),
    }
    const link = blockerWaitLink('wo-820da051')
    await notify(store, ALLISON, 'waiting_on_requested', {
      checklistId: 'check-2a32fae2',
      message: 'Lisa is waiting on you: "House Call Pro" in "Monthly Reconciliations"',
      link,
      appPublicUrl: 'https://app.test',
    })

    const [userId, event, , storedLink, payload] = store.createNotification.mock.calls[0] as unknown[]
    expect(userId).toBe(ALLISON)
    expect(event).toBe('waiting_on_requested')
    expect(storedLink).toBe('/delayed?tab=blocking&focus=wo-820da051')
    expect((payload as { link: string }).link).toBe(storedLink)

    // The L4 rule (lib/notify.js): notification emails link to the app root,
    // never a deep link. Unchanged here on purpose; the bell carries the route.
    expect(sentHtml).toContain('href="https://app.test/"')
    expect(sentHtml).not.toContain('/delayed')
    expect(sentHtml).not.toContain('/checklists')
  })
})
