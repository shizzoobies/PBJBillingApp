/**
 * An engagement letter as eSignatures.io Markdown (featreq-56d39567, task 18; docs/esignatures.md).
 * eSignatures.io takes no PDF: a contract is made from a Markdown template, so the FILLED letter -
 * the same runs the PDF draws (lib/engagement-documents.js) - is written out as Markdown here.
 * No placeholders are left for eSignatures to fill. Pure and deterministic.
 *
 * The layout: the firm name as a `##` heading, under it the firm's address and contact lines (the SAME
 * lines the letterhead PDF prints - lib/firm-lines.js `firmDetailLines`), the date line, the addressee
 * lines, then the body paragraphs, bold runs as `**bold**`, a line break inside a paragraph as a hard
 * break (two spaces). A section heading (`isSectionHeading`: a short line alone in its paragraph, with
 * text after it) is written bold, since eSignatures.io draws everything else in one plain face.
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
 * Letter text is escaped so it prints as typed: `\` `*` `_` `` ` `` `[` `]` `<` everywhere, `#` `>` `-`
 * `+` `1.` and a `---` / `===` line at a line start, and `{{` (eSignatures' own placeholder syntax).
 */

import { firmDetailLines } from './firm-lines.js'
import { letterParagraphs } from './letter-bold.js'
import { mailingAddressLines } from './mailing-address.js'

const DEFAULT_FIRM_NAME = 'PB&J Strategic Accounting'

/** The label of the mandatory checkbox an initials tag becomes. */
export const ESIGNATURES_INITIALS_LABEL = 'Initials: I have read and agree to the section above'

/**
 * The letter's own blank "Signature:" or "Date:" line - nothing after the label but underscores (the platform
 * signs and dates the letter itself). "Date: October 1, 2026 ..." is letter text and stays.
 */
