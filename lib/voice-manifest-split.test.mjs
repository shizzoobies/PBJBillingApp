import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CORE_MAX_CHARS, FIRST_PAGE_SECTION, splitManifestForVoice } from './voice-manifest-split.js'

const sample = [
  '# Manifest',
  '',
  'Intro line.',
  '',
  '## How durations are displayed (site-wide rule)',
  '',
  'Rule text.',
  '',
  '## Navigation map',
  '',
  'Pages.',
  '',
  '## Dashboard',
  '',
  'Dashboard text.',
  '',
  '## Invoices',
  '',
  'Invoice text.',
  '',
].join('\n')

describe('splitManifestForVoice', () => {
  it('puts everything before the first page section in the core and the rest in the body', () => {
    const { core, body } = splitManifestForVoice(sample)
    expect(core).toContain('## Navigation map')
    expect(core).not.toContain('## Dashboard')
    expect(body.startsWith('## Dashboard\n')).toBe(true)
    expect(body).toContain('## Invoices')
    // nothing lost, nothing duplicated
    expect(core + body).toBe(sample)
  })

  it('reads a CRLF file the same as an LF one', () => {
    const crlf = splitManifestForVoice(sample.replace(/\n/g, '\r\n'))
    const lf = splitManifestForVoice(sample)
    expect(crlf).toEqual(lf)
  })

  it('refuses a manifest without the first page section heading', () => {
    expect(() => splitManifestForVoice(sample.replace('## Dashboard', '## Dash'))).toThrow(
      /no "## Dashboard" heading/,
    )
  })

  it('refuses an oversized core: the core rides in every voice turn', () => {
    const fat = sample.replace('Rule text.', 'x'.repeat(CORE_MAX_CHARS))
    expect(() => splitManifestForVoice(fat)).toThrow(/always-loaded core is/)
  })

  it('splits the real manifest: a small core and a body that starts at the first page', () => {
    const real = readFileSync(path.join(process.cwd(), 'docs', 'capability-manifest.md'), 'utf8')
    const { core, body } = splitManifestForVoice(real)
    expect(core.length).toBeLessThanOrEqual(CORE_MAX_CHARS)
    expect(core).toContain('## Navigation map')
    expect(body.startsWith(FIRST_PAGE_SECTION.trim())).toBe(true)
  })
})
