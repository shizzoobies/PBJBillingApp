/**
 * An engagement letter as eSignatures.io Markdown (featreq-56d39567, task 18; docs/esignatures.md).
 * eSignatures.io takes no PDF: a contract is made from a Markdown template, so the FILLED letter -
 * the same runs the PDF draws (lib/engagement-documents.js) - is written out as Markdown here.
 * No placeholders are left for eSignatures to fill. Pure and deterministic.
 *
 * The layout: the firm name as a `##` heading, the date line, the addressee lines, then the body
 * paragraphs, bold runs as `**bold**`, a line break inside a paragraph as a hard break (two spaces).
 *
 * The SignWell field tags a letter may carry (lib/letter-template.js `isEsignTag`) become
 * eSignatures.io "extended markdown" signer fields - each on a line of its own, the JSON config in
 * backticks at the END of the line (their docs; one signer field per line):
 *  - `{{initial:...}}` / `{{i:...}}` -> a MANDATORY checkbox "Initials: I have read and agree to the
 *    section above" (eSignatures has no initials field; its docs say to use a mandatory checkbox);
 *  - `{{text:...}}` -> a text input (label = the tag's label part, required per its y/n flag);
 *  - `{{check:...}}` / `{{c:...}}` -> a checkbox (label = the tag's label part, required per y/n);
 *  - `{{signature:...}}` / `{{date:...}}` -> dropped: eSignatures renders ONE signature section at the
 *    end itself (name, date, IP), and a signature block in the template is not supported.
 * For the same reason the letter's own "Signature:" and "Date:" lines and its blank-to-fill lines
 * ("Printed name: ______", a line of underscores) are left out.
 *
 * Letter text is escaped so it prints as typed: `\` `*` `_` `` ` `` `[` `]` `<` everywhere, `#` and
 * `>` at a line start, and `{{` (eSignatures' own placeholder syntax).
 */

import { letterParagraphs } from './letter-bold.js'
import { mailingAddressLines } from './mailing-address.js'

const DEFAULT_FIRM_NAME = 'PB&J Strategic Accounting'

/** The label of the mandatory checkbox an initials tag becomes. */
export const ESIGNATURES_INITIALS_LABEL = 'Initials: I have read and agree to the section above'

