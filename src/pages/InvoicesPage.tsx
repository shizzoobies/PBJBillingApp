import { ExternalLink, FileText, Mail, Plus, Printer, RotateCcw, Sliders, Trash2 } from 'lucide-react'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppContext } from '../AppContext'
import { AddModal } from '../components/AddModal'
import { InvoiceHistory } from '../components/InvoiceHistory'
import { InvoiceMonthRun, type InvoiceMonthRunHandle } from '../components/InvoiceMonthRun'
import { ReimbursementsCard } from '../components/ReimbursementsCard'
import type {
  BillRateVersion,
  Client,
  Employee,
  Invoice,
  InvoiceEmailLogEntry,
  PersistedInvoice,
  PersistedInvoiceLine,
  InvoiceLine,
  RecurringReimbursement,
  Reimbursement,
  SubscriptionPlan,
  TimeEntry,
} from '../lib/types'
import { ApiError } from '../lib/types'
import {
  currency,
  formatDecimalHours,
  formatSentOn,
  getBillingPeriodLabel,
  getInvoice,
  INVOICE_STATUS_LABELS,
  isInBillingPeriod,
  isSafeHttpUrl,
  isSafeImageSrc,
  latestInvoiceSend,
  recipientCountLabel,
  resolveInvoiceRecipients,
  type InvoiceRecipientDetail,
} from '../lib/utils'
import {
  DETAIL_SECTION_TITLE,
  INVOICE_FOOTER_DEFAULT,
  clientFacingInvoiceLines,
  invoiceDetailRows,
  invoiceDocumentRenderMode,
  invoiceSections,
  isEmptyPlanLine,
  normalizeTimeBreakdownMode,
  renderedInvoiceLines,
} from '../../lib/invoice-lines.js'
import { invoiceDisplayDate, paymentTermsLabel } from '../../lib/invoice-draft.js'
import { mailingAddressLines } from '../../lib/mailing-address.js'
import type { InvoiceLineOut, InvoiceRoleTier } from '../../lib/invoice-lines.js'
import { InvoiceDeliveryBadge } from '../components/InvoiceDeliveryBadge'
import { InvoiceRecipientPicker } from '../components/InvoiceRecipientPicker'
import {
  fetchRateVersions,
  generateInvoicesRequest,
  listInvoicesRequest,
  sendInvoiceRequest,
} from '../lib/api'
import { selectableClients } from '../lib/clientLifecycle'
import { invoiceAddressee } from '../lib/completeness'
import { generateSkipMessage } from '../lib/invoiceSkipMessage'

/**
 * `roleTier` is declared here rather than on `InvoiceLine`: it is presentational
 * only, and this page is the one place that reads it. Carrying it (and `kind`)
 * through EVERY builder below is load-bearing — a display row that loses either
 * lands ungrouped, or vanishes from the sheet entirely.
 */
type DisplayLine = InvoiceLine & {
  groupKey?: string
  roleTier?: InvoiceRoleTier
  /** A recurring line's Software mark: it prints under its own heading. */
  section?: 'software'
}

type DisplayInvoice = {
  invoice: Invoice
  /**
   * What KIND of document this is — carried because the client-facing renderer
   * asks. `Invoice` is the ephemeral per-client calculation and has no `kind`
   * of its own, and a retainer is exempt from combined rendering: rendered
   * combined it would print "Bookkeeping services — August 2026" over money
   * that is not a month's bookkeeping. Only a stored invoice can be a retainer,
   * so every other builder here says 'monthly'.
   */
  kind: PersistedInvoice['kind']
  /** The stored invoice's number. Null for the live preview, which has none. */
  number: string | null
  /**
   * The invoice's OWN date, from `invoiceDisplayDate` — sent, else created, or
   * the last day of its billing month from September 2026 on. The live preview
   * is a calculation rather than a document, so it leaves this null and sets
   * `liveForPeriod` instead: the sheet works its date out from that, through the
   * same rule (`liveInvoiceDate`), when it renders. Printing `new Date()` for a
   * stored invoice was a real bug: an August invoice reprinted in October said
   * October.
   */
  invoiceDate: string | null
  /**
   * Set on the live preview only: the billing month it calculates. Its date is
   * worked out when the sheet RENDERS (`liveInvoiceDate`), never stored here,
   * so a page left open overnight does not keep printing yesterday.
   */
  liveForPeriod?: string
  lines: DisplayLine[]
  groupSubtotals: Array<{ label: string; total: number }>
  hideTimeBreakdown: boolean
  hideInternal: boolean
  groupByCategory: boolean
}

// ---- Build-invoice (customize-before-print) draft model -------------------
// Session-only: the draft lives in component state, seeded from the generated
// invoice. It is intentionally NOT persisted (v1). Switching client/period or
// refreshing re-seeds from the freshly generated invoice.

type IncludeFlags = {
  contactName: boolean
  email: boolean
  phone: boolean
  address: boolean
  logo: boolean
  serviceLabel: boolean
  paymentTerms: boolean
  footerNote: boolean
  payLink: boolean
}

type DraftLine = DisplayLine & { id: string }

type InvoiceDraft = {
  include: IncludeFlags
  lines: DraftLine[]
  intro: string
  footer: string
}

type CustomMeta = { include: IncludeFlags; intro: string; footer: string }

const INCLUDE_FIELDS: Array<{ key: keyof IncludeFlags; label: string }> = [
  { key: 'contactName', label: 'Contact name' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'address', label: 'Mailing address' },
  { key: 'logo', label: 'Logo' },
  { key: 'serviceLabel', label: 'Service / plan label' },
  { key: 'paymentTerms', label: 'Payment terms' },
  { key: 'footerNote', label: 'Footer note' },
  { key: 'payLink', label: 'QuickBooks pay link' },
]

let draftLineSeq = 0
function makeLineId() {
  draftLineSeq += 1
  return `draft-line-${draftLineSeq}`
}

function hasText(value?: string | null) {
  return Boolean(value && value.trim().length > 0)
}

function hasAddress(client: Client) {
  return (
    hasText(client.addressLine1) ||
    hasText(client.addressLine2) ||
    hasText(client.city) ||
    hasText(client.state) ||
    hasText(client.postalCode)
  )
}

function getServiceLabel(client: Client) {
  if (client.billingMode === 'subscription') {
    return client.monthlyServiceTier || 'Monthly service'
  }
  if (client.billingMode === 'annual') {
    return client.monthlyServiceTier || 'Annual service'
  }
  return 'Billable hours'
}

function seedDraft(display: DisplayInvoice, client: Client, hasFirmLogo: boolean): InvoiceDraft {
  return {
    include: {
      contactName: hasText(client.contactName),
      email: hasText(client.email),
      phone: hasText(client.phone),
      address: hasAddress(client),
      logo: hasText(client.logoUrl) || hasFirmLogo,
      serviceLabel: true,
      // Always on offer now: the terms line tells the client when to pay, so it
      // has something to say even for a client whose record leaves terms blank.
      // It is still hers to switch off.
      paymentTerms: true,
      footerNote: hasText(client.footerNote),
      payLink: hasText(client.quickbooksPayUrl),
    },
    // `kind` and `roleTier` ride along even though the editor never shows them:
    // the sheet groups on them, so a draft that dropped them would print every
    // row under no heading — or, for a kind the section layer does not name, not
    // print it at all.
    lines: display.lines.map((line) => ({
      id: makeLineId(),
      kind: line.kind,
      roleTier: line.roleTier,
      section: line.section,
      hours: line.hours,
      label: line.label,
      detail: line.detail,
      amount: line.amount,
    })),
    intro: '',
    footer: client.footerNote ?? '',
  }
}

function draftToDisplay(draft: InvoiceDraft, baseInvoice: Invoice): DisplayInvoice {
  const lines: DisplayLine[] = draft.lines.map((line) => ({
    kind: line.kind,
    roleTier: line.roleTier,
    section: line.section,
    hours: line.hours,
    label: line.label,
    detail: line.detail,
    amount: line.amount,
  }))
  const total = lines.reduce(
    (sum, line) => sum + (Number.isFinite(line.amount) ? line.amount : 0),
    0,
  )
  return {
    invoice: { ...baseInvoice, lines, total },
    kind: 'monthly',
    number: null,
    invoiceDate: null,
    liveForPeriod: baseInvoice.period,
    lines,
    groupSubtotals: [],
    hideTimeBreakdown: false,
    hideInternal: true,
    groupByCategory: false,
  }
}

const invoiceDateFormat = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
})

/**
 * The printed "Invoice Date". `value` is the invoice's stored timestamp; null
 * (the live preview, which is not yet an invoice) falls back to today.
 *
 * Reads the UTC calendar day out of the timestamp — `raw.slice(0, 10)` — and
 * formats THAT day at noon, exactly as the generated PDF's `stampDate` does
 * (`lib/invoice-pdf.js`). Falling through to `new Date(isoTimestamp)` instead
 * parses the FULL timestamp in the LOCAL timezone, so a `createdAt` stamped
 * just after midnight UTC (a 9pm ET generate) prints the day before on this
 * sheet while the PDF — which only ever looks at the UTC calendar day — prints
 * the day after: two client-facing copies of the same invoice disagreeing on
 * their own date. A bare `yyyy-mm-dd` value is read the same way, for the same
 * reason `formatEntryDate` reads noon a few lines down: a plain UTC-midnight
 * parse would print the day BEFORE in every US timezone.
 */
