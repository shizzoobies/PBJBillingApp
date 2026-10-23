import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { registerPeriodicJob, runAllPeriodicJobs, runPeriodicJob, tickRefusal } from './periodic-jobs.js'

describe('the periodic job registry', () => {
  it('runs every job once, in registration order, and names them', async () => {
    const order = []
    const registry = []
    registerPeriodicJob('a', () => order.push('a'), registry)
    registerPeriodicJob('b', async () => order.push('b'), registry)
    registerPeriodicJob('c', () => order.push('c'), registry)
    const result = await runAllPeriodicJobs(registry)
    expect(order).toEqual(['a', 'b', 'c'])
    expect(result).toEqual({ ran: ['a', 'b', 'c'], failed: [] })
  })

  it('reports a throwing job (sync or async) and still runs the rest', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const registry = []
    const after = vi.fn()
    registerPeriodicJob(
      'first',
      () => {
        throw new Error('boom')
      },
      registry,
    )
    registerPeriodicJob('second', async () => Promise.reject(new Error('later')), registry)
    registerPeriodicJob('third', after, registry)
    const result = await runAllPeriodicJobs(registry)
    expect(result.ran).toEqual(['third'])
    expect(result.failed).toEqual([
      { name: 'first', message: 'boom' },
      { name: 'second', message: 'later' },
    ])
    expect(after).toHaveBeenCalledTimes(1)
  })

  it('runs jobs one at a time, never in parallel', async () => {
    const registry = []
    let running = 0
    let overlap = false
    for (const name of ['x', 'y']) {
      registerPeriodicJob(
        name,
        async () => {
          running += 1
          if (running > 1) overlap = true
          await new Promise((resolve) => setTimeout(resolve, 5))
          running -= 1
        },
        registry,
      )
    }
    await runAllPeriodicJobs(registry)
    expect(overlap).toBe(false)
  })

  it('does not start a job that is still running; reports it as skipped busy', async () => {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const run = vi.fn(() => gate)
    const job = { name: 'slow', run }
    const first = runPeriodicJob(job)
    await expect(runPeriodicJob(job)).resolves.toEqual({ skipped: 'busy' })
    const registry = []
    registerPeriodicJob('slow', run, registry)
    registerPeriodicJob('quick', () => {}, registry)
    await expect(runAllPeriodicJobs(registry)).resolves.toEqual({
      ran: ['quick'],
      failed: [],
      skipped: [{ name: 'slow', skipped: 'busy' }],
    })
    expect(run).toHaveBeenCalledTimes(1)
    release()
    await expect(first).resolves.toBeNull()
    // Finished: the next start is allowed, and a failure also frees the name.
    await expect(runPeriodicJob({ name: 'slow', run: () => {} })).resolves.toBeNull()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(runPeriodicJob({ name: 'flaky', run: () => Promise.reject(new Error('x')) })).resolves.toBe('x')
    await expect(runPeriodicJob({ name: 'flaky', run: () => {} })).resolves.toBeNull()
  })

  it('replaces a job registered twice under one name instead of doubling it', async () => {
    const registry = []
    const first = vi.fn()
    const second = vi.fn()
    registerPeriodicJob('same', first, registry)
    registerPeriodicJob('same', second, registry)
    expect(registry).toHaveLength(1)
    await runAllPeriodicJobs(registry)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('runPeriodicJob swallows a failure so an interval can never crash the process', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(runPeriodicJob({ name: 'bad', run: () => Promise.reject(new Error('x')) })).resolves.toBe('x')
    await expect(runPeriodicJob({ name: 'ok', run: () => {} })).resolves.toBeNull()
  })
})

