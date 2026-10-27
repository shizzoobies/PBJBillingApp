import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import App from '../App'
import { forgetDashboardCollapseMemory } from '../lib/useDashboardArrangement'
import { defaultDashboardLayout, type DashboardLayout } from '../../lib/dashboard-layout.js'
import { installFetchMock, OWNER_SESSION } from './helpers'
import type { SessionUser } from '../lib/types'

/**
 * Alex, 2026-10-27, for Brittany: "give her a way to organize things on her
 * dashboard so she can decide which panels are where; make them collapsible
 * and have her be able to decide if it is collapsed by default or open by
 * default."
 *
 * Mounts the REAL <App> on a mocked network: the layout comes from
 * GET /api/me/dashboard-layout and Done saves it with one PUT.
 */

const LAYOUT_PATH = '/api/me/dashboard-layout'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const panel = (key: string, over: { hidden?: boolean; collapsed?: boolean } = {}) => ({
  key,
  hidden: false,
  collapsed: false,
  ...over,
})

type Call = { path: string; method: string; body: unknown; headers: Headers }

let calls: Call[] = []

/**
 * Boots the app with `saved` as the stored layout (null = none). A PUT answers
 * with what it was sent, as the server does once it has cleaned it.
 */
function boot(saved: unknown, sessionUser: SessionUser = OWNER_SESSION) {
  calls = []
  installFetchMock({
    sessionUser,
    extraRoutes: [
      (path, method, body) => {
        if (!path.endsWith(LAYOUT_PATH)) return undefined
        if (method === 'PUT') return json({ layout: (body as { layout: unknown }).layout })
        return json({ layout: saved })
      },
    ],
  })
  // Record every request (path, method, body, headers) behind the mock.
  const inner = globalThis.fetch as unknown as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push({
        path: url.split('?')[0],
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        headers: new Headers(init?.headers),
      })
      return inner(input, init)
    }),
  )
  return render(<App />)
}

const layoutCalls = (method: string) => calls.filter((call) => call.path.endsWith(LAYOUT_PATH) && call.method === method)

/** The Dashboard's panels, in page order, by their accessible names. */
function panelNames(container: HTMLElement) {
  const page = container.querySelector('.dashboard-page') as HTMLElement
  return Array.from(page.querySelectorAll(':scope > section')).map((section) => section.getAttribute('aria-label'))
}

/** Arrange, once the saved arrangement has loaded (the button is off until then). */
async function openArrange(container: HTMLElement) {
  const button = await within(container).findByRole('button', { name: 'Arrange' })
  await waitFor(() => expect(button).toHaveProperty('disabled', false))
  fireEvent.click(button)
}

async function dashboardLoaded(container: HTMLElement) {
  await within(container).findByRole('heading', { name: 'Dashboard', level: 1 })
  await waitFor(() => expect(layoutCalls('GET').length).toBeGreaterThan(0))
}

const OWNER_DEFAULT_ORDER = [
  'Alerts',
  'Your queue',
  'Team',
  'Cases in flight',
  'Recent activity',
  'This month at a glance',
]

beforeEach(() => {
  window.history.pushState({}, '', '/')
  window.localStorage.clear()
  forgetDashboardCollapseMemory()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the owner Dashboard with no saved arrangement', () => {
  it('shows every panel open in the default order, each with a collapse control but Alerts', async () => {
    const { container } = boot(null)
    await dashboardLoaded(container)

    await waitFor(() => expect(panelNames(container)).toEqual(OWNER_DEFAULT_ORDER))
    const alerts = within(container).getByRole('region', { name: 'Alerts' })
    expect(within(alerts).queryByRole('button', { name: /^(Collapse|Expand) / })).toBeNull()
    for (const name of OWNER_DEFAULT_ORDER.slice(1)) {
      const region = within(container).getByRole('region', { name })
      expect(within(region).getByRole('button', { name: `Collapse ${name}` }).getAttribute('aria-expanded')).toBe('true')
    }
    // The section headings are unchanged.
    expect(within(container).getByRole('heading', { name: 'Your queue', level: 2 })).toBeTruthy()
  })
})

