import { describe, expect, it } from 'vitest'

import { buildLetterPdf, letterPdfFilename } from './letter-pdf.js'

/**
 * The engagement letter PDF (featreq-5e195707). Asserts on the REAL bytes, like
 * lib/proposal-pdf.test.mjs: built uncompressed, each drawn line is a `TJ` array
 * of hex runs, reassembled here. ASCII substrings only.
 */
function pdfRuns(buffer) {
  const raw = buffer.toString('latin1')
  const runs = []
  for (const match of raw.matchAll(/\[([^\]]*)\]\s*TJ/g)) runs.push(match[1])
  for (const match of raw.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) runs.push(`<${match[1]}>`)
  return runs.map((run) =>
    [...run.matchAll(/<([0-9A-Fa-f]*)>/g)]
      .map((hex) => Buffer.from(hex[1], 'hex').toString('latin1'))
      .join(''),
  )
}
const pdfText = (buffer) => pdfRuns(buffer).join('\n')
const pageCount = (buffer) => (buffer.toString('latin1').match(/\/Type \/Page[^s]/g) ?? []).length

const client = {
  id: 'client-1',
  name: 'Acme Books LLC',
  addressLine1: '12 Main St',
  addressLine2: '',
  city: 'Nashville',
  state: 'TN',
  postalCode: '37201',
}
const firmSettings = {
  name: 'PB&J Strategic Accounting',
  city: 'Nashville',
  state: 'TN',
  email: 'hello@pbjsa.com',
  phone: '615-555-0100',
}
const bodyText = 'Dear Pat,\n\nWe would be glad to prepare your 1099s for 2027.\n\nOur fee is $500.00 per month.'

const build = (over = {}) =>
  buildLetterPdf({
    bodyText,
    client,
    firmSettings,
    dateLabel: 'October 8, 2026',
    title: 'Your 1099s',
    compress: false,
    ...over,
  })

