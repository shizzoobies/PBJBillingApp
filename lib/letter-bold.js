/**
 * Bold text in the engagement letter (featreq-5e195707, Brittany's send-back of
 * 2026-10-10): she bolds a phrase in the email or the letter by wrapping it in
 * double asterisks, `**like this**`, which the B button and Ctrl/Cmd+B on the
 * Letters page type for her.
 *
 * Pure on purpose (no store, no env, no node built-ins): the page imports
 * `wrapBold` for the button, the server renders `boldRuns` into the email's
 * `<strong>` and the PDF's bold face. The placeholders are filled FIRST
 * (lib/letter-template.js knows nothing of asterisks) and the bold pass runs on
 * the filled text, so `**{{client_name}}**` bolds the client's name.
 *
 * The rule, kept small so nothing typed is ever swallowed:
 *  - `**` opens a run and the NEXT `**` closes it. The run is bold when there is
 *    something other than spaces between the two.
 *  - An opening `**` with no closing one, and an empty or blank pair (`****`,
 *    `** **`), stay in the text as typed.
 *  - Runs never cross a paragraph: the callers split on blank lines first.
 */

const MARK = '**'

/**
 * Split one paragraph into plain and bold runs.
 *
 * @param {string} text
 * @returns {Array<{text: string, bold: boolean}>}  in order; adjacent runs never both plain
 */
export function boldRuns(text) {
  const source = String(text ?? '')
  const runs = []
  let plain = ''
  let at = 0
  while (at < source.length) {
    const open = source.indexOf(MARK, at)
    if (open < 0) break
    const close = source.indexOf(MARK, open + MARK.length)
    if (close < 0) break
    const inner = source.slice(open + MARK.length, close)
    if (!inner.trim()) {
      // `****` or `** **`: not a run. Keep the opening marker as typed and look again after it.
      plain += source.slice(at, open + MARK.length)
      at = open + MARK.length
      continue
    }
    plain += source.slice(at, open)
    if (plain) runs.push({ text: plain, bold: false })
    plain = ''
    runs.push({ text: inner, bold: true })
    at = close + MARK.length
  }
  plain += source.slice(at)
  if (plain) runs.push({ text: plain, bold: false })
  return runs
}

/**
 * A blank line - two line breaks with nothing but spaces or tabs between them -
 * starts a new paragraph. The renderers and the B button (`wrapBold`) use this
 * same rule, so a selection bolded one paragraph at a time renders that way.
 */
export const PARAGRAPH_SPLIT = /\n[ \t]*\n/

/**
 * A letter's text as paragraphs of runs, ready to draw: split into paragraphs,
 * each paragraph's `**bold**` runs read from the text AS TYPED, then `fill`
 * applied inside each run. Reading the runs before filling means a filled-in
 * value is never markup: a client named "A**B" prints its asterisks, while
 * `**{{client_name}}**` still bolds the name.
 *
 * A paragraph is trimmed at its edges after filling, empty runs are dropped, and a
 * paragraph left blank (say, a placeholder that filled to nothing) is left out.
 *
 * @param {string} text  the template text (or already-filled text, with no `fill`)
 * @param {(text: string) => string} [fill]  fills the placeholders in one run
 * @returns {Array<Array<{text: string, bold: boolean}>>}
 */
export function letterParagraphs(text, fill = (value) => value) {
  const paragraphs = []
  for (const paragraph of String(text ?? '').replace(/\r\n?/g, '\n').split(PARAGRAPH_SPLIT)) {
    const runs = boldRuns(paragraph.trim())
      .map((run) => ({ text: String(fill(run.text) ?? ''), bold: run.bold }))
      .filter((run) => run.text !== '')
    if (runs.length > 0) {
      runs[0] = { ...runs[0], text: runs[0].text.trimStart() }
      const last = runs.length - 1
      runs[last] = { ...runs[last], text: runs[last].text.trimEnd() }
    }
    const kept = runs.filter((run) => run.text !== '')
    if (kept.some((run) => run.text.trim())) paragraphs.push(kept)
  }
  return paragraphs
}

/** The paragraph with its bold markers taken out (the email's plain-text part). Unmatched `**` stay. */
export function withoutBoldMarks(text) {
  return boldRuns(text)
    .map((run) => run.text)
    .join('')
}

/** A blank line between two paragraphs (PARAGRAPH_SPLIT), kept as a separator when a selection spans several. */
const PARAGRAPH_BREAK = /(\n[ \t]*\n\s*)/

/**
 * What the B button (and Ctrl/Cmd+B) does to a text box: wrap the selection in
 * `**`, or take the markers off when the selection is already bold. With no
 * selection it types `****` and puts the caret between the pairs. Spaces at the
 * edges of a selection are left outside the markers (a double-click selects the
 * word's trailing space), and a selection that spans paragraphs is bolded one
 * paragraph at a time, because a run never crosses a blank line.
 *
 * @param {string} value  the box's text
 * @param {number} start  selectionStart
 * @param {number} end    selectionEnd
 * @returns {{value: string, start: number, end: number}}  the new text and selection
 */
export function wrapBold(value, start, end) {
  const text = String(value ?? '')
  let from = Math.max(0, Math.min(Number(start) || 0, text.length))
  let to = Math.max(from, Math.min(Number(end) || 0, text.length))
  const selected = text.slice(from, to)
  const lead = selected.length - selected.trimStart().length
  const trail = selected.length - selected.trimEnd().length
  if (lead + trail >= selected.length) {
    // No selection (or only spaces): the caret goes between a fresh pair, or an empty pair
    // around the caret is taken back out.
    from = to
    if (text.slice(from - MARK.length, from) === MARK && text.slice(from, from + MARK.length) === MARK) {
      const next = text.slice(0, from - MARK.length) + text.slice(from + MARK.length)
      return { value: next, start: from - MARK.length, end: from - MARK.length }
    }
    const next = `${text.slice(0, from)}${MARK}${MARK}${text.slice(from)}`
    return { value: next, start: from + MARK.length, end: from + MARK.length }
  }
  from += lead
  to -= trail
  const inner = text.slice(from, to)

  // Already bold, markers just outside the selection: take them off.
  if (text.slice(from - MARK.length, from) === MARK && text.slice(to, to + MARK.length) === MARK) {
    const next = text.slice(0, from - MARK.length) + inner + text.slice(to + MARK.length)
    return { value: next, start: from - MARK.length, end: to - MARK.length }
  }
  // Already bold, markers inside the selection: take them off.
  if (inner.length > MARK.length * 2 && inner.startsWith(MARK) && inner.endsWith(MARK)) {
    const bare = inner.slice(MARK.length, -MARK.length)
    if (!bare.includes(MARK)) {
      const next = text.slice(0, from) + bare + text.slice(to)
      return { value: next, start: from, end: from + bare.length }
    }
  }

  const wrapped = inner
    .split(PARAGRAPH_BREAK)
    .map((piece, index) => {
      if (index % 2 === 1 || !piece.trim()) return piece
      const pieceLead = piece.slice(0, piece.length - piece.trimStart().length)
      const pieceTrail = piece.slice(piece.trimEnd().length)
      return `${pieceLead}${MARK}${piece.trim()}${MARK}${pieceTrail}`
    })
    .join('')
  const next = text.slice(0, from) + wrapped + text.slice(to)
  return { value: next, start: from, end: from + wrapped.length }
}