describe('a saved arrangement', () => {
  const saved: DashboardLayout = {
    version: 1,
    panels: [
      panel('alerts'),
      panel('kpi', { collapsed: true }),
      panel('activity'),
      panel('queue'),
      panel('cases'),
      panel('team', { hidden: true }),
      panel('skipped'),
      panel('past_due'),
    ] as DashboardLayout['panels'],
  }

  it('reorders, hides and starts collapsed as saved', async () => {
    const { container } = boot(saved)
    await dashboardLoaded(container)

    await waitFor(() =>
      expect(panelNames(container)).toEqual([
        'Alerts',
        'This month at a glance',
        'Recent activity',
        'Your queue',
        'Cases in flight',
      ]),
    )
    expect(within(container).queryByRole('region', { name: 'Team' })).toBeNull()
    const kpi = within(container).getByRole('region', { name: 'This month at a glance' })
    expect(within(kpi).getByRole('button', { name: 'Expand This month at a glance' }).getAttribute('aria-expanded')).toBe(
      'false',
    )
    expect(within(kpi).queryByText('Hours tracked')).toBeNull()
  })

  it('a chevron press opens or closes a panel for this visit and saves nothing', async () => {
    const { container } = boot(saved)
    await dashboardLoaded(container)
    const kpi = await within(container).findByRole('region', { name: 'This month at a glance' })
    await within(kpi).findByRole('button', { name: 'Expand This month at a glance' })

    fireEvent.click(within(kpi).getByRole('button', { name: 'Expand This month at a glance' }))
    expect(within(kpi).getByText('Hours tracked')).toBeTruthy()
    const queue = within(container).getByRole('region', { name: 'Your queue' })
    fireEvent.click(within(queue).getByRole('button', { name: 'Collapse Your queue' }))
    expect(within(queue).getByRole('button', { name: 'Expand Your queue' }).getAttribute('aria-expanded')).toBe('false')

    // Give any stray save a chance to go out.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(layoutCalls('PUT')).toEqual([])
  })

  it('a hidden Invoices past due is never mounted and asks the server for nothing', async () => {
    const hidesPastDue = {
      version: 1,
      panels: [panel('alerts'), panel('past_due', { hidden: true })],
    }
    const { container } = boot(hidesPastDue)
    await dashboardLoaded(container)
    await waitFor(() => expect(panelNames(container)).toEqual(OWNER_DEFAULT_ORDER))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(calls.some((call) => call.path.endsWith('/api/invoices'))).toBe(false)
  })

  it('shown (the default), Invoices past due asks for its invoices once the layout is known', async () => {
    const { container } = boot(null)
    await dashboardLoaded(container)
    await waitFor(() => expect(calls.some((call) => call.path.endsWith('/api/invoices'))).toBe(true))
  })
})

