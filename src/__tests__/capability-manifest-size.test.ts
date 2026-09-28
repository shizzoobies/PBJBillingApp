/**
 * Size tripwire for the capability manifest (docs/capability-manifest.md).
 *
 * The in-app assistant reads the whole file, and scripts/provision-voice-agent.mjs
 * uploads the whole file to the ElevenLabs voice agent's knowledge base, which
 * refuses anything above ~216,000 characters (the 2026-09-23 upload failed at
 * 224,772). The manifest was condensed to ~195 KB on 2026-09-28; this fails
 * verify at 205,000 so a ship that outgrows it is caught before the voice
 * provision is.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const LIMIT = 205_000
const WHY =
  "the voice agent's knowledge-base upload fails above ~216,000 characters; " +
  'condense the manifest (state each rule once) before shipping'

describe('capability manifest size', () => {
  const manifest = readFileSync(
    path.join(process.cwd(), 'docs', 'capability-manifest.md'),
    'utf8',
  )

  it(`stays at or under ${LIMIT.toLocaleString('en-US')} bytes`, () => {
    const bytes = Buffer.byteLength(manifest, 'utf8')
    expect(bytes, `manifest is ${bytes} bytes — ${WHY}`).toBeLessThanOrEqual(LIMIT)
  })

  it(`stays at or under ${LIMIT.toLocaleString('en-US')} characters`, () => {
    const chars = manifest.length
    expect(chars, `manifest is ${chars} characters — ${WHY}`).toBeLessThanOrEqual(LIMIT)
  })
})
