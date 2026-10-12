/**
 * Assemble an engagement letter from the section library
 * (docs/plans/engagements-2026-10.md, stage 2A).
 *
 * Pure: the sections and the proposal's priced lines in, the three text boxes out -
 * still with their `{{placeholders}}`, which `lib/engagement-documents.js` fills at
 * preview and send time (so a later edit to the party or the retainer shows up
 * without re-assembling). Each letter section prints as a `**Title**` line, a blank
 * line and its body (the `**bold**` rule of lib/letter-bold.js); the intro prints no
 * title, and a section whose body is blank is left out.
 */

import { EMAIL_SECTION_KEY, INTRO_SECTION_KEY, triggeredSections } from './engagement-sections.js'

export const ENGAGEMENT_KINDS = Object.freeze(['original', 'amendment', 'superseding'])

/** The subject per kind, placeholders left for the filler. */
export const ENGAGEMENT_SUBJECTS = Object.freeze({
  original: 'Engagement letter - {{client_name}}',
  superseding: 'Updated engagement letter - {{client_name}}',
  amendment: 'Engagement amendment - {{client_name}}',
})

const normalized = (value) => String(value ?? '').replace(/\r\n?/g, '\n').trim()

/** A title as one line, without `**` (which would end the bold run early). */
const titleLine = (title) => String(title ?? '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim()

/**
 * @param {object} args
 * @param {ReadonlyArray<object>} args.sections  the library (stored rows or DEFAULT_ENGAGEMENT_SECTIONS)
 * @param {{lines?: ReadonlyArray<object>}|null} [args.snapshot]  the proposal's priced snapshot (or the engagement's figures)
 * @param {'original'|'amendment'|'superseding'} [args.kind]  anything else reads as 'original'
 * @param {object} [args.party]     accepted for the callers' symmetry; the text keeps placeholders
 * @param {string} [args.firmName]  accepted for the callers' symmetry; the text keeps placeholders
 * @returns {{subject: string, emailBody: string, letterBody: string, sectionKeys: string[]}}
 *   `sectionKeys`: the letter sections used, in order (the email section is not listed).
 */
export function assembleEngagement({ sections, snapshot = null, kind = 'original' } = {}) {
  const library = Array.isArray(sections) ? sections : []
  const subject = ENGAGEMENT_SUBJECTS[ENGAGEMENT_KINDS.includes(kind) ? kind : 'original']

  const email = library.find(
    (section) => section && section.active !== false && section.key === EMAIL_SECTION_KEY,
  )
  const emailBody = normalized(email?.body)

  const lines = Array.isArray(snapshot?.lines) ? snapshot.lines : []
  const parts = []
  const sectionKeys = []
  for (const section of triggeredSections(library, lines)) {
    const body = normalized(section.body)
    if (!body) continue
    const title = section.key === INTRO_SECTION_KEY ? '' : titleLine(section.title)
    parts.push(title ? `**${title}**\n\n${body}` : body)
    sectionKeys.push(section.key)
  }
  return { subject, emailBody, letterBody: parts.join('\n\n'), sectionKeys }
}
