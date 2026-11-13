// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkDatabase, checksPass, startHold } from './container-hold.js'

// The hold a new instance waits in during a deploy (lib/container-hold.js). Each test uses
// port 0 (any free port) and a fake "app" loader, so nothing of server.js is loaded.
const open = []
afterEach(async () => {
  for (const server of open.splice(0)) await new Promise((resolve) => server.close(() => resolve()))
  vi.restoreAllMocks()
})

async function hold(options = {}) {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const exit = vi.fn()
  const load = vi.fn(async () => {})
  const started = startHold({
    env: {},
    port: 0,
    app: 'file:///app/server.js',
    check: async () => ({ database: 'ok', net: 'skipped' }),
    exit,
    load,
    maxHoldMs: 60_000,
    checkEveryMs: 20,
    ...options,
  })
  open.push(started.server)
  const port = await started.listening
  const ask = (path, init) => fetch('http://127.0.0.1:' + port + path, init)
  return { ...started, exit, load, ask }
}

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms))

describe('the hold', () => {
  it('reports held, and ok only once its checks have run and pass', async () => {
    let answer
    const check = vi.fn(() => new Promise((resolve) => void (answer = resolve)))
    const { ask } = await hold({ check })
    const pending = await (await ask('/held')).json()
    expect(pending).toMatchObject({ held: true, ok: false, checks: { database: 'pending' } })
    answer({ database: 'ok', net: 'skipped' })
    await settle()
    await expect((await ask('/held')).json()).resolves.toMatchObject({ held: true, ok: true, checks: { database: 'ok', net: 'skipped' } })
  })

  it('is not ok while the database cannot be reached, and checks again', async () => {
    const answers = ['failed', 'failed', 'ok']
    const check = vi.fn(async () => ({ database: answers.shift() ?? 'ok', net: 'skipped' }))
    const { ask } = await hold({ check })
    await expect((await ask('/held')).json()).resolves.toMatchObject({ ok: false, checks: { database: 'failed' } })
    await settle(120)
    await expect((await ask('/held')).json()).resolves.toMatchObject({ ok: true, checks: { database: 'ok' } })
    expect(check.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('a check that throws counts as failed', async () => {
    const { ask } = await hold({ check: async () => Promise.reject(new Error('boom')) })
    await settle()
    await expect((await ask('/held')).json()).resolves.toMatchObject({ ok: false, checks: { database: 'failed' } })
  })

  it('does not load the app until POST /go, then loads it exactly once and stops listening', async () => {
    const { ask, load, server } = await hold()
    await settle()
    expect(load).not.toHaveBeenCalled()
    expect((await ask('/go')).status).toBe(404)
    expect(load).not.toHaveBeenCalled()
    const answer = await ask('/go', { method: 'POST' })
    await expect(answer.json()).resolves.toEqual({ released: true })
    await settle()
    expect(load).toHaveBeenCalledTimes(1)
    expect(load).toHaveBeenCalledWith('file:///app/server.js')
    expect(server.listening).toBe(false)
  })

  it('leaves at once on SIGTERM while holding, and hands signals to the app once released', async () => {
    const before = process.listenerCount('SIGTERM')
    const { ask, exit } = await hold()
    expect(process.listenerCount('SIGTERM')).toBe(before + 1)
    process.emit('SIGTERM')
    expect(exit).toHaveBeenCalledWith(0)
    await ask('/go', { method: 'POST' })
    await settle()
    // The hold's own handler is gone: the app's shutdown (the end of server.js) decides now.
    expect(process.listenerCount('SIGTERM')).toBe(before)
  })

  it('exits 1 when the app fails to start', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { ask, exit } = await hold({ load: async () => Promise.reject(new Error('cannot find module')) })
    await ask('/go', { method: 'POST' })
    await settle()
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('leaves by itself if nobody ever releases it', async () => {
    const { exit } = await hold({ maxHoldMs: 30 })
    await settle(80)
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('answers 404 to anything else', async () => {
    const { ask } = await hold()
    expect((await ask('/health')).status).toBe(404)
    expect((await ask('/held', { method: 'POST' })).status).toBe(404)
  })
})

describe('the checks', () => {
  it('pass with a database that answered or with none (the file backend); not while pending or failed', () => {
    expect(checksPass({ database: 'ok' })).toBe(true)
    expect(checksPass({ database: 'none', net: 'failed' })).toBe(true)
    expect(checksPass({ database: 'failed' })).toBe(false)
    expect(checksPass({ database: 'pending' })).toBe(false)
    expect(checksPass(null)).toBe(false)
  })

  it('checkDatabase says none without a DATABASE_URL, and failed (never throwing) for one nothing answers on', async () => {
    await expect(checkDatabase({})).resolves.toBe('none')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(checkDatabase({ DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/db' })).resolves.toBe('failed')
  })
})
