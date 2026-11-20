import { describe, expect, it } from 'vitest'
import {
  ENTRY_CHANGED_MESSAGE,
  applyEntryMarks,
  changeWords,
  deniedMessage,
  entrySignature,
  invoicedFacts,
  isWeekStart,
  markIsCurrent,
  normalizeDenyInput,
  normalizeMark,
  normalizeMarkInput,
  normalizeMarks,
  noteInSentence,
  normalizeSendBackInput,
  normalizeUndoInput,
  payrollHoursOf,
  restoredMessage,
  sentBackMessage,
  signatureFields,
  weekInvoiceMonths,
  weekdayDayText,
} from './payroll-week-approvals.js'

/**
 * Payroll review ship 2 (featreq-0b4e42a1): the rules the page and the server
 * share. Clock times are built in LOCAL time; dates are calendar dates.
 */
const at = (day, hour, minute, second = 0) => new Date(2026, 10, day, hour, minute, second).toISOString()

function entry(over = {}) {
  return {
    id: 'e1',
    employeeId: 'emp-1',
    date: '2026-11-10',
    clientId: 'c1',
    isAdministrative: false,
    minutes: 72,
    billable: true,
    taskLabel: 'Bookkeeping',
    description: 'Work',
    entryMethod: 'manual',
    approvalStatus: 'pending',
    startAt: at(10, 9, 0, 7),
    endAt: at(10, 10, 12, 7),
    sessions: [{ startAt: at(10, 9, 0, 7), endAt: at(10, 10, 12, 7) }],
    ...over,
  }
}

const OK_MARK = (over = {}) => ({
  kind: 'ok',
  by: 'emp-patrice',
  byName: 'Brittany Smith',
  at: new Date(2026, 10, 20, 15, 0).toISOString(),
  note: '',
  signature: entrySignature(entry()),
  flags: ['manual'],
  ...over,
})

describe('entrySignature', () => {
  it('is the same whatever the key order and the text form of an instant', () => {
    const a = entry()
    const reordered = Object.fromEntries(Object.entries(a).reverse())
    expect(entrySignature(reordered)).toBe(entrySignature(a))
    // Postgres hands instants back as "+00:00"; the instant is the same.
    const pgText = {
      ...a,
      sessions: a.sessions.map((s) => ({ startAt: s.startAt.replace('Z', '+00:00'), endAt: s.endAt.replace('Z', '+00:00') })),
    }
    expect(entrySignature(pgText)).toBe(entrySignature(a))
    expect(entrySignature(a)).toMatch(/^v1-[0-9a-f]{14}$/)
  })

  it('does not move for what payroll does not depend on', () => {
    const base = entrySignature(entry())
    for (const change of [
      { description: 'Something else' },
      { approvalStatus: 'approved', approvedBy: 'emp-patrice', approvedAt: at(20, 9, 0) },
      { approvalStatus: 'rejected', approvalNote: 'Which client?' },
      { taskLabel: 'Payroll', taskId: 'chk-1' },
      { billable: false },
      { entryMethod: 'timer' },
    ]) {
      expect(entrySignature(entry(change))).toBe(base)
    }
  })

  it('moves for minutes, day, person, client, administrative, stretches and block', () => {
    const base = entrySignature(entry())
    for (const change of [
      { minutes: 73 },
      { date: '2026-11-11' },
      { employeeId: 'emp-2' },
      { clientId: 'c2' },
      { isAdministrative: true },
      { sessions: [{ startAt: at(10, 9, 5, 7), endAt: at(10, 10, 12, 7) }] },
      { groupId: 'g1' },
    ]) {
      expect(entrySignature(entry(change))).not.toBe(base)
    }
  })

  it('an entry with no stretches still has one, from its start and stop', () => {
    const pair = entry({ sessions: [] })
    expect(entrySignature(pair)).toBe(entrySignature(entry()))
  })
})

