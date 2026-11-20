import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Payroll review ship 2 routes (featreq-0b4e42a1). server.js is not booted by
 * the tests, so the glue is pinned by reading the source between anchors, the
 * way the other route tests do. The rules are in
 * lib/payroll-week-approvals.test.mjs; what is stored is in
 * db/store-staleness.test.mjs.
 */

const server = readFileSync(resolve('server.js'), 'utf8').split('\r\n').join('\n')
const notifySource = readFileSync(resolve('lib/notify.js'), 'utf8')
const prefsSource = readFileSync(resolve('lib/notification-prefs.js'), 'utf8')

const slice = (startMark: string, endMark: string) => {
  const start = server.indexOf(startMark)
  const end = server.indexOf(endMark, start + startMark.length)
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  return server.slice(start, end)
}

const gate = slice('async function requirePayrollWeekWriter(request, response) {', '\n}\n')
const read = slice("if (normalizedPath === '/api/payroll-weeks') {", "if (normalizedPath === '/api/payroll-weeks/marks') {")
const marks = slice("if (normalizedPath === '/api/payroll-weeks/marks') {", "if (normalizedPath === '/api/payroll-weeks/send-back') {")
const sendBack = slice("if (normalizedPath === '/api/payroll-weeks/send-back') {", "if (normalizedPath === '/api/payroll-weeks/deny') {")
const deny = slice("if (normalizedPath === '/api/payroll-weeks/deny') {", "if (normalizedPath === '/api/payroll-weeks/undo') {")
const undo = slice("if (normalizedPath === '/api/payroll-weeks/undo') {", '// Approve / reject / edit / delete a single time entry.')

describe('who may act: owners only, same origin, JSON, never in preview', () => {
  it('every write goes through one gate', () => {
    expect(gate).toContain('const session = await requireSession(request, response)')
    expect(gate).toContain("if (request.method !== 'POST') {")
    expect(gate).toContain("if (session.user.role !== 'owner') {")
    expect(gate).toContain("sendJson(response, 403, { error: 'Only owners can review payroll.' })")
    expect(gate).toContain('if (isCrossSiteOrigin(request)) {')
    expect(gate).toContain('if (!isJsonContentType(request)) {')
    for (const route of [marks, sendBack, deny, undo]) {
      expect(route).toContain('const session = await requirePayrollWeekWriter(request, response)')
      expect(route).toContain('if (!session) return')
    }
  })

  it('the read is owner only, takes a Sunday, and carries the capability marker', () => {
    expect(read).toContain("if (session.user.role !== 'owner') {")
    expect(read).toContain('if (!isWeekStart(weekStart)) {')
    expect(read).toContain('actions: { ok: true, sendBack: true, deny: true, undo: true }')
    // The full stored copies never leave the server.
    expect(read).toContain('deniedEntries: row.deniedEntries.map(({ entries: _stored, ...denial }) => denial)')
  })

  it('a preview is refused: the paths are not on the preview allowlist', () => {
    const allowlist = server.slice(server.indexOf('const PREVIEW_AWARE_API_PATHS = new Set(['), server.indexOf('])', server.indexOf('const PREVIEW_AWARE_API_PATHS = new Set([')))
    expect(allowlist).not.toContain('payroll-weeks')
  })
})

