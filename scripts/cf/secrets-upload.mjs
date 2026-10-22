#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { readEnvFile } from '../prod/env.mjs'

export const DEFAULT_ROTATION_FILE = 'D:\\PBJ Accounting Work\\secrets\\rotation-2026-10-21.env'
export const SECRET_NAMES = Object.freeze([
  'DATABASE_URL', 'JWT_SECRET', 'VOICE_TOOL_SECRET', 'OWNER_BOOTSTRAP_PASSWORD',
  'TOTP_ENC_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'RESEND_API_KEY',
  'RESEND_WEBHOOK_SECRET', 'ANTHROPIC_API_KEY', 'ELEVENLABS_API_KEY',
  'ELEVENLABS_WEBHOOK_SECRET', 'SIGNWELL_API_KEY', 'SIGNWELL_TEST_MODE',
  'SIGNWELL_WEBHOOK_ID', 'TICK_TOKEN', 'INVOICE_AUTO_REMINDERS', 'PGSSLMODE',
])
const GENERATED_NAMES = ['JWT_SECRET', 'VOICE_TOOL_SECRET', 'TICK_TOKEN']

export function selectSecrets(values) {
  const secrets = Object.create(null)
  const skipped = new Set()
  for (const name of SECRET_NAMES) {
    if (String(values[name] ?? '').trim()) secrets[name] = values[name]
    else skipped.add(name)
  }
  for (const name of Object.keys(values)) {
    if (!SECRET_NAMES.includes(name)) skipped.add(name)
  }
  return { secrets, skipped: [...skipped] }
}

export function uploadSecrets(argv = [], { run = spawnSync, print = console.log } = {}) {
  const positional = argv.filter((arg) => !arg.startsWith('--'))
  if (positional.length > 1 || argv.some((arg) => arg.startsWith('--') && !['--dry-run', '--generate'].includes(arg))) {
    throw new Error('Usage: node scripts/cf/secrets-upload.mjs [env-file] [--dry-run] [--generate]')
  }
  const dryRun = argv.includes('--dry-run')
  const generate = argv.includes('--generate')
  const source = readEnvFile(positional[0] || DEFAULT_ROTATION_FILE)
  const generated = {}
  if (generate) {
    for (const name of GENERATED_NAMES) {
      if (!String(source.values[name] ?? '').trim()) generated[name] = randomBytes(32).toString('hex')
    }
  }
  // A dry run never changes the file, including when --generate is supplied.
  if (!dryRun && Object.keys(generated).length) {
    const lines = source.text.replace(/\r\n/g, '\n').split('\n')
    for (const [name, value] of Object.entries(generated)) {
      const entry = name + '=' + value
      let replaced = false
      for (let i = 0; i < lines.length; i++) {
        if (new RegExp('^\\s*' + name + '\\s*=').test(lines[i])) {
          lines[i] = entry
          replaced = true
        }
      }
      if (!replaced) lines.push(entry)
    }
    try { writeFileSync(source.file, lines.join('\r\n'), { mode: 0o600 }) } catch {
      throw new Error('Cannot save generated names to env file')
    }
  }
  const { secrets, skipped } = selectSecrets({ ...source.values, ...generated })
  const names = Object.keys(secrets)
  if (!dryRun && names.length) {
    // Wrangler stdin JSON, with no FILE argument:
    // https://developers.cloudflare.com/workers/wrangler/commands/workers/#secret-bulk
    // Only the fixed command enters a Windows shell. Values travel on stdin.
    let result
    try {
      result = run('npx', ['--no-install', 'wrangler', 'secret', 'bulk', '--name', 'pbjbillingapp'], {
        input: JSON.stringify(secrets),
        encoding: 'utf8',
        shell: process.platform === 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 120_000,
        env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
      })
    } catch { throw new Error('Secret upload failed; no values or child output shown') }
    if (result.error || result.status !== 0) {
      throw new Error('Secret upload failed; no values or child output shown')
    }
  }
  print((dryRun ? 'Would set: ' : 'Set: ') + (names.join(', ') || '(none)'))
  print('Skipped: ' + (skipped.join(', ') || '(none)'))
  return { names, skipped }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { uploadSecrets(process.argv.slice(2)) } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
