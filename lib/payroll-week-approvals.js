/**
 * Payroll review, ship 2 of 4 (featreq-0b4e42a1; plan
 * docs/plans/payroll-week-approval-2026-11.md sections 4.1, 10 and 11): what the
 * owner can do to ONE entry on the Payroll review tab, and the rules the page
 * and the server share about it.
 *
 *  - OK, looked at: a tick on an entry carrying a needs-a-look mark. It stores
 *    who, when, the entry's SIGNATURE and which flag kinds were showing, and it
 *    stops counting the moment the entry's signature changes.
 *  - Send back to fix: today's reject, which now leaves a `sent_back` mark
 *    (from either route), so a change by the person reads "Changed, look again".
 *  - Deny and remove: the entry (or the whole shared block) leaves
 *    `time_entries` and a full copy is kept on the person's week row, with Undo.
 *
 * Pure, plain JS with a sibling .d.ts: the browser (the page) and the server
 * (the routes and the store) import the same rules. No Node imports, so the
 * signature is a small string hash rather than node:crypto.
 */

import { dateOnlyInZone } from './firm-time.js'
import { displayHours, duplicateFullSliceIds, sumDisplayHours } from './payroll-cost.js'
import { stretchesOf } from './payroll-week-checks.js'
import { stableStringify } from './stable-json.js'

/** The flag kinds an "OK, looked at" tick can cover. Sent back waits on the person; Long day is a day, not an entry. */
export const TICKABLE_FLAG_KINDS = [
  'manual',
  'overlap',
  'possible_duplicate',
  'typed_hours',
  'block_parts',
  'long_entry',
  'changed',
]

/** The flag kinds whose OK also remembers WHICH other entries were showing (a new partner needs a look again). */
export const PARTNER_FLAG_KINDS = ['overlap', 'possible_duplicate']

export const MARK_KINDS = ['ok', 'sent_back']

/** The longest note an owner may type on a send-back or a deny. */
export const PAYROLL_NOTE_MAX = 1000

/** The refusal when the entry on screen is not the entry stored any more. */
export const ENTRY_CHANGED_MESSAGE = 'This entry changed since you opened the week. Reload and look again.'

const SIGNATURE_PATTERN = /^v1-[0-9a-f]{14}$/
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,200}$/
const WEEK_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** cyrb53: a small, fast 53-bit string hash. Not for secrets; only "is this the same entry". */
function hash53(text) {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0')
}

/**
 * What payroll depends on in an entry, and nothing else: whose it is, the day,
 * the minutes (to the whole second, the way the store keeps them), the client
 * or administrative time, the stretches (as instants, so the text form of a
 * timestamp does not matter) and the shared block it belongs to. The
 * description, the task, billable and the approval fields are NOT in it:
 * changing them does not change pay.
 */
export function signatureFields(entry) {
  const administrative = Boolean(entry?.isAdministrative)
  return {
    person: typeof entry?.employeeId === 'string' ? entry.employeeId : '',
    date: typeof entry?.date === 'string' ? entry.date.slice(0, 10) : '',
    seconds: Math.round((Number(entry?.minutes) || 0) * 60),
    client: administrative ? '' : typeof entry?.clientId === 'string' ? entry.clientId : '',
    administrative,
    stretches: stretchesOf(entry ?? {}).map((span) => [span.startMs, span.endMs]),
    group: typeof entry?.groupId === 'string' ? entry.groupId : '',
  }
}

/** A stable short hash of {@link signatureFields}: equal for the same payroll facts whatever the key order or text form. */
export function entrySignature(entry) {
  return `v1-${hash53(stableStringify(signatureFields(entry)))}`
}

export function isSignature(value) {
  return typeof value === 'string' && SIGNATURE_PATTERN.test(value)
}

/** A stored mark is still about the entry as it is now. */
export function markIsCurrent(mark, entry) {
  return Boolean(mark && entry && mark.signature === entrySignature(entry))
}

const cleanText = (value, max) =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''

/** The partner entry ids an OK covered, per partner kind; junk dropped. */
export function normalizePartners(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const kind of PARTNER_FLAG_KINDS) {
    if (!Array.isArray(raw[kind])) continue
    const ids = [...new Set(raw[kind].filter((id) => typeof id === 'string' && ID_PATTERN.test(id)))].sort().slice(0, 50)
    if (ids.length > 0) out[kind] = ids
  }
  return out
}