describe('marks', () => {
  it('is current only while the signature matches', () => {
    expect(markIsCurrent(OK_MARK(), entry())).toBe(true)
    expect(markIsCurrent(OK_MARK(), entry({ minutes: 90 }))).toBe(false)
    expect(markIsCurrent(null, entry())).toBe(false)
  })

  it('normalizes a good mark and refuses junk', () => {
    expect(normalizeMark(OK_MARK({ flags: ['manual', 'nonsense', 'sent_back', 'long_day'] }))).toEqual({
      ...OK_MARK(),
      flags: ['manual'],
    })
    expect(normalizeMark(null)).toBeNull()
    expect(normalizeMark([])).toBeNull()
    expect(normalizeMark(OK_MARK({ kind: 'approved' }))).toBeNull()
    expect(normalizeMark(OK_MARK({ signature: 'abc' }))).toBeNull()
    expect(normalizeMark(OK_MARK({ by: '' }))).toBeNull()
    expect(normalizeMark(OK_MARK({ at: 'not a time' }))).toBeNull()
    // An OK that covers nothing, and a send-back with no note, are not marks.
    expect(normalizeMark(OK_MARK({ flags: [] }))).toBeNull()
    expect(normalizeMark(OK_MARK({ kind: 'sent_back', flags: [], note: '  ' }))).toBeNull()
    expect(normalizeMark(OK_MARK({ kind: 'sent_back', flags: [], note: ' fix the client ' }))?.note).toBe('fix the client')
    expect(normalizeMarks({ e1: OK_MARK(), 'bad id!': OK_MARK(), e2: { kind: 'ok' } })).toEqual({ e1: OK_MARK() })
    expect(normalizeMarks('junk')).toEqual({})
  })
})

describe('the bodies the routes take', () => {
  const sig = entrySignature(entry())
  it('OK, looked at', () => {
    expect(normalizeMarkInput({ entryId: 'e1', signature: sig, flags: ['manual', 'x'] })).toEqual({
      ok: true,
      value: { entryId: 'e1', remove: false, signature: sig, flags: ['manual'], partners: {} },
    })
    expect(normalizeMarkInput({ entryId: 'e1', remove: true })).toEqual({ ok: true, value: { entryId: 'e1', remove: true } })
    expect(normalizeMarkInput({ entryId: 'e1', signature: sig, flags: ['sent_back'] }).ok).toBe(false)
    expect(normalizeMarkInput({ entryId: '', signature: sig, flags: ['manual'] }).ok).toBe(false)
    expect(normalizeMarkInput({ entryId: 'e1', signature: 'x', flags: ['manual'] })).toEqual({ ok: false, error: ENTRY_CHANGED_MESSAGE })
  })

  it('Send back needs a note and a signature', () => {
    expect(normalizeSendBackInput({ entryId: 'e1', signature: sig, note: '  Which client? ' })).toEqual({
      ok: true,
      value: { entryId: 'e1', signature: sig, note: 'Which client?' },
    })
    expect(normalizeSendBackInput({ entryId: 'e1', signature: sig, note: '  ' })).toEqual({ ok: false, error: 'A note is required.' })
    expect(normalizeSendBackInput({ entryId: 'e1', signature: sig })).toEqual({ ok: false, error: 'A note is required.' })
    expect(normalizeSendBackInput({ entryId: 'e1', note: 'x' })).toMatchObject({ ok: false, status: 409 })
    expect(normalizeSendBackInput({ entryId: 'e1', signature: sig, note: 'x'.repeat(1001) }).ok).toBe(false)
  })

  it('Deny needs a note and the signature of every entry it names, the clicked one among them', () => {
    expect(normalizeDenyInput({ entryId: 'e1', signatures: { e1: sig, e2: sig }, note: 'Logged twice' })).toEqual({
      ok: true,
      value: { entryId: 'e1', signatures: { e1: sig, e2: sig }, note: 'Logged twice' },
    })
    expect(normalizeDenyInput({ entryId: 'e1', signatures: { e2: sig }, note: 'x' })).toMatchObject({ ok: false, status: 409 })
    expect(normalizeDenyInput({ entryId: 'e1', signatures: { e1: 'nope' }, note: 'x' })).toMatchObject({ ok: false, status: 409 })
    expect(normalizeDenyInput({ entryId: 'e1', signatures: [sig], note: 'x' })).toMatchObject({ ok: false, status: 409 })
    expect(normalizeDenyInput({ entryId: 'e1', signatures: { e1: sig }, note: '' })).toEqual({ ok: false, error: 'A note is required.' })
  })

  it('Undo names a person, a Sunday and a denial', () => {
    expect(normalizeUndoInput({ userId: 'emp-1', weekStart: '2026-11-08', denialId: 'deny-1' }).ok).toBe(true)
    expect(normalizeUndoInput({ userId: 'emp-1', weekStart: '2026-11-09', denialId: 'deny-1' }).ok).toBe(false)
    expect(normalizeUndoInput({ userId: 'emp-1', weekStart: '2026-11-08' }).ok).toBe(false)
    expect(isWeekStart('2026-11-08')).toBe(true)
    expect(isWeekStart('2026-02-30')).toBe(false)
    expect(isWeekStart('2026-11-14')).toBe(false)
  })
})

