// The container's restart route sends SIGTERM and gives the process 20 s to leave before it
// destroys it. server.js must close itself down on the signal, well inside that window.
//
// This boots the real server.js (it listens at import, so there is no in-process harness) on the
// FILE backend: the child gets a bare environment, never DATABASE_URL or a key from this shell.
// It runs under `node --test` after vitest finishes, so it never shares tmp/app-data.json with a
// vitest run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const BOOT_LIMIT_MS = 60_000
const EXIT_LIMIT_MS = 10_000

// On Windows, child.kill('SIGTERM') terminates the process outright and no handler runs. There the
// child preloads this relay and the test asks it over IPC to raise the signal on itself, which runs
// the same process.on('SIGTERM') listener a real signal would. Elsewhere a real signal is sent.
const signalRelay = `data:text/javascript,${encodeURIComponent(
  "process.on('message', (m) => { if (m === 'SIGTERM' || m === 'SIGINT') process.emit(m, m) }); process.channel?.unref?.()",
)}`

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

function bareEnv(port) {
  const env = { PORT: String(port) }
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
    if (process.env[name]) env[name] = process.env[name]
  }
  return env
}

function bootServer(t, port) {
  const child = spawn(process.execPath, [`--import=${signalRelay}`, 'server.js'], {
    cwd: repoRoot,
    env: bareEnv(port),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => (output += chunk))
  child.stderr.on('data', (chunk) => (output += chunk))
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  })
  return { child, exited, output: () => output }
}

function waitFor(predicate, limitMs, what, exited) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer)
        resolve()
      } else if (Date.now() - started > limitMs) {
        clearInterval(timer)
        reject(new Error(`timed out after ${limitMs} ms waiting for ${what}`))
      }
    }, 50)
    exited.then(({ code, signal }) => {
      clearInterval(timer)
      if (!predicate()) reject(new Error(`server exited (code ${code}, signal ${signal}) before ${what}`))
    })
  })
}

function sendSignal(child, signal) {
  if (process.platform === 'win32') child.send(signal)
  else child.kill(signal)
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`server.js exits 0 within ${EXIT_LIMIT_MS / 1000} s of ${signal} and logs the shutdown line`, async (t) => {
    const port = await freePort()
    const server = bootServer(t, port)
    await waitFor(
      () => server.output().includes(`app listening on ${port}`),
      BOOT_LIMIT_MS,
      'the listening line',
      server.exited,
    )

    // Leave a served keep-alive connection open: an idle socket must not hold server.close() up.
    const health = await fetch(`http://127.0.0.1:${port}/health`)
    assert.equal(health.status, 200)
    await health.arrayBuffer()

    const signalledAt = Date.now()
    sendSignal(server.child, signal)
    const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), EXIT_LIMIT_MS).unref())
    const result = await Promise.race([server.exited, timeout])
    const tookMs = Date.now() - signalledAt

    assert.notEqual(result, 'timeout', `still running ${EXIT_LIMIT_MS} ms after ${signal}:\n${server.output()}`)
    assert.deepEqual(result, { code: 0, signal: null }, server.output())
    assert.ok(tookMs < EXIT_LIMIT_MS, `took ${tookMs} ms`)
    assert.match(server.output(), new RegExp(`\\[shutdown\\] ${signal}: .*closed in \\d+ ms`))
    assert.doesNotMatch(server.output(), /forced exit/)
  })
}