function formatInvoiceDate(value: string | null | undefined) {
  const raw = value?.trim()
  if (raw) {
    const day = raw.slice(0, 10)
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      const parsed = new Date(`${day}T12:00:00`)
      if (!Number.isNaN(parsed.getTime())) return invoiceDateFormat.format(parsed)
    }
  }
  return invoiceDateFormat.format(new Date())
}

/**
 * The date the live per-client preview prints: today's LOCAL date run through
 * the same rule a stored invoice uses (`invoiceDisplayDate`), so a finished
 * month from September 2026 on prints its last day and the current month prints
 * today. Never the stored-invoice path — the preview is not a document yet.
 */
function liveInvoiceDate(period: string): string | null {
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`
  return invoiceDisplayDate({ period, createdAt: today })
}

function formatEntryDate(date: string) {
  const parsed = new Date(`${date}T12:00:00`)
  if (Number.isNaN(parsed.getTime())) {
    return date
  }
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(parsed)
}

function buildDisplayInvoice(
  invoice: Invoice,
  entries: TimeEntry[],
  billingPeriod: string,
): DisplayInvoice {
  const client = invoice.client
  const hideInternal = client.invoiceHideInternalHours ?? true
  // Derived from the ONE setting the owner edits (featreq-…), not from the
  // older boolean beside it — two sources here meant this preview and the
  // generated invoice could disagree about whether a client shows time.
  const showBreakdown = normalizeTimeBreakdownMode(client.invoiceTimeBreakdownMode) !== 'off'
  const groupByCategory = client.invoiceGroupByCategory ?? false

  const clientEntries = entries.filter(
    (entry) =>
      entry.clientId === client.id &&
      isInBillingPeriod(entry, billingPeriod) &&
      (hideInternal ? entry.billable : true),
  )

  if (!showBreakdown) {
    return {
      invoice,
      lines: [
        {
          // Not a `plan`/`hourly` row — it is the whole month collapsed into one
          // summary line. `custom` puts it in the untitled block, which prints it
          // plainly with no heading and no section total. A row with no `kind` at
          // all would be dropped by the section layer and take its money with it.
          kind: 'custom',
          label: `Bookkeeping services - ${invoice.periodLabel}`,
          detail: `${formatDecimalHours(invoice.billableMinutes)} this period`,
          amount: invoice.total,
        },
      ],
      kind: 'monthly',
      number: null,
      invoiceDate: null,
      liveForPeriod: billingPeriod,
      groupSubtotals: [],
      hideTimeBreakdown: true,
      hideInternal,
      groupByCategory: false,
    }
  }

  // Build per-entry rate-based lines, then merge with subscription/plan lines
  // from the base invoice so subscription clients still see their plan fee.
  // Ad hoc and hourly lines are dropped here because `entryLines` below
  // re-lists EVERY client entry, ad hoc and hourly ones included — keeping
  // both would show the same work twice on this preview.
  //
  // Filtered by KIND, not by label. It used to filter on the exact labels
  // 'Billable hours' / 'Hourly overage', which stopped matching once the June
  // 2026 cutover made hourly labels per-person ("Billable hours — <name>"), so
  // hourly work was listed twice here — invisible while nothing printed a
  // section total next to it, but wrong now that "Total Ad-Hoc/Billable
  // Hours" prints beside a correct Total due: the section total would read
  // roughly double the actual charge. `kind !== 'hourly'` matches regardless
  // of label wording, the same way `invoiceSections` already groups by kind.
  const subscriptionLines = invoice.lines.filter(
    (line) => line.kind !== 'adhoc' && line.kind !== 'hourly',
  )

  // Work-type categorization is retired; fall back to a generic label so
  // existing invoice grouping keeps working for legacy and new entries alike.
  const entryCategory = (entry: TimeEntry) => entry.category ?? 'Bookkeeping services'

  const entryLines: DisplayLine[] = clientEntries
    .slice()
    .sort((a, b) =>
      a.date === b.date
        ? entryCategory(a).localeCompare(entryCategory(b))
        : a.date.localeCompare(b.date),
    )
    .map((entry) => {
      const amount = entry.billable ? (entry.minutes / 60) * client.hourlyRate : 0
      const detail = entry.billable
        ? `${formatDecimalHours(entry.minutes)} at ${currency.format(client.hourlyRate)}/hr · ${formatEntryDate(entry.date)}`
        : `${formatDecimalHours(entry.minutes)} · ${formatEntryDate(entry.date)} · internal`
      return {
        // These rows ARE the hours, so they belong to the hours section. They
        // carry no `roleTier` — this preview lists raw time entries rather than
        // the generator's per-person lines — so they print ungrouped at the top
        // of that section, which is exactly what a row with no tier is for.
        kind: 'hourly' as const,
        label: entryCategory(entry),
        detail: entry.description ? `${detail} · ${entry.description}` : detail,
        amount,
        groupKey: entryCategory(entry),
      }
    })

  let lines: DisplayLine[]
  let groupSubtotals: Array<{ label: string; total: number }> = []

  if (groupByCategory && entryLines.length > 0) {
    const groups = new Map<string, DisplayLine[]>()
    for (const line of entryLines) {
      const key = line.groupKey ?? 'Other'
      const existing = groups.get(key) ?? []
      existing.push(line)
      groups.set(key, existing)
    }
    const ordered: DisplayLine[] = []
    for (const [category, items] of groups) {
      ordered.push(...items)
      groupSubtotals.push({
        label: category,
        total: items.reduce((sum, item) => sum + item.amount, 0),
      })
    }
    lines = [...subscriptionLines, ...ordered]
  } else {
    lines = [...subscriptionLines, ...entryLines]
    groupSubtotals = []
  }

  return {
    invoice,
    kind: 'monthly',
    number: null,
    invoiceDate: null,
    liveForPeriod: billingPeriod,
    lines,
    groupSubtotals,
    hideTimeBreakdown: false,
    hideInternal,
    groupByCategory,
  }
}


/**
 * Adapt a STORED invoice into the shape the preview / print document already
 * speaks, so a generated invoice prints through exactly the same renderer the
 * live per-client view uses — one printed format, not two that drift.
 *
 * The time-breakdown flags are forced off: a stored invoice carries its lines,
 * not the underlying entries, so there is no per-entry detail to expand and
 * pretending otherwise would print an empty section.
 *
 * Ad hoc lines the owner left off drop out here, through the same shared filter
 * the PDF and the email use — the printed page and the emailed one have to be
 * the same document. They carry $0.00, so nothing below moves.
 */
function persistedToDisplay(
  stored: PersistedInvoice,
  client: Client,
  periodLabel: string,
): DisplayInvoice {
  // `kind` is carried through, not dropped as it was: the client-facing
  // renderer keeps a `card-fee`, a `retainer_credit` and an `account_credit` line even in combined
  // mode — they explain the CHARGE rather than describe the work — and it can
  // only recognize them by kind. Mapping to label/detail/amount alone erased a
  // card fee from the printed sheet while the PDF and the email still showed
  // it, which is the one place those three documents may not disagree.
  //
  // `roleTier` is carried for the same reason and it is the same class of bug:
  // the sheet groups the hours section by it, so dropping it here would print
  // every person's row ungrouped while the PDF and the email showed the role
  // headings. Both fields must survive this mapping.
  const lines: DisplayLine[] = renderedInvoiceLines<
    PersistedInvoiceLine & { roleTier?: InvoiceRoleTier }
  >(stored.lineItems).map((line) => ({
    kind: line.kind,
    roleTier: line.roleTier,
    section: line.section,
    // `hours` too: the sheet leaves an hours row with no hours off, as the PDF
    // does, and `isEmptyHoursLine` can only recognize one that still has it.
    hours: line.hours,
    label: line.label,
    detail: line.detail,
    amount: line.amount,
  }))
  return {
    invoice: {
      client,
      plan: null,
      billableMinutes: 0,
      entryCount: 0,
      period: stored.period,
      periodLabel,
      lines,
      total: stored.total,
    },
    kind: stored.kind,
    number: stored.number,
    // Sent, else created. NOT today: this sheet is a copy of a document that
    // already has a date, and reprinting it may not re-date it.
    invoiceDate: invoiceDisplayDate(stored),
    lines,
    groupSubtotals: [],
    hideTimeBreakdown: true,
    hideInternal: true,
    groupByCategory: false,
  }
}

export function InvoicesPage({
  openPeriod = null,
  onOpenPeriodHandled,
}: {
  /**
   * A billing month (`YYYY-MM`) the page was opened on, from the URL's `period`
   * query (a payment notification links to `/invoices?period=2026-09`). The month
   * run moves to it and the page tells its caller it has done so, so the query is
   * dropped and the same link works again later.
   */
  openPeriod?: string | null
  onOpenPeriodHandled?: () => void
} = {}) {
  const {
    data,
    selectedClientId,
    setSelectedClientId,
    billingPeriod,
    printInvoice,
    ownerMode,
    previewMode,
    applyScopeTagsLocally,
    updateClient,
    firmSettings,
  } = useAppContext()

  /**
   * Dated bill rates, so a pinned client PREVIEWS at its pin — the same rate the
   * generated invoice bills it at. Owner-only data; the endpoint 403s in a
   * preview-as session and the helper hands back empty lists, which is not an
   * error: `getInvoice` then falls back to today's rates as it always did.
   */
  const [billRateVersions, setBillRateVersions] = useState<BillRateVersion[]>([])
  useEffect(() => {
    const controller = new AbortController()
    fetchRateVersions(controller.signal)
      .then((versions) => setBillRateVersions(versions.billRateVersions))
      // Non-fatal: the preview simply prices at today's rates.
      .catch(() => {})
    return () => controller.abort()
  }, [])

  // The billing queue and its client picker are a to-do list for THIS month's
  // invoicing, so retired clients drop out — the monthly run skips them too, and
  // a queue row you can never action is just a row you learn to ignore. Their
  // invoices are untouched and stay in History (which builds its own filter
  // list from the invoice rows, so it keeps every former client it ever billed).
  // A retired client that is somehow still selected stays listed rather than
  // vanishing mid-look.
  const billableClients = useMemo(
    () => selectableClients(data.clients, [selectedClientId]),
    [data.clients, selectedClientId],
  )
  const selectedClient =
    data.clients.find((client) => client.id === selectedClientId) ?? billableClients[0]
  const baseInvoice = useMemo(
    () =>
      selectedClient
        ? getInvoice(
            selectedClient,
            data.timeEntries,
            data.plans,
            billingPeriod,
            data.reimbursements ?? [],
            data.recurringReimbursements ?? [],
            data.employees,
            firmSettings.clientDefaults?.hourlyRate ?? 0,
            billRateVersions,
          )
        : null,
    [
      selectedClient,
      data.timeEntries,
      data.plans,
      billingPeriod,
      data.reimbursements,
      data.recurringReimbursements,
      data.employees,
      firmSettings.clientDefaults?.hourlyRate,
      billRateVersions,
    ],
  )
  const display = useMemo(
    () =>
      baseInvoice ? buildDisplayInvoice(baseInvoice, data.timeEntries, billingPeriod) : null,
    [baseInvoice, data.timeEntries, billingPeriod],
  )
  const billingPeriodLabel = getBillingPeriodLabel(billingPeriod)

  const [customizing, setCustomizing] = useState(false)
  const [draft, setDraft] = useState<InvoiceDraft | null>(null)
  const hasFirmLogo = hasText(firmSettings?.logoUrl)
  const seedKey = `${selectedClient?.id ?? ''}::${billingPeriod}`
  const seededKeyRef = useRef<string | null>(null)

  // Re-seed the draft only when the client or billing period changes (not on
  // every keystroke or time-entry update), so her edits aren't clobbered while
  // she's building the same invoice.
  useEffect(() => {
    if (!display || !selectedClient) return
    if (seededKeyRef.current === seedKey) return
    seededKeyRef.current = seedKey
    setDraft(seedDraft(display, selectedClient, hasFirmLogo))
  }, [seedKey, display, selectedClient, hasFirmLogo])

  const customDisplay = useMemo(
    () => (customizing && draft && baseInvoice ? draftToDisplay(draft, baseInvoice) : null),
    [customizing, draft, baseInvoice],
  )

  // When set, the print document renders this STORED invoice instead of the
  // live per-client calculation. Cleared by the live Print button so the two
  // cannot print each other's content.
  const [storedPrint, setStoredPrint] = useState<PersistedInvoice | null>(null)
  // "Print invoice" asks which month first. `printDialog` is that question while
  // it is open; `monthPrint` is the live calculation for a month OTHER than the
  // top-bar one, held just long enough for the sheet to commit and print.
  const [printDialog, setPrintDialog] = useState<{ period: string } | null>(null)
  const [monthPrint, setMonthPrint] = useState<DisplayInvoice | null>(null)

  // "Email invoice" really sends. Its outcome is reported here rather than in a
  // toast because it is the only evidence a client was just emailed.
  //
  // The result carries the client+month it belongs to, so switching either one
  // simply stops rendering it. Stamping beats clearing it from an effect: the
  // message can never briefly survive onto the next client's invoice.
  const [sendBusy, setSendBusy] = useState(false)
  const [sendResult, setSendResult] = useState<{
    key: string
    note?: string
    error?: string
    emailLog?: InvoiceEmailLogEntry[]
  } | null>(null)
  const [monthRunRefresh, setMonthRunRefresh] = useState(0)
  // The send waiting on her checkbox choices. Only ever set when the client has
  // more than one address on file — a single one goes straight out.
  const [pickingSend, setPickingSend] = useState<{
    invoiceId: string
    label: string
    details: InvoiceRecipientDetail[]
  } | null>(null)
  const shownSend = sendResult?.key === seedKey ? sendResult : null

  // Which half of the page is on screen. Deliberately NOT remembered across
  // visits: the month you are in the middle of billing is what this page is
  // for, and landing in the archive because you were last there in March is
  // the wrong place to start a month.
  const [view, setView] = useState<'month' | 'history'>('month')
  const monthRunRef = useRef<InvoiceMonthRunHandle>(null)
  // Why a click in History did nothing. See `openMonthRun`.
  const [historyNote, setHistoryNote] = useState<string | null>(null)

  // Land on the month a link asked for. The page is put on the month run, which
  // is where that month lives - adjusted while rendering (React's own pattern for
  // state that follows a prop) rather than in an effect...
  const [seenOpenPeriod, setSeenOpenPeriod] = useState<string | null>(null)
  if ((openPeriod ?? null) !== seenOpenPeriod) {
    setSeenOpenPeriod(openPeriod ?? null)
    if (openPeriod) setView('month')
  }
  // ...and the run is moved by the same guarded move the month picker makes (an
  // open editor with unsaved edits asks first). The page renders NOTHING until its
  // data (the selected client) has loaded, so on a cold load the run is not
  // mounted yet: the request is held until it is, and only cleared from the URL
  // after `showPeriod` has actually run.
  const runIsMounted = Boolean(ownerMode && selectedClient && baseInvoice && display)
  useEffect(() => {
    if (!openPeriod || !runIsMounted) return
    const run = monthRunRef.current
    if (!run) return
    if (/^\d{4}-(0[1-9]|1[0-2])$/.test(openPeriod)) run.showPeriod(openPeriod)
    onOpenPeriodHandled?.()
    // Keyed on the requested month and the run's mount only: the callback is a
    // fresh function every render of the router and must not re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPeriod, runIsMounted])

  const showView = (next: 'month' | 'history') => {
    setHistoryNote(null)
    setView(next)
  }

  // History's "Open in month run". The run keeps its own month — this only
  // asks it to move, then brings it back on screen. It is still mounted behind
  // History, so the handle is always there; the null check is belt and braces
  // rather than a real case.
  //
  // It can refuse: an open editor with unsaved edits asks before they are
  // thrown away, and "keep them" has to mean the view stays put too — putting
  // her on a month run sitting on a different month from the row she clicked
  // would be the worst of both answers. A refusal must not be a silent no-op
  // either, so it says which month is holding the edits; the run is off screen
  // and she may not remember leaving an invoice open in it.
  const openMonthRun = (period: string) => {
    const run = monthRunRef.current
    if (run && !run.showPeriod(period)) {
      setHistoryNote(
        `Kept your unsaved edits — finish or discard them in the ${getBillingPeriodLabel(
          run.showingPeriod(),
        )} month run first.`,
      )
      return
    }
    setHistoryNote(null)
    setView('month')
  }

  const printStored = (stored: PersistedInvoice) => {
    setMonthPrint(null)
    setStoredPrint(stored)
  }

  // Print AFTER the sheet holding this invoice has actually been committed —
  // an effect, not a timeout racing the render. A 60ms guess is the difference
  // between printing the invoice she clicked and printing the previous one.
  //
  // Then clear it, so the sheet falls back to the live per-client calculation:
  // a plain Ctrl+P on this page later has to print what the page is showing,
  // not whichever archived row she last hit Print on.
  useEffect(() => {
    if (!storedPrint && !monthPrint) return
    printInvoice()
    const done = () => {
      setStoredPrint(null)
      setMonthPrint(null)
    }
    window.addEventListener('afterprint', done)
    // Not every browser fires afterprint, and cancelling the dialog may not
    // either — without this the page would stay stuck on the stored invoice.
    const fallback = window.setTimeout(done, 2000)
    return () => {
      window.removeEventListener('afterprint', done)
      window.clearTimeout(fallback)
    }
    // printInvoice is re-created every render; depending on it would re-fire
    // this effect — and re-open the print dialog — on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedPrint, monthPrint])

  const storedPrintDisplay = useMemo(() => {
    if (!storedPrint) return null
    const storedClient = data.clients.find((c) => c.id === storedPrint.clientId)
    if (!storedClient) return null
    return persistedToDisplay(storedPrint, storedClient, getBillingPeriodLabel(storedPrint.period))
  }, [storedPrint, data.clients])
  if (!ownerMode || !selectedClient || !baseInvoice || !display) {
    return null
  }


  const effectiveDisplay = customizing && customDisplay ? customDisplay : display
  const customMeta: CustomMeta | null =
    customizing && draft
      ? { include: draft.include, intro: draft.intro, footer: draft.footer }
      : null

  const resetDraft = () => setDraft(seedDraft(display, selectedClient, hasFirmLogo))
  const updateLine = (id: string, patch: Partial<DraftLine>) =>
    setDraft((prev) =>
      prev
        ? { ...prev, lines: prev.lines.map((line) => (line.id === id ? { ...line, ...patch } : line)) }
        : prev,
    )
  const addLine = () =>
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            // `kind: 'custom'` — what `sanitizeInvoiceLines` would coerce a
            // kind-less line to on save anyway. Without it here, this row has
            // no `kind` the section layer recognizes, so it vanishes from the
            // printed sheet while its amount still counts toward Total due: a
            // printed document whose rows do not add to its own total.
            lines: [
              ...prev.lines,
              { id: makeLineId(), kind: 'custom', label: '', detail: '', amount: 0 },
            ],
          }
        : prev,
    )
  const removeLine = (id: string) =>
    setDraft((prev) => (prev ? { ...prev, lines: prev.lines.filter((line) => line.id !== id) } : prev))
  const setInclude = (key: keyof IncludeFlags, value: boolean) =>
    setDraft((prev) => (prev ? { ...prev, include: { ...prev.include, [key]: value } } : prev))
  const setIntro = (intro: string) => setDraft((prev) => (prev ? { ...prev, intro } : prev))
  const setFooter = (footer: string) => setDraft((prev) => (prev ? { ...prev, footer } : prev))

  /**
   * Really send this client's invoice for the selected billing month, through
   * the same rail as the month run's Send button.
   *
   * The stored invoice is fetched at click time rather than cached here: the
   * month run keeps its own list on its own period, and a second copy on this
   * page would be one more thing that can quietly go stale between the two.
   *
   * A month that has not been built yet used to be a dead end here. It now
   * offers to build THIS client's invoice and nothing else — a whole month is
   * not what someone clicking "Email invoice" asked for, but one invoice for
   * the client already named on screen plainly is. It stops at the draft:
   * review comes before send, always, so she is pointed at the month run
   * rather than having an email leave on the back of one confirm.
   */
  const emailInvoice = async (chooseAddresses = false) => {
    // Stamped with the invoice on screen when the click happened.
    const fail = (message: string) => setSendResult({ key: seedKey, error: message })
    setSendResult(null)
    setSendBusy(true)
    try {
      const invoices = await listInvoicesRequest(billingPeriod)
      // Only a LIVE invoice can be sent. Rows that are all void count as no
      // invoice rather than as a refusal: "Void & regenerate" makes void-only a
      // routine state (voided, then skipped on the rebuild because there was
      // nothing left to bill), and dead-ending on it would be telling her the
      // one thing she cannot act on instead of offering the thing she can.
      // The MONTH's invoice, never a retainer by accident: the lower Print
      // picks by the same rule.
      const { saved: stored, retainerOnly } = monthInvoiceForClient(invoices, selectedClient.id)

      if (retainerOnly) {
        // A retainer is another document, sent from its own row. Nothing to
        // build and nothing to confirm, so nothing is offered or sent here.
        fail(
          `This month has only a retainer invoice for ${selectedClient.name}; no monthly invoice has been generated yet. Send the retainer invoice from its row in the list above.`,
        )
        return
      }
      if (!stored) {
        const buildIt = window.confirm(
          `${selectedClient.name} has no invoice for ${billingPeriodLabel} yet. Generate it now? (Just this client — nothing else is created.)`,
        )
        if (!buildIt) {
          // Declining is not an error — leave the old pointer as a quiet note.
          setSendResult({
            key: seedKey,
            note: 'Nothing sent. Build the month with Generate in the month run above, then send.',
          })
          return
        }

        const built = await generateInvoicesRequest(billingPeriod, selectedClient.id)
        // The month run keeps its own list; tell it to reload so the new draft
        // shows up there, which is where she has to go to review it.
        setMonthRunRefresh((token) => token + 1)
        const made = built.created[0] ?? null
        if (!made) {
          fail(
            generateSkipMessage(
              built.skipped[0],
              selectedClient.name,
              billingPeriodLabel,
              (id) => data.clients.find((entry) => entry.id === id)?.name ?? null,
            ),
          )
          return
        }
        setSendResult({
          key: seedKey,
          // The month is named because the month run keeps its OWN picker and
          // may well be sitting on a different one.
          note: `${made.number ? `Invoice ${made.number}` : 'The invoice'} created as a draft — mark it reviewed in the ${billingPeriodLabel} month run above, then send.`,
        })
        return
      }
      if (stored.status === 'draft') {
        // The same review-then-send rule the month run enforces.
        fail('Mark this invoice reviewed first, in the month run above.')
        return
      }

      // Who it would reach, worked out from the SAME resolver the endpoint
      // uses. Nobody on file stops here with the reason, rather than making her
      // sit through a confirm to be told no.
      const recipients = resolveInvoiceRecipients({
        // Whose addresses the send will use: a billing master's go to the company
        // it names, exactly as the server decides it.
        client: invoiceAddressee(selectedClient, data.clients),
        contacts: data.contacts,
      })
      // "Send to other addresses..." is the way to reach a client with no
      // address on file yet: she types the address for this one send.
      if (recipients.to.length === 0 && !chooseAddresses) {
        fail(recipients.reason ?? 'No email address on file for this client.')
        return
      }

      const label = stored.number ? `Invoice ${stored.number}` : 'This invoice'
      // One address goes straight out; two or more get the checkbox list, all
      // ticked, so she can leave one off. Same rule as the month run. The
      // "other addresses" link opens it regardless, to add one for this send.
      if (recipients.to.length > 1 || chooseAddresses) {
        setPickingSend({
          invoiceId: stored.id,
          label: `${label} for ${selectedClient.name}`,
          details: recipients.details,
        })
        return
      }

      await performSend(stored.id)
    } catch (err) {
      // The endpoint answers with sentences meant for a person — no recipients
      // on file, the provider refused — so show what it said.
      fail(err instanceof Error ? err.message : 'Could not send the invoice.')
    } finally {
      setSendBusy(false)
    }
  }

  /**
   * The send itself, once the recipients are settled. Split out so the direct
   * path and the picker's Send land on identical bookkeeping — the note she
   * reads afterwards names the addresses that actually went out, read back off
   * the server's email log rather than off what was asked for.
   */
  const performSend = async (invoiceId: string, to?: string[], extra?: string[]) => {
    setSendBusy(true)
    try {
      // `extra` is only passed when the picker added some for this one send.
      const { invoice: updated } = await (extra && extra.length > 0
        ? sendInvoiceRequest(invoiceId, to, extra)
        : sendInvoiceRequest(invoiceId, to))
      setPickingSend(null)
      const lastSent = latestInvoiceSend(updated.emailLog)
      setSendResult({
        key: seedKey,
        note: lastSent
          ? `Sent to ${recipientCountLabel(lastSent.to.length)} on ${formatSentOn(
              lastSent.at,
            )} — ${lastSent.to
              .map((email) => (lastSent.oneTime?.includes(email) ? `${email} (this send only)` : email))
              .join(', ')}`
          : 'Sent.',
        // Carried so the badge beside the note reads the same log the note
        // does. Delivery events arrive seconds to hours later, so this is
        // usually empty at this moment and the badge stays silent.
        emailLog: updated.emailLog,
      })
      // Tell the month run to reload so it does not still read "Reviewed". It
      // keeps its own month picker, so this only shows up there when it happens
      // to be on the same month as this page.
      setMonthRunRefresh((token) => token + 1)
    } catch (err) {
      // The invoice moved under the send (voided, or changed by another tab):
      // the month run's row is stale, so it reloads to show what it is now.
      if (err instanceof ApiError && (err.code === 'invoice_voided' || err.code === 'invoice_changed')) {
        setMonthRunRefresh((token) => token + 1)
      }
      setSendResult({
        key: seedKey,
        error: err instanceof Error ? err.message : 'Could not send the invoice.',
      })
    } finally {
      setSendBusy(false)
    }
  }

  /**
   * The Print button of the "which month?" dialog. The page's own month prints
   * exactly what is on screen, Customize edits included. Any other month prints
   * the live calculation for that month, built by the same two functions the
   * page itself uses, with no edits — Customize belongs to the month it was
   * opened on. That sheet is committed by the effect above before it prints.
   *
   * A month that already has a SAVED invoice prints that, through the same path
   * as the Print on its row in the month run: the dialog found it and hands it
   * here, unless Customize is open on the page's month (her one-off sheet).
   */
  const confirmPrint = (period: string, saved: PersistedInvoice | null) => {
    setPrintDialog(null)
    if (saved) {
      printStored(saved)
      return
    }
    setStoredPrint(null)
    if (period === billingPeriod) {
      setMonthPrint(null)
      printInvoice()
      return
    }
    const invoice = getInvoice(
      selectedClient,
      data.timeEntries,
      data.plans,
      period,
      data.reimbursements ?? [],
      data.recurringReimbursements ?? [],
      data.employees,
      firmSettings.clientDefaults?.hourlyRate ?? 0,
      billRateVersions,
    )
    setMonthPrint(buildDisplayInvoice(invoice, data.timeEntries, period))
  }

  return (
    <>
      {printDialog ? (
        <PrintInvoiceDialog
          clientId={selectedClient.id}
          clientName={selectedClient.name}
          billedOnName={
            data.clients.find((entry) => entry.id === selectedClient.billToClientId)?.name ?? null
          }
          initialPeriod={printDialog.period}
          pagePeriod={billingPeriod}
          customizeNote={customizing ? billingPeriodLabel : null}
          onPrint={confirmPrint}
          onCancel={() => setPrintDialog(null)}
        />
      ) : null}

      {/* The checkbox list for a client with more than one address on file.
          Rendered at the page root so it overlays whichever half is showing. */}
      {pickingSend ? (
        <InvoiceRecipientPicker
          invoiceLabel={pickingSend.label}
          details={pickingSend.details}
          busy={sendBusy}
          onSend={(to, extra) => void performSend(pickingSend.invoiceId, to, extra)}
          onCancel={() => setPickingSend(null)}
        />
      ) : null}

      {/* One page owns everything invoice: this month, and every month.
          Deliberately NOT a second `.task-area-tabs` bar — the month run has
          one of those a few pixels below for its status groups, and two
          identical underline bars stacked would read as one control split in
          half. A page-level switch is also a different kind of thing from a
          filter: it changes what the page IS, so it gets its own quiet
          treatment rather than borrowing the filtering one. */}
      <div className="invoice-view-switch" role="group" aria-label="Invoice view">
        <button
          type="button"
          className={view === 'month' ? 'invoice-view-choice is-active' : 'invoice-view-choice'}
          aria-pressed={view === 'month'}
          onClick={() => showView('month')}
        >
          This month
        </button>
        <span className="invoice-view-divider" aria-hidden="true" />
        <button
          type="button"
          className={view === 'history' ? 'invoice-view-choice is-active' : 'invoice-view-choice'}
          aria-pressed={view === 'history'}
          onClick={() => showView('history')}
        >
          History
        </button>
      </div>

      {/* HIDDEN rather than unmounted while History is up. The month run holds
          the picker position and, more to the point, an open editor that may
          have unsaved line edits in it — glancing at the archive must not throw
          those away. History is the other way round (mounted only while shown,
          so it re-reads the archive every time): it holds nothing but filter
          choices, and an archive that has gone stale behind a hidden div is
          worth less than one that is simply current. */}
      <div className="invoice-view" hidden={view !== 'month'}>
        {/* The month run (I1/I2): the STORED invoices for a period. The
            per-client section below is the older live-calculation view, kept
            for its preview and print until they are pointed at stored data. */}
        <InvoiceMonthRun
          clients={data.clients}
          contacts={data.contacts}
          // The hours behind each invoice, for the review panel beside it
          // (featreq-8cec48db). Handed down as props rather than read from the
          // context inside the run: that component has never touched the
          // context, and its tests mock only the API.
          timeEntries={data.timeEntries}
          employees={data.employees}
          // The same dated rates the preview above prices with, so a re-tag
          // that creates a line bills it at the client's pin.
          billRateVersions={billRateVersions}
          checklists={data.checklists}
          timesheetLocks={data.timesheetLocks}
          previewMode={previewMode}
          onEntriesTagged={applyScopeTagsLocally}
          // The note was already written by its own endpoint; this only keeps
          // the page's copy of the client current.
          onClientNoteKept={(clientId, note) => updateClient(clientId, { invoiceNote: note })}
          refreshToken={monthRunRefresh}
          ref={monthRunRef}
          onPrint={printStored}
        />
        <section className="content-grid invoice-layout" id="invoices">
          <div className="panel">
            <div className="section-heading">
              <div>
                <p className="section-kicker">Owner billing</p>
                <h2>Invoices</h2>
              </div>
              <div className="invoice-header-actions">
                <button
                  className="ghost-action"
                  onClick={() => setCustomizing((value) => !value)}
                  type="button"
                >
                  <Sliders size={16} />
                  {customizing ? 'Use generated' : 'Customize'}
                </button>
                {/* Email sends the STORED invoice, so it is held back while
                    Customize is open: what that panel changes reaches the printed
                    sheet only, and a button that silently ignored her edits would
                    be worse than one she has to close a panel to reach. */}
                <button
                  className="ghost-action"
                  disabled={sendBusy || customizing || selectedClient.invoiceNoEmail === true}
                  onClick={() => void emailInvoice()}
                  title={
                    selectedClient.invoiceNoEmail === true
                      ? 'This client’s invoices are delivered outside the app and never emailed'
                      : customizing
                        ? 'Email sends the stored invoice — close Customize first; edit lines in the month run'
                        : 'Email this invoice to the client'
                  }
                  type="button"
                >
                  <Mail size={16} />
                  {sendBusy ? 'Sending…' : 'Email invoice'}
                </button>
                {/* Beside the button, not instead of it: Email invoice is
                    unchanged. This opens the address picker even for a client
                    with one address (or none), to add one for this send only. */}
                <button
                  className="invoice-send-others"
                  disabled={sendBusy || customizing || selectedClient.invoiceNoEmail === true}
                  onClick={() => void emailInvoice(true)}
                  title={
                    selectedClient.invoiceNoEmail === true
                      ? 'This client’s invoices are delivered outside the app and never emailed'
                      : customizing
                        ? 'Email sends the stored invoice — close Customize first; edit lines in the month run'
                        : 'Email this invoice to an address that is not on file, just this once'
                  }
                  type="button"
                >
                  Send to other addresses...
                </button>
                <button
                  className="primary-action"
                  onClick={() =>
                    setPrintDialog({ period: monthRunRef.current?.showingPeriod() ?? billingPeriod })
                  }
                  type="button"
                >
                  <Printer size={16} />
                  Print invoice
                </button>
              </div>
            </div>
            <label className="field">
              <span>Client</span>
              {/* Frozen mid-send: the confirm names a client, and switching
                  underneath it would attribute the send to the wrong one. */}
              <select
                className="input"
                disabled={sendBusy}
                onChange={(event) => setSelectedClientId(event.target.value)}
                value={selectedClientId}
              >
                {billableClients.map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.name}
                  </option>
                ))}
              </select>
            </label>
            {shownSend?.error ? (
              <p className="invoice-run-error" role="alert">
                {shownSend.error}
              </p>
            ) : null}
            {shownSend?.note ? (
              <p className="invoice-run-sent">
                {shownSend.note} <InvoiceDeliveryBadge emailLog={shownSend.emailLog} />
              </p>
            ) : null}
            <div className="invoice-context">
              <span>{billingPeriodLabel}</span>
              <span>{baseInvoice.entryCount} billable entries</span>
              <span>{formatDecimalHours(baseInvoice.billableMinutes)} tracked</span>
              {/* Only for the clients who have it — the absence of this says
                  "bank transfer only", which is everyone else. */}
              {selectedClient.cardPaymentsEnabled ? <span>Card enabled</span> : null}
            </div>
            {customizing && draft ? (
              <InvoiceBuilder
                draft={draft}
                total={effectiveDisplay.invoice.total}
                onToggleInclude={setInclude}
                onUpdateLine={updateLine}
                onAddLine={addLine}
                onRemoveLine={removeLine}
                onIntro={setIntro}
                onFooter={setFooter}
                onReset={resetDraft}
              />
            ) : null}
            <InvoicePreview display={effectiveDisplay} custom={customMeta} />
            {ownerMode ? (
              <ReimbursementsCard
                clientId={selectedClient.id}
                periodFilter={billingPeriod}
                title="This invoice's reimbursements"
                subtitle={`Out-of-pocket expenses for ${selectedClient.name} that show up on the ${billingPeriodLabel} invoice. Each entry becomes a line above.`}
              />
            ) : null}
          </div>
          <BillingQueue
            selectedClientId={selectedClient?.id ?? null}
            onSelect={setSelectedClientId}
            billingPeriod={billingPeriod}
            clients={billableClients}
            entries={data.timeEntries}
            plans={data.plans}
            reimbursements={data.reimbursements ?? []}
            recurringReimbursements={data.recurringReimbursements ?? []}
            employees={data.employees}
            defaultHourlyRate={firmSettings.clientDefaults?.hourlyRate ?? 0}
            billRateVersions={billRateVersions}
          />
        </section>
      </div>

      {view === 'history' ? (
        <InvoiceHistory
          clients={data.clients}
          note={historyNote}
          onOpenMonth={openMonthRun}
          onPrint={printStored}
        />
      ) : null}

      {/* PORTALED TO <body> ON PURPOSE, and the print path breaks if it is not.
          The invoice print works by hiding everything and showing only this
          sheet (`body.printing-invoice #root { display: none }` plus
          `… .invoice-print { display: block }`). A page renders inside #root
          via the router Outlet, so leaving this sheet in place makes it a
          DESCENDANT of the element being hidden — and no descendant rule can
          undo an ancestor's `display: none`. The printout comes out blank.

          It has to clear #root, not just `.app-shell`: #root carries
          `min-height: 100vh`, and in paged media `vh` is the PAGE box, so an
          emptied #root still prints as a full blank sheet ahead of the
          invoice. Being a sibling of #root is what makes hiding #root safe.

          `invoice-print` scopes it: the assistant's report modal renders a
          `.print-document` too, and this sheet is on the page whenever the
          Invoices page is. */}
      {createPortal(
        <div className="print-document invoice-print" aria-hidden="true">
          {storedPrintDisplay ? (
            <InvoiceDocument display={storedPrintDisplay} custom={null} />
          ) : monthPrint ? (
            <InvoiceDocument display={monthPrint} custom={null} />
          ) : (
            <InvoiceDocument display={effectiveDisplay} custom={customMeta} />
          )}
        </div>,
        document.body,
      )}
    </>
  )
}

