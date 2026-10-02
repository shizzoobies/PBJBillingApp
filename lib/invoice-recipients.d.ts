/**
 * Types for the plain-JS `lib/invoice-recipients.js`, so `src/` can call the
 * SAME resolver the send endpoint uses instead of keeping a second TypeScript
 * copy of the rules that would drift away from it.
 */

/** One resolved address and who it belongs to. */
export type InvoiceRecipientDetail = {
  email: string
  /** The contact's name, or `'client record'` for the address on the client. */
  source: string
}

export type ResolvedInvoiceRecipients = {
  to: string[]
  details: InvoiceRecipientDetail[]
  /** Non-null only when `to` is empty — what is missing, in words. */
  reason: string | null
}

/** Structural inputs — deliberately loose so both the TS and JS callers fit. */
export type ResolveInvoiceRecipientsArgs = {
  client?: {
    id?: string
    email?: string | null
    contactIds?: string[]
  } | null
  contacts?: Array<{
    id: string
    name?: string
    email?: string
    archivedAt?: string | null
    companyEmails?: Array<{ clientId: string; email: string }>
  }>
}

export declare const NO_INVOICE_RECIPIENT_REASON: string
export declare const NO_CHOSEN_RECIPIENT_REASON: string
export declare const CLIENT_RECORD_SOURCE: string

export declare function resolveInvoiceRecipients(
  args: ResolveInvoiceRecipientsArgs,
): ResolvedInvoiceRecipients

export declare function chooseInvoiceRecipients(
  allowed: string[],
  requested: unknown,
): { to: string[]; reason: string | null }

/** A plausible single address: trimmed, one `@`, a dot in the domain, no whitespace. */
export declare function isPlausibleEmail(value: unknown): boolean

/** The most addresses one send may carry beyond the ones on file. */
export declare const MAX_EXTRA_INVOICE_RECIPIENTS: number

/** What the 409 says when the browser chose from addresses the server no longer has. */
export declare const RECIPIENTS_CHANGED_REASON: string

export declare const EXTRA_RECIPIENT_REFUSALS: {
  readonly shape: string
  readonly invalid: string
  readonly tooMany: string
}

/** The extra addresses a send carries, cleaned - or the sentence that refuses them. */
export declare function cleanExtraRecipients(requested: unknown): {
  extra: string[]
  reason: string | null
}

/** Who a send goes to: the chosen on-file addresses plus the one-time extras. */
export declare function resolveSendRecipients(args: {
  allowed: string[]
  to?: unknown
  extra?: unknown
}):
  | { ok: true; to: string[]; oneTime: string[] }
  | { ok: false; status: number; error: string; message: string }
