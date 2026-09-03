/**
 * Types for the shared invoice line builder. Implementation is plain JS so the
 * server generator can import it; this lets the React side use it too.
 */

/** What produced this line — the persisted invoice stores it, and Client Recap
 *  uses it to separate service revenue from reimbursements. */
export type InvoiceLineKind =
  | 'plan'
  | 'hourly'
  | 'reimbursement'
  | 'recurring'
  | 'adhoc'
  /** The single line of a retainer invoice. */
  | 'retainer'
  /** A paid retainer given back on a later invoice. Always <= 0. */
  | 'retainer_credit'
  /** Informational hours detail. ALWAYS $0.00 — see `timeBreakdownLines`. */
  | 'time_detail'
  /** The card-payment convenience fee, appended when a card payment settles. */
  | 'card-fee'
  /** A true-up carried from last month's invoice. Outside the subtotal. */
  | 'adjustment'
  /** Anything the owner typed, or a kind this build does not recognize. */
  | 'custom'

/** The owner's per-line decision about one piece of ad hoc work. */
export type AdhocMode = 'billed' | 'courtesy' | 'omitted'

export type InvoiceLineOut = {
  kind: InvoiceLineKind
  label: string
  detail: string
  amount: number
  /** Present on `adhoc` lines only. Defaults to 'billed'. */
  adhocMode?: AdhocMode
  /** What billing this work WOULD charge, kept while the line sits at $0.00. */
  adhocAmount?: number
  /* -- the hours rule (featreq-cfb1536a) ----------------------------------- */
  /** Printed 2dp hours. `hours * rate === amount` by construction. */
  hours?: number
  /** The employee's bill rate this line was priced at. */
  rate?: number
  /* -- presentation -------------------------------------------------------- */
  /** Which role heading this row prints under. Presentational ONLY: no money
   *  is derived from it, and a line without one renders ungrouped. */
  roleTier?: InvoiceRoleTier
  /** On a billing master's invoice, the SUB this line was built from. */
  sourceClientId?: string
  /* -- `recurring` lines with a covered-date window configured -------------- */
  /** The recurring reimbursement this line came from, for confirming its dates. */
  recurringId?: string
  /** yyyy-mm-dd, inclusive start of the window this line's wording names. */
  coverageStart?: string
  /** yyyy-mm-dd, the day the cycle turns. */
  coverageEnd?: string
  /** The owner has to confirm these dates before the invoice can be reviewed. */
  needsCoverageConfirmation?: boolean
  /** Why she is being asked: a skipped cycle, or a resumed pause. */
  coverageReason?: 'gap' | 'resumed'
}

export type BuildInvoiceLinesResult = {
  lines: InvoiceLineOut[]
  total: number
  billableMinutes: number
  entryCount: number
  plan: unknown
  periodLabel: string
}

/** Structural inputs — deliberately loose so both the TS and JS callers fit. */
export type BuildInvoiceLinesArgs = {
  client: {
    id: string
    planIds?: string[]
    billingMode?: string
    hourlyRate?: number
    monthlyRate?: number
    annualRate?: number
    annualBillingMonth?: number | string
    monthlyServiceTier?: string
  }
  entries?: Array<{
    clientId?: string
    employeeId?: string
    billable?: boolean
    minutes: number
    date?: string
    description?: string
    /** Out-of-scope one-off work — billed as its own line, never inside hours. */
    isAdhoc?: boolean
  }>
  plans?: Array<{ id: string; name: string }>
  billingPeriod: string
  reimbursements?: Array<{ clientId: string; date: string; description: string; amount: number }>
  recurringReimbursements?: Array<
    {
      id?: string
      clientId: string
      description: string
      amount: number
      frequency: string
      startDate: string
    } & import('./expense-coverage.js').CoverageConfig
  >
  employees?: Array<{ id: string; name?: string; billRate?: number | null }>
  defaultHourlyRate?: number
}

export const PER_EMPLOYEE_BILLING_START: string
export const MONTH_NAMES: string[]
export const currency: Intl.NumberFormat

export function formatDecimalHours(minutes: number): string
export function normalizeBillingMonth(value: unknown): number
export function getBillingPeriodLabel(period: string): string
export function isInBillingPeriod(entry: { date?: string }, period: string): boolean
export const ADHOC_MODES: AdhocMode[]
export function normalizeAdhocMode(value: unknown): AdhocMode
export function adhocLineForMode<T extends { adhocAmount?: number; amount: number }>(
  line: T,
  mode: unknown,
): T & { adhocMode: AdhocMode; adhocAmount: number; amount: number }
export function renderedInvoiceLines<T extends { kind?: string; adhocMode?: string }>(
  lines: T[] | null | undefined,
): T[]

/* -- the rendering mode: what a client-facing document shows ---------------- */

/** A billing master, or any client, as far as the rendering mode is concerned. */
export type InvoiceRenderClient = {
  isBillingMaster?: boolean
  invoiceRenderMode?: string
} | null | undefined

/**
 * 'standard' prints every stored line; 'combined' prints one line for the whole
 * month, with no company names. A billing master defaults to 'combined'.
 */
export type InvoiceRenderMode = 'standard' | 'combined'

/** The single line a 'combined' document prints. */
export type CombinedInvoiceLine = {
  kind: 'combined'
  label: string
  detail: string
  amount: number
}

