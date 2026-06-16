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

// Live-data tools (V2). Optional: skipped (with a warning) when the webhook
// base URL or shared secret isn't provided, so V1-style prompt/KB syncs still
// work standalone.
const appBaseUrl = (process.env.APP_PUBLIC_URL || '').replace(/\/$/, '')
const toolSecret = process.env.VOICE_TOOL_SECRET || ''

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

/**
 * The agent's live-data tools (V2): each is a webhook ElevenLabs POSTs to on
 * our server, authenticated by the shared x-voice-secret header. Read-only
 * analytics + the two memory tools.
 */
function toolDefinitions() {
  const def = (name, description, properties = {}, required = []) => ({
    tool_config: {
      type: 'webhook',
      name,
      description,
      response_timeout_secs: 15,
      api_schema: {
        url: `${appBaseUrl}/api/voice/tools/${name}`,
        method: 'POST',
        content_type: 'application/json',
        request_headers: { 'x-voice-secret': toolSecret },
        request_body_schema: {
          type: 'object',
          properties,
          required,
        },
      },
    },
  })

  return [
    def(
      'client_profitability',
      'Get per-client economics for a month: revenue, hours logged, realized rate (fee divided by hours), and margin where cost rates are set. Use for "how profitable is…", "which clients eat the most time".',
      { month: { type: 'string', description: 'Month as yyyy-mm. Omit for the current month.' } },
    ),
    def(
      'time_summary',
      'Get hours logged grouped by client and staff over a date range, split billable vs administrative. Use for "how many hours did X log on Y".',
      {
        from: { type: 'string', description: 'Start date yyyy-mm-dd. Omit for the start of this month.' },
        to: { type: 'string', description: 'End date yyyy-mm-dd. Omit for today.' },
        groupBy: { type: 'string', description: "One of 'client', 'staff', or 'both'. Defaults to both." },
      },
    ),
    def(
      'deadlines',
      'Get open tasks that are overdue or due soon, with client and assignee. Use for "what is overdue", "what is due this week".',
      { horizonDays: { type: 'number', description: 'Days ahead that count as due soon. Defaults to 7.' } },
    ),
    def(
      'capacity',
      'Get hours logged per team member this week versus the weekly target, flagging who is over or near capacity.',
      { targetHours: { type: 'number', description: 'Weekly target hours. Omit for the firm default.' } },
    ),
    def(
      'workspace_snapshot',
      "Get the firm's current setup: client names and billing modes, recurring template names and frequencies, plans, and team members.",
    ),
    def(
      'remember_fact',
      'Save one durable fact or preference the owner just told you, so future calls remember it. Use only for things worth keeping, not chit-chat.',
      { fact: { type: 'string', description: 'The fact to remember, as one self-contained sentence.' } },
      ['fact'],
    ),
    def(
      'recall_memory',
      'Search saved memories from previous conversations. Use before saying you do not know something the owner may have told you before.',
      { topic: { type: 'string', description: 'Keyword(s) to search for. Omit to get the most recent memories.' } },
    ),
    def(
      'build_report',
      'Generate a structured report from data you gathered and display it to the owner in a modal she can read and save as a PDF. Compose any report she asks for using sections of paragraphs, stat blocks, and/or tables. Use ONLY real numbers from your data tools. Gather the data first, then call this; do not read the whole report aloud.',
      {
        title: { type: 'string', description: 'Report title.' },
        subtitle: { type: 'string', description: 'Optional scope line, e.g. the period or client.' },
        sections: {
          type: 'array',
          description: 'Ordered report sections.',
          items: {
            type: 'object',
            description: 'One report section.',
            properties: {
              heading: { type: 'string', description: 'Section heading.' },
              paragraphs: {
                type: 'array',
                description: 'Plain-text paragraphs for this section.',
                items: { type: 'string', description: 'A paragraph of text.' },
              },
              stats: {
                type: 'array',
                description: 'Key figures shown as label/value tiles.',
                items: {
                  type: 'object',
                  description: 'One key figure.',
                  properties: {
                    label: { type: 'string', description: 'The figure label.' },
                    value: { type: 'string', description: 'The figure value, e.g. "$1,500".' },
                  },
                  required: ['label', 'value'],
                },
              },
              table: {
                type: 'object',
                description: 'Optional table for this section.',
                properties: {
                  columns: {
                    type: 'array',
                    description: 'Column headers.',
                    items: { type: 'string', description: 'A column header.' },
                  },
                  rows: {
                    type: 'array',
                    description: 'Table rows.',
                    items: {
                      type: 'array',
                      description: 'One row of cells, aligned to the columns.',
                      items: { type: 'string', description: 'A cell value.' },
                    },
                  },
                },
              },
            },
            required: ['heading'],
          },
        },
      },
      ['title', 'sections'],
    ),
    // ---- Action proposals (PROPOSE-ONLY) ----
    // These file a confirmation card in the app; they execute NOTHING. The
    // server endpoint behind them can only validate + park a proposal — the
    // change runs solely when the owner taps "Run it" in her signed-in panel.
    def(
      'make_template_recurring',
      'PROPOSE attaching an existing checklist template to a client on a recurring schedule. This only files a confirmation card in the app — nothing changes until the owner taps "Run it" there. Use exact names from workspace_snapshot.',
      {
        templateTitle: { type: 'string', description: 'Exact title of the existing template to copy.' },
        clientName: { type: 'string', description: 'Exact client name to attach it to.' },
        frequency: { type: 'string', description: 'One of weekly, monthly, quarterly, annually.' },
        firstDueDate: { type: 'string', description: 'Optional first due date yyyy-mm-dd.' },
      },
      ['templateTitle', 'clientName', 'frequency'],
    ),
    def(
      'assign_client',
      'PROPOSE giving a team member access to a client. Only files a confirmation card — nothing changes until the owner taps "Run it". Use exact names from workspace_snapshot.',
      {
        clientName: { type: 'string', description: 'Exact client name.' },
        bookkeeperName: { type: 'string', description: 'Exact team member name.' },
      },
      ['clientName', 'bookkeeperName'],
    ),
    def(
      'generate_tasks_now',
      'PROPOSE generating a task list right now from an existing template. Only files a confirmation card — nothing changes until the owner taps "Run it".',
      {
        templateTitle: { type: 'string', description: 'Exact template title.' },
        clientName: { type: 'string', description: 'Optional client name to disambiguate.' },
        dueDate: { type: 'string', description: 'Optional due date yyyy-mm-dd.' },
      },
      ['templateTitle'],
    ),
  ]
}