const SIGNING_LINE = /^\s*(signature|date)\s*:[\s_]*$/i
/** A blank to fill in: a line of underscores, or a short label followed only by underscores. */
const BLANK_LINE = /^\s*(?:[A-Za-z][A-Za-z .'/-]{0,40}:)?\s*_{3,}[\s_]*$/

/** Markdown-escape letter text so it prints as typed. Line-start `#` and `>` are handled per line. */
export function escapeMarkdown(text) {
  return String(text ?? '')
    .replace(/[\\`*_[\]<]/g, (char) => `\\${char}`)
    .replace(/\{\{/g, '\\{\\{')
}

/**
 * One line of text with what Markdown reads at a line start escaped: `#` (heading), `>` (quote), `-` / `+`
 * (a list), `1.` / `1)` (a numbered list), and a line of only `-` or `=` (a rule, or a heading underline:
 * every one escaped).
 */
function escapeLineStart(line) {
  if (/^\s*[-=][-=\s]*$/.test(line)) return line.replace(/[-=]/g, (char) => `\\${char}`)
  return line.replace(/^(\s*)([#>+-])/, '$1\\$2').replace(/^(\s*\d{1,9})([.)])(?=\s|$)/, '$1\\$2')
}

const clean = (value) => String(value ?? '').trim()

/** The longest line that can be a section heading. */
export const SECTION_HEADING_MAX_LENGTH = 80
/** "Dear Pat,", "Hello Pat", "To whom it may concern:" - a greeting, never a heading. */
const SALUTATION = /^(?:dear|hi|hello|greetings|good (?:morning|afternoon|evening)|to whom)\b/i
/** A sign-off ("Sincerely,", "Best regards", "Thank you!") - never a heading, and nothing after it is one. */
const CLOSING =
  /^(?:sincerely|regards|best|best regards|kind regards|warm regards|warmest regards|warmly|respectfully|respectfully yours|yours|yours truly|truly yours|very truly yours|yours sincerely|cordially|thank you|thanks|many thanks|with thanks|with gratitude|all the best)(?:\s+(?:again|so much))?\s*[,.!]?$/i

/** True for a sign-off line such as "Sincerely," (see CLOSING). */
export function isClosingLine(text) {
  return CLOSING.test(clean(text))
}

/**
 * THE section-heading rule (one copy; the e-sign Markdown and its preview both use it). A heading is a
 * body line that stands alone as its own paragraph (`aloneInParagraph`), is at most 80 characters, has a
 * letter in it, does not end with a period (nor a comma or semicolon - a sentence or a greeting does), is
 * not a greeting ("Dear ...") or a sign-off ("Sincerely,"), and is followed by a paragraph or a list
 * (`followedByText`: not a signer field, not the end of the letter). The caller also stops looking after
 * the sign-off, so a signature block ("Brittany Ferguson, CPA") is never bolded.
 *
 * @param {string} text  the line as it prints (no Markdown)
 * @param {{aloneInParagraph: boolean, followedByText: boolean}} where
 */
export function isSectionHeading(text, { aloneInParagraph, followedByText }) {
  const line = clean(text)
  if (!aloneInParagraph || !followedByText) return false
  if (!line || line.length > SECTION_HEADING_MAX_LENGTH || !/\p{L}/u.test(line)) return false
  if (/[.,;]$/.test(line)) return false
  return !SALUTATION.test(line) && !isClosingLine(line)
}

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

/**
 * One line's segments (runs cut at line breaks) as Markdown: bold as `**...**`, spaces kept outside the
 * markers. A bold run ending in punctuation right before a letter or digit gets a space after it: Markdown
 * does not close `**Fees:**due` (the closing marker would sit between punctuation and a letter).
 */
function renderSegments(segments) {
  const text = segments
    .map((segment, index) => {
      if (!segment.bold) return escapeMarkdown(segment.text)
      const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(segment.text)
      if (!core) return segment.text
      const next = segments[index + 1]?.text ?? ''
      const space = !trail && /[\p{P}\p{S}]$/u.test(core) && /^[\p{L}\p{N}]/u.test(next) ? ' ' : ''
      return `${lead}**${escapeMarkdown(core)}**${trail}${space}`
    })
    .join('')
  return escapeLineStart(text.trimEnd())
}

/**
 * One paragraph of runs as blocks: its text lines (`{ kind: 'text', lines: [{ segments, plain }] }`, hard
 * breaks between them when written) and, for each e-sign tag, a field line as a block of its own
 * (`{ kind: 'field', markdown }`: a field must be alone on its line).
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
    if (current.length > 0) blocks.push({ kind: 'text', lines: current })
    current = []
  }
  for (const line of lines) {
    if ('field' in line) {
      flush()
      if (line.field) blocks.push({ kind: 'field', markdown: line.field })
      continue
    }
    const plain = line.segments.map((segment) => segment.text).join('')
    if (!plain.trim() || SIGNING_LINE.test(plain) || BLANK_LINE.test(plain)) continue
    current.push({ segments: line.segments, plain })
  }
  flush()
  return blocks
}

/** A text block's lines as Markdown (hard breaks between them); `heading` writes its one line bold. */
function textBlockMarkdown(block, heading) {
  if (heading) return renderSegments([{ text: block.lines[0].plain.trim(), bold: true }])
  return block.lines.map((line) => renderSegments(line.segments).replace(/^\s+/, '')).join('  \n')
}

/**
 * @param {object} args  what lib/engagement-documents.js hands a PDF builder
 * @param {Array<Array<{text: string, bold: boolean, esignTag?: true}>>} [args.paragraphs]  the letter as runs
 * @param {string} [args.bodyText]       read with `letterParagraphs` when no runs are given
 * @param {object} [args.client]         the addressee: name and mailing address
 * @param {object} [args.firmSettings]   the firm's name, address and contact (firmDetailLines)
 * @param {string} [args.dateLabel]      the date line
 * @returns {string} the Markdown, ending in one newline
 */
export function letterMarkdown({ paragraphs, bodyText = '', client = {}, firmSettings = null, dateLabel = '' } = {}) {
  const firmName = clean(firmSettings?.name) || DEFAULT_FIRM_NAME
  const blocks = [`## ${escapeMarkdown(firmName)}`]
  const firmLines = firmDetailLines(firmSettings)
  if (firmLines.length > 0) blocks.push(firmLines.map((line) => escapeLineStart(escapeMarkdown(line))).join('  \n'))
  const date = clean(dateLabel)
  if (date) blocks.push(escapeLineStart(escapeMarkdown(date)))
  const addressee = [clean(client?.name), ...mailingAddressLines(client)].filter(Boolean)
  if (addressee.length > 0) blocks.push(addressee.map((line) => escapeLineStart(escapeMarkdown(line))).join('  \n'))
  const counters = {}
  const runs = Array.isArray(paragraphs) ? paragraphs : letterParagraphs(bodyText)
  // Each paragraph's blocks, kept per paragraph: "alone in its paragraph" means the paragraph made exactly
  // one block, of one text line.
  const body = runs
    .filter((paragraph) => Array.isArray(paragraph) && paragraph.length > 0)
    .map((paragraph) => paragraphBlocks(paragraph, counters))
    .filter((made) => made.length > 0)
  let signedOff = false
  body.forEach((made, index) => {
    const alone = made.length === 1 && made[0].kind === 'text' && made[0].lines.length === 1
    const next = body[index + 1]?.[0]
    for (const block of made) {
      if (block.kind === 'field') {
        blocks.push(block.markdown)
        continue
      }
      const heading =
        !signedOff && isSectionHeading(block.lines[0].plain, { aloneInParagraph: alone, followedByText: next?.kind === 'text' })
      if (block.lines.some((line) => isClosingLine(line.plain))) signedOff = true
      blocks.push(textBlockMarkdown(block, heading))
    }
  })
  return `${blocks.join('\n\n')}\n`
}