describe('buildLetterPdf', () => {
  it('prints the firm, the date, the addressee, the letter and the footer', async () => {
    const buffer = await build()
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    const text = pdfText(buffer)
    expect(text).toContain('PB&J Strategic Accounting')
    expect(text).toContain('October 8, 2026')
    expect(text).toContain('Acme Books LLC')
    expect(text).toContain('12 Main St')
    expect(text).toContain('Nashville, TN 37201')
    expect(text).toContain('Dear Pat,')
    expect(text).toContain('We would be glad to prepare your 1099s for 2027.')
    expect(text).toContain('Our fee is $500.00 per month.')
    expect(text).toContain('hello@pbjsa.com')
    expect(text).toContain('615-555-0100')
  })

  it('keeps the order: letterhead, date, addressee, letter', async () => {
    const text = pdfText(await build())
    const at = (needle) => text.indexOf(needle)
    expect(at('Nashville, TN')).toBeGreaterThanOrEqual(0)
    expect(at('October 8, 2026')).toBeGreaterThan(at('Nashville, TN'))
    expect(at('Acme Books LLC')).toBeGreaterThan(at('October 8, 2026'))
    expect(at('Dear Pat,')).toBeGreaterThan(at('Nashville, TN 37201'))
  })

  it('draws no blank lines for a half-filled address', async () => {
    const sparse = { name: 'Acme Books LLC', city: 'Nashville', state: 'TN' }
    const runs = pdfRuns(await build({ client: sparse }))
    expect(runs.filter((run) => run.trim() === '')).toEqual([])
    expect(runs.join('\n')).toContain('Nashville, TN')

    const none = pdfRuns(await build({ client: { name: 'Acme Books LLC' } }))
    expect(none.filter((run) => run.trim() === '')).toEqual([])
  })

  it('splits paragraphs on blank lines and keeps a single line break inside one', async () => {
    const runs = pdfRuns(await build({ bodyText: 'First\nsecond line\n\nThird\r\n\r\nFourth' }))
    const joined = runs.join('|')
    expect(joined).toContain('First')
    expect(joined).toContain('second line')
    expect(joined).toContain('Third')
    expect(joined).toContain('Fourth')
  })

  it('runs a long letter onto further pages', async () => {
    const long = Array.from({ length: 60 }, (_, n) => `Paragraph ${n} ${'lorem ipsum '.repeat(25)}`).join('\n\n')
    const buffer = await build({ bodyText: long })
    expect(pageCount(buffer)).toBeGreaterThan(1)
    const text = pdfText(buffer)
    expect(text).toContain('Paragraph 0 ')
    expect(text).toContain('Paragraph 59 ')
    expect(await build()).toSatisfy((short) => pageCount(short) === 1)
  })

  /* ---- **bold** (send-back 2026-10-10) ---------------------------------- */

  /** Each drawn run with the font resource it was drawn in, in stream order. */
  function fontRuns(buffer) {
    const raw = buffer.toString('latin1')
    const runs = []
    let font = null
    for (const match of raw.matchAll(/\/(F\d+)\s+[\d.]+\s+Tf|\[([^\]]*)\]\s*TJ/g)) {
      if (match[1]) {
        font = match[1]
        continue
      }
      const text = [...match[2].matchAll(/<([0-9A-Fa-f]*)>/g)]
        .map((hex) => Buffer.from(hex[1], 'hex').toString('latin1'))
        .join('')
      runs.push({ font, text })
    }
    return runs
  }
  /** The bold and the regular face, read off the firm name (bold) and the date line (regular). */
  function faces(runs) {
    return {
      bold: runs.find((run) => run.text.includes('PB&J Strategic Accounting')).font,
      regular: runs.find((run) => run.text.includes('October 8, 2026')).font,
    }
  }

  it('draws a **bold** run in the bold face, on the same line as the plain text around it', async () => {
    const runs = fontRuns(await build({ bodyText: 'Your fee is **$500.00 per month** and **due monthly**.' }))
    const { bold, regular } = faces(runs)
    expect(bold).not.toBe(regular)
    const body = runs.slice(runs.findIndex((run) => run.text.startsWith('Your fee is')))
    expect(body[0]).toEqual({ font: regular, text: 'Your fee is ' })
    expect(body[1]).toEqual({ font: bold, text: '$500.00 per month' })
    expect(body[2]).toEqual({ font: regular, text: ' and ' })
    expect(body[3]).toEqual({ font: bold, text: 'due monthly' })
    expect(body[4]).toEqual({ font: regular, text: '.' })
    // No marker reaches the page, and the next paragraph is back in the regular face.
    expect(pdfText(await build({ bodyText: 'A **b** c' }))).not.toContain('**')
    const next = fontRuns(await build({ bodyText: '**Bold** start.\n\nPlain after.' }))
    expect(next.find((run) => run.text.includes('Plain after.')).font).toBe(regular)
  })

  it('draws the runs it is handed, never reading ** inside them as bold', async () => {
    const runs = fontRuns(
      await build({
        bodyText: 'ignored',
        paragraphs: [[{ text: 'Dear A**B**C ', bold: false }, { text: 'Co', bold: true }]],
      }),
    )
    const { bold, regular } = faces(runs)
    const at = runs.findIndex((run) => run.text.startsWith('Dear'))
    expect(runs[at]).toEqual({ font: regular, text: 'Dear A**B**C ' })
    expect(runs[at + 1]).toEqual({ font: bold, text: 'Co' })
    expect(pdfText(await build({ paragraphs: [[{ text: 'Only this', bold: false }]] }))).not.toContain('Dear Pat')
  })

  it('starts a paragraph at a blank line holding only spaces', async () => {
    const runs = pdfRuns(await build({ bodyText: 'First para.\n   \nSecond para.' }))
    expect(runs).toContain('First para.')
    expect(runs).toContain('Second para.')
  })

  it('prints an unbalanced marker as typed, in the regular face', async () => {
    const runs = fontRuns(await build({ bodyText: 'Half **open marker.' }))
    const { regular } = faces(runs)
    expect(runs.find((run) => run.text.includes('Half **open marker.'))).toEqual({
      font: regular,
      text: 'Half **open marker.',
    })
  })

  it('wraps a long paragraph with bold runs inside the margins and onto further pages', async () => {
    const paragraph = `${'plain words here '.repeat(20)}**${'bold words here '.repeat(20)}**${'tail words '.repeat(20)}`
    const long = Array.from({ length: 12 }, () => paragraph).join('\n\n')
    const buffer = await build({ bodyText: long })
    expect(pageCount(buffer)).toBeGreaterThan(1)
    const runs = fontRuns(buffer)
    const { bold } = faces(runs)
    expect(runs.filter((run) => run.font === bold && run.text.includes('bold words here')).length).toBeGreaterThan(12)
    expect(pdfText(buffer)).not.toContain('**')
  })

  /* ---- e-sign field tags in the body (task 17) ---------------------------- */

  /** Each drawn run with the fill color and font it was drawn in and its position, in stream order. */
  function inkRuns(buffer) {
    const raw = buffer.toString('latin1')
    const runs = []
    let color = null
    let font = null
    let at = { x: null, y: null }
    const pattern = /([\d.]+ [\d.]+ [\d.]+) scn|\/(F\d+)\s+[\d.]+\s+Tf|1 0 0 1 ([\d.]+) ([\d.]+) Tm|\[([^\]]*)\]\s*TJ/g
    for (const match of raw.matchAll(pattern)) {
      if (match[1]) color = match[1]
      else if (match[2]) font = match[2]
      else if (match[3]) at = { x: Number(match[3]), y: Number(match[4]) }
      else {
        const text = [...match[5].matchAll(/<([0-9A-Fa-f]*)>/g)].map((hex) => Buffer.from(hex[1], 'hex').toString('latin1')).join('')
        runs.push({ color, font, text, ...at })
      }
    }
    return runs
  }

  it('prints an e-sign field tag in the body where it was typed, in white, on the line with its neighbors', async () => {
    const buffer = await build({ bodyText: 'Dear Pat,\n\nPlease initial **here** {{initial:1:y}} to agree.\n\nThank you.' })
    const runs = inkRuns(buffer)
    const at = runs.findIndex((run) => run.text === '{{initial:1:y}}')
    expect(at).toBeGreaterThan(-1)
    const [before, tag, after] = runs.slice(at - 1, at + 2)
    expect(tag.color).toBe('1 1 1')
    expect(before.color).not.toBe('1 1 1')
    expect(after).toMatchObject({ text: ' to agree.' })
    expect(after.color).not.toBe('1 1 1')
    // The tag's face is the regular one, even next to bold.
    expect(tag.font).toBe(runs.find((run) => run.text.startsWith('Please initial')).font)
    // Inline: the same baseline as its neighbors, to the right of the text before it.
    expect(Math.abs(tag.y - before.y)).toBeLessThan(1)
    expect(Math.abs(after.y - tag.y)).toBeLessThan(1)
    expect(tag.x).toBeGreaterThan(before.x)
    expect(after.x).toBeGreaterThan(tag.x)
    // Everything after it is back in the letter's ink.
    expect(runs.find((run) => run.text === 'Thank you.').color).not.toBe('1 1 1')
    expect(pdfText(buffer)).toContain('{{initial:1:y}}')
  })

  it('prints a tag in the runs it is handed the same way, and leaves a letter with none in black', async () => {
    const runs = inkRuns(
      await build({
        paragraphs: [[{ text: 'Sign ', bold: false }, { text: '{{signature:1:y}}', bold: false, esignTag: true }]],
      }),
    )
    expect(runs.find((run) => run.text === '{{signature:1:y}}').color).toBe('1 1 1')
    expect((await build()).toString('latin1')).not.toContain('1 1 1 scn')
  })

  it('carries the title and the firm as the document properties', async () => {
    const raw = (await build()).toString('latin1')
    expect(raw).toContain('\n(Your 1099s)\n')
    expect(raw).toContain('\n(PB&J Strategic Accounting)\n')
  })

  it('renders with nothing at all without throwing', async () => {
    const buffer = await buildLetterPdf({ client: {} })
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })

  it('is smaller compressed than not', async () => {
    const long = 'lorem ipsum '.repeat(400)
    expect((await buildLetterPdf({ bodyText: long, client, firmSettings })).length).toBeLessThan(
      (await build({ bodyText: long })).length,
    )
  })
})