/** The signature's fields as stored on a mark (so an un-tick can say WHAT changed), or null for junk. */
export function normalizeFields(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const stretches = Array.isArray(raw.stretches)
    ? raw.stretches
        .filter((pair) => Array.isArray(pair) && pair.length === 2 && pair.every((value) => Number.isFinite(value)))
        .slice(0, 100)
    : []
  return {
    person: cleanText(raw.person, 200),
    date: typeof raw.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? raw.date : '',
    seconds: Number.isFinite(Number(raw.seconds)) ? Math.round(Number(raw.seconds)) : 0,
    client: cleanText(raw.client, 200),
    administrative: raw.administrative === true,
    stretches,
    group: cleanText(raw.group, 200),
  }
}

/**
 * One stored mark, normalized the same way by both backends, or null for junk.
 * `{ kind: 'ok' | 'sent_back', by, byName, at, note, signature, flags, fields?, partners? }`:
 * `fields` are the signature's fields when the mark was made (the store fills
 * them from the entry it checked), `partners` the other entries an OK'd
 * overlap or possible duplicate named.
 */
export function normalizeMark(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (!MARK_KINDS.includes(raw.kind)) return null
  if (!isSignature(raw.signature)) return null
  const by = cleanText(raw.by, 200)
  const at = typeof raw.at === 'string' && Number.isFinite(Date.parse(raw.at)) ? new Date(raw.at).toISOString() : ''
  if (!by || !at) return null
  const flags = Array.isArray(raw.flags)
    ? TICKABLE_FLAG_KINDS.filter((kind) => raw.flags.includes(kind))
    : []
  if (raw.kind === 'ok' && flags.length === 0) return null
  const note = cleanText(raw.note, PAYROLL_NOTE_MAX)
  if (raw.kind === 'sent_back' && !note) return null
  return {
    kind: raw.kind,
    by,
    byName: cleanText(raw.byName, 200),
    at,
    note,
    signature: raw.signature,
    flags,
    ...(normalizeFields(raw.fields) ? { fields: normalizeFields(raw.fields) } : {}),
    ...(Object.keys(normalizePartners(raw.partners)).length > 0 ? { partners: normalizePartners(raw.partners) } : {}),
  }
}

/** A stored `entry_marks` object: junk keys and junk marks dropped. */
export function normalizeMarks(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [entryId, mark] of Object.entries(raw)) {
    if (!ID_PATTERN.test(entryId)) continue
    const clean = normalizeMark(mark)
    if (clean) out[entryId] = clean
  }
  return out
}

/** A required note: trimmed, at most {@link PAYROLL_NOTE_MAX} characters. */
export function normalizeNote(value) {
  if (typeof value !== 'string') return { ok: false, error: 'A note is required.' }
  const note = value.trim()
  if (!note) return { ok: false, error: 'A note is required.' }
  if (note.length > PAYROLL_NOTE_MAX) return { ok: false, error: `Keep the note under ${PAYROLL_NOTE_MAX} characters.` }
  return { ok: true, value: note }
}