describe('Arrange', () => {
  it('moves a panel down and Done saves the new order in one PUT', async () => {
    const { container } = boot(null)
    await dashboardLoaded(container)
    await waitFor(() => expect(panelNames(container)).toEqual(OWNER_DEFAULT_ORDER))

    await openArrange(container)
    const list = within(container).getByRole('region', { name: 'Arrange your dashboard' })
    // Alerts has no controls: it is always first and always shown.
    const alertsRow = within(list).getByRole('listitem', { name: 'Alerts' })
    expect(within(alertsRow).queryAllByRole('button')).toEqual([])
    // At the top, Up does nothing - and stays focusable (aria-disabled, not disabled).
    const up = within(list).getByRole('button', { name: 'Move Your queue up' })
    expect(up.getAttribute('aria-disabled')).toBe('true')
    expect(up).toHaveProperty('disabled', false)
    up.focus()
    fireEvent.click(up)
    expect(document.activeElement).toBe(up)
    expect(within(list).getAllByRole('listitem').map((row) => row.getAttribute('aria-label')).slice(0, 3)).toEqual([
      'Alerts',
      'Your queue',
      'Team',
    ])

    fireEvent.click(within(list).getByRole('button', { name: 'Move Your queue down' }))
    fireEvent.change(within(list).getByRole('combobox', { name: 'How Recent activity starts' }), {
      target: { value: 'collapsed' },
    })
    fireEvent.click(within(list).getByRole('button', { name: 'Done' }))

    await waitFor(() => expect(panelNames(container)).toEqual([
      'Alerts',
      'Team',
      'Your queue',
      'Cases in flight',
      'Recent activity',
      'This month at a glance',
    ]))
    expect(layoutCalls('PUT')).toHaveLength(1)
    const sent = layoutCalls('PUT')[0].body as { layout: DashboardLayout }
    expect(sent.layout.panels.map((entry) => entry.key)).toEqual([
      'alerts',
      'team',
      'queue',
      'cases',
      'skipped',
      'past_due',
      'activity',
      'kpi',
    ])
    expect(sent.layout.panels.find((entry) => entry.key === 'activity')?.collapsed).toBe(true)
    // The new "starts collapsed" takes effect at once.
    const activity = within(container).getByRole('region', { name: 'Recent activity' })
    expect(within(activity).getByRole('button', { name: 'Expand Recent activity' })).toBeTruthy()
  })

  it('hides a panel', async () => {
    const { container } = boot(null)
    await dashboardLoaded(container)
    await openArrange(container)
    const list = within(container).getByRole('region', { name: 'Arrange your dashboard' })
    fireEvent.click(within(list).getByRole('button', { name: 'Hide Team' }))
    expect(within(list).getByRole('button', { name: 'Show Team' })).toBeTruthy()
    fireEvent.click(within(list).getByRole('button', { name: 'Done' }))

    await waitFor(() => expect(within(container).queryByRole('region', { name: 'Team' })).toBeNull())
    expect(layoutCalls('PUT')).toHaveLength(1)
  })

  it('Reset to default then Done saves the default layout', async () => {
    const saved = {
      version: 1,
      panels: [panel('alerts'), panel('kpi'), panel('team', { hidden: true }), panel('queue', { collapsed: true })],
    }
    const { container } = boot(saved)
    await dashboardLoaded(container)
    await waitFor(() => expect(within(container).queryByRole('region', { name: 'Team' })).toBeNull())

    await openArrange(container)
    const list = within(container).getByRole('region', { name: 'Arrange your dashboard' })
    fireEvent.click(within(list).getByRole('button', { name: 'Reset to default' }))
    fireEvent.click(within(list).getByRole('button', { name: 'Done' }))

    await waitFor(() => expect(panelNames(container)).toEqual(OWNER_DEFAULT_ORDER))
    expect(layoutCalls('PUT')).toHaveLength(1)
    expect((layoutCalls('PUT')[0].body as { layout: DashboardLayout }).layout).toEqual(defaultDashboardLayout('owner'))
  })

  it('Cancel leaves the saved arrangement alone and saves nothing', async () => {
    const { container } = boot(null)
    await dashboardLoaded(container)
    await openArrange(container)
    const list = within(container).getByRole('region', { name: 'Arrange your dashboard' })
    fireEvent.click(within(list).getByRole('button', { name: 'Move Your queue down' }))
    fireEvent.click(within(list).getByRole('button', { name: 'Cancel' }))

    expect(panelNames(container)).toEqual(OWNER_DEFAULT_ORDER)
    expect(layoutCalls('PUT')).toEqual([])
  })
})

describe('preview and staff', () => {
  it('previewing a bookkeeper shows THEIR saved arrangement, read-only', async () => {
    const staffLayout = {
      version: 1,
      panels: [panel('alerts'), panel('my_kpi'), panel('watching', { hidden: true })],
    }
    calls = []
    installFetchMock({
      sessionUser: OWNER_SESSION,
      extraRoutes: [
        (path, method) => {
          if (!path.endsWith(LAYOUT_PATH) || method !== 'GET') return undefined
          return json({ layout: null })
        },
      ],
    })
    const inner = globalThis.fetch as unknown as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        const headers = new Headers(init?.headers)
        calls.push({ path: url.split('?')[0], method: init?.method ?? 'GET', body: undefined, headers })
        // The server scopes this read by X-Preview-As.
        if (url.split('?')[0].endsWith(LAYOUT_PATH) && headers.get('X-Preview-As') === 'emp-jordan') {
          return json({ layout: staffLayout })
        }
        return inner(input, init)
      }),
    )
    const { container } = render(<App />)
    await dashboardLoaded(container)

    const viewAs = await within(container).findByRole('combobox', { name: /Viewing as/ })
    fireEvent.change(viewAs, { target: { value: 'emp-jordan' } })

    await within(container).findByRole('region', { name: 'My queue' })
    await waitFor(() => expect(panelNames(container).slice(0, 2)).toEqual(['Alerts', 'My month at a glance']))
    expect(within(container).queryByRole('region', { name: 'Watching' })).toBeNull()
    expect(within(container).queryByRole('button', { name: 'Arrange' })).toBeNull()
  })

  it('a bookkeeper arranges their own Dashboard', async () => {
    const jordan: SessionUser = {
      id: 'emp-jordan',
      name: 'Jordan Ellis',
      email: 'jordan@example.com',
      role: 'employee',
      staffRole: 'Bookkeeper',
      totpEnabled: true,
    }
    const { container } = boot(null, jordan)
    await dashboardLoaded(container)
    await openArrange(container)
    const list = within(container).getByRole('region', { name: 'Arrange your dashboard' })
    fireEvent.click(within(list).getByRole('button', { name: 'Hide Watching' }))
    fireEvent.click(within(list).getByRole('button', { name: 'Done' }))

    await waitFor(() => expect(within(container).queryByRole('region', { name: 'Watching' })).toBeNull())
    const sent = layoutCalls('PUT')[0].body as { layout: DashboardLayout }
    expect(sent.layout.panels.find((entry) => entry.key === 'watching')?.hidden).toBe(true)
  })
})