describe('a mark keeps what the entry looked like and which partners it covered', () => {
  it('normalizes the fields and the partners, junk dropped', () => {
    const fields = signatureFields(entry())
    const clean = normalizeMark(OK_MARK({ fields, partners: { overlap: ['e3', 'e2', 'e2', 'bad id!'], possible_duplicate: 'x', other: ['e9'] } }))
    expect(clean?.fields).toEqual(fields)
    expect(clean?.partners).toEqual({ overlap: ['e2', 'e3'] })
    expect(normalizeMark(OK_MARK({ fields: 'junk' }))?.fields).toBeUndefined()
    expect(normalizeMarkInput({ entryId: 'e1', signature: entrySignature(entry()), flags: ['overlap'], partners: { overlap: ['e2'] } })).toMatchObject({
      ok: true,
      value: { partners: { overlap: ['e2'] } },
    })
  })
})

describe('hours and words', () => {
  it('counts a block billed in full to each client once, the payroll report’s rule', () => {
    const full = (id, clientId) => entry({ id, clientId, minutes: 60, groupId: 'g1', groupAllocation: 'full' })
    expect(payrollHoursOf([full('p1', 'c1'), full('p2', 'c2')])).toBe(1)
    const even = (id, clientId) => entry({ id, clientId, minutes: 24, groupId: 'g2', groupAllocation: 'even' })
    expect(payrollHoursOf([even('p1', 'c1'), even('p2', 'c2'), even('p3', 'c3')])).toBe(1.2)
  })

  const ACME = [{ date: '2026-11-04', job: 'Acme Dental', task: 'Bookkeeping' }]

  it('tells the person what was removed, the reason and the hours, never money', () => {
    const text = deniedMessage({ ownerName: 'Brittany Smith', hours: 1.2, parts: ACME, note: 'Logged twice by the system' })
    expect(text).toBe(
      'Brittany removed a 1.20h entry from your time (Wed Nov 4, Acme Dental, Bookkeeping). Reason: Logged twice by the system. Your hours for that week are lower by 1.20h. You do not need to do anything. If you think this is a mistake, talk to Brittany.',
    )
    expect(text).not.toMatch(/\$/)
    // A note ending in a period or a question mark never makes "..".
    expect(deniedMessage({ ownerName: 'Brittany', hours: 1.2, parts: ACME, note: 'Same as Monday.' })).toContain('Reason: Same as Monday. Your hours')
    expect(deniedMessage({ ownerName: 'Brittany', hours: 1.2, parts: ACME, note: 'Was this twice? ' })).toContain('Reason: Was this twice? Your hours')
    expect(noteInSentence('Done...')).toBe('Done')
    expect(noteInSentence('Really?! ')).toBe('Really?!')
    expect(deniedMessage({ ownerName: 'Brittany', hours: 1.2, parts: ACME, note: 'Not again!' })).toContain('Reason: Not again! Your hours')
    expect(
      deniedMessage({
        ownerName: 'Brittany',
        hours: 1.2,
        parts: [ACME[0], { date: '2026-11-04', job: 'Bright Books', task: 'Bookkeeping' }],
        note: 'x',
      }),
    ).toContain('removed a 1.20h block from your time (Wed Nov 4; Acme Dental, Bright Books; Bookkeeping)')
  })

  it('a put-back asks the person to disregard the earlier notice', () => {
    expect(restoredMessage({ ownerName: 'Brittany', hours: 1.2, parts: ACME })).toBe(
      "Brittany put back a 1.20h entry in your time (Wed Nov 4, Acme Dental, Bookkeeping). It counts toward that week's hours again. Please disregard the earlier notice about it.",
    )
    expect(weekdayDayText('2026-11-08')).toBe('Sun Nov 8')
  })

  it('a send-back names the day, client and task the same way (both the queue and Payroll review)', () => {
    expect(sentBackMessage({ ownerName: 'Brittany Smith', hours: 1.5, parts: ACME, note: 'Which client?' })).toBe(
      'Brittany sent back your 1.50h entry (Wed Nov 4, Acme Dental, Bookkeeping). Reason: Which client? Edit and resubmit it from the Time page.',
    )
    expect(
      sentBackMessage({ ownerName: '', hours: 1, parts: [{ date: '2026-11-04', job: 'Administrative', task: 'Training' }], note: 'x' }),
    ).toBe('An owner sent back your 1.00h entry (Wed Nov 4, Administrative, Training). Reason: x. Edit and resubmit it from the Time page.')
  })
})