export function isWeekStart(value) {
  return typeof value === 'string' && WEEK_PATTERN.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00Z`))
    && new Date(`${value}T12:00:00Z`).getUTCDay() === 0
    && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value
}

function entryIdOf(value) {
  return typeof value === 'string' && ID_PATTERN.test(value) ? value : ''
}

/**
 * The body of "OK, looked at": `{ entryId, signature, flags }` to tick, or
 * `{ entryId, remove: true }` to take her tick off.
 */
export function normalizeMarkInput(body) {
  const entryId = entryIdOf(body?.entryId)
  if (!entryId) return { ok: false, error: 'Which entry?' }
  if (body?.remove === true) return { ok: true, value: { entryId, remove: true } }
  if (!isSignature(body?.signature)) return { ok: false, error: ENTRY_CHANGED_MESSAGE }
  const flags = Array.isArray(body?.flags) ? TICKABLE_FLAG_KINDS.filter((kind) => body.flags.includes(kind)) : []
  if (flags.length === 0) return { ok: false, error: 'There is nothing on this entry to OK.' }
  return { ok: true, value: { entryId, remove: false, signature: body.signature, flags, partners: normalizePartners(body?.partners) } }
}

/** The body of Send back to fix: `{ entryId, signature, note }`. */
export function normalizeSendBackInput(body) {
  const entryId = entryIdOf(body?.entryId)
  if (!entryId) return { ok: false, error: 'Which entry?' }
  if (!isSignature(body?.signature)) return { ok: false, status: 409, error: ENTRY_CHANGED_MESSAGE }
  const note = normalizeNote(body?.note)
  if (!note.ok) return note
  return { ok: true, value: { entryId, signature: body.signature, note: note.value } }
}

/**
 * The body of Deny and remove: `{ entryId, signatures: { <id>: <signature> }, note }`.
 * `signatures` names EVERY entry the confirm listed (the whole block for a part
 * of a shared block), each with the signature the screen saw.
 */
export function normalizeDenyInput(body) {
  const entryId = entryIdOf(body?.entryId)
  if (!entryId) return { ok: false, error: 'Which entry?' }
  const raw = body?.signatures
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, status: 409, error: ENTRY_CHANGED_MESSAGE }
  const signatures = {}
  for (const [id, signature] of Object.entries(raw)) {
    if (!entryIdOf(id) || !isSignature(signature)) return { ok: false, status: 409, error: ENTRY_CHANGED_MESSAGE }
    signatures[id] = signature
  }
  if (!signatures[entryId] || Object.keys(signatures).length > 50) {
    return { ok: false, status: 409, error: ENTRY_CHANGED_MESSAGE }
  }
  const note = normalizeNote(body?.note)
  if (!note.ok) return note
  return { ok: true, value: { entryId, signatures, note: note.value } }
}

/** The body of Undo: `{ userId, weekStart, denialId }`. */
export function normalizeUndoInput(body) {
  const userId = entryIdOf(body?.userId)
  const denialId = entryIdOf(body?.denialId)
  if (!userId || !denialId || !isWeekStart(body?.weekStart)) return { ok: false, error: 'Which removed entry?' }
  return { ok: true, value: { userId, weekStart: body.weekStart, denialId } }
}

/**
 * The hours a denial takes off payroll: the rows' two-decimal hours, a block
 * billed in full to each client counted once (the payroll report's rule).
 */
export function payrollHoursOf(entries) {
  const list = Array.isArray(entries) ? entries : []
  const repeats = duplicateFullSliceIds(list)
  return sumDisplayHours(list.filter((entry) => !repeats.has(entry.id)).map((entry) => displayHours(Number(entry.minutes) || 0)))
}

/** The app-shaped facts of a denied entry the page lists (never the whole stored row). */
export function denialPart(entry) {
  return {
    id: entry.id,
    employeeId: entry.employeeId,
    date: entry.date,
    clientId: entry.isAdministrative ? '' : entry.clientId || '',
    isAdministrative: Boolean(entry.isAdministrative),
    taskId: entry.taskId ?? null,
    ...(entry.taskLabel ? { taskLabel: entry.taskLabel } : {}),
    description: typeof entry.description === 'string' ? entry.description : '',
    minutes: Number(entry.minutes) || 0,
    ...(entry.groupId ? { groupId: entry.groupId } : {}),
    ...(entry.groupAllocation ? { groupAllocation: entry.groupAllocation } : {}),
    billable: Boolean(entry.billable),
    ...(entry.startAt ? { startAt: entry.startAt } : {}),
    ...(entry.endAt ? { endAt: entry.endAt } : {}),
    ...(Array.isArray(entry.sessions) && entry.sessions.length > 0 ? { sessions: entry.sessions } : {}),
  }
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** "Nov 4" for a calendar date (yyyy-mm-dd), read as a date, never an instant. */
export function dayText(date) {
  const match = typeof date === 'string' ? /^(\d{4})-(\d{2})-(\d{2})/.exec(date) : null
  if (!match) return ''
  return `${MONTHS[Number(match[2]) - 1]} ${Number(match[3])}`
}

/** "Wed Nov 4". */
export function weekdayDayText(date) {
  const match = typeof date === 'string' ? /^(\d{4})-(\d{2})-(\d{2})/.exec(date) : null
  if (!match) return ''
  const weekday = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay()
  return `${WEEKDAYS[weekday]} ${dayText(date)}`
}

/** "Nov 20": the firm's calendar day an instant falls on. */
export function instantDayText(iso) {
  if (typeof iso !== 'string' || !Number.isFinite(Date.parse(iso))) return ''
  return dayText(dateOnlyInZone(new Date(iso)) ?? '')
}

const hoursText = (hours) => (hours === 0 ? 0 : hours).toFixed(2)
const firstName = (name) => (typeof name === 'string' && name.trim() ? name.trim().split(/\s+/)[0] : '')

/**
 * A note placed inside a sentence: trimmed, without closing periods, so a
 * notice never reads "..". A closing question or exclamation mark is kept.
 */
export function noteInSentence(note) {
  return cleanText(note, PAYROLL_NOTE_MAX).replace(/[.\s]+$/, '')
}

/** " Reason: <note>.", with no period added after a closing "?" or "!"; empty for no note. */
function reasonSentence(note) {
  const reason = noteInSentence(note)
  if (!reason) return ''
  return /[?!]$/.test(reason) ? ` Reason: ${reason}` : ` Reason: ${reason}.`
}

/**
 * "(Wed Nov 4, Acme Dental, Bookkeeping)", or for a block of several clients
 * "(Thu Nov 12; Acme Dental, Bright Books; Bookkeeping)". `parts`: `{ date, job, task }`.
 */
function scopeText(parts) {
  const list = Array.isArray(parts) ? parts : []
  const days = [...new Set(list.map((part) => part.date).filter(Boolean))].sort().map(weekdayDayText)
  const jobs = [...new Set(list.map((part) => part.job).filter(Boolean))]
  const tasks = [...new Set(list.map((part) => part.task).filter(Boolean))]
  const groups = [days, jobs, tasks].filter((group) => group.length > 0)
  if (groups.length === 0) return ''
  const several = groups.some((group) => group.length > 1)
  return ` (${groups.map((group) => group.join(several ? ', ' : '')).join(several ? '; ' : ', ')})`
}

const whatOf = (parts) => ((Array.isArray(parts) ? parts : []).length > 1 ? 'block' : 'entry')

/**
 * What the person is told when an entry of theirs is denied and removed (her
 * words: "letting her know there was an error in system and she will be paid
 * less by this amount"), in hours, never money.
 */
export function deniedMessage({ ownerName, hours, parts, note }) {
  const owner = firstName(ownerName) || 'An owner'
  return `${owner} removed a ${hoursText(hours)}h ${whatOf(parts)} from your time${scopeText(parts)}.${reasonSentence(note)} Your hours for that week are lower by ${hoursText(hours)}h. You do not need to do anything. If you think this is a mistake, talk to ${firstName(ownerName) || 'an owner'}.`
}

/** What the person is told when a denial is undone. */
export function restoredMessage({ ownerName, hours, parts }) {
  const owner = firstName(ownerName) || 'An owner'
  return `${owner} put back a ${hoursText(hours)}h ${whatOf(parts)} in your time${scopeText(parts)}. It counts toward that week's hours again. Please disregard the earlier notice about it.`
}