/** Create the tools, replacing any same-name tools from a previous run. */
async function syncTools() {
  const existing = await call('GET', `${API}/tools`)
  const byName = new Map(
    (existing.tools ?? []).map((t) => [t.tool_config?.name, t.id]).filter(([n]) => n),
  )
  const ids = []
  for (const definition of toolDefinitions()) {
    const name = definition.tool_config.name
    const previousId = byName.get(name)
    if (previousId) {
      try {
        const updated = await call('PATCH', `${API}/tools/${previousId}`, definition)
        ids.push(updated.id || previousId)
        console.log(`     updated tool ${name} (${previousId})`)
        continue
      } catch {
        console.log(`     could not update ${name}; recreating…`)
        await call('DELETE', `${API}/tools/${previousId}`).catch(() => {})
      }
    }
    const created = await call('POST', `${API}/tools`, definition)
    ids.push(created.id)
    console.log(`     created tool ${name} (${created.id})`)
  }
  return ids
}

async function main() {
  const personaMd = await readFile(path.join(root, 'docs', 'voice-agent-persona.md'), 'utf8')
  const manifest = await readFile(path.join(root, 'docs', 'capability-manifest.md'), 'utf8')
  const systemPrompt = extractSystemPrompt(personaMd)
  console.log(`System prompt: ${systemPrompt.length} chars`)
  console.log(`Manifest: ${manifest.length} chars`)

  console.log('\n1/3  Uploading the capability manifest to the knowledge base…')
  const kb = await call('POST', `${API}/knowledge-base/text`, {
    name: 'PB&J app knowledge (capability manifest)',
    text: manifest,
  })
  console.log(`     knowledge-base doc id: ${kb.id}`)

  let toolIds = null
  if (appBaseUrl && toolSecret) {
    console.log('\n2/3  Syncing live-data + memory tools…')
    toolIds = await syncTools()
  } else {
    console.log('\n2/3  SKIPPING tools (set APP_PUBLIC_URL + VOICE_TOOL_SECRET to enable).')
  }

  console.log('\n3/3  Updating the agent (prompt + knowledge base + greeting + tools)…')
  const updateBody = {
    conversation_config: {
      agent: {
        first_message: 'Hey {{owner_name}}! What can I help with?',
        prompt: {
          prompt: systemPrompt,
          knowledge_base: [
            { type: 'text', name: 'PB&J app knowledge (capability manifest)', id: kb.id },
          ],
          ...(toolIds ? { tool_ids: toolIds } : {}),
        },
      },
    },
  }
  const updated = await call('PATCH', `${API}/agents/${agentId}`, updateBody)
  console.log(`     agent updated: ${updated.agent_id || agentId}`)

  console.log('\nDone. Persona + knowledge base synced' + (toolIds ? ` + ${toolIds.length} tools attached.` : '.'))
  console.log('Voice and LLM were left as configured in the dashboard.')
}

main().catch((error) => {
  console.error('\nProvisioning failed:\n', error.message)
  process.exit(1)
})
