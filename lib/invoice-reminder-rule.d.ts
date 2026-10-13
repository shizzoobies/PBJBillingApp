/**
 * Types for the plain-JS `lib/invoice-reminder-rule.js`, so the month run reads
 * the same "may this invoice be reminded?" rule the server route enforces.
 */

import type { InvoiceLogEntry, InvoiceSendLogEntry } from './invoice-overdue'

export declare const REMINDER_KIND: 'reminder'

export type ReminderRefusalCode =
  | 'invoice_voided'
  | 'invoice_not_sent'
  | 'payment_clearing'
  | 'invoice_paid'
  | 'nothing_owed'
  | 'client_opted_out'
  | 'client_not_emailed'
  | 'autopay_in_flight'
  | 'changed_since_sent'
  | 'reminded_today'

/** The newest reminder that actually left, or null. */
export declare function latestInvoiceReminder(
  emailLog: readonly InvoiceLogEntry[] | undefined | null,
): InvoiceSendLogEntry | null

/** The newer of the last ok reminder and the last ok send, as an ISO instant. */
export declare function lastRemindedOrSentAt(
  emailLog: readonly InvoiceLogEntry[] | undefined | null,
): string | null

export declare function reminderRefusalCode(args: {
  invoice: {
    status?: string
    total?: number
    emailLog?: readonly InvoiceLogEntry[] | null
  } | null | undefined
  client: { platformInvoicingOptOut?: boolean; invoiceNoEmail?: boolean } | null | undefined
  autopayActive: boolean
  changedSinceSent: boolean
  /** The firm's day, YYYY-MM-DD (`firmToday()`). */
  today: string
}): ReminderRefusalCode | null

export declare const REMINDER_REFUSAL_TIPS: Readonly<Record<ReminderRefusalCode, string>>

export declare function reminderRefusalMessage(code: string, clientName?: string): string
