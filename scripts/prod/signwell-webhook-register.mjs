#!/usr/bin/env node
// Registers (or removes) the app's SignWell webhook (featreq-56d39567; docs/signwell.md).
// Usage: node scripts/prod/signwell-webhook-register.mjs            list the hooks, create ours if absent
//        node scripts/prod/signwell-webhook-register.mjs --delete <id>   remove one hook
//
// SIGNWELL_API_KEY and APP_PUBLIC_URL come from the environment when both are set, else
// from the Railway service variables (the way voice-provision.mjs reads them), so nobody
// pastes a key into a shell. NEITHER is ever printed - not the key, not the callback URL.
// A webhook id is a SECRET too (it is the key SignWell signs events with): only OUR hook's id is
// printed (to be set on Railway), never the ids of any other hook on the account.
//
// SignWell sends every event type to the one callback URL and signs it with the webhook's
// id, so the id printed here is what must be set as SIGNWELL_WEBHOOK_ID on the Railway service.
import { execSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

import { createWebhook, deleteWebhook, listWebhooks } from '../../lib/signwell.js'

const CALLBACK_PATH = '/api/signwell/webhook'

/** The two variables, from `env` or, for what is missing there, the Railway service. */
export function resolveEnvironment(env, readRailway = railwayVariables) {
  const wanted = ['SIGNWELL_API_KEY', 'APP_PUBLIC_URL']
  if (wanted.every((key) => String(env[key] ?? '').trim())) return { ...env }
  const vars = readRailway()
  const merged = { ...env }
  for (const key of wanted) {
    if (!String(merged[key] ?? '').trim()) merged[key] = vars[key]
    if (!String(merged[key] ?? '').trim()) throw new Error(`missing ${key} (not in the environment or the Railway variables)`)
  }
  return merged
}

function railwayVariables() {
  const raw = execSync('npx @railway/cli@latest variables --service PBJBillingApp --json', {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  return JSON.parse(raw)
}

/** `${APP_PUBLIC_URL}/api/signwell/webhook`, without a doubled slash. */
export const callbackUrlFor = (appPublicUrl) => `${String(appPublicUrl).trim().replace(/\/+$/, '')}${CALLBACK_PATH}`

/**
 * @param {{env: object, argv?: string[], api?: object, print?: (line: string) => void, readRailway?: Function}} args
 * @returns {Promise<{created: object|null, deleted: string|null, existing: object[]}>}
 */
export async function registerWebhook({ env, argv = [], api = { listWebhooks, createWebhook, deleteWebhook }, print = console.log, readRailway }) {
  const resolved = resolveEnvironment(env, readRailway)
  const options = { env: resolved }
  const deleteAt = argv.indexOf('--delete')
  if (deleteAt !== -1) {
    const id = String(argv[deleteAt + 1] ?? '').trim()
    if (!id) throw new Error('--delete needs the webhook id')
    await api.deleteWebhook(id, options)
    print(`removed webhook ${id}`)
    return { created: null, deleted: id, existing: [] }
  }

  const callbackUrl = callbackUrlFor(resolved.APP_PUBLIC_URL)
  const hooks = await api.listWebhooks(options)
  const existing = Array.isArray(hooks) ? hooks : []
  print(`${existing.length} webhook(s) registered`)
  const ours = existing.find((hook) => hook.callback_url === callbackUrl)
  if (ours) {
    print('')
    print(`The app's webhook already exists: ${ours.id}`)
    print(`Set SIGNWELL_WEBHOOK_ID to ${ours.id} on the Railway service (if it is not already).`)
    return { created: null, deleted: null, existing }
  }
  const created = await api.createWebhook(callbackUrl, options)
  print('')
  print(`created webhook ${created.id}`)
  print(`Set SIGNWELL_WEBHOOK_ID to ${created.id} on the Railway service.`)
  return { created, deleted: null, existing }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  registerWebhook({ env: process.env, argv: process.argv.slice(2) }).catch((error) => {
    // The message carries SignWell's status and text, never the key (lib/signwell.js).
    console.error(error?.message || error)
    process.exit(1)
  })
}
