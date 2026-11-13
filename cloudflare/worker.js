// The Cloudflare front door for PBJBillingApp. See docs/cloudflare.md and
// docs/plans/zero-downtime-deploy-2026-11.md.
//
// Every request goes to the ONE live instance of the app (the repo Dockerfile image).
// A deploy does not stop that instance while Cloudflare brings the new image up. Instead a
// router (AppRouter) starts a second instance (an AppHost) on the new image beside it, HELD:
// its container is up but the app is not started (lib/container-hold.js). When it is parked
// the router moves the pointer to it (requests wait there), stops the old app, and only then
// lets the new app start, so two copies of the app never run against the database at once.
// The rules are in cloudflare/rollout.js.
//
// AppContainer is the OLD arrangement (one container on Cloudflare's default scheduling
// policy, where a deploy stops the container before starting the new one). It stays until
// the cutover has been observed, as the instance named "legacy" and as the way back.
//
// This file is bundled by wrangler (see wrangler.jsonc); it is not part of the
// container image. https://developers.cloudflare.com/containers/
import { DurableObject } from 'cloudflare:workers'
import { Container, getContainer } from '@cloudflare/containers'
import { CONTAINER_ENV_NAMES } from './env-names.js'
import { LEGACY, PROTOCOL, TICK_SLOW_MS, force, handoverStep, hostName, initialState, plan, retireFailed, retired } from './rollout.js'

/** How often a request re-checks that the router's heartbeat alarm is still set. */
const ARM_CHECK_MS = 60_000

export { CONTAINER_ENV_NAMES }

