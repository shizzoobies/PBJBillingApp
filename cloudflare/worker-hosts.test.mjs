import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HANDOVER, HANDOVER_BOOT_TIMEOUT_MS, LEGACY, RETIRE_GRACE_MS, TICK_FAST_MS, TICK_SLOW_MS } from './rollout.js'

// The arrangement that keeps the app up through a deploy: AppHost (one instance of the app),
// AppRouter (which one is live, and the swaps), and the Worker's routing. worker.test.mjs
// covers the old arrangement.
const legacyFetch = vi.fn()
const legacyRetire = vi.fn(async () => ({ graceful: true }))
const legacyRevive = vi.fn(async () => ({}))
const legacyRestartWith = vi.fn(async () => ({ graceful: true, lastStatus: 'stopped' }))
const legacyProtocol = vi.fn(async () => 2)
vi.mock('@cloudflare/containers', () => ({
  Container: class {
    constructor(ctx, env) {
      this.ctx = ctx
      this.env = env
    }
  },
  getContainer: () => ({ fetch: legacyFetch, retire: legacyRetire, revive: legacyRevive, restartWith: legacyRestartWith, protocol: legacyProtocol }),
}))

const { default: worker, AppHost, AppRouter, targetOf } = await import('./worker.js')

const HOLD = ['node', '/app/lib/container-hold.js']

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

/**
 * A container. Started with the hold command it is in 'hold' mode: only port 8079 answers
 * (/held, and POST /go, which turns it into the app). In 'app' mode port 8080 answers
 * /health with `health`.
 */
