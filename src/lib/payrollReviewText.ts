/** The Payroll review's own sentences (featreq-20b13da0), kept apart so tests and the page read the same words. */

export const REVIEW_ONLY_TEXT =
  'Review only: nothing here approves, sends back or changes any time. Look the week over here, then approve on the Weekly submissions tab or in the Approval queue. Approving there does not lock the time, so it can still be edited.'
/**
 * The notice once this tab can act on an entry (ship 2). It still does not
 * approve or lock a week: that is ship 3.
 */
export const REVIEW_ACTIONS_TEXT =
  'Here you can OK an entry you have looked at, send one back to be fixed, or deny and remove one (it comes off their hours and off client reports and invoices; Undo is under Removed from payroll). Nothing here approves or locks a week. Approve on the Weekly submissions tab or in the Approval queue; approving there does not lock the time.'
/** Under the "Needs a look" key, once she can act. */
export const OK_KEY_TEXT =
  'OK, looked at: your note that you checked this entry. It does not approve the entry or the week, and it changes no hours.'
export const OK_COVERS_TEXT =
  'An OK covers the person, day, hours, client, clock times and shared block. If any of those change, your OK comes off and the line says what changed. If the entry is moved to another person or another week, the OK does not follow it. Changing the description or task does not remove it.'
export const CHANGED_KEY_TEXT =
  'Changed, look again: an entry you sent back has been changed by the person and is not approved yet.'
export const OK_ACTION_LABEL = 'OK, looked at'
export const UNDO_OK_LABEL = 'Remove my OK'
export const SEND_BACK_LABEL = 'Send back to fix'
export const DENY_LABEL = 'Deny and remove'
export const UNDO_LABEL = 'Undo'
/** The one-line helper under each choice in the Actions menu. */
export const OK_HELP_TEXT = 'Your note that you looked. Changes nothing.'
export function sendBackHelpText(person: string) {
  return `${person} fixes it. The time stays as it is until then.`
}
export function denyHelpText(person: string) {
  return `Takes this time off ${person}'s hours and off every report and invoice.`
}
export const NOTE_REQUIRED_TEXT = 'Write a reason first. The person reads it.'
/** The note box's label on Send back and Deny. */
export function reasonLabel(person: string) {
  return `Reason (${person} will read this)`
}
export const NOTICE_PREVIEW_LABEL = 'The notice, as it will be sent:'
export const REMOVED_HEADING = 'Removed from payroll'
/**
 * Beside the person's totals: the hours removed that are DATED in the week on
 * screen, and those of a removed block dated in another week.
 */
export function removedHoursText(hours: number, elsewhere = 0) {
  const fmt = (value: number) => `${(value === 0 ? 0 : value).toFixed(2)}h`
  return elsewhere > 0
    ? `${fmt(hours)} removed this week (plus ${fmt(elsewhere)} dated in another week; see Removed from payroll below). It is not in the totals.`
    : `${fmt(hours)} removed this week (see Removed from payroll below). It is not in the totals.`
}
/** What Send back to fix will do, in the sheet she confirms. */
export function sendBackConfirmText(person: string) {
  return `${person} is told your reason, and the entry shows as waiting on ${person} until it is changed. It still counts toward the week until then.`
}
/**
 * What Deny and remove will do. `taken`: "1.20h, $27.00 at cost, $120.00
 * billable" (no money while rates are not read).
 */
export function denyConfirmText(person: string, taken: string) {
  return `This takes ${taken} off ${person}'s time. The entry is deleted, so it also drops off client reports and invoices. A copy is kept. ${person} is told your reason and that their hours are lower by that much. To put it back, press Undo under "Removed from payroll" below ${person}'s name.`
}
export const DENY_SHARED_TEXT = 'This entry is part of a block shared between clients. The whole block is removed, every part:'
export const DENY_BUTTON_LABEL = 'Remove from payroll'
export function denyBlockButtonLabel(parts: number) {
  return `Remove the whole block (${parts} parts)`
}
/** A part of a block dated outside the week on screen, on its confirm line. */
export function otherWeekText(day: string) {
  return `dated ${day}, another week`
}
/** The status line at the top of the tab after a deny. */
export function deniedStatusText(hours: number, person: string) {
  return `Removed ${(hours === 0 ? 0 : hours).toFixed(2)}h from ${person}'s week. Undo is under Removed from payroll below.`
}
/** The one-line confirm before Undo, which sends a notice. */
export function undoConfirmText(person: string) {
  return `Put this back and tell ${person}?`
}
export const UNDO_CONFIRM_LABEL = 'Put back'
/** "Removed by Brittany Nov 20: <note>". */
export function removedByText(name: string, day: string, note: string) {
  return `Removed by ${name || 'an owner'}${day ? ` ${day}` : ''}: ${note}`
}
export const STAFF_REMOVED_NOTE =
  'The person does not see removed time on their Time page; the notice they are sent is how they know.'
/**
 * The invoice warning in the deny confirm, one per invoice that already bills
 * the time (featreq-0b4e42a1 review A). `client`: whose invoice it is (a
 * billing master's name when the time is a sub's); `month`: "October".
 */
export function invoiceWarningText(client: string, month: string, sent: boolean, carriedFrom?: string) {
  const on = `This time is on ${client}'s ${month} invoice${carriedFrom ? ` (carried from ${carriedFrom})` : ''}`
  return sent
    ? `${on}, which has been SENT. That invoice will not change. If the client should not be billed for it, fix the invoice separately.`
    : `${on}, which has not been sent. It will drop off when that invoice is generated again.`
}
export const DASH_MEANS_TEXT = 'A dash means there is no rate on file. It is not $0.'
export const TOTALS_COUNT_TEXT =
  'Day and week totals count every entry still in the time, approved or not, the same way the Hours report does. Entries you removed are not counted.'
export const OWNERS_LEFT_OUT_TEXT = "Owners' own time is not included. Pick an owner under Person to see it."
export const RATES_LOADING_TEXT = 'Reading rates...'
export const RATES_FAILED_TEXT = 'Rates could not be read, so pay figures are missing. Reload to try again.'
export const PAYCHECK_COUNTS_TEXT =
  'Counts every entry still in the time in these two weeks, approved or not. Entries you removed are not counted.'
export const PAYCHECK_FOOT_TEXT =
  'Pay is figured on the two weeks together, so it can differ by a cent from adding the two weekly figures. A block billed in full to each client, with parts in both weeks, has its hours counted once across the two weeks, so the weekly hours can add to more than the total.'