describe('maintenance mode (nothing may write during the cutover)', () => {
  const on = { MAINTENANCE_MODE: '1' }

  it('(b) the tick runs no job and says why', async () => {
    const registry = []
    const job = vi.fn()
    registerPeriodicJob('a', job, registry)
    await expect(runAllPeriodicJobs(registry, on)).resolves.toEqual({ ran: [], skipped: 'maintenance' })
    expect(job).not.toHaveBeenCalled()
  })

  it('(b) an interval or first-run callback returns early without running the job', async () => {
    const job = { name: 'a', run: vi.fn() }
    await expect(runPeriodicJob(job, on)).resolves.toBeNull()
    expect(job.run).not.toHaveBeenCalled()
    await runPeriodicJob(job, {})
    expect(job.run).toHaveBeenCalledTimes(1)
  })

  it('jobs run again as soon as the switch is off', async () => {
    const registry = []
    registerPeriodicJob('a', () => {}, registry)
    await expect(runAllPeriodicJobs(registry, { MAINTENANCE_MODE: '0' })).resolves.toEqual({
      ran: ['a'],
      failed: [],
    })
  })
})

describe('tick authorization', () => {
  it('does not exist (404) when TICK_TOKEN is not set, even for a matching empty header', () => {
    expect(tickRefusal({}, 'anything')?.status).toBe(404)
    expect(tickRefusal({ TICK_TOKEN: '' }, '')?.status).toBe(404)
  })

  it('refuses a missing, wrong or different-length token with 401', () => {
    const env = { TICK_TOKEN: 'secret-token' }
    expect(tickRefusal(env, undefined)?.status).toBe(401)
    expect(tickRefusal(env, 'secret-tokeX')?.status).toBe(401)
    expect(tickRefusal(env, 'secret')?.status).toBe(401)
    expect(tickRefusal(env, 'secret-token-and-more')?.status).toBe(401)
  })

  it('allows the exact token', () => {
    expect(tickRefusal({ TICK_TOKEN: 'secret-token' }, 'secret-token')).toBeNull()
  })
})

describe('server.js wiring (no HTTP harness: server.js listens at import)', () => {
  const source = readFileSync('server.js', 'utf8')

  it('registers every periodic job and starts its interval from the registry entry', () => {
    for (const name of [
      'rate-limit-sweep',
      'signwell-left-finishing',
      'esignatures-expiry',
      'weekly-digest',
      'past-due-notices',
      'auto-invoice-reminders',
    ]) {
      expect(source, name).toContain(`registerPeriodicJob('${name}'`)
    }
    expect(source.match(/setInterval\(\(\) => void runPeriodicJob\(/g)).toHaveLength(6)
    // ...and so do the four first-run timers, so maintenance mode silences them too.
    expect(source.match(/setTimeout\(\(\) => void runPeriodicJob\(/g)).toHaveLength(4)
    // The only other interval is the SSE heartbeat.
    expect(source.match(/setInterval\(/g)).toHaveLength(7)
  })

  it('serves /internal/tick before session auth, behind tickRefusal, answering the runner result', () => {
    const tick = source.indexOf("normalizedPath === '/internal/tick'")
    expect(tick).toBeGreaterThan(-1)
    expect(tick).toBeLessThan(source.indexOf("normalizedPath === '/api/session'"))
    const block = source.slice(tick, tick + 900)
    expect(block).toContain("tickRefusal(process.env, request.headers['x-tick-token'])")
    expect(block).toContain('runAllPeriodicJobs()')
    expect(block).toContain('sendJson(response, 200, result)')
  })

  it('logs a deferred webhook (path only) and reports maintenance on /health', () => {
    expect(source).toContain('[maintenance] webhook deferred ${normalizedPath}')
    expect(source).toContain('maintenance: isMaintenanceMode(),')
    expect(source).toContain("envRevision: String(process.env.ENV_REVISION || '') || null,")
    expect(source).toContain('uptimeSeconds: Math.round(process.uptime()),')
  })

  it('checks maintenance mode before any preview, session or route handling', () => {
    const maintenance = source.indexOf('maintenanceRefusal(process.env')
    expect(maintenance).toBeGreaterThan(source.indexOf("normalizedPath === '/internal/tick'"))
    expect(maintenance).toBeLessThan(source.indexOf("request.headers['x-preview-mode'] === '1'"))
  })
})