describe('invoicedFacts: which invoices already bill the time (review A)', () => {
  const invoice = (over) => ({ clientId: 'c1', period: '2026-11', kind: 'monthly', status: 'draft', sourceClientIds: [], ...over })
  it('reports unsent and sent monthly invoices for the months a week can touch, never a void one', () => {
    const facts = invoicedFacts(
      [
        invoice({ status: 'reviewed' }),
        invoice({ clientId: 'c2', status: 'sent' }),
        invoice({ clientId: 'c3', status: 'paid', period: '2026-10' }),
        invoice({ clientId: 'c4', status: 'void' }),
        invoice({ clientId: 'c5', kind: 'retainer' }),
        invoice({ clientId: 'c6', period: '2026-08' }),
      ],
      '2026-11-01',
    )
    expect(facts).toEqual([
      { clientId: 'c1', invoiceClientId: 'c1', period: '2026-11', status: 'reviewed', sent: false },
      { clientId: 'c2', invoiceClientId: 'c2', period: '2026-11', status: 'sent', sent: true },
      // The week of Nov 1 reaches back a week into October (a part moved there).
      { clientId: 'c3', invoiceClientId: 'c3', period: '2026-10', status: 'paid', sent: true },
    ])
  })

  it('a month pushed to the next is reported as the invoice that carries it, against the original month', () => {
    const pushed = invoice({ status: 'void', rolledIntoPeriod: '2026-12', sourceClientIds: ['sub'] })
    expect(invoicedFacts([pushed, invoice({ period: '2026-12', status: 'sent' })], '2026-11-08')).toEqual([
      { clientId: 'c1', invoiceClientId: 'c1', period: '2026-11', carriedTo: '2026-12', status: 'sent', sent: true },
      { clientId: 'sub', invoiceClientId: 'c1', period: '2026-11', carriedTo: '2026-12', status: 'sent', sent: true },
    ])
    // The carrying invoice is not generated yet: nothing is said.
    expect(invoicedFacts([pushed], '2026-11-08')).toEqual([])
    // A void carrying invoice is not one either.
    expect(invoicedFacts([pushed, invoice({ period: '2026-12', status: 'void' })], '2026-11-08')).toEqual([])
    expect(weekInvoiceMonths('2026-11-29')).toEqual(['2026-11', '2026-12'])
  })

  it('a billing master’s invoice that carries a sub’s lines bills the sub’s time too', () => {
    const facts = invoicedFacts([invoice({ clientId: 'master', status: 'processing', sourceClientIds: ['sub'] })], '2026-11-08')
    expect(facts).toEqual([
      { clientId: 'master', invoiceClientId: 'master', period: '2026-11', status: 'processing', sent: true },
      { clientId: 'sub', invoiceClientId: 'master', period: '2026-11', status: 'processing', sent: true },
    ])
  })
})

