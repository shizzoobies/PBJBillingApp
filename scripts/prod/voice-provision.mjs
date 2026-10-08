#!/usr/bin/env node
// Re-provisions the voice agent with the environment Railway holds, so nobody pastes
// keys into a shell. Run from the repo root AT THE RELEASED COMMIT (the provisioner reads
// docs/capability-manifest.md next to itself - a tree mid-edit would ship a draft knowledge
// base). Usage: node scripts/prod/voice-provision.mjs
import { execSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const raw = execSync('npx @railway/cli@latest variables --service PBJBillingApp --json', {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
})
const vars = JSON.parse(raw)
const env = { ...process.env }
for (const key of ['ELEVENLABS_API_KEY', 'ELEVENLABS_AGENT_ID', 'APP_PUBLIC_URL', 'VOICE_TOOL_SECRET']) {
  if (!vars[key]) throw new Error(`missing ${key} in Railway variables`)
  env[key] = vars[key]
}
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'provision-voice-agent.mjs')
const result = spawnSync(process.execPath, [script], { env, stdio: 'inherit' })
process.exit(result.status ?? 1)