describe('letterPdfFilename', () => {
  it('names the client and the year and strips anything path-ish', () => {
    expect(letterPdfFilename({ name: 'Acme Books LLC' }, '2026')).toBe('Engagement-Letter-Acme-Books-LLC-2026.pdf')
    expect(letterPdfFilename({ name: '../Cooper & Cooper, PA/' }, 2026)).toBe(
      'Engagement-Letter-Cooper-Cooper-PA-2026.pdf',
    )
  })

  it('falls back when the name or the year is missing', () => {
    expect(letterPdfFilename({}, '2026')).toBe('Engagement-Letter-client-2026.pdf')
    expect(letterPdfFilename({ name: 'Acme' })).toBe('Engagement-Letter-Acme.pdf')
    expect(letterPdfFilename(null, '')).toBe('Engagement-Letter-client.pdf')
  })
})

/**
 * SignWell's text tags (featreq-56d39567): `signatureTags` writes `{{signature:1:y}}` and
 * `{{date:1:y}}` in WHITE at the letter's own "Signature:" and "Date:" lines, so the signer's
 * fields land on the line they sign; a plain send is byte-for-byte the letter it always was.
 */
describe('buildLetterPdf signatureTags', () => {
  /** Every drawn text block with its position: { x, y, text }. */
  function placedText(buffer) {
    const raw = buffer.toString('latin1')
    return [...raw.matchAll(/1 0 0 1 ([\d.]+) ([\d.]+) Tm\s*\/F\d+ [\d.]+ Tf\s*\[([^\]]*)\]\s*TJ/g)].map((match) => ({
      x: Number(match[1]),
      y: Number(match[2]),
      text: [...match[3].matchAll(/<([0-9A-Fa-f]*)>/g)].map((hex) => Buffer.from(hex[1], 'hex').toString('latin1')).join(''),
      before: raw.slice(Math.max(0, match.index - 120), match.index),
    }))
  }
  const signing = 'Dear Pat,\n\nWe look forward to working together.\n\nAgreed and accepted:\nSignature: ______________________\nName: Pat Doe\nDate: ______________'

  it('draws the signature tag on the Signature line and the date tag on the Date line, in white', async () => {
    const blocks = placedText(await build({ bodyText: signing, signatureTags: true }))
    const signatureLine = blocks.find((block) => block.text.startsWith('Signature:'))
    const dateLine = blocks.find((block) => block.text.startsWith('Date:'))
    const signatureTag = blocks.find((block) => block.text === '{{signature:1:y}}')
    const dateTag = blocks.find((block) => block.text === '{{date:1:y}}')
    expect(signatureLine && dateLine && signatureTag && dateTag).toBeTruthy()
    // On the same line as the label, to the right of it (over the underscores).
    expect(Math.abs(signatureTag.y - signatureLine.y)).toBeLessThan(1)
    expect(Math.abs(dateTag.y - dateLine.y)).toBeLessThan(1)
    expect(signatureTag.x).toBeGreaterThan(signatureLine.x)
    expect(dateTag.x).toBeGreaterThan(dateLine.x)
    // White ink, set just before each tag is drawn (the letter's own ink is not white).
    for (const tag of [signatureTag, dateTag]) expect(tag.before).toContain('1 1 1 scn')
    expect(signatureLine.before).not.toContain('1 1 1 scn')
  })

  it('writes exactly one signature tag and one date tag, and the letter text is unchanged', async () => {
    const tagged = await build({ bodyText: signing, signatureTags: true })
    const plain = await build({ bodyText: signing })
    const taggedText = pdfText(tagged)
    expect(taggedText.match(/\{\{signature:1:y\}\}/g)).toHaveLength(1)
    expect(taggedText.match(/\{\{date:1:y\}\}/g)).toHaveLength(1)
    expect(taggedText.replace(/\{\{(signature|date):1:y\}\}\n?/g, '')).toBe(pdfText(plain))
    expect(pageCount(tagged)).toBe(pageCount(plain))
  })

  it('leaves a plain send untouched: no tags, no white ink, the same text as before the option existed', async () => {
    const plain = await build({ bodyText: signing })
    expect(pdfText(plain)).not.toContain('{{')
    const explicitOff = await build({ bodyText: signing, signatureTags: false })
    expect(pdfText(explicitOff)).toBe(pdfText(plain))
    expect(plain.toString('latin1')).not.toContain('1 1 1 scn')
  })

  it('signs on the LAST Signature line when there is more than one', async () => {
    const twice = 'Signature: first ______\n\nMore text here.\n\nSignature: ______________\nDate: ________'
    const blocks = placedText(await build({ bodyText: twice, signatureTags: true }))
    const lines = blocks.filter((block) => block.text.startsWith('Signature:'))
    const tags = blocks.filter((block) => block.text === '{{signature:1:y}}')
    expect(lines).toHaveLength(2)
    expect(tags).toHaveLength(1)
    expect(Math.abs(tags[0].y - lines[1].y)).toBeLessThan(1)
  })

  it('adds a signature and date line of its own when the letter has none, so there is always somewhere to sign', async () => {
    const buffer = await build({ signatureTags: true })
    const text = pdfText(buffer)
    expect(text).toContain('Signature: ______________________')
    expect(text).toContain('Date: ______________')
    expect(text.match(/\{\{signature:1:y\}\}/g)).toHaveLength(1)
    expect(text.match(/\{\{date:1:y\}\}/g)).toHaveLength(1)
    const blocks = placedText(buffer)
    const line = blocks.find((block) => block.text.startsWith('Signature:'))
    expect(Math.abs(blocks.find((block) => block.text === '{{signature:1:y}}').y - line.y)).toBeLessThan(1)
  })

  it('never splits the signing paragraph across pages: a long one that does not fit moves whole, tags with it', async () => {
    // Filler sized so the signing paragraph (12 lines) would start near the foot of the first page.
    const signingLines = ['Agreed and accepted:', 'Signature: ______________________', ...Array.from({ length: 8 }, (_, index) => `Line ${index} of the block`), 'Name: Pat Doe', 'Date: ______________'].join('\n')
    let moved = false
    for (let fillers = 30; fillers <= 44; fillers += 1) {
      const filler = Array.from({ length: fillers }, (_, index) => `Filler paragraph ${index}.`).join('\n\n')
      const buffer = await build({ bodyText: `${filler}\n\n${signingLines}`, signatureTags: true })
      const blocks = placedText(buffer)
      const start = blocks.findIndex((block) => block.text === 'Agreed and accepted:')
      const end = blocks.findIndex((block) => block.text.startsWith('Date:'))
      expect(start).toBeGreaterThan(-1)
      const paragraph = blocks.slice(start, end + 1).filter((block) => !block.text.startsWith('{{'))
      // On one page: the baselines only ever go down the page (a new page would reset them upward).
      for (let index = 1; index < paragraph.length; index += 1) {
        expect(paragraph[index].y, `${fillers} fillers, line ${index}`).toBeLessThan(paragraph[index - 1].y)
      }
      const line = blocks.find((block) => block.text.startsWith('Signature:'))
      const tag = blocks.find((block) => block.text === '{{signature:1:y}}')
      expect(Math.abs(tag.y - line.y)).toBeLessThan(1)
      if (pageCount(buffer) > 1 && blocks.findIndex((block) => block.text.startsWith('Filler paragraph')) !== -1) moved ||= start > 0
    }
    expect(moved).toBe(true)
  })

  it('draws the white tags UNDER the letter\'s own ink, so a tag never paints a gap into the signature line', async () => {
    const raw = (await build({ bodyText: signing, signatureTags: true })).toString('latin1')
    const tagAt = raw.toLowerCase().indexOf(Buffer.from('{{signature', 'latin1').toString('hex'))
    const lineAt = raw.toLowerCase().indexOf(Buffer.from('Signature: ', 'latin1').toString('hex').slice(0, 20))
    expect(tagAt).toBeGreaterThan(-1)
    expect(lineAt).toBeGreaterThan(-1)
    // The tag is in the stream BEFORE the line of underscores it sits on, so the black ink is painted over it.
    expect(tagAt).toBeLessThan(lineAt)
  })

  it('keeps the signing paragraph on one page, with its tags, when the letter is long', async () => {
    const long = `${Array.from({ length: 40 }, (_, index) => `Paragraph ${index} of the engagement letter, with enough words to fill a line or two on the page.`).join('\n\n')}\n\n${signing}`
    const buffer = await build({ bodyText: long, signatureTags: true })
    expect(pageCount(buffer)).toBeGreaterThan(1)
    const blocks = placedText(buffer)
    const line = blocks.find((block) => block.text.startsWith('Signature:'))
    const tag = blocks.find((block) => block.text === '{{signature:1:y}}')
    expect(Math.abs(tag.y - line.y)).toBeLessThan(1)
  })
})