/** A "Signature:" or "Date:" line, whatever follows it (the platform signs and dates the letter itself). */
const SIGNING_LINE = /^\s*(signature|date)\s*:/i
/** A blank to fill in: a line of underscores, or a short label followed only by underscores. */
const BLANK_LINE = /^\s*(?:[A-Za-z][A-Za-z .'/-]{0,40}:)?\s*_{3,}[\s_]*$/

/** Markdown-escape letter text so it prints as typed. Line-start `#` and `>` are handled per line. */
export function escapeMarkdown(text) {
  return String(text ?? '')
    .replace(/[\\`*_[\]<]/g, (char) => `\\${char}`)
    .replace(/\{\{/g, '\\{\\{')
}

/** One line of text, its line-start `#` / `>` escaped too. */
const escapeLineStart = (line) => line.replace(/^(\s*)([#>])/, '$1\\$2')

const clean = (value) => String(value ?? '').trim()

/** A signer-field line: the label, a space, then the JSON config in backticks. */
const fieldLine = (label, config) => `${escapeMarkdown(label)} \`${JSON.stringify(config)}\``

/**
 * What one e-sign tag becomes: a field line, or null (dropped). `counters` numbers each field type so
 * every signer_field_id is unique in the letter.
 */
function tagLine(tag, counters) {
  const parts = String(tag).slice(2, -2).split(':')
  const type = parts[0].toLowerCase()
  const required = (parts[2] ?? 'y').toLowerCase() !== 'n'
  const label = clean(String(parts[3] ?? '').replace(/_/g, ' '))
  const next = (kind) => {
    counters[kind] = (counters[kind] ?? 0) + 1
    return `${kind}_${counters[kind]}`
  }
  if (type === 'initial' || type === 'i') {
    return fieldLine(ESIGNATURES_INITIALS_LABEL, {
      line_type: 'checkbox',
      input_type: 'every_signer',
      input_required: 'yes',
      signer_field_id: next('initials'),
    })
  }
  if (type === 'text') {
    return fieldLine(label || 'Your answer', {
      line_type: 'text-input',
      input_type: 'only_first_signer',
      input_required: required ? 'yes' : 'no',
      signer_field_id: next('text'),
    })
  }
  if (type === 'check' || type === 'c') {
    return fieldLine(label || 'I agree', {
      line_type: 'checkbox',
      input_type: 'every_signer',
      input_required: required ? 'yes' : 'no',
      signer_field_id: next('check'),
    })
  }
  return null // signature, date: the platform's own signature section covers them
}

/** One line's segments (runs cut at line breaks) as Markdown: bold as `**...**`, spaces kept outside the markers. */
function renderSegments(segments) {
  const text = segments
    .map((segment) => {
      if (!segment.bold) return escapeMarkdown(segment.text)
      const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(segment.text)
      return core ? `${lead}**${escapeMarkdown(core)}**${trail}` : segment.text
    })
    .join('')
  return escapeLineStart(text.trimEnd())
}

/**
 * One paragraph of runs as Markdown blocks: its text lines (hard breaks between them) and, for each
 * e-sign tag, a field line as a block of its own (a field must be alone on its line).
 */
function paragraphBlocks(runs, counters) {
  const lines = [{ segments: [] }]
  for (const run of runs) {
    if (run.esignTag) {
      lines.push({ field: tagLine(run.text, counters) }, { segments: [] })
      continue
    }
    String(run.text).split('\n').forEach((piece, index) => {
      if (index > 0) lines.push({ segments: [] })
      lines.at(-1).segments.push({ text: piece, bold: Boolean(run.bold) })
    })
  }
  const blocks = []
  let current = []
  const flush = () => {
    if (current.length > 0) blocks.push(current.join('  \n'))
    current = []
  }
  for (const line of lines) {
    if ('field' in line) {
      flush()
      if (line.field) blocks.push(line.field)
      continue
    }
    const plain = line.segments.map((segment) => segment.text).join('')
    if (!plain.trim() || SIGNING_LINE.test(plain) || BLANK_LINE.test(plain)) continue
    current.push(renderSegments(line.segments).replace(/^\s+/, ''))
  }
  flush()
  return blocks
}

/**
 * @param {object} args  what lib/engagement-documents.js hands a PDF builder
 * @param {Array<Array<{text: string, bold: boolean, esignTag?: true}>>} [args.paragraphs]  the letter as runs
 * @param {string} [args.bodyText]       read with `letterParagraphs` when no runs are given
 * @param {object} [args.client]         the addressee: name and mailing address
 * @param {object} [args.firmSettings]   the firm's name
 * @param {string} [args.dateLabel]      the date line
 * @returns {string} the Markdown, ending in one newline
 */
export function letterMarkdown({ paragraphs, bodyText = '', client = {}, firmSettings = null, dateLabel = '' } = {}) {
  const firmName = clean(firmSettings?.name) || DEFAULT_FIRM_NAME
  const blocks = [`## ${escapeMarkdown(firmName)}`]
  const date = clean(dateLabel)
  if (date) blocks.push(escapeLineStart(escapeMarkdown(date)))
  const addressee = [clean(client?.name), ...mailingAddressLines(client)].filter(Boolean)
  if (addressee.length > 0) blocks.push(addressee.map((line) => escapeLineStart(escapeMarkdown(line))).join('  \n'))
  const counters = {}
  const runs = Array.isArray(paragraphs) ? paragraphs : letterParagraphs(bodyText)
  for (const paragraph of runs) {
    if (Array.isArray(paragraph) && paragraph.length > 0) blocks.push(...paragraphBlocks(paragraph, counters))
  }
  return `${blocks.join('\n\n')}\n`
}
