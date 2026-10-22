#!/usr/bin/env node
// Re-provisions the voice agent with the local production environment, so nobody pastes
// keys into a shell. Run from the repo root AT THE RELEASED COMMIT (the provisioner reads
// docs/capability-manifest.md next to itself - a tree mid-edit would ship a draft knowledge
// base). Usage: node scripts/prod/voice-provision.mjs
import { spawnSync } from 'node:child_process'
import { prodEnv } from './env.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const env = { ...process.env, ...prodEnv(['ELEVENLABS_API_KEY', 'ELEVENLABS_AGENT_ID', 'APP_PUBLIC_URL', 'VOICE_TOOL_SECRET']) }
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'provision-voice-agent.mjs')
const result = spawnSync(process.execPath, [script], { env, stdio: 'inherit' })
process.exit(result.status ?? 1)
