/**
 * Size tripwire for the capability manifest (docs/capability-manifest.md).
 *
 * Two readers, two limits:
 *
 *   - The in-app assistant (lib/assistant.js) sends the WHOLE file as a cached
 *     system-prompt block on every chat turn. The cap here is cost and model
 *     attention, not a hard refusal: 400,000 bytes is roughly 100k tokens, half
 *     the model's context, leaving room for the conversation and tool results.
 *     Until 2026-11-01 the cap was 205,000, set by the voice agent's
 *     whole-document knowledge-base upload (ElevenLabs refused ~216,000+
 *     characters; the 2026-09-23 upload failed at 224,772). The voice agent now
 *     reads the manifest by retrieval (lib/voice-manifest-split.js), so that
 *     limit no longer applies and the manifest is no longer trimmed to fit.
 *
 *   - The voice agent's always-loaded CORE (everything before the first page
 *     section) rides in every voice turn, so it must stay small. The split
 *     helper enforces CORE_MAX_CHARS and refuses a manifest whose first page
 *     heading moved; this test runs it against the real file so a ship that
 *     breaks the voice provision fails verify first.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CORE_MAX_CHARS, splitManifestForVoice } from '../../lib/voice-manifest-split.js'

const LIMIT = 400_000
const WHY =
  'the in-app assistant carries the whole manifest in its prompt on every turn; ' +
  'condense (state each rule once) or move detail behind a tool before shipping'

describe('capability manifest size', () => {
  // Measured as the Linux CI runner and the assistant see it: LF. A Windows
  // checkout (autocrlf) writes CRLF to the working copy, which would add one byte
  // per line (about 770 here) to a cap that is about the content.
  const manifest = readFileSync(
    path.join(process.cwd(), 'docs', 'capability-manifest.md'),
    'utf8',
  ).replace(/\r\n/g, '\n')

  it(`stays at or under ${LIMIT.toLocaleString('en-US')} bytes`, () => {
    const bytes = Buffer.byteLength(manifest, 'utf8')
    expect(bytes, `manifest is ${bytes} bytes - ${WHY}`).toBeLessThanOrEqual(LIMIT)
  })

  it(`stays at or under ${LIMIT.toLocaleString('en-US')} characters`, () => {
    const chars = manifest.length
    expect(chars, `manifest is ${chars} characters - ${WHY}`).toBeLessThanOrEqual(LIMIT)
  })

  it('splits for the voice agent: a small always-loaded core and a retrieval body', () => {
    const { core, body } = splitManifestForVoice(manifest)
    expect(core.length).toBeLessThanOrEqual(CORE_MAX_CHARS)
    expect(core).toContain('## Navigation map')
    expect(body.length).toBeGreaterThan(core.length)
    // nothing lost between the two uploads
    expect(core + body).toBe(manifest)
  })
})