/** Copy exactly the listed names that are defined on `env`; never invent one. */
export function pickContainerEnv(env) {
  const picked = {}
  for (const name of CONTAINER_ENV_NAMES) {
    const value = env?.[name]
    if (value !== undefined && value !== null) picked[name] = String(value)
  }
  return picked
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// How long a stop waits for the app to exit on SIGTERM before it is killed. The app's own
// shutdown gives in-flight requests 10 seconds (server.js SHUTDOWN_BACKSTOP_MS).
const GRACEFUL_STOP_MS = 20_000
const STOP_POLL_MS = 500
const STOPPED_STATES = new Set(['stopped', 'stopped_with_code'])

// server.js listens on PORT, which the Dockerfile sets to 8080.
const APP_PORT = 8080
// The same size as the old application's instance_type.
const HOST_INSTANCE = 'standard-1'
// The longest Cloudflare allows. The router looks at the live host every 30 seconds, which
// keeps it active, so this only matters if the router itself is down for hours.
const HOST_INACTIVITY_MS = 6 * 60 * 60_000
const HEALTH_TIMEOUT_MS = 4_000
// A request that arrives while the only instance is still starting waits this long for it.
const COLD_WAIT_MS = 90_000
const COLD_POLL_MS = 300
/** Marks an answer from a host that no longer serves, so the Worker can ask the router again. */
const GONE_HEADER = 'x-pbj-host-gone'

// A held instance runs this instead of the app, and listens here until it is let go
// (lib/container-hold.js; the Dockerfile copies lib/ to /app/lib).
const HOLD_PORT = 8079
const HOLD_COMMAND = ['node', '/app/lib/container-hold.js']
// Between moving the pointer and stopping the old app: requests that were already on their
// way to the old instance arrive, and its own shutdown lets them finish.
const SETTLE_MS = 1_000
// How long after letting an instance go the host keeps checking that the hold really let go.
const NUDGE_FOR_MS = 5 * 60_000

/**
 * REHEARSAL ONLY (the staging Worker sets these vars; production never does). Read once, when
 * an instance is begun, and kept in its record, so an older instance is never affected.
 *   REHEARSAL_START_DELAY_SECONDS  make the new instance slow to come up, the way
 *     production's are while Cloudflare brings the image to the machine.
 *   REHEARSAL_BOOT_FAIL=1  make the new app fail to start, to practice the way back.
 */
function rehearsalOf(env) {
  const seconds = Number(env?.REHEARSAL_START_DELAY_SECONDS)
  const delay = Number.isInteger(seconds) && seconds > 0 && seconds <= 3600 ? seconds : 0
  const fail = env?.REHEARSAL_BOOT_FAIL === '1'
  return delay || fail ? { delay, fail } : null
}

/** The command a start runs: null for the image's own (the app), the hold while parked. */
function commandFor(cfg) {
  const parked = Boolean(cfg.held && !cfg.released)
  let command = parked ? HOLD_COMMAND : null
  const rehearsal = cfg.rehearsal
  if (rehearsal?.fail) command = parked ? [...HOLD_COMMAND, '/app/no-such-app.js'] : ['node', '/app/no-such-app.js']
  if (rehearsal?.delay && !cfg.released) {
    command = ['sh', '-c', 'sleep ' + rehearsal.delay + '; exec ' + (command ?? ['node', 'server.js']).join(' ')]
  }
  return command
}

const NAME_SET = new Set(CONTAINER_ENV_NAMES)

/** Throws (message without values) unless `value` is a plain object of listed names with string values. */
function assertContainerEnv(value) {
  const plain = value !== null && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  if (!plain) throw new Error('restartWith needs a plain object of environment values')
  for (const [name, entry] of Object.entries(value)) {
    if (!NAME_SET.has(name)) throw new Error('restartWith: a name is not in CONTAINER_ENV_NAMES')
    if (typeof entry !== 'string') throw new Error('restartWith: every value must be a string')
  }
}

const json = (status, body, headers) => Response.json(body, { status, headers })

// ---------------------------------------------------------------------------------------
// The old arrangement (kept until the cutover has been observed).
// ---------------------------------------------------------------------------------------
export class AppContainer extends Container {
  defaultPort = APP_PORT
  // Idle time before the platform may put the container to sleep. Overridden below so
  // it never does, but a long value keeps the default sane if that override is removed.
  sleepAfter = '2h'

  constructor(ctx, env) {
    super(ctx, env)
    // Applied at every container start. https://developers.cloudflare.com/containers/container-package/
    this.envVars = pickContainerEnv(env)
  }

  // The default stops the container when sleepAfter passes with no requests. The app has
  // in-process state (rate-limit buckets, open SSE streams) and its own hourly jobs, so we
  // renew instead of stopping; the platform may still restart it at any time (SIGTERM,
  // then SIGKILL after 15 minutes), which the app already survives.
  // https://developers.cloudflare.com/containers/container-package/ (onActivityExpired:
  // "If you override it, you must call stop() or destroy() or the container won't sleep" -
  // not sleeping is the point here.)
  async onActivityExpired() {
    // Once the router has moved traffic to a host, this container was stopped on purpose and
    // must stay stopped; with nothing running there is nothing to renew.
    if (this.retired === true || this.ctx.container?.running === false) return
    this.renewActivityTimeout()
  }

  /** SIGTERM, wait up to GRACEFUL_STOP_MS for the app to leave, then destroy() either way. */
  async stopAndDestroy() {
    let graceful = false
    let lastStatus = null
    try {
      await this.stop('SIGTERM')
      const deadline = Date.now() + GRACEFUL_STOP_MS
      for (;;) {
        const state = await this.getState()
        lastStatus = state?.status ?? null
        if (STOPPED_STATES.has(lastStatus) || this.container?.running === false) {
          graceful = true
          break
        }
        if (Date.now() >= deadline) break
        await sleep(STOP_POLL_MS)
      }
    } catch (error) {
      console.error('[restart] graceful stop failed', error?.message)
    }
    try {
      await this.destroy()
    } catch (error) {
      console.error('[restart] destroy failed', error?.message)
      throw error
    }
    return { graceful, lastStatus }
  }

  /**
   * Restart the container on the environment the CALLER holds. The Durable Object isolate that
   * owns the container can be older than the Worker version (a secret upload does not replace
   * it promptly), so `this.envVars` from the constructor can be stale; the stateless Worker
   * always has the current env and hands it in here. The package reads `envVars` when it
   * starts the container, so a value set right before destroy() is what the next start uses.
   * The values travel over the Durable Object RPC inside this one Worker, never the network.
   *
   * Resolves to { graceful, lastStatus }; throws if destroy() fails. The next request starts
   * the container again.
   */
  async restartWith(envVars) {
    assertContainerEnv(envVars)
    this.envVars = { ...envVars }
    const { graceful, lastStatus } = await this.stopAndDestroy()
    console.log('[restart] graceful=' + graceful + ' lastStatus=' + lastStatus)
    return { graceful, lastStatus }
  }

  /** Which hand-over calls this object answers (see PROTOCOL in rollout.js). */
  async protocol() {
    return PROTOCOL
  }

  async isRetired() {
    if (this.retired === undefined) this.retired = (await this.ctx.storage.get('retiredByRouter')) === true
    return this.retired
  }

  /**
   * The router moved traffic to a host: stop this container and leave it stopped. The mark
   * is stored first, because the package starts the container on ANY fetch: without it a
   * late request (or a Worker version from before the router) would wake a second copy of
   * the app that nothing would ever stop.
   */
  async retire() {
    this.retired = true
    await this.ctx.storage.put('retiredByRouter', true)
    const { graceful, lastStatus } = await this.stopAndDestroy()
    console.log('[legacy] retired graceful=' + graceful + ' lastStatus=' + lastStatus)
    return { graceful }
  }

  /** The way back: the router wants this container to serve again. */
  async revive() {
    this.retired = false
    await this.ctx.storage.delete('retiredByRouter')
    return {}
  }

  async fetch(request) {
    if (await this.isRetired()) {
      return json(503, { error: 'This instance no longer serves. Try again.' }, { [GONE_HEADER]: '1', 'retry-after': '1' })
    }
    return super.fetch(request)
  }
}

// ---------------------------------------------------------------------------------------
// One instance of the app on the durable_object scheduling policy: this object's own code
// chooses the image, so a deploy never restarts it.
// https://developers.cloudflare.com/containers/configuration/scheduling-policy/
// https://developers.cloudflare.com/containers/api/durable-object-container/
// ---------------------------------------------------------------------------------------
export class AppHost extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    /**
     * { image, begunAt, held, released, releasedAt, stopped } once begin() has run; null
     * before that and after retire(). held: it was started parked (the hold, not the app);
     * released: it has been let go, so every start from then on runs the app; stopped: its
     * app was stopped on purpose and must stay stopped until resume().
     */
    this.cfg = undefined
    /** Environment handed in by the router for this start (a restart after a secret upload). */
    this.envOverride = null
    this.ready = false
    this.readying = null
    this.retiring = false
    this.stopping = false
    this.watching = null
    /** How many times the container has exited since this instance was let go. */
    this.exits = 0
    // "A Durable Object that restarts, for example after a deploy, starts without [a timeout]."
    if (ctx.container?.running) this.keepAwake()
  }

  async loadCfg() {
    if (this.cfg === undefined) this.cfg = (await this.ctx.storage.get('cfg')) ?? null
    return this.cfg
  }

  /** Keep the container through idle stretches, and notice when it exits. */
  keepAwake() {
    const container = this.ctx.container
    Promise.resolve()
      .then(() => container.setInactivityTimeout(HOST_INACTIVITY_MS))
      .catch((error) => console.error('[host] setInactivityTimeout failed', error?.message))
    if (this.watching) return
    const watching = Promise.resolve()
      .then(() => container.monitor())
      .then(() => console.log('[host] container exited'))
      .catch((error) => console.error('[host] container stopped:', error?.message ?? error))
      .finally(() => {
        this.ready = false
        this.exits += 1
        if (this.watching === watching) this.watching = null
      })
    this.watching = watching
  }

  /**
   * Start the container on this host's image unless it is running or was stopped on purpose.
   * True when it started one. Always from the CURRENT record: a request that began waiting
   * while the instance was parked must not start the hold again after it was let go.
   */
  startIfNeeded() {
    const cfg = this.cfg
    const container = this.ctx.container
    if (!cfg || cfg.stopped || container.running || this.retiring || this.stopping) return false
    const entrypoint = commandFor(cfg)
    try {
      container.start({
        image: cfg.image,
        instance: HOST_INSTANCE,
        // The app talks straight to Postgres, Stripe, Resend and the rest, as it did before.
        enableInternet: true,
        env: this.envOverride ?? pickContainerEnv(this.env),
        ...(entrypoint ? { entrypoint } : {}),
      })
    } catch (error) {
      // "Throws Error if already running": a second caller got here first.
      if (container.running) return false
      throw error
    }
    this.ready = false
    this.keepAwake()
    return true
  }

  /** Ask the app itself whether it can serve. */
  async probe() {
    try {
      const response = await this.ctx.container
        .getTcpPort(APP_PORT)
        .fetch('http://app/health', { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
      const body = await response.json().catch(() => null)
      return {
        ok: response.status === 200 && body?.ok === true,
        status: response.status,
        commit: typeof body?.commit === 'string' ? body.commit : null,
        uptimeSeconds: Number.isFinite(body?.uptimeSeconds) ? body.uptimeSeconds : null,
      }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error).slice(0, 160) }
    }
  }

  /** Ask a parked instance's hold whether it is there and its checks pass. */
  async probeHold() {
    try {
      const response = await this.ctx.container
        .getTcpPort(HOLD_PORT)
        .fetch('http://app/held', { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
      const body = await response.json().catch(() => null)
      const held = response.status === 200 && body?.held === true
      const text = (value) => (typeof value === 'string' ? value.slice(0, 20) : null)
      return {
        held,
        ok: held && body?.ok === true,
        checks: body?.checks ? { database: text(body.checks.database), net: text(body.checks.net) } : null,
        commit: typeof body?.commit === 'string' ? body.commit.slice(0, 12) : null,
      }
    } catch (error) {
      return { held: false, ok: false, error: String(error?.message ?? error).slice(0, 160) }
    }
  }

  /** Tell the hold to become the app. No hold listening means it already did. */
  async letGo() {
    try {
      const response = await this.ctx.container
        .getTcpPort(HOLD_PORT)
        .fetch('http://app/go', { method: 'POST', signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
      await response.text().catch(() => {})
      if (!response.ok) throw new Error('the hold answered ' + response.status)
    } catch (error) {
      if ((await this.probeHold()).held) throw error
    }
  }

  /** Is a container running here? Starts nothing (describe() would, for a host that should be up). */
  async peek() {
    return { begun: Boolean(await this.loadCfg()), running: Boolean(this.ctx.container.running) }
  }

  /**
   * What the router asks every time it looks. Also the supervision: a host that has been
   * begun and is not running (it crashed, or its machine was replaced) is started again here,
   * unless it was stopped on purpose.
   */
  async describe() {
    const cfg = await this.loadCfg()
    const container = this.ctx.container
    const base = { wanted: container.images?.app ?? null, version: this.env.CF_VERSION?.id ?? null }
    if (!cfg) return { ...base, begun: false, image: null, running: Boolean(container.running), ready: false }
    const mine = { ...base, begun: true, image: cfg.image, held: Boolean(cfg.held && !cfg.released), exits: this.exits, protocol: PROTOCOL }
    if (cfg.stopped) return { ...mine, running: Boolean(container.running), ready: false, stopped: true }
    let error = null
    let started = false
    try {
      started = this.startIfNeeded()
    } catch (startError) {
      error = String(startError?.message ?? startError).slice(0, 160)
    }
    if (mine.held) {
      // Parked: the container is up and its hold answers with passing checks. The app itself
      // is not started, so it is never "ready" here.
      const hold = started || error ? { ok: false } : await this.probeHold()
      return {
        ...mine,
        running: Boolean(container.running),
        ready: false,
        // An instance whose environment has no database must never take over: it would start
        // on the demo file backend. Only the staging copy, which has none, says that is fine
        // (ALLOW_NO_DATABASE in its Wrangler config).
        parked: hold.ok === true && (hold.checks?.database === 'ok' || this.env.ALLOW_NO_DATABASE === '1'),
        checks: hold.checks ?? null,
        commit: hold.commit ?? null,
        error: error ?? hold.error ?? null,
      }
    }
    const health = started || error ? { ok: false } : await this.probe()
    this.ready = health.ok && !this.retiring && !this.stopping
    // Let go, but the app is not answering yet: make sure the hold really did let go (the
    // call that told it to may have been lost).
    if (!health.ok && !started && !error && cfg.held && cfg.releasedAt && Date.now() - cfg.releasedAt < NUDGE_FOR_MS) {
      if ((await this.probeHold()).held) await this.letGo().catch((nudgeError) => console.error('[host] nudge failed', nudgeError?.message))
    }
    return {
      ...mine,
      running: Boolean(container.running),
      ready: this.ready,
      commit: health.commit ?? null,
      uptimeSeconds: health.uptimeSeconds ?? null,
      error: error ?? health.error ?? null,
    }
  }

  /**
   * Become an instance of the image this version of the code wants, and start it. Calling it
   * again changes nothing (the image is chosen once), so the router may repeat it freely.
   * `held`: start parked (the hold, not the app) and wait for release().
   */
  async begin({ envVars = null, held = false } = {}) {
    let cfg = await this.loadCfg()
    if (!cfg) {
      const image = this.ctx.container.images?.app
      if (!image) throw new Error('this Worker version has no container image named "app"')
      cfg = { image, begunAt: Date.now(), held: Boolean(held), released: false }
      const rehearsal = rehearsalOf(this.env)
      if (rehearsal) cfg.rehearsal = rehearsal
      await this.ctx.storage.put('cfg', cfg)
      this.cfg = cfg
      this.retiring = false
    }
    if (envVars) {
      assertContainerEnv(envVars)
      this.envOverride = { ...envVars }
    }
    this.startIfNeeded()
    return { image: cfg.image }
  }

  /**
   * Let a parked instance start its app. The record is stored first: from then on any start
   * of this container (a crash, a replaced machine) runs the app, never the hold again.
   * Calling it again is harmless.
   */
  async release() {
    let cfg = await this.loadCfg()
    if (!cfg) throw new Error('this host was never begun')
    if (cfg.held && !cfg.released) {
      cfg = { ...cfg, released: true, releasedAt: Date.now() }
      await this.ctx.storage.put('cfg', cfg)
      this.cfg = cfg
      this.exits = 0
    }
    if (this.startIfNeeded()) return { released: true, started: true }
    if (cfg.held) await this.letGo()
    return { released: true }
  }

  /** SIGTERM, wait for the app to finish its requests, destroy it if it has not left. True when it left by itself. */
  async endContainer() {
    const container = this.ctx.container
    if (!container.running) return true
    try {
      container.signal(15)
    } catch (error) {
      console.error('[host] SIGTERM failed', error?.message)
    }
    const deadline = Date.now() + GRACEFUL_STOP_MS
    while (Date.now() < deadline) {
      if (!container.running) return true
      await sleep(STOP_POLL_MS)
    }
    if (container.running) await container.destroy()
    return false
  }

  /**
   * Stop the app but KEEP this host's record, so the same image can be started again
   * (resume) if the instance taking over does not come up. The mark is stored before the
   * signal, so nothing (a waiting request, the router's look) starts the app again.
   */
  async stop() {
    let cfg = await this.loadCfg()
    if (!cfg) return { graceful: true }
    this.stopping = true
    this.ready = false
    try {
      if (!cfg.stopped) {
        cfg = { ...cfg, stopped: true }
        await this.ctx.storage.put('cfg', cfg)
        this.cfg = cfg
      }
      const graceful = await this.endContainer()
      console.log('[host] stopped, record kept, graceful=' + graceful)
      return { graceful }
    } finally {
      this.stopping = false
    }
  }

  /** Start a stopped host again on its own image (the way back from a hand-over that failed). */
  async resume() {
    let cfg = await this.loadCfg()
    if (!cfg) throw new Error('this host has nothing to resume')
    if (cfg.stopped) {
      cfg = { ...cfg, stopped: false }
      await this.ctx.storage.put('cfg', cfg)
      this.cfg = cfg
    }
    this.startIfNeeded()
    return { resumed: true }
  }

  /** Stop for good: SIGTERM, wait for the app to finish its requests, then forget everything. */
  async retire() {
    this.retiring = true
    this.ready = false
    const graceful = await this.endContainer()
    await this.ctx.storage.deleteAll()
    this.cfg = null
    this.envOverride = null
    console.log('[host] retired graceful=' + graceful)
    return { graceful }
  }

  /**
   * Wait (once, shared by every waiting request) until the app answers /health. During a
   * hand-over this is where requests wait: the instance is parked, then let go, then boots.
   */
  waitReady() {
    // Every request gets its own full wait: one that arrives late in a slow start is not cut
    // short by the deadline of the first one.
    this.readyUntil = Math.max(this.readyUntil ?? 0, Date.now() + COLD_WAIT_MS)
    this.readying ??= (async () => {
      for (;;) {
        if (this.retiring || this.stopping || !this.cfg || this.cfg.stopped) return false
        try {
          if (!this.startIfNeeded() && (await this.probe()).ok) {
            this.ready = true
            return true
          }
        } catch (error) {
          console.error('[host] start failed', error?.message)
        }
        if (Date.now() >= this.readyUntil) return false
        await sleep(COLD_POLL_MS)
      }
    })().finally(() => {
      this.readying = null
    })
    return Promise.race([this.readying, sleep(COLD_WAIT_MS).then(() => false)])
  }

  async fetch(request) {
    const cfg = await this.loadCfg()
    if (!cfg || cfg.stopped || this.retiring || this.stopping) {
      return json(503, { error: 'This instance no longer serves. Try again.' }, { [GONE_HEADER]: '1', 'retry-after': '1' })
    }
    const container = this.ctx.container
    if ((!container.running || !this.ready) && !(await this.waitReady())) {
      // It stopped serving while this request waited (a hand-over that was undone): say so,
      // so the Worker asks the router where to go instead of telling the browser to wait.
      if (!this.cfg || this.cfg.stopped || this.retiring || this.stopping) {
        return json(503, { error: 'This instance no longer serves. Try again.' }, { [GONE_HEADER]: '1', 'retry-after': '1' })
      }
      return json(503, { error: 'The app is starting. Try again in a moment.' }, { 'retry-after': '5' })
    }
    try {
      // The same Request object (not a copy), so the HMAC-signed webhook bodies reach
      // server.js byte for byte. Only the scheme changes: the container speaks plain HTTP.
      return await container.getTcpPort(APP_PORT).fetch(request.url.replace(/^https:/, 'http:'), request)
    } catch (error) {
      this.ready = false
      console.error('[host] could not reach the app:', error?.message)
      return json(503, { error: 'The app did not answer. Try again in a moment.' }, { 'retry-after': '2' })
    }
  }
}

// ---------------------------------------------------------------------------------------
// The router: one object that knows which instance is live and carries out the swaps.
// ---------------------------------------------------------------------------------------
export class AppRouter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    this.state = undefined
    /** Environment for the next forced swap; memory only, never stored. */
    this.envForNext = null
    this.ticking = null
    /** When the alarm was last checked (0: never). */
    this.armed = 0
  }

  async load() {
    if (this.state === undefined) {
      const stored = await this.ctx.storage.get('state')
      this.state = stored ?? initialState({ hasLegacy: Boolean(this.env.APP) })
      // A first-ever state is written at once, so "unchanged" in save() never hides it.
      if (!stored) await this.ctx.storage.put('state', this.state)
    }
    return this.state
  }

  /** Store the state, unless nothing changed (most looks change nothing). */
  async save(state) {
    const unchanged = this.state !== undefined && JSON.stringify(this.state) === JSON.stringify(state)
    this.state = state
    if (!unchanged) await this.ctx.storage.put('state', state)
  }

  /** The heartbeat must never stop: it is what notices a new image and a crashed instance. */
  async arm() {
    const now = Date.now()
    if (this.armed && now - this.armed < ARM_CHECK_MS) return
    this.armed = now
    // null also while the alarm handler is running; setting one then only adds a look.
    if (!this.ticking && (await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(now)
  }

  /**
   * Where traffic should be: 'hosts' or the old application. The Worker hands this in with
   * every poke (see targetOf), because this object can keep running an OLDER version of the
   * code and its vars for minutes after a deploy (measured: 5 minutes on staging), while the
   * stateless Worker is always the newest. Its own env is only the fallback before any poke.
   */
  target() {
    const stored = this.state?.target
    if (stored === LEGACY || stored === 'hosts') return stored
    return this.env.ROLLOUT_TARGET === LEGACY ? LEGACY : 'hosts'
  }

  /** Something with describe(), begin(), stop(), release(), resume() and retire(), whichever kind of instance `name` is. */
  instance(name) {
    if (name !== LEGACY) return this.env.HOST.get(this.env.HOST.idFromName(name))
    const legacy = getContainer(this.env.APP, 'app')
    return {
      // Starting the old container is just asking it something (its package starts it on
      // fetch), once the mark that keeps it stopped is cleared.
      begin: () => legacy.revive(),
      retire: () => legacy.retire(),
      // The old container has one kind of stop (stopped, marked, startable again by revive).
      stop: () => legacy.retire(),
      resume: () => legacy.revive(),
      release: async () => ({}),
      describe: async ({ probe = false } = {}) => {
        // While it is live it is not poked: it is supervised the way it always was (requests
        // and the cron tick). As the candidate on the way BACK, it is ready when it answers.
        if (!probe) {
          // The one thing asked of it: does its object run a version of this code that can be
          // handed over from? (For minutes after the first deploy of this arrangement it may not.)
          let protocol = 0
          try {
            protocol = Number(await legacy.protocol()) || 0
          } catch {
            // An older version of the code: no such method yet.
          }
          return { begun: true, image: LEGACY, running: true, ready: true, wanted: null, protocol }
        }
        try {
          const response = await legacy.fetch(new Request('http://app/health', { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) }))
          const body = await response.json().catch(() => null)
          const ready = response.status === 200 && body?.ok === true
          return { begun: true, image: LEGACY, running: true, ready, commit: body?.commit ?? null, wanted: null }
        } catch (error) {
          return { begun: true, image: LEGACY, running: false, ready: false, error: String(error?.message ?? error).slice(0, 160), wanted: null }
        }
      },
    }
  }

  async describe(name, options) {
    try {
      return await this.instance(name).describe(options)
    } catch (error) {
      console.error('[router] could not ask ' + name + ':', error?.message)
      return null
    }
  }

  async facts(state) {
    const target = this.target()
    const [live, next] = await Promise.all([
      state.live ? this.describe(state.live.name) : null,
      state.next ? this.describe(state.next.name, { probe: true }) : null,
    ])
    // What the newest code wants is asked of the host that WOULD be next: a new object always
    // runs the newest version, where a long-lived one may briefly lag behind a deploy.
    let wanted = null
    if (target !== LEGACY) wanted = (await this.describe(hostName(state.seq + 1)))?.wanted ?? live?.wanted ?? null
    // While a hand-over is being undone: is the new instance's container really gone?
    let to = null
    if (state.handover?.phase === 'undo') {
      try {
        to = await this.instance(state.handover.to).peek()
      } catch (error) {
        console.error('[router] could not ask ' + state.handover.to + ':', error?.message)
      }
    }
    return { live, next, wanted, target, to }
  }

  /** One look: gather the facts, decide (rollout.js), store the decision, then act on it. */
  tick() {
    this.ticking ??= this.runTick().finally(() => {
      this.ticking = null
    })
    return this.ticking
  }

  async runTick() {
    const facts = await this.facts(await this.load())
    // Gathering the facts takes seconds (a health call per instance), and swap() may have
    // stored a restart request meanwhile. Plan from what is stored NOW, with no await
    // between this line and the save, or that request would be overwritten.
    const state = this.state
    const { state: planned, actions, delay } = plan(state, facts, Date.now())
    const flipped = planned.live?.name !== state.live?.name
    // Stored BEFORE acting: a begin that fails is asked again on the next look, and the
    // pointer can only move once the new instance has answered /health.
    await this.save(planned)
    if (flipped) console.log('[router] live is now ' + planned.live?.name + ' (was ' + (state.live?.name ?? 'nothing') + ')')
    for (const action of actions) {
      try {
        if (action.type === 'begin') {
          console.log('[router] begin ' + action.name + ' (' + action.reason + (action.held ? ', held' : '') + ')')
          const envVars = action.forced ? this.envForNext : null
          if (action.forced) this.envForNext = null
          await this.instance(action.name).begin({ envVars, held: Boolean(action.held) })
        } else if (action.type === 'retire') {
          const { graceful } = await this.instance(action.name).retire()
          console.log('[router] retired ' + action.name + ' graceful=' + graceful)
          await this.save(retired(this.state, action.name, { graceful, now: Date.now() }))
          await this.save(handoverStep(this.state, 'retired', { name: action.name, now: Date.now() }))
        } else if (action.type === 'stop') {
          // The pointer has just moved (the state is already stored): give the requests that
          // were on their way to the old instance a moment to arrive before it stops.
          if (action.settle) await sleep(SETTLE_MS)
          const { graceful } = await this.instance(action.name).stop()
          console.log('[router] stopped ' + action.name + ' graceful=' + graceful)
          await this.save(handoverStep(this.state, 'stopped', { name: action.name, now: Date.now(), graceful }))
        } else if (action.type === 'release') {
          await this.instance(action.name).release()
          console.log('[router] let go ' + action.name)
          await this.save(handoverStep(this.state, 'released', { name: action.name, now: Date.now() }))
        } else if (action.type === 'resume') {
          await this.instance(action.name).resume()
          console.log('[router] resumed ' + action.name)
          await this.save(handoverStep(this.state, 'resumed', { name: action.name, now: Date.now() }))
        }
      } catch (error) {
        console.error('[router] ' + action.type + ' ' + action.name + ' failed:', error?.message)
        if (action.type === 'retire') await this.save(retireFailed(this.state, action.name, Date.now()))
        // A step of a sequence failed: the steps after it wait for the next look. (A new app
        // is never let go while the old one may still be running.)
        if (action.seq) break
      }
    }
    return delay
  }

  async alarm() {
    let delay = TICK_SLOW_MS
    try {
      delay = await this.tick()
    } catch (error) {
      console.error('[router] look failed:', error?.message)
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + delay)
    }
  }

  /** Which instance serves right now. Asked on every request, so it only reads memory. */
  async liveName() {
    let state = await this.load()
    if (!state.live) {
      await this.tick()
      state = this.state
    }
    await this.arm()
    return state.live?.name ?? null
  }

  /**
   * Look now instead of at the next heartbeat (a new Worker version just started serving).
   * `target` and `stamp` come from the Worker version that is poking; the newest stamp wins,
   * so a straggling isolate of an older version cannot turn the target back.
   */
  async poke({ target = null, stamp = 0 } = {}) {
    const state = await this.load()
    const wanted = target === LEGACY ? LEGACY : target === 'hosts' ? 'hosts' : null
    if (wanted && Number.isFinite(stamp) && stamp >= (state.targetStamp ?? 0) && (state.target !== wanted || stamp > (state.targetStamp ?? 0))) {
      if (state.target !== wanted) console.log('[router] target is now ' + wanted)
      await this.save({ ...this.state, target: wanted, targetStamp: stamp })
    }
    this.armed = Date.now()
    await this.ctx.storage.setAlarm(Date.now())
  }

  /**
   * Swap to a fresh instance on the same image, started with the environment the CALLER
   * holds (the stateless Worker always has the current one): the zero-downtime form of a
   * restart after a secret upload.
   */
  async swap({ envVars = null, reason = 'restart' } = {}) {
    if (envVars) assertContainerEnv(envVars)
    const state = await this.load()
    // A fresh instance can only start the newest image. If that image is the one whose
    // hand-over was undone, a restart would only repeat the failure: refuse, out loud.
    if (state.failed?.final) return { swapping: false, refused: 'The newest image did not start (' + (state.failed.why ?? 'unknown') + '). Deploy a fix; the app is still running the previous version and environment.' }
    this.envForNext = envVars ? { ...envVars } : null
    await this.save(force(state, reason))
    await this.poke()
    return { swapping: true }
  }

  /** For people and scripts: where things stand. No environment values, and only the tail of an image digest. */
  async status() {
    const state = await this.load()
    const short = (image) => (typeof image === 'string' && image.includes('sha256:') ? image.slice(-12) : (image ?? null))
    const [live, next] = await Promise.all([
      state.live ? this.describe(state.live.name) : null,
      state.next ? this.describe(state.next.name, { probe: true }) : null,
    ])
    const brief = (entry, facts) =>
      entry && {
        name: entry.name,
        since: entry.since ?? entry.startedAt ?? null,
        reason: entry.reason ?? null,
        image: short(facts?.image ?? entry.image),
        ready: facts?.ready ?? null,
        running: facts?.running ?? null,
        commit: facts?.commit ?? entry.commit ?? null,
        uptimeSeconds: facts?.uptimeSeconds ?? null,
        version: facts?.version ?? null,
        protocol: facts?.protocol ?? null,
        held: facts?.held ?? null,
        parked: facts?.parked ?? null,
        checks: facts?.checks ?? null,
        stopped: facts?.stopped ?? null,
        exits: facts?.exits ?? null,
        error: facts?.error ?? null,
      }
    const handover = state.handover
    return {
      target: this.target(),
      routerVersion: this.env.CF_VERSION?.id ?? null,
      live: brief(state.live, live),
      next: brief(state.next, next),
      handover: handover
        ? { from: handover.from, to: handover.to, phase: handover.phase, at: handover.at, stoppedAt: handover.stoppedAt ?? null, releasedAt: handover.releasedAt ?? null, why: handover.why ?? null }
        : null,
      retiring: state.retiring.map((old) => ({ name: old.name, at: old.at, tries: old.tries ?? 0, retryAt: old.retryAt ?? null })),
      failed: state.failed ? { ...state.failed, image: short(state.failed.image) } : null,
      forced: state.forced,
      history: state.history,
      alarm: await this.ctx.storage.getAlarm(),
    }
  }
}

// ---------------------------------------------------------------------------------------
// The Worker.
// ---------------------------------------------------------------------------------------

/** Length-independent, constant-time string compare (digests first, so lengths never leak). */
async function tokensMatch(presented, expected) {
  const digest = async (value) =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  const [a, b] = await Promise.all([digest(presented), digest(expected)])
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

const routerOf = (env) => (env.ROUTER ? env.ROUTER.get(env.ROUTER.idFromName('router')) : null)

/** What this Worker version says the target is, and when the version was made (newest wins). */
export function targetOf(env) {
  const made = Date.parse(env?.CF_VERSION?.timestamp ?? '')
  return { target: env?.ROLLOUT_TARGET === LEGACY ? LEGACY : 'hosts', stamp: Number.isFinite(made) ? made : 0 }
}

// One poke per Worker isolate: new isolates appear when a new version starts serving, which
// is exactly when the router should look for a new image.
let poked = false

const ROUTER_TRIES = 3

/** The live instance's name. A Durable Object being replaced by a deploy answers on a retry. */
async function liveName(router) {
  let lastError
  for (let attempt = 0; attempt < ROUTER_TRIES; attempt++) {
    try {
      return await router.liveName()
    } catch (error) {
      lastError = error
      await sleep(100 * (attempt + 1))
    }
  }
  throw lastError
}

/**
 * Send one request to the live instance. `make()` builds the Request each time it is called;
 * `repeatable` says it may be sent a second time (it has no body to have been consumed).
 */
async function sendToLive(env, make, repeatable) {
  const router = routerOf(env)
  // No router bound: the old arrangement, exactly as before.
  if (!router) return getContainer(env.APP, 'app').fetch(make())
  for (let attempt = 0; ; attempt++) {
    const last = attempt > 0 || !repeatable
    let response
    try {
      const name = await liveName(router)
      if (!name) return json(503, { error: 'The app is starting. Try again in a moment.' }, { 'retry-after': '5' })
      const instance = name === LEGACY ? getContainer(env.APP, 'app') : env.HOST.get(env.HOST.idFromName(name))
      response = await instance.fetch(make())
    } catch (error) {
      console.error('[worker] could not reach the live instance:', error?.message)
      if (last) return json(503, { error: 'The app did not answer. Try again in a moment.' }, { 'retry-after': '2' })
      await sleep(250)
      continue
    }
    // The pointer moved between asking and arriving: ask again (once) rather than fail.
    if (response.headers.has(GONE_HEADER) && !last) {
      await sleep(250)
      continue
    }
    return response
  }
}

export default {
  async fetch(request, env, ctx) {
    // A client must never choose which container port the Worker talks to.
    if (request.headers.has('cf-container-target-port')) {
      return json(400, { error: 'Bad request' })
    }

    // The app decodes the path before routing, so decode it here before judging it.
    let pathname
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname).toLowerCase()
    } catch {
      return json(400, { error: 'Bad request' })
    }

    const router = routerOf(env)
    if (router && !poked) {
      poked = true
      ctx?.waitUntil?.(router.poke(targetOf(env)).catch((error) => console.error('[worker] poke failed', error?.message)))
    }

    // /internal/* is for the Worker and its cron, never for the public internet. The cron
    // reaches /internal/tick through the instance directly (see scheduled below).
    if (pathname === '/internal' || pathname.startsWith('/internal/')) {
      const isRestart = pathname === '/internal/restart' && request.method === 'POST'
      const isEnvRevision = pathname === '/internal/env-revision' && request.method === 'GET'
      const isRollout = pathname === '/internal/rollout' && request.method === 'GET' && Boolean(router)
      // The staging copy has no secrets at all, so its rollout status is open (ROLLOUT_STATUS_PUBLIC).
      if (isRollout && env.ROLLOUT_STATUS_PUBLIC === '1' && !env.TICK_TOKEN) return json(200, await router.status())
      if ((!isRestart && !isEnvRevision && !isRollout) || !env.TICK_TOKEN) {
        return json(404, { error: 'Not found' })
      }
      if (!(await tokensMatch(request.headers.get('x-tick-token') ?? '', String(env.TICK_TOKEN)))) {
        return json(401, { error: 'Unauthorized' })
      }
      if (isRollout) return json(200, await router.status())
      // The revision THIS Worker version carries (the last secrets upload). Answered here,
      // never forwarded, so it proves what a restart is about to hand to the container.
      if (isEnvRevision) return json(200, { workerEnvRevision: env.ENV_REVISION ?? null })
      // The app reads its environment only when it STARTS, so a secret change reaches it only
      // after a restart, and the Durable Object that owns the container may still hold an
      // older env than this Worker. So this Worker (which has the current env) hands it over.
      // The values go over the Durable Object RPC inside this Worker, never the public network.
      try {
        if (router && (await liveName(router)) !== LEGACY) {
          // A fresh instance is brought up beside the live one with this env and handed over to
          // like a deploy: requests wait a few seconds while the app starts, none fail.
          const asked = await router.swap({ envVars: pickContainerEnv(env), reason: 'restart' })
          if (!asked?.swapping) return json(409, { restarted: false, error: asked?.refused ?? 'The restart was refused.' })
          return json(200, { restarted: true, graceful: true, lastStatus: 'swapping', swapping: true })
        }
        const { graceful, lastStatus } = await getContainer(env.APP, 'app').restartWith(pickContainerEnv(env))
        return json(200, { restarted: true, graceful, lastStatus })
      } catch (error) {
        console.error('[restart] restartWith failed', error?.message)
        return json(500, { restarted: false })
      }
    }

    // The app trusts the LAST x-forwarded-for hop (server.js getClientIp), so a client-sent
    // header must never reach it: replace it with the address Cloudflare saw. Rebuilding only
    // the headers keeps the body stream untouched, which the Stripe, Resend and SignWell
    // webhooks need (they verify an HMAC over the exact bytes sent).
    const headers = new Headers(request.headers)
    headers.set('x-forwarded-for', request.headers.get('cf-connecting-ip') ?? '')
    headers.delete('x-real-ip')
    const repeatable = request.method === 'GET' || request.method === 'HEAD'
    return sendToLive(env, () => new Request(request, { headers }), repeatable)
  },

  // Cron Trigger (wrangler.jsonc triggers.crons): run the app's periodic jobs on the live
  // instance, and nudge the router. The fetch also wakes the old container if it was
  // restarted, which is what re-arms its own timers.
  scheduled: (controller, env, ctx) => {
    const tick = { method: 'POST', headers: { 'x-tick-token': env.TICK_TOKEN ?? '' } }
    // The cron is also the heartbeat's safety net: it sets the router's alarm again.
    routerOf(env)
      ?.poke(targetOf(env))
      .catch((error) => console.error('[cron] poke failed', error?.message))
    const sent = routerOf(env)
      ? sendToLive(env, () => new Request('http://app/internal/tick', tick), true)
      : getContainer(env.APP, 'app').fetch('http://app/internal/tick', tick)
    return ctx.waitUntil(
      sent
        .then((response) => response.ok || console.error('[cron] tick', response.status))
        .catch((error) => console.error('[cron] tick failed', error?.message)),
    )
  },
}
