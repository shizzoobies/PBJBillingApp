import { describe, expect, it } from 'vitest'

import { boldRuns, withoutBoldMarks, wrapBold } from './letter-bold.js'

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
