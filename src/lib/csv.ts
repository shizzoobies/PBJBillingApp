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
