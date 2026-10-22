#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

function installedCli() {
  const require = createRequire(import.meta.url)
  // bin/wrangler.js launches another Node process. Killing that launcher on
  // Windows leaves the real CLI alive, so launch its entry point directly.
  return path.resolve(path.dirname(require.resolve('wrangler/bin/wrangler.js')), '../wrangler-dist/cli.js')
}

export async function tailWorker({ env = process.env, resolveCli = installedCli, durationMs = 10_000, print = console.log } = {}) {
  if (!env.CLOUDFLARE_API_TOKEN) {
    print('Skipped Wrangler tail: CLOUDFLARE_API_TOKEN is not set; no browser login attempted.')
    return
  }
  let cli
  try { cli = resolveCli() } catch {
    print('Skipped Wrangler tail: install the locked Wrangler dependency first.')
    return
  }
  // Equivalent to npx wrangler tail pbjbillingapp --format json.
  await new Promise((resolve) => {
    const child = spawn(process.execPath, ['--no-warnings', cli, 'tail', 'pbjbillingapp', '--format', 'json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
    })
    let output = ''
    let timedOut = false
    child.stdout.on('data', (data) => { output = (output + data).slice(-32768) })
    child.stderr.resume()
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, durationMs)
    child.on('error', () => {
      clearTimeout(timer)
      print('Skipped Wrangler tail: command unavailable; no browser login attempted.')
      resolve()
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (!timedOut && code !== 0) {
        print('Skipped Wrangler tail: credentials or command unavailable; no browser login attempted.')
      } else {
        const lines = output.trim().split(/\r?\n/).slice(-8).join('\n')
        print(lines || 'Wrangler tail: no events received during the 10-second window.')
      }
      resolve()
    })
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await tailWorker()