/**
 * What the person is told when an entry is sent back to fix: the Approval
 * queue's reject and Payroll review's Send back say the same thing.
 */
export function sentBackMessage({ ownerName, hours, parts, note }) {
  const owner = firstName(ownerName) || 'An owner'
  return `${owner} sent back your ${hoursText(hours)}h entry${scopeText(parts)}.${reasonSentence(note)} Edit and resubmit it from the Time page.`
}

/** Invoice statuses that have not gone to the client yet: a regenerate can still change them. */
export const UNSENT_INVOICE_STATUSES = ['draft', 'reviewed']

/**
 * The months (yyyy-mm) a week's entries can fall in: the week's own, and a
 * week either side (a part of a shared block moved to another week).
 */
export function weekInvoiceMonths(weekStart) {
  const start = new Date(`${weekStart}T12:00:00Z`).getTime()
  const day = 24 * 60 * 60 * 1000
  return [...new Set([-7, 0, 6, 13].map((offset) => new Date(start + offset * day).toISOString().slice(0, 7)))]
}

/**
 * Which months' monthly invoices already bill time of which client, for the
 * months a week's entries can fall in. Read-only facts for the deny confirm's
 * warning; nothing about invoices is ever written from Payroll review.
 *
 * `evidence` is the store's `listInvoiceEvidence({ periods })` rows.
 *  - A billing master's invoice that carries a sub's lines (`sourceClientIds`)
 *    bills the sub's time too, so it is reported for the sub as well, naming
 *    the master's invoice.
 *  - A month PUSHED to the next (a void monthly invoice with
 *    `rolledIntoPeriod`) is billed on the invoice that carries it: that
 *    invoice is reported against the ORIGINAL month, with `carriedTo` its own
 *    month. When the carrying invoice does not exist yet, nothing is said.
 *
 * `period` is always the month the TIME belongs to (what the page matches an
 * entry's date against); `carriedTo` the month of the invoice it is on, when
 * that differs.
 *
 * @returns {Array<{ clientId: string, invoiceClientId: string, period: string, carriedTo?: string, status: string, sent: boolean }>}
 */
