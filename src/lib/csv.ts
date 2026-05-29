// Tiny CSV download helper. Quotes every field so commas, quotes, and
// newlines inside cells survive a round trip through Excel/Google Sheets.

function escapeCell(value: string | number | boolean | null | undefined): string {
  const raw = value === null || value === undefined ? '' : String(value)
  return `"${raw.replace(/"/g, '""')}"`
}

export function buildCsv(headers: string[], rows: Array<Array<string | number | boolean | null | undefined>>): string {
  const lines: string[] = []
  lines.push(headers.map(escapeCell).join(','))
  for (const row of rows) {
    lines.push(row.map(escapeCell).join(','))
  }
  // CRLF for maximum spreadsheet compatibility.
  return lines.join('\r\n')
}

/**
 * Parse CSV text into a grid of cells, robustly per RFC 4180:
 *   - double-quoted fields may contain commas, newlines, and `""` (an
 *     escaped double-quote inside a quoted field);
 *   - both `\r\n` and bare `\n` line endings are accepted (a lone `\r` is
 *     also treated as a line break);
 *   - a leading UTF-8 BOM is stripped;
 *   - a single trailing blank line (the common artifact of a trailing
 *     newline) is dropped.
 * Returns an array of rows, each an array of cell strings. Whitespace is
 * preserved verbatim — trimming is the caller's job.
 */
export function parseCsv(text: string): string[][] {
  // Strip a leading UTF-8 BOM if present.
  let input = text
  if (input.charCodeAt(0) === 0xfeff) {
    input = input.slice(1)
  }

  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  const len = input.length

  const endField = () => {
    row.push(field)
    field = ''
  }
  const endRow = () => {
    endField()
    rows.push(row)
    row = []
  }

  while (i < len) {
    const char = input[i]

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          // Escaped quote inside a quoted field.
          field += '"'
          i += 2
          continue
        }
        // Closing quote.
        inQuotes = false
        i += 1
        continue
      }
      field += char
      i += 1
      continue
    }

    if (char === '"') {
      inQuotes = true
      i += 1
      continue
    }
    if (char === ',') {
      endField()
      i += 1
      continue
    }
    if (char === '\r') {
      // Treat \r\n and a lone \r as one line break.
      endRow()
      if (input[i + 1] === '\n') {
        i += 2
      } else {
        i += 1
      }
      continue
    }
    if (char === '\n') {
      endRow()
      i += 1
      continue
    }

    field += char
    i += 1
  }

  // Flush the final field/row. The loop ends mid-row whenever the input
  // doesn't end with a newline; always emit what we have.
  endRow()

  // Drop a single trailing blank row produced by a trailing newline. A blank
  // row from the parser is exactly one empty cell.
  if (rows.length > 0) {
    const last = rows[rows.length - 1]
    if (last.length === 1 && last[0] === '') {
      rows.pop()
    }
  }

  return rows
}

export function downloadCsv(
  filename: string,
  headers: string[],
  rows: Array<Array<string | number | boolean | null | undefined>>,
): void {
  const csv = buildCsv(headers, rows)
  // BOM so Excel recognises UTF-8.
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  // Yield to the click before revoking; otherwise some browsers cancel the download.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
