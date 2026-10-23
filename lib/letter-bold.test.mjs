import { describe, expect, it } from 'vitest'

import { PARAGRAPH_SPLIT, boldRuns, letterParagraphs, withoutBoldMarks, wrapBold } from './letter-bold.js'

/**
 * Bold in the engagement letter (featreq-5e195707, send-back 2026-10-10):
 * `**text**`, never swallowing what she typed.
 */
describe('boldRuns', () => {
  it('splits a paragraph into plain and bold runs', () => {
    expect(boldRuns('Your fee is **$500.00 per month** starting now.')).toEqual([
      { text: 'Your fee is ', bold: false },
      { text: '$500.00 per month', bold: true },
      { text: ' starting now.', bold: false },
    ])
  })

  it('handles several runs, a run at either edge, and a run across a single line break', () => {
    expect(boldRuns('**Dear Pat,**\nplease **sign**\n**and return**')).toEqual([
      { text: 'Dear Pat,', bold: true },
      { text: '\nplease ', bold: false },
      { text: 'sign', bold: true },
      { text: '\n', bold: false },
      { text: 'and return', bold: true },
    ])
    expect(boldRuns('**one\ntwo**')).toEqual([{ text: 'one\ntwo', bold: true }])
  })

  it('keeps an unbalanced marker in the text as typed', () => {
    expect(boldRuns('Only **one marker here')).toEqual([{ text: 'Only **one marker here', bold: false }])
    expect(boldRuns('**a** and **b')).toEqual([
      { text: 'a', bold: true },
      { text: ' and **b', bold: false },
    ])
  })

  it('keeps an empty or blank pair as typed', () => {
    expect(boldRuns('****')).toEqual([{ text: '****', bold: false }])
    expect(boldRuns('a ** ** b')).toEqual([{ text: 'a ** ** b', bold: false }])
    expect(boldRuns('****x**')).toEqual([
      { text: '**', bold: false },
      { text: 'x', bold: true },
    ])
  })

  it('answers no runs for an empty text, and one plain run without markers', () => {
    expect(boldRuns('')).toEqual([])
    expect(boldRuns(null)).toEqual([])
    expect(boldRuns('plain')).toEqual([{ text: 'plain', bold: false }])
  })

  it('never loses a character: the runs joined back are the text minus the matched markers', () => {
    for (const text of ['a **b** c', '**', '***', '*****', 'x ** y', '**a****b**', '** a**b **c']) {
      const runs = boldRuns(text)
      const markers = runs.filter((run) => run.bold).length * 4
      expect(runs.map((run) => run.text).join('').length, text).toBe(text.length - markers)
    }
  })
})

