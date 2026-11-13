import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LEGACY, RETIRE_GRACE_MS, TICK_FAST_MS, TICK_SLOW_MS } from './rollout.js'

// The zero-downtime arrangement: AppHost (one instance of the app), AppRouter (which one is
// live, and the swaps), and the Worker's routing. worker.test.mjs covers the old arrangement.
const legacyFetch = vi.fn()
const legacyRetire = vi.fn(async () => ({ graceful: true }))
const legacyRevive = vi.fn(async () => ({}))
const legacyRestartWith = vi.fn(async () => ({ graceful: true, lastStatus: 'stopped' }))
vi.mock('@cloudflare/containers', () => ({
  Container: class {
    constructor(ctx, env) {
      this.ctx = ctx
      this.env = env
    }
  },
  getContainer: () => ({ fetch: legacyFetch, retire: legacyRetire, revive: legacyRevive, restartWith: legacyRestartWith }),
}))

const { default: worker, AppHost, AppRouter, targetOf } = await import('./worker.js')

function fakeStorage() {
  const map = new Map()
  let alarm = null
  return {
    map,
    get: vi.fn(async (key) => map.get(key)),
    put: vi.fn(async (key, value) => void map.set(key, structuredClone(value))),
    deleteAll: vi.fn(async () => void map.clear()),
    getAlarm: vi.fn(async () => alarm),
    setAlarm: vi.fn(async (at) => void (alarm = at)),
  }
}

/** A container whose app answers /health with `health` once it is running. */
function fakeContainer({ image = 'reg/app@sha256:aaaaaaaaaaaa', health = { ok: true, commit: 'abc1234', uptimeSeconds: 3 } } = {}) {
  const container = {
    running: false,
    images: { app: image },
    health,
    started: [],
    signals: [],
    exitsOnSigterm: true,
    portFetch: vi.fn(async (url) => {
      if (!container.running) throw new Error('the container is not listening')
      if (String(url).endsWith('/health') && String(url).startsWith('http://app/')) {
        return Response.json(container.health, { status: container.health.ok ? 200 : 503 })
      }
      return new Response('from the app')
    }),
    start: vi.fn((options) => {
      if (container.running) throw new Error('already running')
      container.started.push(options)
      container.running = true
    }),
    signal: vi.fn((n) => {
      container.signals.push(n)
      if (container.exitsOnSigterm) container.running = false
    }),
    destroy: vi.fn(async () => void (container.running = false)),
    monitor: vi.fn(() => new Promise(() => {})),
    setInactivityTimeout: vi.fn(async () => {}),
    getTcpPort: vi.fn(() => ({ fetch: container.portFetch })),
  }
  return container
}

function makeHost({ container = fakeContainer(), env = { NODE_ENV: 'production', DATABASE_URL: 'db-url', NOT_LISTED: 'x' } } = {}) {
  const storage = fakeStorage()
  const host = new AppHost({ storage, container }, env)
  return { host, storage, container }
}