/**
 * The client's invoice for the month, picked out of that month's rows: a LIVE
 * row only (void rows count as none), and the MONTHLY one when the client also
 * has a retainer invoice issued that month. The lower Print and the lower Email
 * invoice both mean the month's invoice, and a retainer is another document, so
 * both choose through here. `retainerOnly` says the only live row is a retainer.
 */
function monthInvoiceForClient(invoices: PersistedInvoice[], clientId: string) {
  const live = invoices.filter((entry) => entry.clientId === clientId && entry.status !== 'void')
  const saved = live.find((entry) => entry.kind !== 'retainer') ?? null
  return { saved, retainerOnly: !saved && live.length > 0 }
}

/**
 * "Which month is this invoice for?" — asked before the live invoice prints, so
 * the sheet cannot quietly be the top-bar month (the current one) while she is
 * invoicing the month before. Nothing prints until Print; Escape and Cancel
 * print nothing.
 *
 * It also looks for the client's SAVED invoice for the month chosen and says
 * which sheet Print will give: the saved invoice (what the month run's own
 * Print gives) or a fresh preview. The answer is kept with the client and month
 * it was asked for, so a slow answer for a month she has since left is never
 * read as the answer for the month now showing.
 */
function PrintInvoiceDialog({
  clientId,
  clientName,
  billedOnName,
  initialPeriod,
  pagePeriod,
  customizeNote,
  onPrint,
  onCancel,
}: {
  clientId: string
  clientName: string
  /** The billing master this client is billed on (`billToClientId`), if any. */
  billedOnName: string | null
  initialPeriod: string
  /** The month the page itself is on, the one Customize edits belong to. */
  pagePeriod: string
  /** The month Customize edits belong to, while Customize is open. */
  customizeNote: string | null
  onPrint: (period: string, saved: PersistedInvoice | null) => void
  onCancel: () => void
}) {
  const [period, setPeriod] = useState(initialPeriod)
  const monthInputRef = useRef<HTMLInputElement>(null)
  const valid = /^\d{4}-(0[1-9]|1[0-2])$/.test(period)
  const lookupKey = `${clientId}::${period}`
  const [lookup, setLookup] = useState<{
    key: string
    saved: PersistedInvoice | null
    /** The client's only live row that month is a retainer invoice. */
    retainerOnly: boolean
    failed: boolean
  } | null>(null)
  useEffect(() => {
    if (!valid) return
    let stale = false
    void (async () => {
      try {
        const invoices = await listInvoicesRequest(period)
        const { saved, retainerOnly } = monthInvoiceForClient(invoices, clientId)
        if (!stale) setLookup({ key: lookupKey, saved, retainerOnly, failed: false })
      } catch {
        if (!stale) setLookup({ key: lookupKey, saved: null, retainerOnly: false, failed: true })
      }
    })()
    return () => {
      stale = true
    }
  }, [valid, period, clientId, lookupKey])
  const answer = valid && lookup?.key === lookupKey ? lookup : null
  const checking = valid && !answer
  const saved = answer?.saved ?? null
  // Customize is her deliberate one-off sheet for the page's own month.
  const customizedHere = Boolean(customizeNote) && period === pagePeriod
  const savedLabel = saved ? `saved invoice${saved.number ? ` ${saved.number}` : ''}` : ''
  const printable = valid && (customizedHere || Boolean(answer && !answer.failed))
  // The month is the one thing this dialog asks, so the cursor starts there.
  useEffect(() => {
    monthInputRef.current?.focus()
  }, [])
  return (
    <AddModal title="Print invoice" onClose={onCancel}>
      {/* A form so Enter prints, with Print as its submit button. A disabled
          submit blocks the browser's implicit submission, and the guard below
          keeps an unanswered, failed or invalid lookup from printing either way. */}
      <form
        // The modal body spaces its children with a grid gap; the form is now
        // its only child, so it carries the same spacing for its own.
        style={{ display: 'grid', gap: 14 }}
        onSubmit={(event) => {
          event.preventDefault()
          if (printable) onPrint(period, customizedHere ? null : saved)
        }}
      >
        <p className="modal-intro">Which month is this invoice for?</p>
        <label className="field">
          <span>Billing month</span>
          <input
            ref={monthInputRef}
            className="input"
            type="month"
            value={period}
            onChange={(event) => setPeriod(event.target.value)}
          />
        </label>
        {valid ? (
          <p className="modal-intro">
            {clientName} · {getBillingPeriodLabel(period)}
          </p>
        ) : null}
        {customizeNote ? (
          <p className="modal-intro">Customize edits apply to {customizeNote} only.</p>
        ) : null}
        {customizedHere ? (
          // Her Customize sheet prints whatever the lookup says, so the lookup
          // neither holds Print nor shows its own progress or failure here.
          <p className="modal-intro">
            {saved
              ? `Prints this page with your Customize edits, not the ${savedLabel}.`
              : 'Prints this page with your Customize edits.'}
          </p>
        ) : checking ? (
          <p className="modal-intro">Checking for a saved invoice...</p>
        ) : answer?.failed ? (
          <p className="modal-intro" role="alert">
            Could not check for a saved invoice. Try again.
          </p>
        ) : saved ? (
          <p className="modal-intro">
            Prints the {savedLabel} ({INVOICE_STATUS_LABELS[saved.status] ?? saved.status}).
          </p>
        ) : answer && billedOnName ? (
          <p className="modal-intro">
            {clientName} is billed on {billedOnName}'s invoice. Print that invoice from the list above.
            This prints a preview of {clientName}'s own lines.
          </p>
        ) : answer ? (
          <p className="modal-intro">
            No {answer.retainerOnly ? 'monthly ' : ''}invoice has been generated for{' '}
            {getBillingPeriodLabel(period)} yet. Prints a preview from current time and rates.
          </p>
        ) : null}
        <div className="button-row">
          <button type="button" className="secondary-action" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary-action" disabled={!printable}>
            Print
          </button>
        </div>
      </form>
    </AddModal>
  )
}

