// Pure (React-free) logic for the owner-only "Import contacts from CSV"
// flow. The UI layer (ContactsPage) drives everything off these helpers so
// the parsing/matching/merging rules stay unit-testable in isolation.

import type { Contact } from './types'
import { parseCsv } from './csv'

/** The Contact fields a CSV column can map onto. `id` is never importable. */
export type ContactField = 'name' | 'email' | 'phone' | 'title' | 'notes'

/** A single CSV data row reduced to (trimmed) Contact fields. */
export type ParsedRow = {
  name: string
  email?: string
  phone?: string
  title?: string
  notes?: string
}

/** Header-cell text → Contact field, for the columns we recognized. */
export type HeaderMap = Record<number, ContactField>

export type ParseContactsResult = {
  rows: ParsedRow[]
  /** Count of rows dropped because they had no name. */
  skipped: number
  headerMap: HeaderMap
}

/** One parsed row paired with the existing contacts it could be. */
export type ImportRow = {
  row: ParsedRow
  matches: Contact[]
}

/** Per-field choice when an existing value and the CSV value differ. */
export type FieldChoice = 'existing' | 'csv'
export type FieldChoices = Partial<Record<ContactField, FieldChoice>>

// Case-insensitive header aliases. Keys are already lower-cased; lookups
// trim + lower-case the incoming header before comparing.
const HEADER_ALIASES: Record<ContactField, string[]> = {
  name: ['name', 'full name', 'contact', 'contact name'],
  email: ['email', 'email address', 'e-mail'],
  phone: ['phone', 'phone number', 'mobile', 'cell', 'telephone'],
  title: ['title', 'company', 'role', 'position', 'job title'],
  notes: ['notes', 'note', 'comment', 'comments'],
}

const ALIAS_TO_FIELD: Record<string, ContactField> = (() => {
  const map: Record<string, ContactField> = {}
  for (const field of Object.keys(HEADER_ALIASES) as ContactField[]) {
    for (const alias of HEADER_ALIASES[field]) {
      map[alias] = field
    }
  }
  return map
})()

function normalizeHeader(cell: string): string {
  return cell.trim().toLowerCase()
}

/**
 * Map each header cell index to a Contact field when it matches a known
 * alias (case-insensitive, trimmed). Unrecognized columns are omitted. If
 * the same field appears twice, the FIRST matching column wins.
 */
export function detectHeaderMap(header: string[]): HeaderMap {
  const map: HeaderMap = {}
  const claimed = new Set<ContactField>()
  header.forEach((cell, index) => {
    const field = ALIAS_TO_FIELD[normalizeHeader(cell)]
    if (field && !claimed.has(field)) {
      map[index] = field
      claimed.add(field)
    }
  })
  return map
}

function cleanField(value: string | undefined): string {
  return (value ?? '').trim()
}

/**
 * Parse CSV text into trimmed Contact-shaped rows. The first row is treated
 * as the header. Rows whose mapped `name` is empty are skipped and counted.
 * Optional fields are included only when non-empty.
 */
export function parseContactRows(text: string): ParseContactsResult {
  const grid = parseCsv(text)
  if (grid.length === 0) {
    return { rows: [], skipped: 0, headerMap: {} }
  }

  const [header, ...dataRows] = grid
  const headerMap = detectHeaderMap(header)
  const entries = Object.entries(headerMap) as Array<[string, ContactField]>

  const rows: ParsedRow[] = []
  let skipped = 0

  for (const cells of dataRows) {
    const collected: Record<ContactField, string> = {
      name: '',
      email: '',
      phone: '',
      title: '',
      notes: '',
    }
    for (const [indexKey, field] of entries) {
      collected[field] = cleanField(cells[Number(indexKey)])
    }

    if (!collected.name) {
      skipped += 1
      continue
    }

    const row: ParsedRow = { name: collected.name }
    if (collected.email) row.email = collected.email
    if (collected.phone) row.phone = collected.phone
    if (collected.title) row.title = collected.title
    if (collected.notes) row.notes = collected.notes
    rows.push(row)
  }

  return { rows, skipped, headerMap }
}

function norm(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

/**
 * Existing contacts that the parsed row could be a duplicate of. A contact
 * matches when its email equals the row's email (case-insensitive, trimmed,
 * BOTH non-empty) OR its name equals the row's name (case-insensitive,
 * trimmed). Returns every match.
 */
export function findMatches(row: ParsedRow, existing: Contact[]): Contact[] {
  const rowEmail = norm(row.email)
  const rowName = norm(row.name)
  return existing.filter((contact) => {
    const contactEmail = norm(contact.email)
    const emailMatch = rowEmail !== '' && contactEmail !== '' && contactEmail === rowEmail
    const nameMatch = rowName !== '' && norm(contact.name) === rowName
    return emailMatch || nameMatch
  })
}

/**
 * Build the per-row review plan: every parsed row with the existing
 * contacts it might merge into. Drives the Review step UI.
 */
export function buildImportPlan(text: string, existing: Contact[]): ImportRow[] {
  const { rows } = parseContactRows(text)
  return rows.map((row) => ({ row, matches: findMatches(row, existing) }))
}

const MERGEABLE_FIELDS: ContactField[] = ['name', 'email', 'phone', 'title', 'notes']

/**
 * Produce a minimal PATCH merging a parsed row into an existing contact:
 *   - a field the existing contact leaves empty but the CSV fills → take
 *     the CSV value;
 *   - a field where both are non-empty and DIFFER → honor
 *     `fieldChoices[field]` ('existing' is the default when unspecified);
 *   - unchanged fields are never included.
 * Comparison/“empty” checks are trimmed; the written value is the trimmed
 * CSV value (parsed rows are already trimmed).
 */
export function applyMerge(
  existing: Contact,
  row: ParsedRow,
  fieldChoices: FieldChoices,
): Partial<Contact> {
  const patch: Partial<Contact> = {}

  for (const field of MERGEABLE_FIELDS) {
    const csvValue = cleanField(row[field])
    const existingValue = cleanField(existing[field])

    if (csvValue === '') {
      // CSV has nothing to contribute for this field.
      continue
    }

    if (existingValue === '') {
      // Existing is blank — fill it from the CSV.
      patch[field] = csvValue
      continue
    }

    if (existingValue === csvValue) {
      // Identical — nothing to change.
      continue
    }

    // Both present and differ — the user's per-field choice decides.
    const choice = fieldChoices[field] ?? 'existing'
    if (choice === 'csv') {
      patch[field] = csvValue
    }
  }

  return patch
}