beforeEach(() => {
  legacyFetch.mockReset()
  legacyRetire.mockClear()
  legacyRevive.mockClear()
  legacyRestartWith.mockClear()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('AppHost', () => {
  it('before begin() it runs nothing: it only says which image the code wants', async () => {
    const { host, container } = makeHost()
    await expect(host.describe()).resolves.toMatchObject({ begun: false, image: null, ready: false, wanted: 'reg/app@sha256:aaaaaaaaaaaa' })
    expect(container.start).not.toHaveBeenCalled()
    const response = await host.fetch(new Request('https://app.example/api/x'))
    expect(response.status).toBe(503)
    expect(response.headers.get('x-pbj-host-gone')).toBe('1')
  })

  it('begin() starts the wanted image with only the listed environment, and keeps that image for good', async () => {
    const { host, container, storage } = makeHost()
    await expect(host.begin()).resolves.toEqual({ image: 'reg/app@sha256:aaaaaaaaaaaa' })
    expect(container.started).toEqual([
      { image: 'reg/app@sha256:aaaaaaaaaaaa', instance: 'standard-1', enableInternet: true, env: { NODE_ENV: 'production', DATABASE_URL: 'db-url' } },
    ])
    expect(storage.map.get('cfg').image).toBe('reg/app@sha256:aaaaaaaaaaaa')
    expect(container.setInactivityTimeout).toHaveBeenCalledWith(6 * 60 * 60_000)
    // A deploy changes what the code wants; this host does not move.
    container.images.app = 'reg/app@sha256:bbbbbbbbbbbb'
    await host.begin()
    expect(container.started).toHaveLength(1)
    await expect(host.describe()).resolves.toMatchObject({ image: 'reg/app@sha256:aaaaaaaaaaaa', wanted: 'reg/app@sha256:bbbbbbbbbbbb', ready: true, commit: 'abc1234' })
  })

  it('uses the environment the router hands in, and refuses a name that is not listed', async () => {
    const { host, container } = makeHost()
    await expect(host.begin({ envVars: { NOT_LISTED: 'x' } })).rejects.toThrow('not in CONTAINER_ENV_NAMES')
    await host.begin({ envVars: { DATABASE_URL: 'fresh' } })
    expect(container.started.at(-1).env).toEqual({ DATABASE_URL: 'fresh' })
  })

  it('describe() starts a begun host that is not running (supervision) and reports it not ready yet', async () => {
    const { host, container } = makeHost()
    await host.begin()
    container.running = false
    await expect(host.describe()).resolves.toMatchObject({ begun: true, running: true, ready: false })
    expect(container.started).toHaveLength(2)
    await expect(host.describe()).resolves.toMatchObject({ ready: true })
  })

  it('is not ready while the app answers /health badly', async () => {
    const { host } = makeHost({ container: fakeContainer({ health: { ok: false, db: 'unreachable' } }) })
    await host.begin()
    await expect(host.describe()).resolves.toMatchObject({ begun: true, ready: false })
  })

  it('forwards the same request (method, path, body bytes) to the app over plain http', async () => {
    const { host, container } = makeHost()
    await host.begin()
    const request = new Request('https://app.example/api/stripe/webhook?x=1', { method: 'POST', body: '{"a":1}', headers: { 'stripe-signature': 't=1' } })
    const response = await host.fetch(request)
    await expect(response.text()).resolves.toBe('from the app')
    const [url, forwarded] = container.portFetch.mock.calls.at(-1)
    expect(url).toBe('http://app.example/api/stripe/webhook?x=1')
    expect(forwarded).toBe(request)
  })

  it('answers 503 with retry-after, not an exception, when the app cannot be reached', async () => {
    const { host, container } = makeHost()
    await host.begin()
    await host.describe()
    container.portFetch.mockRejectedValueOnce(new Error('Network connection lost'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = await host.fetch(new Request('https://app.example/api/x'))
    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('2')
    expect(response.headers.has('x-pbj-host-gone')).toBe(false)
  })

  it('retire() sends SIGTERM, forgets everything, and from then on says it is gone', async () => {
    const { host, container, storage } = makeHost()
    await host.begin()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await expect(host.retire()).resolves.toEqual({ graceful: true })
    expect(container.signals).toEqual([15])
    expect(container.destroy).not.toHaveBeenCalled()
    expect(storage.map.size).toBe(0)
    const response = await host.fetch(new Request('https://app.example/'))
    expect(response.headers.get('x-pbj-host-gone')).toBe('1')
    await expect(host.describe()).resolves.toMatchObject({ begun: false })
    expect(container.started).toHaveLength(1)
  })

  it('retire() destroys an app that ignores SIGTERM after the wait', async () => {
    vi.useFakeTimers()
    const { host, container } = makeHost()
    await host.begin()
    container.exitsOnSigterm = false
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const pending = host.retire()
    await vi.advanceTimersByTimeAsync(21_000)
    await expect(pending).resolves.toEqual({ graceful: false })
    expect(container.destroy).toHaveBeenCalledTimes(1)
  })
})

/** A HOST namespace of real AppHost objects on fake containers, all wanting `images.app`. */
function fakeHosts(images) {
  const hosts = new Map()
  return {
    hosts,
    idFromName: (name) => name,
    get: (name) => {
      if (!hosts.has(name)) {
        const container = fakeContainer()
        container.images = images
        hosts.set(name, { ...makeHost({ container }), name })
      }
      return hosts.get(name).host
    },
  }
}

function makeRouter({ legacy = false, target } = {}) {
  const images = { app: 'reg/app@sha256:aaaaaaaaaaaa' }
  const HOST = fakeHosts(images)
  const storage = fakeStorage()
  const env = { HOST, ...(legacy ? { APP: {} } : {}), ...(target ? { ROLLOUT_TARGET: target } : {}) }
  const router = new AppRouter({ storage }, env)
  return { router, storage, HOST, images, env }
}

describe('AppRouter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-12T12:00:00Z'))
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  it('with nothing serving, starts the first host and names it live', async () => {
    const { router, HOST, storage } = makeRouter()
    await expect(router.liveName()).resolves.toBe('app-1')
    expect(HOST.hosts.get('app-1').container.started).toHaveLength(1)
    // The heartbeat is armed from the first request on.
    expect(storage.setAlarm).toHaveBeenCalled()
  })

  it('a deploy: the old host serves until the new one answers, then is stopped after the grace period', async () => {
    const { router, HOST, images } = makeRouter()
    await router.liveName()
    await expect(router.tick()).resolves.toBe(TICK_SLOW_MS)

    // The deploy: the code now wants another image. The new host's app is not up yet.
    images.app = 'reg/app@sha256:bbbbbbbbbbbb'
    await expect(router.tick()).resolves.toBe(TICK_FAST_MS)
    const next = HOST.hosts.get('app-2')
    expect(next.container.started[0].image).toBe('reg/app@sha256:bbbbbbbbbbbb')
    next.container.health = { ok: false }
    await router.tick()
    await expect(router.liveName()).resolves.toBe('app-1')
    expect(HOST.hosts.get('app-1').container.running).toBe(true)

    // It answers: the pointer moves, and the old host is still running.
    next.container.health = { ok: true, commit: 'def5678', uptimeSeconds: 4 }
    await router.tick()
    await expect(router.liveName()).resolves.toBe('app-2')
    expect(HOST.hosts.get('app-1').container.signals).toEqual([])

    // After the grace period it is asked to stop, and forgotten.
    vi.setSystemTime(Date.now() + RETIRE_GRACE_MS)
    await router.tick()
    expect(HOST.hosts.get('app-1').container.signals).toEqual([15])
    const status = await router.status()
    expect(status.live).toMatchObject({ name: 'app-2', image: 'bbbbbbbbbbbb', ready: true, commit: 'def5678' })
    expect(status.retiring).toEqual([])
    expect(status.history.at(-2)).toMatchObject({ from: 'app-1', to: 'app-2', reason: 'image' })
    expect(status.history.at(-1)).toMatchObject({ stopped: 'app-1', graceful: true })
    await expect(router.tick()).resolves.toBe(TICK_SLOW_MS)
  })

  it('cuts over from the old application without poking it, and stops it only after the host answers', async () => {
    const { router, HOST } = makeRouter({ legacy: true })
    await expect(router.liveName()).resolves.toBe(LEGACY)
    await router.tick()
    expect(HOST.hosts.get('app-1').container.started).toHaveLength(1)
    expect(legacyFetch).not.toHaveBeenCalled()
    await router.tick()
    await expect(router.liveName()).resolves.toBe('app-1')
    expect(legacyRetire).not.toHaveBeenCalled()
    vi.setSystemTime(Date.now() + RETIRE_GRACE_MS)
    await router.tick()
    expect(legacyRetire).toHaveBeenCalledTimes(1)
  })

  it('stays on the old application while ROLLOUT_TARGET says legacy', async () => {
    const { router, HOST } = makeRouter({ legacy: true, target: LEGACY })
    await router.tick()
    await router.tick()
    await expect(router.liveName()).resolves.toBe(LEGACY)
    expect(HOST.hosts.size).toBe(0)
  })

  it('goes back to the old application: it must answer /health before the host is stopped', async () => {
    const { router, HOST, env } = makeRouter({ legacy: true })
    await router.tick()
    await router.tick()
    await expect(router.liveName()).resolves.toBe('app-1')
    env.ROLLOUT_TARGET = LEGACY
    legacyFetch.mockResolvedValue(Response.json({ ok: false }, { status: 503 }))
    await router.tick()
    // The mark that keeps the old container stopped is cleared before it is asked anything.
    expect(legacyRevive).toHaveBeenCalledTimes(1)
    await router.tick()
    await expect(router.liveName()).resolves.toBe('app-1')
    legacyFetch.mockImplementation(async () => Response.json({ ok: true, commit: 'old1234' }))
    await router.tick()
    await expect(router.liveName()).resolves.toBe(LEGACY)
    vi.setSystemTime(Date.now() + RETIRE_GRACE_MS)
    await router.tick()
    expect(HOST.hosts.get('app-1').container.signals).toEqual([15])
  })

  it('takes the target from the newest Worker version that pokes it, not from its own (possibly older) env', async () => {
    const { router, HOST } = makeRouter({ legacy: true })
    await router.tick()
    await router.tick()
    await expect(router.liveName()).resolves.toBe('app-1')
    // A new version says legacy; this object's own env still says hosts.
    legacyFetch.mockImplementation(async () => Response.json({ ok: true, commit: 'old1234' }))
    await router.poke({ target: LEGACY, stamp: 2_000 })
    await router.tick()
    await router.tick()
    await expect(router.liveName()).resolves.toBe(LEGACY)
    // A straggling isolate of the older version cannot turn it back.
    await router.poke({ target: 'hosts', stamp: 1_000 })
    expect((await router.status()).target).toBe(LEGACY)
    await router.poke({ target: 'hosts', stamp: 3_000 })
    expect((await router.status()).target).toBe('hosts')
    expect(HOST.hosts.get('app-1').container.signals.length).toBeLessThanOrEqual(1)
  })

  it('targetOf reads the var and the version time, and defaults to hosts', () => {
    expect(targetOf({})).toEqual({ target: 'hosts', stamp: 0 })
    expect(targetOf({ ROLLOUT_TARGET: LEGACY, CF_VERSION: { timestamp: '2026-11-13T00:00:00.000Z' } })).toEqual({
      target: LEGACY,
      stamp: Date.parse('2026-11-13T00:00:00.000Z'),
    })
  })

  it('swap() restarts onto a fresh host with the environment handed in, once', async () => {
    const { router, HOST } = makeRouter()
    await router.liveName()
    await router.tick()
    await expect(router.swap({ envVars: { DATABASE_URL: 'fresh' } })).resolves.toEqual({ swapping: true })
    await router.tick()
    expect(HOST.hosts.get('app-2').container.started[0].env).toEqual({ DATABASE_URL: 'fresh' })
    await router.tick()
    await expect(router.liveName()).resolves.toBe('app-2')
    await router.tick()
    // app-3 exists only as the object the router asks "which image does the code want"; it runs nothing.
    expect(HOST.hosts.get('app-3')?.container.started ?? []).toEqual([])
    await expect(router.swap({ envVars: { NOT_LISTED: 'x' } })).rejects.toThrow('not in CONTAINER_ENV_NAMES')
  })

  it('a restart asked for while the router is busy looking is not lost', async () => {
    const { router, HOST } = makeRouter()
    await router.liveName()
    await router.tick()
    // Hold the live host's answer open, as a slow health call would.
    const live = HOST.hosts.get('app-1').host
    let release
    const held = new Promise((resolve) => void (release = resolve))
    const describe = live.describe.bind(live)
    vi.spyOn(live, 'describe').mockImplementationOnce(async () => {
      await held
      return describe()
    })
    const looking = router.tick()
    await vi.advanceTimersByTimeAsync(10)
    await router.swap({ envVars: { DATABASE_URL: 'fresh' } })
    release()
    await looking
    expect(HOST.hosts.get('app-2').container.started[0].env).toEqual({ DATABASE_URL: 'fresh' })
    expect((await router.status()).next).toMatchObject({ name: 'app-2', reason: 'restart' })
  })

  it('a failed stop is tried again, and the alarm is always set again even when a look throws', async () => {
    const { router, HOST, images, storage } = makeRouter()
    await router.liveName()
    images.app = 'reg/app@sha256:bbbbbbbbbbbb'
    await router.tick()
    await router.tick()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const old = HOST.hosts.get('app-1')
    old.container.signal.mockImplementation(() => {})
    old.container.destroy.mockRejectedValueOnce(new Error('destroy exploded'))
    vi.setSystemTime(Date.now() + RETIRE_GRACE_MS)
    const first = router.tick()
    await vi.advanceTimersByTimeAsync(21_000)
    await first
    expect((await router.status()).retiring).toMatchObject([{ name: 'app-1', tries: 1 }])
    // Not yet: the next try waits its turn.
    await router.tick()
    expect((await router.status()).retiring).toMatchObject([{ name: 'app-1', tries: 1 }])
    vi.setSystemTime(Date.now() + 30_000)
    const second = router.tick()
    await vi.advanceTimersByTimeAsync(21_000)
    await second
    expect((await router.status()).retiring).toEqual([])

    storage.setAlarm.mockClear()
    vi.spyOn(router, 'tick').mockRejectedValueOnce(new Error('look exploded'))
    await router.alarm()
    expect(storage.setAlarm).toHaveBeenCalledWith(Date.now() + TICK_SLOW_MS)
  })
})

describe('the Worker with a router', () => {
  const stubRouter = (names) => {
    const queue = [...names]
    const router = {
      liveName: vi.fn(async () => (queue.length > 1 ? queue.shift() : queue[0])),
      poke: vi.fn(async () => {}),
      status: vi.fn(async () => ({ live: { name: queue[0] } })),
      swap: vi.fn(async () => ({ swapping: true })),
    }
    return { router, ROUTER: { idFromName: (name) => name, get: () => router } }
  }
  const stubHosts = (answers) => {
    const fetches = []
    return {
      fetches,
      HOST: {
        idFromName: (name) => name,
        get: (name) => ({
          fetch: async (request) => {
            fetches.push({ name, request })
            const answer = answers[name]
            if (answer instanceof Error) throw answer
            return typeof answer === 'function' ? answer() : answer
          },
        }),
      },
    }
  }
  const gone = () => Response.json({ error: 'gone' }, { status: 503, headers: { 'x-pbj-host-gone': '1' } })

  it('sends the request to the host the router names, with the forwarded-for header replaced', async () => {
    const { ROUTER } = stubRouter(['app-4'])
    const { HOST, fetches } = stubHosts({ 'app-4': new Response('ok') })
    const waitUntil = vi.fn()
    const request = new Request('https://app.example/api/x', { method: 'POST', body: 'b', headers: { 'x-forwarded-for': '198.51.100.1', 'cf-connecting-ip': '203.0.113.9' } })
    const response = await worker.fetch(request, { ROUTER, HOST, APP: {} }, { waitUntil })
    await expect(response.text()).resolves.toBe('ok')
    expect(fetches).toHaveLength(1)
    expect(fetches[0].name).toBe('app-4')
    expect(fetches[0].request.headers.get('x-forwarded-for')).toBe('203.0.113.9')
    await expect(fetches[0].request.text()).resolves.toBe('b')
  })

  it('uses the old application while the router says legacy', async () => {
    const { ROUTER } = stubRouter([LEGACY])
    legacyFetch.mockResolvedValue(new Response('old'))
    const response = await worker.fetch(new Request('https://app.example/'), { ROUTER, HOST: {}, APP: {} }, { waitUntil: vi.fn() })
    await expect(response.text()).resolves.toBe('old')
  })

  it('asks the router again when a GET lands on a host that has just stopped serving', async () => {
    const { ROUTER, router } = stubRouter(['app-1', 'app-2'])
    const { HOST, fetches } = stubHosts({ 'app-1': gone, 'app-2': new Response('new') })
    const response = await worker.fetch(new Request('https://app.example/api/x'), { ROUTER, HOST, APP: {} }, { waitUntil: vi.fn() })
    await expect(response.text()).resolves.toBe('new')
    expect(fetches.map((f) => f.name)).toEqual(['app-1', 'app-2'])
    expect(router.liveName).toHaveBeenCalledTimes(2)
  })

  it('never sends a request with a body twice', async () => {
    const { ROUTER } = stubRouter(['app-1', 'app-2'])
    const { HOST, fetches } = stubHosts({ 'app-1': gone, 'app-2': new Response('new') })
    const response = await worker.fetch(new Request('https://app.example/api/x', { method: 'POST', body: 'b' }), { ROUTER, HOST, APP: {} }, { waitUntil: vi.fn() })
    expect(response.status).toBe(503)
    expect(fetches).toHaveLength(1)
  })

  it('answers 503 with retry-after when the live host cannot be reached at all', async () => {
    const { ROUTER } = stubRouter(['app-1'])
    const { HOST } = stubHosts({ 'app-1': new Error('Durable Object reset because its code was updated.') })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = await worker.fetch(new Request('https://app.example/api/x'), { ROUTER, HOST, APP: {} }, { waitUntil: vi.fn() })
    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('2')
  })

  it('shows the rollout status only with the token, unless the staging flag opens it', async () => {
    const { ROUTER, router } = stubRouter(['app-1'])
    const env = { ROUTER, HOST: {}, APP: {}, TICK_TOKEN: 'tick-token-value' }
    const ask = (headers, extra = {}) => worker.fetch(new Request('https://app.example/internal/rollout', { headers }), { ...env, ...extra }, { waitUntil: vi.fn() })
    expect((await ask({})).status).toBe(401)
    expect((await ask({ 'x-tick-token': 'tick-token-value' })).status).toBe(200)
    expect((await ask({}, { TICK_TOKEN: undefined })).status).toBe(404)
    expect((await ask({}, { TICK_TOKEN: undefined, ROLLOUT_STATUS_PUBLIC: '1' })).status).toBe(200)
    // The flag never opens a Worker that has a token.
    expect((await ask({}, { ROLLOUT_STATUS_PUBLIC: '1' })).status).toBe(401)
    expect(router.status).toHaveBeenCalledTimes(2)
  })

  it('a restart on a host is a swap with the Worker env, not a stop', async () => {
    const { ROUTER, router } = stubRouter(['app-1'])
    const env = { ROUTER, HOST: {}, APP: {}, TICK_TOKEN: 'tick-token-value', DATABASE_URL: 'db', NOT_LISTED: 'x' }
    const response = await worker.fetch(
      new Request('https://app.example/internal/restart', { method: 'POST', headers: { 'x-tick-token': 'tick-token-value' } }),
      env,
      { waitUntil: vi.fn() },
    )
    await expect(response.json()).resolves.toEqual({ restarted: true, graceful: true, lastStatus: 'swapping', swapping: true })
    expect(router.swap).toHaveBeenCalledWith({ envVars: { DATABASE_URL: 'db', TICK_TOKEN: 'tick-token-value' }, reason: 'restart' })
    expect(legacyRestartWith).not.toHaveBeenCalled()
  })

  it('the cron tick goes to the live host', async () => {
    const { ROUTER } = stubRouter(['app-2'])
    const { HOST, fetches } = stubHosts({ 'app-2': new Response('{}') })
    let pending
    worker.scheduled({}, { ROUTER, HOST, APP: {}, TICK_TOKEN: 'tick-token-value' }, { waitUntil: (p) => void (pending = p) })
    await pending
    expect(fetches[0].name).toBe('app-2')
    expect(fetches[0].request.url).toBe('http://app/internal/tick')
    expect(fetches[0].request.method).toBe('POST')
    expect(fetches[0].request.headers.get('x-tick-token')).toBe('tick-token-value')
  })
})