export function invoicedFacts(evidence, weekStart) {
  const months = new Set(weekInvoiceMonths(weekStart))
  const rows = Array.isArray(evidence) ? evidence.filter((invoice) => invoice && invoice.kind === 'monthly') : []
  const out = []
  const seen = new Set()
  const report = (invoice, billedFor, period, carriedTo) => {
    const sent = !UNSENT_INVOICE_STATUSES.includes(invoice.status)
    for (const clientId of new Set(billedFor)) {
      if (typeof clientId !== 'string' || !clientId) continue
      const key = `${clientId}|${invoice.clientId}|${period}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        clientId,
        invoiceClientId: invoice.clientId,
        period,
        ...(carriedTo ? { carriedTo } : {}),
        status: invoice.status,
        sent,
      })
    }
  }
  for (const invoice of rows) {
    if (!months.has(invoice.period)) continue
    if (invoice.status !== 'void') {
      report(invoice, [invoice.clientId, ...(invoice.sourceClientIds ?? [])], invoice.period)
      continue
    }
    if (!invoice.rolledIntoPeriod) continue
    const carrying = rows.find(
      (other) => other.clientId === invoice.clientId && other.period === invoice.rolledIntoPeriod && other.status !== 'void',
    )
    if (!carrying) continue
    // Whose time the pushed month held: its own client and the subs on its lines.
    report(carrying, [invoice.clientId, ...(invoice.sourceClientIds ?? [])], invoice.period, carrying.period)
  }
  return out
}

/** The activity-log target of a deny or an undo: no note, no money. */
export function denialAuditTarget({ userId, weekStart, hours, entryIds }) {
  return `${userId} · week of ${weekStart} · ${hoursText(hours)}h · ${(entryIds ?? []).join(', ')}`.slice(0, 300)
}

/**
 * WHAT changed between the fields an OK stored and the entry now, in words:
 * "hours 1.00 to 1.50", "day Nov 10 to Nov 11", "client Acme Dental to Bright
 * Books", "clock times", "shared block", "person". Empty when the mark holds
 * no fields (or nothing it holds differs).
 */
export function changeWords(before, entry, { clientName = (id) => id, personName = (id) => id } = {}) {
  if (!before) return []
  const now = signatureFields(entry)
  const words = []
  const client = (fields) => (fields.administrative ? 'Administrative' : clientName(fields.client) || 'no client')
  if (before.person !== now.person) words.push(`person ${personName(before.person)} to ${personName(now.person)}`)
  if (before.date !== now.date) words.push(`day ${dayText(before.date)} to ${dayText(now.date)}`)
  if (before.seconds !== now.seconds) {
    words.push(`hours ${hoursText(Math.round(before.seconds / 36) / 100)} to ${hoursText(Math.round(now.seconds / 36) / 100)}`)
  }
  if (before.client !== now.client || before.administrative !== now.administrative) {
    words.push(`client ${client(before)} to ${client(now)}`)
  }
  if (JSON.stringify(before.stretches) !== JSON.stringify(now.stretches)) words.push('clock times')
  if (before.group !== now.group) words.push('shared block')
  return words
}

// ---------------------------------------------------------------------------
// The marks on the screen
// ---------------------------------------------------------------------------

const NEW_PARTNER_WORDS = {
  overlap: 'A new overlap since you OK\'d it.',
  possible_duplicate: 'A new possible duplicate since you OK\'d it.',
}

/**
 * An entry's flags as the screen shows them once her marks are applied.
 *
 *  - A current OK tick turns each flag kind it covered into tier `seen` (not
 *    counted, not kept by Show only flagged) with `seenBy` ("OK'd by Brittany
 *    Nov 20"). A kind that was not showing when she ticked stays `look`, and
 *    so does an overlap or possible duplicate with a PARTNER entry that was
 *    not showing then ("A new overlap since you OK'd it.").
 *  - A tick whose signature no longer matches leaves every flag as it is and
 *    adds the note "Changed since you OK'd it on Nov 20 (hours 1.00 to 1.50):
 *    look again."
 *  - A sent-back entry reads "Sent back Nov 20, waiting on Lisa: <note>".
 *  - A `sent_back` mark on an entry that is no longer sent back and not
 *    approved adds the look flag "Changed, look again" (the person changed it;
 *    she has not checked it yet). Once it is approved, nothing is shown.
 *
 * @param {object} [options]
 * @param {object} [options.partners] - the partner ids showing NOW, per kind.
 * @param {(id: string) => string} [options.clientName]
 * @param {(id: string) => string} [options.personNameOf]
 * @returns {{ flags: object[], ok: 'current' | 'changed' | null, tickable: string[] }}
 *   `tickable`: the look kinds an "OK, looked at" tick would cover now (empty
 *   while the entry is sent back).
 */
export function applyEntryMarks(flags, { entry, mark, personName = '', partners = {}, clientName, personNameOf } = {}) {
  const list = (Array.isArray(flags) ? flags : []).map((flag) => ({ ...flag }))
  const waitingOn = firstName(personName) || 'the person'
  if (entry?.approvalStatus === 'rejected') {
    const sent = list.find((flag) => flag.kind === 'sent_back')
    if (sent) {
      const day = instantDayText(entry.approvedAt)
      const note = cleanText(entry.approvalNote, PAYROLL_NOTE_MAX)
      sent.sentence = `Sent back${day ? ` ${day}` : ''}, waiting on ${waitingOn}${note ? `: ${note}` : ''}`
    }
  }
  let ok = null
  if (mark?.kind === 'ok') {
    if (markIsCurrent(mark, entry)) {
      ok = 'current'
      const seenBy = `OK'd by ${firstName(mark.byName) || 'an owner'}${instantDayText(mark.at) ? ` ${instantDayText(mark.at)}` : ''}`
      for (const flag of list) {
        if (flag.tier !== 'look' || !mark.flags.includes(flag.kind)) continue
        if (PARTNER_FLAG_KINDS.includes(flag.kind)) {
          const covered = new Set(mark.partners?.[flag.kind] ?? [])
          const showing = Array.isArray(partners?.[flag.kind]) ? partners[flag.kind] : []
          if (showing.some((id) => !covered.has(id))) {
            flag.sentence = `${NEW_PARTNER_WORDS[flag.kind]} ${flag.sentence}`
            continue
          }
        }
        flag.tier = 'seen'
        flag.seenBy = seenBy
      }
    } else {
      ok = 'changed'
      const what = changeWords(mark.fields, entry, { clientName, personName: personNameOf })
      list.push({
        kind: 'ok_changed',
        tier: 'note',
        label: 'Changed since you OK\'d it',
        sentence: `Changed since you OK'd it${instantDayText(mark.at) ? ` on ${instantDayText(mark.at)}` : ''}${what.length > 0 ? ` (${what.join('; ')})` : ''}: look again.`,
      })
    }
  } else if (
    mark?.kind === 'sent_back' &&
    entry &&
    entry.approvalStatus !== 'rejected' &&
    entry.approvalStatus !== 'approved'
  ) {
    const day = instantDayText(mark.at)
    list.unshift({
      kind: 'changed',
      tier: 'look',
      label: 'Changed, look again',
      // Same signature: it went back to waiting with the same hours, day and
      // client (the description or task may have changed): "resubmitted".
      sentence: markIsCurrent(mark, entry)
        ? `${firstName(personName) || 'The person'} resubmitted this entry after you sent it back${day ? ` (${day})` : ''}, with no change to its hours, day or client. Please check it.${mark.note ? ` Your note was: ${mark.note}` : ''}`
        : `${firstName(personName) || 'The person'} changed this entry after you sent it back${day ? ` (${day})` : ''}. Please check it.${mark.note ? ` Your note was: ${mark.note}` : ''}`,
    })
  }
  const tickable =
    entry?.approvalStatus === 'rejected'
      ? []
      : list.filter((flag) => flag.tier === 'look' && TICKABLE_FLAG_KINDS.includes(flag.kind)).map((flag) => flag.kind)
  return { flags: list, ok, tickable }
}