describe('the first paint', () => {
  it('uses the arrangement this browser last saw while the server is still answering', async () => {
    window.localStorage.setItem(
      `pbj.dashboardLayout.${OWNER_SESSION.id}`,
      JSON.stringify({ version: 1, panels: [panel('alerts'), panel('kpi'), panel('team', { hidden: true })] }),
    )
    installFetchMock({
      sessionUser: OWNER_SESSION,
      // The layout read never answers: whatever shows came from the hint.
      extraRoutes: [(path) => (path.endsWith(LAYOUT_PATH) ? (new Promise(() => {}) as unknown as Response) : undefined)],
    })
    const { container } = render(<App />)
    await within(container).findByRole('heading', { name: 'Dashboard', level: 1 })

    expect(panelNames(container).slice(0, 2)).toEqual(['Alerts', 'This month at a glance'])
    expect(within(container).queryByRole('region', { name: 'Team' })).toBeNull()
  })
})

describe('Arrange waits for the saved arrangement', () => {
  it('is off ("Loading…") while the server has not answered, even with a hint on hand, then on', async () => {
    window.localStorage.setItem(
      `pbj.dashboardLayout.${OWNER_SESSION.id}`,
      JSON.stringify({ version: 1, panels: [panel('alerts'), panel('kpi')] }),
    )
    let answer: (response: Response) => void = () => {}
    const pending = new Promise<Response>((resolve) => {
      answer = resolve
    })
    installFetchMock({
      sessionUser: OWNER_SESSION,
      extraRoutes: [(path, method) => (path.endsWith(LAYOUT_PATH) && method === 'GET' ? (pending as unknown as Response) : undefined)],
    })
    const { container } = render(<App />)
    const button = await within(container).findByRole('button', { name: 'Arrange' })
    expect(button).toHaveProperty('disabled', true)
    expect(button.getAttribute('title')).toBe('Loading…')
    fireEvent.click(button)
    expect(within(container).queryByRole('region', { name: 'Arrange your dashboard' })).toBeNull()

    // The server's saved arrangement differs from the hint: Arrange starts from IT.
    answer(json({ layout: { version: 1, panels: [panel('alerts'), panel('activity')] } }))
    await waitFor(() => expect(button).toHaveProperty('disabled', false))
    fireEvent.click(button)
    const list = within(container).getByRole('region', { name: 'Arrange your dashboard' })
    expect(within(list).getAllByRole('listitem').map((row) => row.getAttribute('aria-label')).slice(0, 2)).toEqual([
      'Alerts',
      'Recent activity',
    ])
  })

  it('stays off when the arrangement could not be loaded, and says why', async () => {
    installFetchMock({
      sessionUser: OWNER_SESSION,
      extraRoutes: [(path) => (path.endsWith(LAYOUT_PATH) ? json({ error: 'boom' }, 500) : undefined)],
    })
    const { container } = render(<App />)
    await within(container).findByRole('region', { name: 'Your queue' })
    const button = within(container).getByRole('button', { name: 'Arrange' })
    await waitFor(() =>
      expect(button.getAttribute('title')).toBe('Your arrangement could not be loaded. Reload the page to arrange.'),
    )
    expect(button).toHaveProperty('disabled', true)
  })
})

describe('a hidden panel’s own fetch', () => {
  it('Team and This month at a glance hidden: no /api/team and no /api/rate-versions', async () => {
    const { container } = boot({
      version: 1,
      panels: [panel('alerts'), panel('team', { hidden: true }), panel('kpi', { hidden: true })],
    })
    await dashboardLoaded(container)
    await waitFor(() => expect(within(container).queryByRole('region', { name: 'Team' })).toBeNull())
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(calls.some((call) => call.path.endsWith('/api/team'))).toBe(false)
    expect(calls.some((call) => call.path.endsWith('/api/rate-versions'))).toBe(false)
  })

  it('shown (the default), both are fetched', async () => {
    const { container } = boot(null)
    await dashboardLoaded(container)
    await waitFor(() => {
      expect(calls.some((call) => call.path.endsWith('/api/team'))).toBe(true)
      expect(calls.some((call) => call.path.endsWith('/api/rate-versions'))).toBe(true)
    })
  })
})
