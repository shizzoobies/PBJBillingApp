import { describe, expect, it } from 'vitest'
import { parseCsv } from '../lib/csv'

/**
 * parseCsv must round-trip the things spreadsheets actually emit: quoted
 * fields with commas/newlines, the `""` escaped-quote, CRLF vs LF endings,
 * a leading UTF-8 BOM, and a single trailing newline.
 */
describe('parseCsv', () => {
  it('parses a simple comma-separated grid', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ])
  })

  it('keeps a comma that lives inside a quoted field', () => {
    expect(parseCsv('name,note\n"Doe, Jane",hello')).toEqual([
      ['name', 'note'],
      ['Doe, Jane', 'hello'],
    ])
  })

  it('keeps a newline embedded in a quoted field', () => {
    const text = 'name,note\n"Jane","line one\nline two"'
    expect(parseCsv(text)).toEqual([
      ['name', 'note'],
      ['Jane', 'line one\nline two'],
    ])
  })

  it('unescapes a doubled "" quote inside a quoted field', () => {
    expect(parseCsv('q\n"She said ""hi"""')).toEqual([['q'], ['She said "hi"']])
  })

  it('accepts CRLF line endings', () => {
    expect(parseCsv('a,b\r\n1,2\r\n3,4')).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
    ])
  })

  it('treats LF and CRLF identically', () => {
    expect(parseCsv('a,b\n1,2')).toEqual(parseCsv('a,b\r\n1,2'))
  })

  it('strips a leading UTF-8 BOM', () => {
    expect(parseCsv('﻿name,email\nJane,j@x.com')).toEqual([
      ['name', 'email'],
      ['Jane', 'j@x.com'],
    ])
  })

  it('drops a single trailing blank line from a trailing newline', () => {
    expect(parseCsv('a,b\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('drops a single trailing blank line with CRLF', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('returns an empty grid for empty input', () => {
    expect(parseCsv('')).toEqual([])
  })

  it('preserves an empty trailing cell on a row', () => {
    expect(parseCsv('a,b,c\n1,2,')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', ''],
    ])
  })

  it('handles a quoted field followed by more fields', () => {
    expect(parseCsv('"a,b",c,"d"')).toEqual([['a,b', 'c', 'd']])
  })
})