describe('letterParagraphs', () => {
  const fill = (text) => text.replaceAll('{{name}}', 'A**B').replaceAll('{{blank}}', '')

  it('reads bold from the text as typed, then fills each run, so a value is never markup', () => {
    expect(letterParagraphs('Dear **{{name}}**, from {{name}}', fill)).toEqual([
      [
        { text: 'Dear ', bold: false },
        { text: 'A**B', bold: true },
        { text: ', from A**B', bold: false },
      ],
    ])
  })

  it('splits on a blank line even with spaces or tabs on it, trims, and drops what fills to nothing', () => {
    expect(letterParagraphs('One\n \t\nTwo\n\n{{blank}}\n\n  **{{blank}}** Three  ', fill)).toEqual([
      [{ text: 'One', bold: false }],
      [{ text: 'Two', bold: false }],
      [{ text: 'Three', bold: false }],
    ])
    expect(PARAGRAPH_SPLIT.test('a\n  \nb')).toBe(true)
    expect(PARAGRAPH_SPLIT.test('a\nb')).toBe(false)
  })

  it('reads markers out of plain text when no fill is given', () => {
    expect(letterParagraphs('A **b**\r\n\r\nc')).toEqual([
      [
        { text: 'A ', bold: false },
        { text: 'b', bold: true },
      ],
      [{ text: 'c', bold: false }],
    ])
  })

  // Task 17: a SignWell field tag is its own run, flagged, never filled and never bold, so the PDF can
  // print it invisibly in its place.
  it('splits each e-sign field tag into its own run, flagged, never bold and never filled', () => {
    const seen = []
    const spy = (text) => {
      seen.push(text)
      return fill(text)
    }
    expect(letterParagraphs('Initial {{initial:1:y}} for {{name}}.\n\n**Bold {{i:1:n}} too**\n\n{{signature:1:y}}', spy)).toEqual([
      [
        { text: 'Initial ', bold: false },
        { text: '{{initial:1:y}}', bold: false, esignTag: true },
        { text: ' for A**B.', bold: false },
      ],
      [
        { text: 'Bold ', bold: true },
        { text: '{{i:1:n}}', bold: false, esignTag: true },
        { text: ' too', bold: true },
      ],
      [{ text: '{{signature:1:y}}', bold: false, esignTag: true }],
    ])
    expect(seen.some((text) => text.includes('{{initial:1:y}}') || text.includes('{{i:1:n}}'))).toBe(false)
  })

  it('writes a tag typed in capitals in lower case, its label as typed', () => {
    expect(letterParagraphs('A {{INITIAL:1:Y}} b {{Text:1:N:Title}}')).toEqual([
      [
        { text: 'A ', bold: false },
        { text: '{{initial:1:y}}', bold: false, esignTag: true },
        { text: ' b ', bold: false },
        { text: '{{text:1:n:Title}}', bold: false, esignTag: true },
      ],
    ])
  })

  it('leaves a token that is not a tag (signer 2, a typo) inside its run, for the fill to report', () => {
    expect(letterParagraphs('A {{initial:2:y}} and {{nope}} b')).toEqual([[{ text: 'A {{initial:2:y}} and {{nope}} b', bold: false }]])
  })

  it('reads tags out of already-filled text too, and drops nothing around two tags in a row', () => {
    expect(letterParagraphs('{{initial:1:y}} {{date:1:y}}')).toEqual([
      [
        { text: '{{initial:1:y}}', bold: false, esignTag: true },
        { text: ' ', bold: false },
        { text: '{{date:1:y}}', bold: false, esignTag: true },
      ],
    ])
  })
})

describe('withoutBoldMarks', () => {
  it('takes the matched markers out and leaves unmatched ones', () => {
    expect(withoutBoldMarks('Fee: **$500** a month, **really')).toBe('Fee: $500 a month, **really')
  })
})

describe('wrapBold (the B button)', () => {
  it('wraps the selection and keeps it selected', () => {
    const text = 'Your fee is $500.'
    const at = text.indexOf('$500')
    expect(wrapBold(text, at, at + 4)).toEqual({ value: 'Your fee is **$500**.', start: at, end: at + 8 })
  })

  it('leaves the spaces at the edges of a selection outside the markers', () => {
    expect(wrapBold('say hello world', 3, 10).value).toBe('say **hello** world')
  })

  it('types a pair at the caret and puts the caret between them', () => {
    expect(wrapBold('ab', 1, 1)).toEqual({ value: 'a****b', start: 3, end: 3 })
    // ...and pressing it again takes the empty pair back out.
    expect(wrapBold('a****b', 3, 3)).toEqual({ value: 'ab', start: 1, end: 1 })
  })

  it('takes the markers off an already-bold selection, markers outside or inside it', () => {
    expect(wrapBold('a **bold** b', 4, 8)).toEqual({ value: 'a bold b', start: 2, end: 6 })
    expect(wrapBold('a **bold** b', 2, 10)).toEqual({ value: 'a bold b', start: 2, end: 6 })
  })

  it('bolds a selection that spans paragraphs one paragraph at a time', () => {
    const text = 'First para.\n\nSecond para.'
    expect(wrapBold(text, 0, text.length).value).toBe('**First para.**\n\n**Second para.**')
    // ...so each paragraph renders bold.
    expect(boldRuns('**First para.**')).toEqual([{ text: 'First para.', bold: true }])
  })

  it('treats an out-of-range selection as the end of the text', () => {
    expect(wrapBold('ab', 9, 9)).toEqual({ value: 'ab****', start: 4, end: 4 })
  })
})
