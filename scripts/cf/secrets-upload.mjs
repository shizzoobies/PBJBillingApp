#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readEnvFile } from '../prod/env.mjs'
import { CONTAINER_ENV_NAMES } from '../../cloudflare/env-names.js'

export const DEFAULT_ROTATION_FILE = 'D:\\PBJ Accounting Work\\secrets\\rotation-2026-10-21.env'

// Remove // and /* */ comments (outside strings) and trailing commas from a .jsonc text.
export function parseJsonc(text) {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end < 0) throw new Error('Unterminated comment in wrangler.jsonc')
      i = end + 1
    } else out += ch
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

const WRANGLER_CONFIG = fileURLToPath(new URL('../../wrangler.jsonc', import.meta.url))
export const WRANGLER_VARS = Object.freeze(Object.keys(parseJsonc(readFileSync(WRANGLER_CONFIG, 'utf8')).vars ?? {}))

// Every name the container may receive, except the plain settings wrangler.jsonc declares
// as vars. Everything else - addresses, ids, switches, keys - is uploaded as a Worker secret,
// because the repo is public.
export const SECRET_NAMES = Object.freeze(CONTAINER_ENV_NAMES.filter((name) => !WRANGLER_VARS.includes(name)))
const GENERATED_NAMES = ['JWT_SECRET', 'VOICE_TOOL_SECRET', 'TICK_TOKEN']

// A database holding real data must never go live un-gated: the same upload has to carry
// MAINTENANCE_MODE=1 (blocks writes, jobs and webhooks until /health is checked).
export function assertMaintenanceGate(values, allowLive = false) {
  const has = (name) => String(values[name] ?? '').trim() !== ''
  if (has('DATABASE_URL') && !has('MAINTENANCE_MODE') && !allowLive) {
    throw new Error(
      'Refusing to upload DATABASE_URL without MAINTENANCE_MODE (set MAINTENANCE_MODE=1 in the env file, or pass --allow-live)',
    )
  }
}

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
  if (positional.length > 1 || argv.some((arg) => arg.startsWith('--') && !['--dry-run', '--generate', '--allow-live'].includes(arg))) {
    throw new Error('Usage: node scripts/cf/secrets-upload.mjs [env-file] [--dry-run] [--generate] [--allow-live]')
  }
  const dryRun = argv.includes('--dry-run')
  const generate = argv.includes('--generate')
  const source = readEnvFile(positional[0] || DEFAULT_ROTATION_FILE)
  assertMaintenanceGate(source.values, argv.includes('--allow-live'))
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
