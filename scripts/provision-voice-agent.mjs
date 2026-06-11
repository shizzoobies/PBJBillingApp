/**
 * Provision the ElevenLabs voice agent (Phase: voice V1).
 *
 * Reads the persona system prompt (docs/voice-agent-persona.md) and the
 * capability manifest (docs/capability-manifest.md), then:
 *   1. uploads the manifest to the agent's knowledge base (create-from-text),
 *   2. PATCHes the agent: sets the system prompt, attaches the knowledge-base
 *      doc, and sets a greeting.
 *
 * It deliberately does NOT touch the agent's voice or LLM — those are set in
 * the ElevenLabs dashboard (a female voice + the hosted low-latency model).
 *
 * Run:  ELEVENLABS_API_KEY=sk_... ELEVENLABS_AGENT_ID=agent_... node scripts/provision-voice-agent.mjs
 * (the same vars already live in Railway for the running server)
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const API = 'https://api.elevenlabs.io/v1/convai'
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const apiKey = process.env.ELEVENLABS_API_KEY
const agentId = process.env.ELEVENLABS_AGENT_ID
if (!apiKey || !agentId) {
  console.error('Missing ELEVENLABS_API_KEY or ELEVENLABS_AGENT_ID in the environment.')
  process.exit(1)
}

const headers = { 'xi-api-key': apiKey, 'Content-Type': 'application/json' }

async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    json = { raw: text }
  }
  if (!res.ok) {
    throw new Error(`${method} ${url} -> ${res.status}: ${text.slice(0, 600)}`)
  }
  return json
}

/** Pull the system prompt out of the persona doc (between the two markers). */
function extractSystemPrompt(md) {
  const start = md.indexOf('## SYSTEM PROMPT')
  const end = md.indexOf('## Notes for provisioning')
  if (start === -1) throw new Error('Could not find "## SYSTEM PROMPT" in the persona doc.')
  let body = md.slice(start + '## SYSTEM PROMPT'.length, end === -1 ? undefined : end)
  // Drop leading/trailing horizontal rules and whitespace.
  body = body.replace(/^\s*-{3,}\s*/g, '').replace(/\s*-{3,}\s*$/g, '').trim()
  return body
}

async function main() {
  const personaMd = await readFile(path.join(root, 'docs', 'voice-agent-persona.md'), 'utf8')
  const manifest = await readFile(path.join(root, 'docs', 'capability-manifest.md'), 'utf8')
  const systemPrompt = extractSystemPrompt(personaMd)
  console.log(`System prompt: ${systemPrompt.length} chars`)
  console.log(`Manifest: ${manifest.length} chars`)

  console.log('\n1/2  Uploading the capability manifest to the knowledge base…')
  const kb = await call('POST', `${API}/knowledge-base/text`, {
    name: 'PB&J app knowledge (capability manifest)',
    text: manifest,
  })
  console.log(`     knowledge-base doc id: ${kb.id}`)

  console.log('\n2/2  Updating the agent (prompt + knowledge base + greeting)…')
  const updateBody = {
    conversation_config: {
      agent: {
        first_message: 'Hi Brittany — what can I help you with?',
        prompt: {
          prompt: systemPrompt,
          knowledge_base: [
            { type: 'text', name: 'PB&J app knowledge (capability manifest)', id: kb.id },
          ],
        },
      },
    },
  }
  const updated = await call('PATCH', `${API}/agents/${agentId}`, updateBody)
  console.log(`     agent updated: ${updated.agent_id || agentId}`)

  console.log('\nDone. The voice agent now has the PB&J persona + app knowledge.')
  console.log('Voice and LLM were left as configured in the dashboard.')
}

main().catch((error) => {
  console.error('\nProvisioning failed:\n', error.message)
  process.exit(1)
})
