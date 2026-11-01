/**
 * The e-sign Markdown (lib/letter-markdown.js) as HTML, drawn the plain way eSignatures.io presents a
 * contract - for the honest preview at Send for signature (owner app, a sandboxed frame). It is NOT a
 * general Markdown renderer: it reads only what `letterMarkdown` writes, and every character of text is
 * HTML-escaped, so nothing in a letter (raw HTML, a `<script>`, an `{{...}}` tag) can become markup.
 *
 * What it reads:
 *  - `#` .. `######` headings (the firm name is `##`);
 *  - paragraphs separated by a blank line; a line ending in two spaces is a line break;
 *  - `**bold**`, `*italic*` / `_italic_`;
 *  - backslash escapes (`\-Review ...` prints "-Review ...", as eSignatures.io prints it);
 *  - `- item` / `* item` / `+ item` and `1. item` lists (the letter's own list lines are escaped, so they
 *    print as typed; a real list only comes from Markdown written elsewhere);
 *  - an eSignatures.io signer-field line (`Label \`{"line_type":...}\``) as the field it becomes: a checkbox
 *    or an empty answer box with its label (an initials tag is the "Initials: I have read and agree to
 *    the section above" checkbox).
 * At the end: a placeholder box "Signature block added by the signing service" (eSignatures.io appends its
 * own signature section and audit trail), and at the top the logo when one goes with the contract.
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char])

/** The placeholder box's words. */
export const ESIGN_SIGNATURE_BLOCK_LABEL = 'Signature block added by the signing service'

/** A plain, provider-like page: one sans-serif face, generous spacing, no letterhead. */
export const ESIGN_PREVIEW_STYLE = [
  'body{margin:0;background:#fff;color:#222;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.55}',
  '.esign-doc{max-width:720px;margin:0 auto;padding:28px 32px 40px}',
  '.esign-doc img.esign-logo{display:block;max-width:200px;max-height:80px;margin:0 0 18px}',
  '.esign-doc h1,.esign-doc h2,.esign-doc h3,.esign-doc h4,.esign-doc h5,.esign-doc h6{margin:0 0 12px;font-weight:700;line-height:1.3}',
  '.esign-doc h2{font-size:22px}',
  '.esign-doc p{margin:0 0 12px}',
  '.esign-doc ul,.esign-doc ol{margin:0 0 12px;padding-left:24px}',
  '.esign-doc .esign-field{display:flex;gap:8px;align-items:flex-start;margin:0 0 12px;padding:8px 10px;background:#f4f6f8;border-radius:4px}',
  '.esign-doc .esign-check{flex:none;width:14px;height:14px;margin-top:3px;border:1.5px solid #555;border-radius:2px;background:#fff}',
  '.esign-doc .esign-input{display:block;min-width:220px;height:22px;margin-top:4px;border:1px solid #999;border-radius:3px;background:#fff}',
  '.esign-doc .esign-required{color:#b00020}',
  '.esign-doc .esign-signature{margin:28px 0 0;padding:28px 16px;border:2px dashed #9aa4ae;border-radius:6px;color:#55606b;text-align:center;font-style:italic}',
].join('')

/** Characters a backslash escape can stand for (CommonMark's ASCII punctuation). */
const ESCAPABLE = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g
/** Private-use markers around an escaped character's index (stripped from the input first). */
const OPEN = '\uE000'
const CLOSE = '\uE001'

/** One line's inline Markdown as HTML: escapes, bold, italic. Every text character is HTML-escaped. */
function inline(text) {
  const literal = []
  const marked = String(text)
    .replace(/[\uE000\uE001]/g, '')
    .replace(ESCAPABLE, (_, char) => {
      literal.push(char)
      return `${OPEN}${literal.length - 1}${CLOSE}`
    })
  return esc(marked)
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, '$1<em>$2</em>')
    .replace(new RegExp(`${OPEN}(\\d+)${CLOSE}`, 'g'), (_, index) => esc(literal[Number(index)]))
}

/** A signer-field line (`Label \`{json}\``) as `{ label, config }`, or null. */
function fieldOf(line) {
  const match = /^(.*?)\s*`(\{[^`]*\})`\s*$/.exec(line)
  if (!match) return null
  try {
    const config = JSON.parse(match[2])
    return config && typeof config.line_type === 'string' ? { label: match[1], config } : null
  } catch {
    return null
  }
}

function fieldHtml({ label, config }) {
  const required = config.input_required === 'yes' ? ' <span class="esign-required" aria-label="required">*</span>' : ''
  const text = `<span>${inline(label)}${required}</span>`
  if (config.line_type === 'checkbox') return `<div class="esign-field"><span class="esign-check" aria-hidden="true"></span>${text}</div>`
  return `<div class="esign-field"><label>${text}<span class="esign-input" aria-hidden="true"></span></label></div>`
}

const LIST_ITEM = /^\s{0,3}(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/

/** One block (the lines between blank lines) as HTML. */
function blockHtml(lines) {
  const first = lines[0]
  const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(first)
  if (heading && lines.length === 1) {
    const level = heading[1].length
    return `<h${level}>${inline(heading[2])}</h${level}>`
  }
  if (lines.length === 1) {
    const field = fieldOf(first)
    if (field) return fieldHtml(field)
  }
  if (lines.every((line) => LIST_ITEM.test(line))) {
    const ordered = Boolean(LIST_ITEM.exec(first)[2])
    const items = lines.map((line) => `<li>${inline(LIST_ITEM.exec(line)[3].replace(/ {2,}$/, ''))}</li>`).join('')
    return ordered ? `<ol>${items}</ol>` : `<ul>${items}</ul>`
  }
  const parts = lines.map((line, index) => {
    const hardBreak = index < lines.length - 1 && / {2,}$/.test(line)
    return `${inline(line.replace(/\s+$/, ''))}${index < lines.length - 1 ? (hardBreak ? '<br>' : ' ') : ''}`
  })
  return `<p>${parts.join('')}</p>`
}

/**
 * @param {string} markdown  what `letterMarkdown` wrote (the e-sign send's exact Markdown)
 * @param {{logoSrc?: string|null}} [options]  the logo's address when one goes with the contract
 * @returns {string} an HTML fragment: a `<style>` and the document
 */
export function esignPreviewHtml(markdown, { logoSrc = null } = {}) {
  const blocks = []
  let current = []
  for (const line of String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    if (line.trim() === '') {
      if (current.length > 0) blocks.push(current)
      current = []
    } else {
      current.push(line)
    }
  }
  if (current.length > 0) blocks.push(current)
  const logo = logoSrc ? `<img class="esign-logo" src="${esc(logoSrc)}" alt="Firm logo">` : ''
  return `<style>${ESIGN_PREVIEW_STYLE}</style><div class="esign-doc">${logo}${blocks.map(blockHtml).join('')}<div class="esign-signature">${esc(ESIGN_SIGNATURE_BLOCK_LABEL)}</div></div>`
}
