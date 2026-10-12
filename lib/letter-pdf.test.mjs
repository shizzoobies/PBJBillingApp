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
