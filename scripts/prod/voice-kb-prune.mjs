#!/usr/bin/env node
// Lists (and with --apply deletes) the orphaned copies of the capability manifest in the
// ElevenLabs knowledge base. Every voice-provision run uploads a fresh copy and never deleted
// the previous one; on 2026-10-28 the workspace stopped persisting new uploads (the POST
// answered with an id that 404ed a second later), so provisioning failed at the agent update.
//
// Keeps: every document that is not a manifest copy, plus the copy the agent currently uses
// (read from the agent itself), plus any copy that lists a dependent agent.
// Usage: node scripts/prod/voice-kb-prune.mjs            (list only)
//        node scripts/prod/voice-kb-prune.mjs --apply    (delete the orphans)
import { prodEnv } from './env.mjs'

const NAME = 'PB&J app knowledge (capability manifest)'
const API = 'https://api.elevenlabs.io/v1/convai'
const env = { ...process.env, ...prodEnv(['ELEVENLABS_API_KEY', 'ELEVENLABS_AGENT_ID']) }
const apply = process.argv.includes('--apply')
const headers = { 'xi-api-key': env.ELEVENLABS_API_KEY }

async function call(method, path) {
  const response = await fetch(`${API}${path}`, { method, headers })
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : null
}

const agent = await call('GET', `/agents/${env.ELEVENLABS_AGENT_ID}`)
const attached = new Set((agent?.conversation_config?.agent?.prompt?.knowledge_base || []).map((doc) => doc.id))
let documents = []
let cursor = null
for (let page = 0; page < 50; page++) {
  const list = await call('GET', `/knowledge-base?page_size=100${cursor ? `&cursor=${cursor}` : ''}`)
  documents = documents.concat(list.documents || [])
  if (!list.has_more || !list.next_cursor) break
  cursor = list.next_cursor
}
const copies = documents.filter((doc) => doc.name === NAME)
const orphans = copies.filter((doc) => !attached.has(doc.id) && !(doc.dependent_agents || []).length)
console.log(`knowledge base: ${documents.length} documents, ${copies.length} manifest copies, ${attached.size} attached to the agent, ${orphans.length} orphaned`)
if (!apply) {
  console.log(orphans.length ? `run again with --apply to delete the ${orphans.length} orphaned copies` : 'nothing to delete')
  process.exit(0)
}
let deleted = 0
for (const doc of orphans) {
  await call('DELETE', `/knowledge-base/${doc.id}`)
  deleted++
}
console.log(`deleted ${deleted} orphaned manifest copies; kept ${[...attached].join(', ')}`)