describe('applyEntryMarks: what the screen shows', () => {
  const manual = { kind: 'manual', tier: 'look', label: 'Manual entry', sentence: 'Logged by hand.' }
  const overlap = { kind: 'overlap', tier: 'look', label: 'Overlaps another entry', sentence: 'Overlaps.' }
  const sentBack = { kind: 'sent_back', tier: 'look', label: 'Sent back', sentence: 'Sent back to the person to fix.' }

  it('a current OK turns what it covered into seen, and a new kind still needs a look', () => {
    const result = applyEntryMarks([manual, overlap], { entry: entry(), mark: OK_MARK(), personName: 'Lisa Reyes' })
    expect(result.ok).toBe('current')
    expect(result.flags.find((f) => f.kind === 'manual')).toMatchObject({ tier: 'seen', seenBy: "OK'd by Brittany Nov 20" })
    expect(result.flags.find((f) => f.kind === 'overlap')?.tier).toBe('look')
    expect(result.tickable).toEqual(['overlap'])
  })

  it('an OK covers the overlap partners that were showing; a NEW partner needs a look again', () => {
    const mark = OK_MARK({ flags: ['overlap'], partners: { overlap: ['e2'] } })
    const same = applyEntryMarks([overlap], { entry: entry(), mark, partners: { overlap: ['e2'] } })
    expect(same.flags[0].tier).toBe('seen')
    const more = applyEntryMarks([overlap], { entry: entry(), mark, partners: { overlap: ['e2', 'e3'] } })
    expect(more.flags[0]).toMatchObject({ tier: 'look', sentence: "A new overlap since you OK'd it. Overlaps." })
    expect(more.tickable).toEqual(['overlap'])
    // A partner that went away is no reason to look again.
    expect(applyEntryMarks([overlap], { entry: entry(), mark, partners: {} }).flags[0].tier).toBe('seen')
  })

  it('un-ticks itself when the entry changed since, and says what changed', () => {
    const mark = OK_MARK({ fields: signatureFields(entry()) })
    const result = applyEntryMarks([manual], {
      entry: entry({ minutes: 90, clientId: 'c2' }),
      mark,
      clientName: (id) => ({ c1: 'Acme Dental', c2: 'Bright Books' })[id] ?? id,
    })
    expect(result.ok).toBe('changed')
    expect(result.flags.find((f) => f.kind === 'manual')?.tier).toBe('look')
    expect(result.flags.find((f) => f.kind === 'ok_changed')).toMatchObject({
      tier: 'note',
      sentence: "Changed since you OK'd it on Nov 20 (hours 1.20 to 1.50; client Acme Dental to Bright Books): look again.",
    })
    expect(result.tickable).toEqual(['manual'])
    // A mark from before the fields were kept still un-ticks, without the words.
    expect(applyEntryMarks([manual], { entry: entry({ minutes: 90 }), mark: OK_MARK() }).flags.at(-1)?.sentence).toBe(
      "Changed since you OK'd it on Nov 20: look again.",
    )
  })

  it('says each kind of change in words', () => {
    const before = signatureFields(entry())
    expect(changeWords(before, entry({ date: '2026-11-11' }))).toEqual(['day Nov 10 to Nov 11'])
    expect(changeWords(before, entry({ sessions: [{ startAt: at(10, 9, 5, 7), endAt: at(10, 10, 12, 7) }] }))).toEqual(['clock times'])
    expect(changeWords(before, entry({ groupId: 'g9' }))).toEqual(['shared block'])
    expect(changeWords(before, entry({ employeeId: 'emp-2' }), { personName: (id) => ({ 'emp-1': 'Lisa', 'emp-2': 'Allison' })[id] })).toEqual([
      'person Lisa to Allison',
    ])
    expect(changeWords(before, entry({ isAdministrative: true }))).toEqual(['client c1 to Administrative'])
    // The description and the task are not part of an OK.
    expect(changeWords(before, entry({ description: 'other', taskLabel: 'Payroll' }))).toEqual([])
  })

  it('a sent-back entry says since when and on whom it waits, and cannot be OK’d', () => {
    const sent = entry({ approvalStatus: 'rejected', approvalNote: 'Which client?', approvedAt: new Date(2026, 10, 20, 9, 0).toISOString() })
    const result = applyEntryMarks([manual, sentBack], { entry: sent, mark: null, personName: 'Lisa Reyes' })
    expect(result.flags.find((f) => f.kind === 'sent_back')?.sentence).toBe('Sent back Nov 20, waiting on Lisa: Which client?')
    expect(result.tickable).toEqual([])
  })

  it('a sent-back mark on an entry no longer sent back and not approved reads "Changed, look again", whatever was changed', () => {
    const mark = OK_MARK({ kind: 'sent_back', flags: [], note: 'Which client?' })
    // Only the description changed: the signature is the same, it still needs a look.
    const described = applyEntryMarks([manual], {
      entry: entry({ description: 'Now with the client name', approvalStatus: 'pending' }),
      mark,
      personName: 'Lisa Reyes',
    })
    expect(described.flags[0]).toMatchObject({
      kind: 'changed',
      tier: 'look',
      label: 'Changed, look again',
      sentence: 'Lisa resubmitted this entry after you sent it back (Nov 20), with no change to its hours, day or client. Please check it. Your note was: Which client?',
    })
    expect(described.tickable).toEqual(['changed', 'manual'])
    // Still sent back: nothing to look at again yet.
    const waiting = applyEntryMarks([sentBack], { entry: entry({ approvalStatus: 'rejected' }), mark })
    expect(waiting.flags.some((f) => f.kind === 'changed')).toBe(false)
    // Resubmitted with the same hours, day and client (the signature it was sent back with):
    // it says so instead of "changed".
    const resubmitted = applyEntryMarks([], {
      entry: entry({ description: 'Same time, better words', approvalStatus: 'pending' }),
      mark: OK_MARK({ kind: 'sent_back', flags: [], note: 'Which client?' }),
      personName: 'Lisa Reyes',
    })
    expect(resubmitted.flags[0].sentence).toBe(
      'Lisa resubmitted this entry after you sent it back (Nov 20), with no change to its hours, day or client. Please check it. Your note was: Which client?',
    )
    const moved = applyEntryMarks([], { entry: entry({ minutes: 30, approvalStatus: 'pending' }), mark, personName: 'Lisa Reyes' })
    expect(moved.flags[0].sentence).toContain('Lisa changed this entry after you sent it back (Nov 20).')
    // Approved (in the old queue, say): nothing is shown and nothing counts.
    expect(applyEntryMarks([], { entry: entry({ clientId: 'c2', approvalStatus: 'approved' }), mark }).flags).toEqual([])
  })
})