export const INVOICE_RENDER_MODES: readonly InvoiceRenderMode[]
/** The CLIENT's setting. Renderers usually want `invoiceDocumentRenderMode`. */
export function invoiceRenderMode(client: InvoiceRenderClient): InvoiceRenderMode
/**
 * What THIS document renders in: the client's setting, except that a retainer
 * invoice (`kind: 'retainer'`) is always standard.
 */
export function invoiceDocumentRenderMode(
  invoice: { kind?: string } | null | undefined,
  client: InvoiceRenderClient,
): InvoiceRenderMode
export const COMBINED_INVOICE_COPY: { label(periodLabel: string): string }
/** Line kinds a combined document keeps beside its one line: they explain the
 *  CHARGE rather than describe the work, so they name no company. */
export const COMBINED_KEPT_KINDS: ReadonlySet<string>
/**
 * The lines the CLIENT reads. In 'combined' mode the stored lines are REPLACED
 * by one line — which is why the return type is the union rather than `T[]` —
 * except for `COMBINED_KEPT_KINDS` lines, which follow it. The combined line
 * carries `invoice.total` LESS those kept lines, so the array always sums to
 * `invoice.total`.
 */
export function clientFacingInvoiceLines<
  T extends { kind?: string; adhocMode?: string; label: string; detail: string; amount: number },
>(
  invoice:
    | { kind?: string; period?: string; total?: number; lineItems?: T[] | null }
    | null
    | undefined,
  client: InvoiceRenderClient,
): Array<T | CombinedInvoiceLine>
export function recurringReimbursementAppliesToPeriod(
  recurring: { startDate?: string; frequency?: string },
  period: string,
): boolean
export function buildInvoiceLines(args: BuildInvoiceLinesArgs): BuildInvoiceLinesResult

export const STRIPE_CARD_PERCENT: number
export const STRIPE_CARD_FIXED: number
export const CARD_PROCESSING_FEE_LABEL: string
export function cardProcessingFee(total: number): number
export function cardChargedTotal(total: number): number
export function cardProcessingFeeLine(invoice: { total?: number }): {
  kind: 'card-fee'
  label: string
  detail: string
  amount: number
}

export const TIME_BREAKDOWN_MODES: readonly string[]
export function normalizeTimeBreakdownMode(value: unknown): 'off' | 'person' | 'day' | 'week' | 'entry'
export function breakdownHoursLabel(minutes: number): string
export function timeBreakdownLines(args?: {
  entries?: Array<{ employeeId?: string; minutes: number; date?: string; description?: string }>
  employees?: Array<{ id: string; name: string }>
  mode?: string
  showAmounts?: boolean
  rateFor?: (employeeId?: string) => number
}): Array<{ kind: 'time_detail'; label: string; detail: string; amount: number }>

export const RETAINER_LABEL: string
export const RETAINER_CREDIT_LABEL: string
export function retainerCreditAmount(
  lines: Array<{ kind?: string; amount?: number }> | null | undefined,
  retainerAmount: number,
): number
export function retainerCreditLine(args: {
  lines: Array<{ kind?: string; amount?: number }> | null | undefined
  retainerAmount: number
  retainerId?: string | null
  retainerNumber?: string | null
}): {
  kind: 'retainer_credit'
  label: string
  detail: string
  amount: number
  retainerInvoiceId: string | null
}

/** Statuses in which an invoice's content is frozen — see the JS for why. */
export const LOCKED_INVOICE_STATUSES: readonly string[]
export const LOCKED_INVOICE_FIELDS: readonly string[]
export const INVOICE_LOCKED_MESSAGE: string
export const INVOICE_PROCESSING_LOCKED_MESSAGE: string
export function isInvoiceLocked(invoice: { status?: string } | null | undefined): boolean
export function invoiceLockMessage(
  invoice: { status?: string } | null | undefined,
): string | null
export function invoiceLockRefusal(
  invoice: { status?: string } | null | undefined,
  patch:
    | { lineItems?: unknown; blurb?: unknown; dueDate?: unknown; status?: unknown }
    | null
    | undefined,
): string | null

/** The four staff tiers a line may print under (see lib/staff-tiers.js). */
export type InvoiceRoleTier = 'CFO' | 'Accountant' | 'Bookkeeper' | 'Other'

/** One role heading inside the hours section. `title: null` = ungrouped rows. */
export type InvoiceSectionGroup = {
  key: string
  title: string | null
  rows: InvoiceLineOut[]
}

/**
 * A titled block of the redesigned invoice. `title`/`totalLabel`/`total`
 * are null for the untitled charges block and in combined mode.
 */
export type InvoiceSection = {
  key: 'plan' | 'work' | 'expenses' | 'charges' | 'combined'
  title: string | null
  totalLabel: string | null
  rows: InvoiceLineOut[]
  total: number | null
  groups: InvoiceSectionGroup[] | null
}

/**
 * Group RESOLVED client-facing lines into the invoice's sections.
 * Feed this `clientFacingInvoiceLines(...)`, never `invoice.lineItems` —
 * see the implementation's header for why.
 */
export function invoiceSections(
  lines: InvoiceLineOut[],
  opts?: { combined?: boolean },
): InvoiceSection[]

/** The `time_detail` rows — the detailed-hours appendix ("page 2"). */
export function invoiceDetailRows(lines: InvoiceLineOut[]): InvoiceLineOut[]

/** The detailed-hours appendix heading, shared by all three renderers. */
export const DETAIL_SECTION_TITLE: string

/** The default footer sentence, shared by the PDF, the email and the print sheet. */
export const INVOICE_FOOTER_DEFAULT: string