// Uncontrolled on purpose: a controlled number input coerces "12." to 12 on
// each keystroke, making decimals impossible to type. The parent row is keyed
// by the draft line id, so "Reset to generated" (which mints new ids) remounts
// this and re-reads `initial`; during editing the input keeps its own buffer.
function AmountInput({
  initial,
  onChange,
}: {
  initial: number
  onChange: (amount: number) => void
}) {
  return (
    <input
      className="input invoice-edit-amount"
      defaultValue={Number.isFinite(initial) ? String(initial) : ''}
      inputMode="decimal"
      onChange={(event) => {
        const raw = event.target.value.trim()
        const next = raw === '' ? 0 : Number(raw)
        if (Number.isFinite(next)) {
          onChange(next)
        }
      }}
      placeholder="0.00"
      type="text"
    />
  )
}

function InvoiceBuilder({
  draft,
  total,
  onToggleInclude,
  onUpdateLine,
  onAddLine,
  onRemoveLine,
  onIntro,
  onFooter,
  onReset,
}: {
  draft: InvoiceDraft
  total: number
  onToggleInclude: (key: keyof IncludeFlags, value: boolean) => void
  onUpdateLine: (id: string, patch: Partial<DraftLine>) => void
  onAddLine: () => void
  onRemoveLine: (id: string) => void
  onIntro: (value: string) => void
  onFooter: (value: string) => void
  onReset: () => void
}) {
  return (
    <div className="invoice-builder">
      <div className="invoice-builder-block">
        <div className="invoice-builder-head">
          <strong>Pull in client info</strong>
          <button className="ghost-action" onClick={onReset} type="button">
            <RotateCcw size={14} />
            Reset to generated
          </button>
        </div>
        <div className="invoice-include-grid">
          {INCLUDE_FIELDS.map((field) => (
            <label className="invoice-include-option" key={field.key}>
              <input
                checked={draft.include[field.key]}
                onChange={(event) => onToggleInclude(field.key, event.target.checked)}
                type="checkbox"
              />
              <span>{field.label}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="invoice-builder-block">
        <strong>Intro note</strong>
        <textarea
          className="input"
          onChange={(event) => onIntro(event.target.value)}
          placeholder="Optional note shown above the line items"
          rows={2}
          value={draft.intro}
        />
      </div>

      <div className="invoice-builder-block">
        <div className="invoice-builder-head">
          <strong>Line items</strong>
          <button className="ghost-action" onClick={onAddLine} type="button">
            <Plus size={14} />
            Add line
          </button>
        </div>
        <div className="invoice-edit-lines">
          {draft.lines.map((line) => (
            <div className="invoice-edit-line" key={line.id}>
              <input
                className="input"
                onChange={(event) => onUpdateLine(line.id, { label: event.target.value })}
                placeholder="Description"
                value={line.label}
              />
              <input
                className="input"
                onChange={(event) => onUpdateLine(line.id, { detail: event.target.value })}
                placeholder="Detail"
                value={line.detail}
              />
              <AmountInput
                initial={line.amount}
                onChange={(amount) => onUpdateLine(line.id, { amount })}
              />
              <button
                aria-label="Remove line"
                className="icon-button"
                onClick={() => onRemoveLine(line.id)}
                type="button"
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
          {draft.lines.length === 0 ? (
            <p className="invoice-edit-empty">No line items yet — add one above.</p>
          ) : null}
        </div>
        <div className="invoice-edit-total">
          <span>Total</span>
          <strong>{currency.format(total)}</strong>
        </div>
      </div>

      <div className="invoice-builder-block">
        <strong>Footer note</strong>
        <textarea
          className="input"
          onChange={(event) => onFooter(event.target.value)}
          placeholder="Shown at the bottom of the invoice"
          rows={2}
          value={draft.footer}
        />
      </div>
    </div>
  )
}

function PayButton({ client, variant }: { client: Client; variant: 'screen' | 'print' }) {
  if (!client.quickbooksPayUrl) {
    return null
  }

  // Print variant — and the screen variant when the stored URL isn't a safe
  // http(s) link — render the URL as plain text so a `javascript:` URL can
  // never execute as a live link in the viewer's session.
  if (variant === 'print' || !isSafeHttpUrl(client.quickbooksPayUrl)) {
    return (
      <div className="invoice-pay-print">
        <strong>Pay via QuickBooks</strong>
        <span>{client.quickbooksPayUrl}</span>
      </div>
    )
  }

  return (
    <a
      className="primary-action invoice-pay-button"
      href={client.quickbooksPayUrl}
      rel="noopener noreferrer"
      target="_blank"
    >
      <ExternalLink size={16} />
      Pay via QuickBooks
    </a>
  )
}

// Intentionally flat: this is the OWNER's on-screen review copy, not the
// client-facing document. `InvoiceDocument` below is what the redesign (§1b)
// sectioned into Subscription Plan / Ad-Hoc / Reimbursed Expenses with role
// sub-headings — that is the client's view. Leave this one flat unless a
// deliberate decision says the owner's review should be sectioned too; do not
// "fix" it to match the print sheet without making that call on purpose.
function InvoicePreview({ display, custom }: { display: DisplayInvoice; custom?: CustomMeta | null }) {
  const { invoice } = display
  const showTerms = custom ? custom.include.paymentTerms : true
  const showPay = custom ? custom.include.payLink : true
  const footerText = custom
    ? custom.include.footerNote
      ? custom.footer
      : ''
    : invoice.client.footerNote ?? ''
  return (
    <div className="invoice-preview">
      <div className="invoice-preview-header">
        <div>
          <span>Invoice draft</span>
          <strong>{invoice.client.name}</strong>
          <span>{invoice.periodLabel}</span>
        </div>
        <strong>{currency.format(invoice.total)}</strong>
      </div>
      {custom && custom.intro.trim() ? (
        <p className="invoice-intro-note">{custom.intro}</p>
      ) : null}
      <div className="invoice-lines">
        {display.lines.map((line, index) => (
          <div className="invoice-line" key={`${line.label}-${line.detail}-${index}`}>
            <div>
              <strong>{line.label}</strong>
              <span>{line.detail}</span>
            </div>
            <span>{currency.format(line.amount)}</span>
          </div>
        ))}
      </div>
      {display.groupSubtotals.length > 0 ? (
        <div className="invoice-subtotals">
          {display.groupSubtotals.map((subtotal) => (
            <div className="invoice-subtotal-row" key={subtotal.label}>
              <span>{subtotal.label} subtotal</span>
              <strong>{currency.format(subtotal.total)}</strong>
            </div>
          ))}
        </div>
      ) : null}
      {showTerms ? (
        <div className="invoice-payment-terms">
          <span>Payment terms</span>
          <strong>{paymentTermsLabel(invoice.client.paymentTerms)}</strong>
        </div>
      ) : null}
      <div className="invoice-total-row">
        <span>Total due</span>
        <strong>{currency.format(invoice.total)}</strong>
      </div>
      {showPay ? (
        <div className="invoice-pay-row">
          <PayButton client={invoice.client} variant="screen" />
        </div>
      ) : null}
      {footerText.trim() ? <p className="invoice-footer-note">{footerText}</p> : null}
    </div>
  )
}

function BillingQueue({
  selectedClientId,
  onSelect,
  billingPeriod,
  clients,
  entries,
  plans,
  reimbursements,
  recurringReimbursements,
  employees,
  defaultHourlyRate,
  billRateVersions,
}: {
  selectedClientId: string | null
  /** Picking a row drives the invoice shown above - the rows looked
   *  clickable but were inert <article> elements. */
  onSelect: (clientId: string) => void
  billingPeriod: string
  clients: Client[]
  entries: TimeEntry[]
  plans: SubscriptionPlan[]
  reimbursements: Reimbursement[]
  recurringReimbursements: RecurringReimbursement[]
  employees: Employee[]
  defaultHourlyRate: number
  billRateVersions: BillRateVersion[]
}) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Ready to review</p>
          <h2>Billing queue</h2>
        </div>
      </div>
      <div className="queue-list">
        {clients.map((client) => {
          const invoice = getInvoice(
            client,
            entries,
            plans,
            billingPeriod,
            reimbursements,
            recurringReimbursements,
            employees,
            defaultHourlyRate,
            billRateVersions,
          )
          return (
            <button
              type="button"
              className={
                client.id === selectedClientId ? 'queue-row is-selected' : 'queue-row'
              }
              key={client.id}
              aria-pressed={client.id === selectedClientId}
              onClick={() => onSelect(client.id)}
            >
              <div>
                <strong>{client.name}</strong>
                <span>
                  {client.billingMode === 'subscription'
                    ? 'Subscription plan'
                    : client.billingMode === 'annual'
                      ? 'Annual plan'
                      : 'Billable hours'}{' '}
                  · {formatDecimalHours(invoice.billableMinutes)}
                </span>
              </div>
              <strong>{currency.format(invoice.total)}</strong>
            </button>
          )
        })}
      </div>
    </section>
  )
}

function InvoiceDocument({ display, custom }: { display: DisplayInvoice; custom?: CustomMeta | null }) {
  const { invoice } = display
  const { firmSettings } = useAppContext()
  /*
   * THE INVOICE'S OWN DATE, not today's.
   *
   * This used to format `new Date()`, so an August invoice reprinted in October
   * was stamped October — the sheet contradicted the PDF the client already had.
   * Renaming the field to "Invoice Date" is what made that unignorable.
   *
   * Today is the right answer for exactly one caller: the live per-client
   * preview, which is a calculation and not yet an invoice, so it carries no
   * date of its own.
   */
  const invoiceDate = formatInvoiceDate(
    display.liveForPeriod !== undefined ? liveInvoiceDate(display.liveForPeriod) : display.invoiceDate,
  )

  const billingClient = invoice.client
  const showField = (key: keyof IncludeFlags) => (custom ? custom.include[key] : true)

  // The same rule the emailed PDF uses, so the two documents agree.
  const addressLines = showField('address') ? mailingAddressLines(billingClient) : []

  const firmName = firmSettings?.name || 'PB&J Strategic Accounting'
  // No tagline: she struck it off the letterhead on the marked-up sample. The
  // firm setting still exists and still prints elsewhere; this sheet just does
  // not use it.
  const firmAddressLines = mailingAddressLines(firmSettings)
  const headerLogoUrl = showField('logo')
    ? billingClient.logoUrl || firmSettings?.logoUrl || ''
    : ''
  const serviceLabel = custom
    ? showField('serviceLabel')
      ? getServiceLabel(billingClient)
      : ''
    : billingClient.billingMode === 'subscription'
      ? 'Subscription plan'
      : billingClient.billingMode === 'annual'
        ? 'Annual plan'
        : 'Billable hours'
  const footerText = custom
    ? custom.include.footerNote
      ? custom.footer
      : ''
    : billingClient.footerNote ?? ''

  /*
   * WHAT THE CLIENT ACTUALLY READS.
   *
   * A billing master's document shows ONE line — "Bookkeeping services —
   * {month}" carrying the invoice total — and no company names anywhere.
   * Brittany's answer to "does KLC see the other companies' names" was "2": the
   * per-company split lives app-side only (the month-run editor, the recaps,
   * history), never on the page the client is handed.
   *
   * The rule is NOT restated here. This is the same `clientFacingInvoiceLines`
   * the emailed body and the generated PDF ask, so the three documents cannot
   * drift apart — and a sent invoice's copy of record cannot end up showing
   * something the printed one did not. For every other client it returns the
   * stored lines unchanged, which is what this sheet has always printed.
   */
  // `invoiceDocumentRenderMode`, not `invoiceRenderMode`: the latter is the
  // CLIENT's setting, this is what THIS document does with it, and a retainer
  // is exempt — combined it would print "Bookkeeping services — {month}" over
  // money that is not a month's bookkeeping. Both this and the line call below
  // must be asked about the same document, or the subtotal rows and the lines
  // would answer to different rules.
  const printDocument = {
    kind: display.kind,
    period: invoice.period,
    total: invoice.total,
    lineItems: display.lines,
  }
  const combined = invoiceDocumentRenderMode(printDocument, billingClient) === 'combined'
  const printLines = clientFacingInvoiceLines(printDocument, billingClient)
  const planLines = display.lines.filter((line) => line.kind === 'plan')
  const onlyEmptyPlanLines = planLines.length > 0 && planLines.every(isEmptyPlanLine)
  /*
   * The three sections she asked for, and the detailed-hours appendix.
   *
   * Both are fed the RESOLVED client-facing lines, never `display.lines` — on a
   * billing master's invoice the company names live in the labels and the
   * coverage windows in the details, and combined mode exists to replace all of
   * that with one line. Grouping upstream of it would print the very breakdown
   * the client chose not to see.
   *
   * Titles, total labels and totals come off these objects. Nothing here words
   * a heading of its own: the sheet, the PDF and the email have to say the same
   * thing, and the only way to guarantee that is to have one source. A null
   * title or total means "print no heading / no total" — which is how a
   * master's sheet keeps its per-company split off the page.
   */
  const sections = invoiceSections(printLines as unknown as InvoiceLineOut[], { combined })
  const detailRows = invoiceDetailRows(printLines as unknown as InvoiceLineOut[])

  return (
    <>
    <section className="print-sheet">
      <header>
        <div>
          <strong>{firmName}</strong>
          {firmAddressLines.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </div>
        {isSafeImageSrc(headerLogoUrl) ? (
          <img alt={`${firmName} logo`} className="print-logo" src={headerLogoUrl} />
        ) : (
          <FileText size={34} />
        )}
      </header>
      <div className="print-meta">
        <div>
          <span>Bill to</span>
          <strong>{billingClient.name}</strong>
          {showField('contactName') && billingClient.contactName ? (
            <small>{billingClient.contactName}</small>
          ) : null}
          {showField('email') && billingClient.email ? <small>{billingClient.email}</small> : null}
          {showField('phone') && billingClient.phone ? <small>{billingClient.phone}</small> : null}
          {addressLines.map((line) => (
            <small key={line}>{line}</small>
          ))}
        </div>
        <div>
          {/* The number used to appear only inside the 20pt title. She wants it
              as a labeled field, beside the date the invoice actually carries. */}
          {display.number ? (
            <>
              <span>Invoice no.</span>
              <strong>{display.number}</strong>
            </>
          ) : null}
          <span>Invoice Date</span>
          <strong>{invoiceDate}</strong>
          {/* A client whose only plan line is $0 has no monthly service on this
              invoice (that line is left off their copy), so the sheet does not
              call it a subscription plan either. */}
          {serviceLabel && !onlyEmptyPlanLines ? <small>{serviceLabel}</small> : null}
          <small>Billing Period: {invoice.periodLabel}</small>
        </div>
      </div>
      {custom && custom.intro.trim() ? <p className="print-intro-note">{custom.intro}</p> : null}
      <table>
        <thead>
          <tr>
            <th>Description</th>
            <th>Detail</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          {sections.map((section) => (
            <Fragment key={section.key}>
              {section.title ? (
                <tr className="print-section-row">
                  <th colSpan={3} scope="colgroup">
                    {section.title}
                  </th>
                </tr>
              ) : null}
              {/* Only the hours section has role groups; every other section
                  renders its rows straight through as one untitled group. */}
              {(section.groups ?? [{ key: section.key, title: null, rows: section.rows }]).map(
                (group) => (
                  <Fragment key={group.key}>
                    {group.title ? (
                      <tr className="print-role-row">
                        <td colSpan={3}>{group.title}</td>
                      </tr>
                    ) : null}
                    {group.rows.map((line, index) => (
                      <tr key={`${group.key}-${line.label}-${line.detail}-${index}`}>
                        <td>{line.label}</td>
                        <td>{line.detail}</td>
                        <td>{currency.format(line.amount)}</td>
                      </tr>
                    ))}
                  </Fragment>
                ),
              )}
              {/* A null total label is not a missing one: the untitled charges
                  block has no total by design, and neither does a combined
                  document — a per-section total there would state the split the
                  client chose to hide. */}
              {section.totalLabel ? (
                <tr className="print-section-total-row">
                  <td colSpan={2}>{section.totalLabel}</td>
                  <td>{currency.format(section.total ?? 0)}</td>
                </tr>
              ) : null}
            </Fragment>
          ))}
          {/* Subtotals are per-CATEGORY groupings of the live preview's lines,
              which the combined document does not have — its one line already
              states the total, so a subtotal row could only repeat it or, once
              a prior-month adjustment is in play, contradict it in front of the
              client. The generated PDF suppresses the row for the same reason. */}
          {combined
            ? null
            : display.groupSubtotals.map((subtotal) => (
                <tr className="print-subtotal-row" key={`subtotal-${subtotal.label}`}>
                  <td colSpan={2}>{subtotal.label} subtotal</td>
                  <td>{currency.format(subtotal.total)}</td>
                </tr>
              ))}
        </tbody>
      </table>
      {/* What the client is asked for, by the same rule the emailed PDF prints:
          "Due on receipt" unless their record names a longer window of its own.
          The invoice's stored due date is the firm's internal past-due line and
          is deliberately not on the client's sheet. */}
      {showField('paymentTerms') ? (
        <div className="print-terms">
          <span>Payment terms:</span>
          <strong>{paymentTermsLabel(billingClient.paymentTerms)}</strong>
        </div>
      ) : null}
      <footer>
        <span>Total due</span>
        <strong>{currency.format(invoice.total)}</strong>
      </footer>
      {showField('payLink') ? <PayButton client={billingClient} variant="print" /> : null}
      {/* Her wording, verbatim, and NOT interpolated with the firm name — it is
          the firm's line, not a template. A per-client `footerNote` still wins. */}
      {footerText.trim() ? (
        <p className="print-footer-note">{footerText}</p>
      ) : (
        <p>{INVOICE_FOOTER_DEFAULT}</p>
      )}
    </section>
    {/*
      PAGE 2 — the detailed hours.
      Its own <section>, after the sheet's footer, with `break-before: page` in
      the print CSS. Safe to move because every `time_detail` row is $0.00 by
      invariant, so lifting the block out of the table cannot shift a total.
      Empty when the client's breakdown is off (the default for all 51 clients,
      so most invoices stay one page) and empty in combined mode, where
      `time_detail` is not among the kept kinds — a master's page 2 is therefore
      suppressed rather than printed blank.
    */}
    {detailRows.length > 0 ? (
      <section className="print-sheet print-detail-sheet">
        {/* The SAME constant the PDF and the email print over this block. It
            could not come off the section object — `time_detail` rows are
            excluded from `invoiceSections` by design — so it is shared as its
            own export rather than typed out three times. */}
        <h2>{DETAIL_SECTION_TITLE}</h2>
        <table>
          <thead>
            <tr>
              <th>Description</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {/* NO amount column, matching the PDF and the email: every
                `time_detail` row is $0.00 by invariant, and a column of zeroes
                under this heading reads as a bug rather than as information. */}
            {detailRows.map((line, index) => (
              <tr key={`detail-${line.label}-${line.detail}-${index}`}>
                <td>{line.label}</td>
                <td>{line.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    ) : null}
    </>
  )
}