describe('each action checks its body on the server and refuses a changed entry', () => {
  it('OK, looked at', () => {
    expect(marks).toContain('normalizeMarkInput(await readJsonBody(request))')
    expect(marks).toContain('expectedSignature: signature')
    expect(marks).toContain('sendPayrollWeekRefusal(response, error)')
  })

  it('Send back is today’s reject, plus the mark', () => {
    expect(sendBack).toContain('normalizeSendBackInput(await readJsonBody(request))')
    expect(sendBack).toContain('if (entrySignature(entry) !== signature) {')
    expect(sendBack).toContain('sendJson(response, 409, { error: ENTRY_CHANGED_MESSAGE })')
    expect(sendBack).toContain('await sendTimeEntryBack({ entry, entryId, note, session, request })')
    // The mark is left by the shared helper, so the old queue's reject leaves it too.
    expect(sendBack).toContain('const { updated, week } = await sendTimeEntryBack({ entry, entryId, note, session, request })')
    // The old reject route uses the very same helper.
    const reject = slice('// ---- Reject ----', '// ---- Edit (PATCH) ----')
    expect(reject).toContain("sendJson(response, 400, { error: 'A rejection note is required' })")
    expect(reject).toContain('await sendTimeEntryBack({ entry, entryId, note, session, request })')
    const helper = slice('async function sendTimeEntryBack({', '\n}\n')
    expect(helper).toContain("approvalStatus: 'rejected'")
    expect(helper).toContain("'time_entry_rejected'")
    expect(helper).toContain("kind: 'sent_back'")
    expect(helper).toContain('appDataStore.savePayrollEntryMark({')
    expect(helper).toContain('message: sentBackMessage({')
    // Best effort: a failed mark is logged, the send-back stands.
    expect(helper).toContain("console.error('[payroll-weeks] send-back mark failed:'")
    expect(reject).toContain('const { updated } = await sendTimeEntryBack({ entry, entryId, note, session, request })')
  })

  it('Deny: note required, every part signed, the new notice, activity recorded', () => {
    expect(deny).toContain('normalizeDenyInput(await readJsonBody(request))')
    expect(deny).toContain('await appDataStore.denyPayrollEntries({')
    expect(deny).toContain("'time_entry_denied'")
    expect(deny).toContain('deniedMessage({')
    expect(deny).toContain("appDataStore.recordActivity(\n          session.user.id,\n          'time_entry_denied',")
    // After the commit everything is best effort: logged, and the answer is still 200.
    expect(deny).toContain("console.error('[payroll-weeks] deny activity failed:'")
    expect(undo).toContain("console.error('[payroll-weeks] undo activity failed:'")
    const helper = slice('async function sendTimeEntryBack({', '\n}\n')
    expect(helper).toContain("console.error('[time-entries] reviewer lookup failed:'")
    // The person is not told of their own entry (the reject's rule).
    expect(deny).toContain('if (userId !== session.user.id) {')
    expect(deny).not.toContain('currency')
  })

  it('Undo: puts back, records, tells the person', () => {
    expect(undo).toContain('normalizeUndoInput(await readJsonBody(request))')
    expect(undo).toContain('await appDataStore.undoPayrollDenial(checked.value)')
    expect(undo).toContain("'time_entry_denial_undone'")
    expect(undo).toContain("'time_entry_restored'")
  })

  it('no read of the workspace carries the week rows: not the staff read, not the owner read (file backend)', () => {
    expect(server).toContain('    payrollWeekApprovals: undefined,')
    expect(server).toContain('const { payrollWeekApprovals: _payrollRows, ...served } = scopeAppDataForSession(scopingSession, data)')
    expect(server).toContain('sendJson(response, 200, served, {')
  })

  it('the notices name the client and task through narrow lookups, never the whole-workspace read', () => {
    const parts = slice('async function payrollNoticeParts(parts) {', '\n}\n')
    expect(parts).toContain('appDataStore.lookupNoticeNames({')
    expect(parts).not.toContain('.read()')
  })

  it('the read carries which invoices already bill the week, read only', () => {
    // Only the months the week touches, never every invoice.
    expect(read).toContain('await appDataStore.listInvoiceEvidence({ periods: weekInvoiceMonths(weekStart) }),')
    expect(read).toContain('{ weekStart, weeks, invoiced, actions:')
  })
})

describe('the new notices', () => {
  it('are known events, in the "sent back" email switch', () => {
    expect(notifySource).toContain("'time_entry_denied',")
    expect(notifySource).toContain("'time_entry_restored',")
    expect(prefsSource).toContain("events: ['time_entry_rejected', 'time_entry_denied', 'time_entry_restored'],")
  })
})