function fakeContainer({ image = 'reg/app@sha256:aaaaaaaaaaaa', health = { ok: true, commit: 'abc1234', uptimeSeconds: 3 } } = {}) {
  const container = {
    running: false,
    images: { app: image },
    health,
    mode: 'app',
    holdChecks: { database: 'ok', net: 'skipped' },
    started: [],
    signals: [],
    exitsOnSigterm: true,
    exitNow: () => {},
    portFetch: vi.fn(async (url, init, port = 8080) => {
      if (!container.running) throw new Error('the container is not listening')
      const path = new URL(String(url)).pathname
      if (port === 8079) {
        if (container.mode !== 'hold') throw new Error('the container is not listening')
        if (path === '/held') {
          return Response.json({ held: true, ok: container.holdChecks.database !== 'failed', checks: container.holdChecks, commit: 'new5678' })
        }
        if (path === '/go' && init?.method === 'POST') {
          container.mode = 'app'
          return Response.json({ released: true })
        }
        return Response.json({ error: 'Not found' }, { status: 404 })
      }
      if (container.mode !== 'app') throw new Error('the container is not listening')
      if (path === '/health' && String(url).startsWith('http://app/')) {
        return Response.json(container.health, { status: container.health.ok ? 200 : 503 })
      }
      return new Response('from the app')
    }),
    start: vi.fn((options) => {
      if (container.running) throw new Error('already running')
      container.started.push(options)
      container.mode = options.entrypoint?.some((part) => String(part).includes('container-hold')) ? 'hold' : 'app'
      container.running = true
    }),
    signal: vi.fn((n) => {
      container.signals.push(n)
      if (container.exitsOnSigterm) container.running = false
    }),
    destroy: vi.fn(async () => void (container.running = false)),
    monitor: vi.fn(
      () =>
        new Promise((resolve) => {
          container.exitNow = () => {
            container.running = false
            resolve()
          }
        }),
    ),
    setInactivityTimeout: vi.fn(async () => {}),
    getTcpPort: vi.fn((port) => ({ fetch: (url, init) => container.portFetch(url, init, port) })),
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
  legacyProtocol.mockReset()
  legacyProtocol.mockImplementation(async () => 2)
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

describe('AppHost, held', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  it('begin({ held }) starts the hold, not the app: it is parked when its checks pass, and never ready', async () => {
    const { host, container, storage } = makeHost()
    await host.begin({ held: true })
    expect(container.started).toEqual([
      { image: 'reg/app@sha256:aaaaaaaaaaaa', instance: 'standard-1', enableInternet: true, env: { NODE_ENV: 'production', DATABASE_URL: 'db-url' }, entrypoint: HOLD },
    ])
    expect(storage.map.get('cfg')).toMatchObject({ held: true, released: false })
    await expect(host.describe()).resolves.toMatchObject({
      begun: true,
      held: true,
      parked: true,
      ready: false,
      checks: { database: 'ok', net: 'skipped' },
      commit: 'new5678',
    })
    container.holdChecks = { database: 'failed', net: 'skipped' }
    await expect(host.describe()).resolves.toMatchObject({ parked: false, ready: false, checks: { database: 'failed' } })
  })

  it('is not parked on the look that starts it, or while the hold is not answering yet', async () => {
    const { host, container } = makeHost()
    await host.begin({ held: true })
    container.running = false
    await expect(host.describe()).resolves.toMatchObject({ held: true, parked: false, running: true })
    container.portFetch.mockRejectedValueOnce(new Error('the container is not listening'))
    await expect(host.describe()).resolves.toMatchObject({ parked: false })
    await expect(host.describe()).resolves.toMatchObject({ parked: true })
  })

  it('release() stores the release first, then tells the hold to become the app; again is harmless', async () => {
    const { host, container, storage } = makeHost()
    await host.begin({ held: true })
    await expect(host.release()).resolves.toEqual({ released: true })
    expect(storage.map.get('cfg')).toMatchObject({ held: true, released: true })
    expect(container.mode).toBe('app')
    expect(container.started).toHaveLength(1)
    await expect(host.release()).resolves.toEqual({ released: true })
    await expect(host.describe()).resolves.toMatchObject({ held: false, ready: true, commit: 'abc1234' })
  })

  it('after release every start runs the app: a crash restarts the app, never the hold', async () => {
    const { host, container } = makeHost()
    await host.begin({ held: true })
    await host.release()
    container.exitNow()
    await Promise.resolve()
    await expect(host.describe()).resolves.toMatchObject({ running: true, ready: false })
    expect(container.started).toHaveLength(2)
    expect(container.started[1].entrypoint).toBeUndefined()
    expect(container.mode).toBe('app')
  })

  it('a release whose call to the hold is lost throws, and the next look lets it go', async () => {
    const { host, container } = makeHost()
    await host.begin({ held: true })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    container.portFetch.mockRejectedValueOnce(new Error('Network connection lost'))
    await expect(host.release()).rejects.toThrow('Network connection lost')
    expect(container.mode).toBe('hold')
    // The record already says released, so the look finds the app not answering, the hold
    // still there, and lets it go.
    await expect(host.describe()).resolves.toMatchObject({ held: false, ready: false })
    expect(container.mode).toBe('app')
    await expect(host.describe()).resolves.toMatchObject({ ready: true })
  })

  it('a release that finds the container gone starts the app directly', async () => {
    const { host, container } = makeHost()
    await host.begin({ held: true })
    container.running = false
    await expect(host.release()).resolves.toEqual({ released: true, started: true })
    expect(container.started[1].entrypoint).toBeUndefined()
  })

  it('requests wait on a parked host and go through once it is let go and the app answers', async () => {
    vi.useFakeTimers()
    const { host, container } = makeHost()
    await host.begin({ held: true })
    let answered = null
    const waiting = host.fetch(new Request('https://app.example/api/x', { method: 'POST', body: 'b' })).then((response) => void (answered = response))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(answered).toBeNull()
    await host.release()
    await vi.advanceTimersByTimeAsync(400)
    await waiting
    expect(answered.status).toBe(200)
    await expect(answered.text()).resolves.toBe('from the app')
    // The hold was started once; nothing started it again while the request waited.
    expect(container.started).toHaveLength(1)
  })

  it('a request that began waiting while parked starts the APP if the container dies after release', async () => {
    vi.useFakeTimers()
    const { host, container } = makeHost()
    await host.begin({ held: true })
    const waiting = host.fetch(new Request('https://app.example/api/x'))
    await vi.advanceTimersByTimeAsync(1_000)
    await host.release()
    container.exitNow()
    await vi.advanceTimersByTimeAsync(1_000)
    const response = await waiting
    expect(response.status).toBe(200)
    expect(container.started).toHaveLength(2)
    expect(container.started[1].entrypoint).toBeUndefined()
  })

  it('counts exits since it was let go', async () => {
    const { host, container } = makeHost()
    await host.begin({ held: true })
    await host.release()
    for (let i = 1; i <= 2; i++) {
      container.exitNow()
      await new Promise((resolve) => setTimeout(resolve, 0))
      await expect(host.describe()).resolves.toMatchObject({ exits: i })
    }
  })

  it('stop() keeps the record: it stays stopped, says it is gone, and resume() starts the same image again', async () => {
    const { host, container, storage } = makeHost()
    await host.begin()
    await expect(host.stop()).resolves.toEqual({ graceful: true })
    expect(container.signals).toEqual([15])
    expect(storage.map.get('cfg')).toMatchObject({ image: 'reg/app@sha256:aaaaaaaaaaaa', stopped: true })
    // Neither the router's look nor a late request starts it again.
    await expect(host.describe()).resolves.toMatchObject({ begun: true, stopped: true, running: false, ready: false })
    const response = await host.fetch(new Request('https://app.example/api/x'))
    expect(response.headers.get('x-pbj-host-gone')).toBe('1')
    expect(container.started).toHaveLength(1)
    // Stopping again is harmless.
    await expect(host.stop()).resolves.toEqual({ graceful: true })

    container.images.app = 'reg/app@sha256:bbbbbbbbbbbb'
    await expect(host.resume()).resolves.toEqual({ resumed: true })
    expect(container.started).toHaveLength(2)
    expect(container.started[1].image).toBe('reg/app@sha256:aaaaaaaaaaaa')
    expect(container.started[1].entrypoint).toBeUndefined()
    await expect(host.describe()).resolves.toMatchObject({ ready: true })
    expect(storage.map.get('cfg').stopped).toBe(false)
  })

  it('stop() throws when the app will not leave and cannot be destroyed, and stays marked stopped', async () => {
    vi.useFakeTimers()
    const { host, container, storage } = makeHost()
    await host.begin()
    container.exitsOnSigterm = false
    container.destroy.mockRejectedValueOnce(new Error('destroy exploded'))
    const pending = host.stop()
    const failed = expect(pending).rejects.toThrow('destroy exploded')
    await vi.advanceTimersByTimeAsync(21_000)
    await failed
    expect(storage.map.get('cfg').stopped).toBe(true)
    const again = host.stop()
    await vi.advanceTimersByTimeAsync(21_000)
    await expect(again).resolves.toEqual({ graceful: false })
    expect(container.running).toBe(false)
  })

  it('is parked only with a database behind it, unless the staging copy says it has none', async () => {
    const container = fakeContainer()
    container.holdChecks = { database: 'none', net: 'ok' }
    const { host } = makeHost({ container, env: { NODE_ENV: 'production' } })
    await host.begin({ held: true })
    await expect(host.describe()).resolves.toMatchObject({ parked: false, checks: { database: 'none' } })
    container.holdChecks = { database: 'ok', net: 'skipped' }
    await expect(host.describe()).resolves.toMatchObject({ parked: true })
    // The staging copy has no database and says so.
    const staging = makeHost({ env: { NODE_ENV: 'production', ALLOW_NO_DATABASE: '1' } })
    staging.container.holdChecks = { database: 'none', net: 'ok' }
    await staging.host.begin({ held: true })
    await expect(staging.host.describe()).resolves.toMatchObject({ parked: true })
  })

  it('every waiting request gets its own full wait, and one waiting on a host that stops serving is told it is gone', async () => {
    vi.useFakeTimers()
    const { host } = makeHost()
    await host.begin({ held: true })
    const answers = []
    const ask = () => host.fetch(new Request('https://app.example/api/x')).then((response) => answers.push(response))
    const first = ask()
    await vi.advanceTimersByTimeAsync(80_000)
    const second = ask()
    await vi.advanceTimersByTimeAsync(11_000)
    await first
    // The first gave up after its 90 seconds; the second, 11 seconds in, is still waiting.
    expect(answers).toHaveLength(1)
    expect(answers[0].status).toBe(503)
    expect(answers[0].headers.get('retry-after')).toBe('5')
    await host.retire()
    await vi.advanceTimersByTimeAsync(500)
    await second
    expect(answers[1].status).toBe(503)
    expect(answers[1].headers.get('x-pbj-host-gone')).toBe('1')
  })

  it('peek() says whether a container is running without starting one', async () => {
    const { host, container } = makeHost()
    await expect(host.peek()).resolves.toEqual({ begun: false, running: false })
    await host.begin()
    container.running = false
    await expect(host.peek()).resolves.toEqual({ begun: true, running: false })
    expect(container.started).toHaveLength(1)
  })

  it('a parked host that is retired just leaves', async () => {
    const { host, container, storage } = makeHost()
    await host.begin({ held: true })
    await expect(host.retire()).resolves.toEqual({ graceful: true })
    expect(container.running).toBe(false)
    expect(storage.map.size).toBe(0)
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

/** One look, with the clock moved far enough for the pause before a stop (and a slow stop). */
async function look(router, ms = 1_100) {
  const looking = router.tick()
  await vi.advanceTimersByTimeAsync(ms)
  return looking
}

/** From the old application to the first host: begun held, handed over, done. */
async function cutOver(router) {
  await look(router)
  await look(router)
  await look(router)
}

describe('AppRouter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-12T12:00:00Z'))
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  it('with nothing serving, starts the first host (the app, not the hold) and names it live', async () => {
    const { router, HOST, storage } = makeRouter()
    await expect(router.liveName()).resolves.toBe('app-1')
    expect(HOST.hosts.get('app-1').container.started).toHaveLength(1)
    expect(HOST.hosts.get('app-1').container.started[0].entrypoint).toBeUndefined()
    // The heartbeat is armed from the first request on.
    expect(storage.setAlarm).toHaveBeenCalled()
  })

  it('a deploy: the old app serves until the new instance is parked, is stopped, and only then is the new app let go', async () => {
    const { router, HOST, images } = makeRouter()
    await router.liveName()
    await expect(router.tick()).resolves.toBe(TICK_SLOW_MS)

    // The deploy: the code now wants another image. The new host is started HELD.
    images.app = 'reg/app@sha256:bbbbbbbbbbbb'
    await expect(router.tick()).resolves.toBe(TICK_FAST_MS)
    const old = HOST.hosts.get('app-1')
    const next = HOST.hosts.get('app-2')
    expect(next.container.started[0]).toMatchObject({ image: 'reg/app@sha256:bbbbbbbbbbbb', entrypoint: HOLD })
    expect((await router.status()).next).toMatchObject({ name: 'app-2', held: true })

    // While its checks do not pass, nothing moves and the old app is untouched.
    next.container.holdChecks = { database: 'failed', net: 'skipped' }
    await look(router)
    await expect(router.liveName()).resolves.toBe('app-1')
    expect(old.container.signals).toEqual([])
    expect(next.container.mode).toBe('hold')

    // Parked. The pointer moves, the old app gets SIGTERM while the new one is still held,
    // and only after it has left is the new one let go.
    next.container.holdChecks = { database: 'ok', net: 'skipped' }
    let modeWhenOldStopped = null
    old.container.signal.mockImplementation((n) => {
      modeWhenOldStopped = next.container.mode
      old.container.signals.push(n)
      old.container.running = false
    })
    next.container.health = { ok: false }
    const looking = router.tick()
    await vi.advanceTimersByTimeAsync(500)
    // The pointer has moved already; the old app is not stopped until the pause is over.
    await expect(router.liveName()).resolves.toBe('app-2')
    expect(old.container.signals).toEqual([])
    await vi.advanceTimersByTimeAsync(600)
    await looking
    expect(old.container.signals).toEqual([15])
    expect(modeWhenOldStopped).toBe('hold')
    expect(next.container.mode).toBe('app')
    expect((await router.status()).handover).toMatchObject({ from: 'app-1', to: 'app-2', phase: 'boot' })
    // The old host keeps its record until the new app answers (it is the way back).
    expect(old.storage.map.get('cfg')).toMatchObject({ stopped: true })

    // Still booting: nothing changes.
    await look(router)
    expect((await router.status()).handover).toMatchObject({ phase: 'boot' })

    // The new app answers: done, and the old host is forgotten.
    next.container.health = { ok: true, commit: 'def5678', uptimeSeconds: 4 }
    await look(router)
    const status = await router.status()
    expect(status.handover).toBeNull()
    expect(status.live).toMatchObject({ name: 'app-2', image: 'bbbbbbbbbbbb', ready: true, commit: 'def5678' })
    expect(status.retiring).toEqual([])
    expect(status.history.at(-2)).toMatchObject({ from: 'app-1', to: 'app-2', reason: 'image', style: HANDOVER })
    expect(status.history.at(-1)).toMatchObject({ stopped: 'app-1', graceful: true })
    expect(old.storage.map.size).toBe(0)
    expect(old.container.started).toHaveLength(1)
    await expect(router.tick()).resolves.toBe(TICK_SLOW_MS)
  })

  it('never lets the new app go while the old one could not be stopped', async () => {
    const { router, HOST, images } = makeRouter()
    await router.liveName()
    images.app = 'reg/app@sha256:bbbbbbbbbbbb'
    await router.tick()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const old = HOST.hosts.get('app-1')
    const next = HOST.hosts.get('app-2')
    old.container.exitsOnSigterm = false
    old.container.destroy.mockRejectedValueOnce(new Error('destroy exploded'))
    await look(router, 22_000)
    expect(next.container.mode).toBe('hold')
    expect((await router.status()).handover).toMatchObject({ phase: 'stop' })
    // The next look stops it, and then lets the new app go.
    await look(router, 22_000)
    expect(old.container.running).toBe(false)
    expect(next.container.mode).toBe('app')
    expect((await router.status()).handover).toMatchObject({ phase: 'boot' })
  })

  it('a new app that does not come up is stopped and the old instance is started again on its own image', async () => {
    const { router, HOST, images } = makeRouter()
    await router.liveName()
    images.app = 'reg/app@sha256:bbbbbbbbbbbb'
    await router.tick()
    const old = HOST.hosts.get('app-1')
    const next = HOST.hosts.get('app-2')
    next.container.health = { ok: false }
    await look(router)
    expect((await router.status()).handover).toMatchObject({ phase: 'boot' })
    vi.setSystemTime(Date.now() + HANDOVER_BOOT_TIMEOUT_MS + 1_000)
    await look(router)
    await expect(router.liveName()).resolves.toBe('app-1')
    expect(next.container.running).toBe(false)
    expect(next.storage.map.size).toBe(0)
    expect(old.container.started).toHaveLength(2)
    expect(old.container.started[1]).toMatchObject({ image: 'reg/app@sha256:aaaaaaaaaaaa' })
    expect(old.container.started[1].entrypoint).toBeUndefined()
    const status = await router.status()
    expect(status.handover).toBeNull()
    expect(status.failed).toMatchObject({ name: 'app-2', final: true, why: 'the new app did not come up' })
    // The image that failed is not tried again by itself.
    await look(router)
    await look(router)
    expect((await router.status()).next).toBeNull()
    expect(HOST.hosts.get('app-3')?.container.started ?? []).toEqual([])
    // A new deploy is.
    images.app = 'reg/app@sha256:cccccccccccc'
    await look(router)
    expect(HOST.hosts.get('app-3').container.started[0]).toMatchObject({ image: 'reg/app@sha256:cccccccccccc', entrypoint: HOLD })
  })

  it('while the new instance cannot be stopped and still runs, the old app is NOT started; once nothing runs there it is', async () => {
    const { router, HOST, images } = makeRouter()
    await router.liveName()
    images.app = 'reg/app@sha256:bbbbbbbbbbbb'
    await router.tick()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const old = HOST.hosts.get('app-1')
    const next = HOST.hosts.get('app-2')
    next.container.health = { ok: false }
    await look(router)
    // The new app hangs: it ignores SIGTERM and cannot be destroyed.
    next.container.exitsOnSigterm = false
    next.container.destroy.mockRejectedValue(new Error('destroy exploded'))
    vi.setSystemTime(Date.now() + HANDOVER_BOOT_TIMEOUT_MS + 1_000)
    await look(router, 22_000)
    expect((await router.status()).handover).toMatchObject({ phase: 'undo' })
    vi.setSystemTime(Date.now() + 10 * 60_000)
    await look(router, 22_000)
    expect((await router.status()).handover).toMatchObject({ phase: 'undo' })
    expect(old.container.started).toHaveLength(1)
    expect(old.container.running).toBe(false)
    // It finally dies by itself; forgetting it still fails once more. The old app is started.
    next.container.running = false
    vi.spyOn(next.host, 'retire').mockRejectedValueOnce(new Error('storage exploded'))
    await look(router)
    expect(old.container.started).toHaveLength(2)
    await look(router)
    expect((await router.status()).handover).toBeNull()
    await expect(router.liveName()).resolves.toBe('app-1')
  })

  it('refuses a restart on demand while the newest image is one that did not start', async () => {
    const { router, HOST, images } = makeRouter()
    await router.liveName()
    images.app = 'reg/app@sha256:bbbbbbbbbbbb'
    await router.tick()
    HOST.hosts.get('app-2').container.health = { ok: false }
    await look(router)
    vi.setSystemTime(Date.now() + HANDOVER_BOOT_TIMEOUT_MS + 1_000)
    await look(router)
    await look(router)
    const answer = await router.swap({ envVars: { DATABASE_URL: 'fresh' } })
    expect(answer.swapping).toBe(false)
    expect(answer.refused).toMatch(/did not start/)
    expect((await router.status()).forced).toBeNull()
  })

  it('hands over from the old application: it serves until the host is parked, and is stopped once', async () => {
    const { router, HOST } = makeRouter({ legacy: true })
    await expect(router.liveName()).resolves.toBe(LEGACY)
    await router.tick()
    expect(HOST.hosts.get('app-1').container.started[0].entrypoint).toEqual(HOLD)
    expect(legacyFetch).not.toHaveBeenCalled()
    expect(legacyRetire).not.toHaveBeenCalled()
    await look(router)
    await expect(router.liveName()).resolves.toBe('app-1')
    expect(legacyRetire).toHaveBeenCalledTimes(1)
    expect(HOST.hosts.get('app-1').container.mode).toBe('app')
    await look(router)
    await look(router)
    expect((await router.status()).handover).toBeNull()
    expect(legacyRetire).toHaveBeenCalledTimes(1)
    expect(legacyRevive).not.toHaveBeenCalled()
  })

  it('waits to hand over from the old application until its object runs code that can be stopped and started again', async () => {
    const { router, HOST } = makeRouter({ legacy: true })
    // For minutes after the first deploy the old object may still run the previous code.
    legacyProtocol.mockRejectedValue(new TypeError('The RPC receiver does not implement the method "protocol".'))
    await router.tick()
    await look(router)
    await look(router)
    await expect(router.liveName()).resolves.toBe(LEGACY)
    expect(legacyRetire).not.toHaveBeenCalled()
    expect(HOST.hosts.get('app-1').container.mode).toBe('hold')
    expect((await router.status()).next).toMatchObject({ name: 'app-1', parked: true })
    legacyProtocol.mockImplementation(async () => 2)
    await look(router)
    await expect(router.liveName()).resolves.toBe('app-1')
    expect(legacyRetire).toHaveBeenCalledTimes(1)
  })

  it('starts the old application again when the first host does not come up', async () => {
    const { router, HOST } = makeRouter({ legacy: true })
    await router.tick()
    HOST.hosts.get('app-1').container.health = { ok: false }
    await look(router)
    await expect(router.liveName()).resolves.toBe('app-1')
    vi.setSystemTime(Date.now() + HANDOVER_BOOT_TIMEOUT_MS + 1_000)
    await look(router)
    await expect(router.liveName()).resolves.toBe(LEGACY)
    expect(legacyRevive).toHaveBeenCalledTimes(1)
    expect(HOST.hosts.get('app-1').container.running).toBe(false)
  })

  it('stays on the old application while ROLLOUT_TARGET says legacy', async () => {
    const { router, HOST } = makeRouter({ legacy: true, target: LEGACY })
    await router.tick()
    await router.tick()
    await expect(router.liveName()).resolves.toBe(LEGACY)
    expect(HOST.hosts.size).toBe(0)
  })

  it('goes back to the old application by overlap: it must answer /health before the host is stopped', async () => {
    const { router, HOST, env } = makeRouter({ legacy: true })
    await cutOver(router)
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
    expect(HOST.hosts.get('app-1').container.signals).toEqual([])
    vi.setSystemTime(Date.now() + RETIRE_GRACE_MS)
    await router.tick()
    expect(HOST.hosts.get('app-1').container.signals).toEqual([15])
  })

  it('takes the target from the newest Worker version that pokes it, not from its own (possibly older) env', async () => {
    const { router, HOST } = makeRouter({ legacy: true })
    await cutOver(router)
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

  it('swap() hands over to a fresh host started with the environment handed in, once', async () => {
    const { router, HOST } = makeRouter()
    await router.liveName()
    await router.tick()
    await expect(router.swap({ envVars: { DATABASE_URL: 'fresh' } })).resolves.toEqual({ swapping: true })
    await router.tick()
    expect(HOST.hosts.get('app-2').container.started[0]).toMatchObject({ env: { DATABASE_URL: 'fresh' }, entrypoint: HOLD })
    await look(router)
    await expect(router.liveName()).resolves.toBe('app-2')
    await look(router)
    await look(router)
    expect((await router.status()).handover).toBeNull()
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

  it('a failed stop for good is tried again, and the alarm is always set again even when a look throws', async () => {
    const { router, HOST, env, storage } = makeRouter({ legacy: true })
    await cutOver(router)
    // Back to the old application (overlap): the host is stopped for good after the grace period.
    env.ROLLOUT_TARGET = LEGACY
    legacyFetch.mockImplementation(async () => Response.json({ ok: true, commit: 'old1234' }))
    await router.tick()
    await router.tick()
    await expect(router.liveName()).resolves.toBe(LEGACY)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const old = HOST.hosts.get('app-1')
    old.container.signal.mockImplementation(() => {})
    old.container.destroy.mockRejectedValueOnce(new Error('destroy exploded'))
    vi.setSystemTime(Date.now() + RETIRE_GRACE_MS)
    await look(router, 21_000)
    expect((await router.status()).retiring).toMatchObject([{ name: 'app-1', tries: 1 }])
    // Not yet: the next try waits its turn.
    await router.tick()
    expect((await router.status()).retiring).toMatchObject([{ name: 'app-1', tries: 1 }])
    vi.setSystemTime(Date.now() + 30_000)
    await look(router, 21_000)
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

  it('says so (409) when the router refuses the restart', async () => {
    const { ROUTER, router } = stubRouter(['app-1'])
    router.swap.mockResolvedValueOnce({ swapping: false, refused: 'The newest image did not start.' })
    const env = { ROUTER, HOST: {}, APP: {}, TICK_TOKEN: 'tick-token-value' }
    const response = await worker.fetch(
      new Request('https://app.example/internal/restart', { method: 'POST', headers: { 'x-tick-token': 'tick-token-value' } }),
      env,
      { waitUntil: vi.fn() },
    )
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ restarted: false, error: 'The newest image did not start.' })
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
