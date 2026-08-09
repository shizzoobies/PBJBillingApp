import { ExternalLink, FileText, Mail, Plus, Printer, RotateCcw, Sliders, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppContext } from '../AppContext'
import { InvoiceMonthRun } from '../components/InvoiceMonthRun'
import { ReimbursementsCard } from '../components/ReimbursementsCard'
import type {
  Client,
  Employee,
  Invoice,
  PersistedInvoice,
  InvoiceLine,
  RecurringReimbursement,
  Reimbursement,
  SubscriptionPlan,
  TimeEntry,
} from '../lib/types'
import {
  currency,
  formatHours,
  formatSentOn,
  getBillingPeriodLabel,
  getInvoice,
  isInBillingPeriod,
  isSafeHttpUrl,
  isSafeImageSrc,
} from '../lib/utils'
import { generateInvoicesRequest, listInvoicesRequest, sendInvoiceRequest } from '../lib/api'

type DisplayLine = InvoiceLine & { groupKey?: string }

type DisplayInvoice = {
  invoice: Invoice
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

type DraftLine = InvoiceLine & { id: string }

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

/**
 * Why a single-client generate produced nothing. A month-wide run can pass
 * these over in silence — one prospect among forty clients is not news — but
 * someone who just asked for ONE invoice and got none is owed the reason.
 */
function generateSkipMessage(
  reason: string | undefined,
  clientName: string,
  periodLabel: string,
) {
  switch (reason) {
    case 'nothing-to-bill':
      return `${clientName} has nothing to bill for ${periodLabel} — no hours, plan, or reimbursements — so no invoice was created.`
    case 'already-generated':
      return `${clientName} already has an invoice for ${periodLabel}. Reload the page and try again.`
    case 'not-billable-yet':
      return `${clientName} is not an active client yet, so there is nothing to bill.`
    case 'no-such-client':
      return `${clientName} is no longer on file.`
    default:
      return `No invoice was created for ${clientName} for ${periodLabel}.`
  }
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
      paymentTerms: hasText(client.paymentTerms),
      footerNote: hasText(client.footerNote),
      payLink: hasText(client.quickbooksPayUrl),
    },
    lines: display.lines.map((line) => ({
      id: makeLineId(),
      label: line.label,
      detail: line.detail,
      amount: line.amount,
    })),
    intro: '',
    footer: client.footerNote ?? '',
  }
}

function draftToDisplay(draft: InvoiceDraft, baseInvoice: Invoice): DisplayInvoice {
  const lines: InvoiceLine[] = draft.lines.map((line) => ({
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
    lines,
    groupSubtotals: [],
    hideTimeBreakdown: false,
    hideInternal: true,
    groupByCategory: false,
  }
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
  const showBreakdown = client.invoiceShowTimeBreakdown ?? true
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
          label: `Bookkeeping services - ${invoice.periodLabel}`,
          detail: `${formatHours(invoice.billableMinutes)} this period`,
          amount: invoice.total,
        },
      ],
      groupSubtotals: [],
      hideTimeBreakdown: true,
      hideInternal,
      groupByCategory: false,
    }
  }

  // Build per-entry rate-based lines, then merge with subscription/plan lines
  // from the base invoice so subscription clients still see their plan fee.
  const subscriptionLines = invoice.lines.filter(
    (line) => line.label !== 'Billable hours' && line.label !== 'Hourly overage',
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
        ? `${formatHours(entry.minutes)} at ${currency.format(client.hourlyRate)}/hr · ${formatEntryDate(entry.date)}`
        : `${formatHours(entry.minutes)} · ${formatEntryDate(entry.date)} · internal`
      return {
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
 */
function persistedToDisplay(
  stored: PersistedInvoice,
  client: Client,
  periodLabel: string,
): DisplayInvoice {
  const lines: DisplayLine[] = stored.lineItems.map((line) => ({
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
    lines,
    groupSubtotals: [],
    hideTimeBreakdown: true,
    hideInternal: true,
    groupByCategory: false,
  }
}

export function InvoicesPage() {
  const {
    data,
    selectedClientId,
    setSelectedClientId,
    billingPeriod,
    printInvoice,
    ownerMode,
    firmSettings,
  } = useAppContext()

  const selectedClient =
    data.clients.find((client) => client.id === selectedClientId) ?? data.clients[0]
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
  } | null>(null)
  const [monthRunRefresh, setMonthRunRefresh] = useState(0)
  const shownSend = sendResult?.key === seedKey ? sendResult : null

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
        ? { ...prev, lines: [...prev.lines, { id: makeLineId(), label: '', detail: '', amount: 0 }] }
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
  const emailInvoice = async () => {
    // Stamped with the invoice on screen when the click happened.
    const fail = (message: string) => setSendResult({ key: seedKey, error: message })
    setSendResult(null)
    setSendBusy(true)
    try {
      const invoices = await listInvoicesRequest(billingPeriod)
      const forClient = invoices.filter((entry) => entry.clientId === selectedClient.id)
      // Only a LIVE invoice can be sent. Rows that are all void count as no
      // invoice rather than as a refusal: "Void & regenerate" makes void-only a
      // routine state (voided, then skipped on the rebuild because there was
      // nothing left to bill), and dead-ending on it would be telling her the
      // one thing she cannot act on instead of offering the thing she can.
      const stored = forClient.find((entry) => entry.status !== 'void') ?? null

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
              built.skipped[0]?.reason,
              selectedClient.name,
              billingPeriodLabel,
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

      const label = stored.number ? `invoice ${stored.number}` : 'this invoice'
      const confirmed = window.confirm(
        `Email ${label} for ${selectedClient.name} to the client's contacts on file?`,
      )
      if (!confirmed) return

      const { invoice: updated } = await sendInvoiceRequest(stored.id)
      const lastSent = [...(updated.emailLog ?? [])].reverse().find((entry) => entry.ok) ?? null
      setSendResult({
        key: seedKey,
        note: lastSent
          ? `Sent to ${lastSent.to.join(', ')} on ${formatSentOn(lastSent.at)}`
          : 'Sent.',
      })
      // Tell the month run to reload so it does not still read "Reviewed". It
      // keeps its own month picker, so this only shows up there when it happens
      // to be on the same month as this page.
      setMonthRunRefresh((token) => token + 1)
    } catch (err) {
      // The endpoint answers with sentences meant for a person — no recipients
      // on file, the provider refused — so show what it said.
      fail(err instanceof Error ? err.message : 'Could not send the invoice.')
    } finally {
      setSendBusy(false)
    }
  }

  return (
    <>
      {/* The month run (I1/I2): the STORED invoices for a period. The
          per-client section below is the older live-calculation view, kept
          for its preview and print until they are pointed at stored data. */}
      <InvoiceMonthRun
        clients={data.clients}
        refreshToken={monthRunRefresh}
        onPrint={(stored) => {
          setStoredPrint(stored)
          // One tick so the document renders before the print dialog opens.
          window.setTimeout(printInvoice, 60)
        }}
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
                disabled={sendBusy || customizing}
                onClick={() => void emailInvoice()}
                title={
                  customizing
                    ? 'Email sends the stored invoice — close Customize first; edit lines in the month run'
                    : 'Email this invoice to the client'
                }
                type="button"
              >
                <Mail size={16} />
                {sendBusy ? 'Sending…' : 'Email invoice'}
              </button>
              <button
                className="primary-action"
                onClick={() => {
                  setStoredPrint(null)
                  printInvoice()
                }}
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
              {data.clients.map((client) => (
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
          {shownSend?.note ? <p className="invoice-run-sent">{shownSend.note}</p> : null}
          <div className="invoice-context">
            <span>{billingPeriodLabel}</span>
            <span>{baseInvoice.entryCount} billable entries</span>
            <span>{formatHours(baseInvoice.billableMinutes)} tracked</span>
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
          clients={data.clients}
          entries={data.timeEntries}
          plans={data.plans}
          reimbursements={data.reimbursements ?? []}
          recurringReimbursements={data.recurringReimbursements ?? []}
          employees={data.employees}
          defaultHourlyRate={firmSettings.clientDefaults?.hourlyRate ?? 0}
        />
      </section>

      <div className="print-document" aria-hidden="true">
        {storedPrintDisplay ? (
          <InvoiceDocument display={storedPrintDisplay} custom={null} />
        ) : (
          <InvoiceDocument display={effectiveDisplay} custom={customMeta} />
        )}
      </div>
    </>
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
      {showTerms && invoice.client.paymentTerms ? (
        <div className="invoice-payment-terms">
          <span>Payment terms</span>
          <strong>{invoice.client.paymentTerms}</strong>
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
                  · {formatHours(invoice.billableMinutes)}
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
  const issuedDate = new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date())

  const billingClient = invoice.client
  const showField = (key: keyof IncludeFlags) => (custom ? custom.include[key] : true)

  const addressLines = showField('address')
    ? [
        billingClient.addressLine1,
        billingClient.addressLine2,
        [billingClient.city, billingClient.state, billingClient.postalCode]
          .filter((part) => part && part.trim())
          .join(', '),
      ].filter((line) => line && line.trim().length > 0)
    : []

  const firmName = firmSettings?.name || 'PB&J Strategic Accounting'
  const firmTagline = firmSettings?.tagline || 'Strategic bookkeeping, payroll, and advisory support'
  const firmAddressLines = [
    firmSettings?.addressLine1,
    firmSettings?.addressLine2,
    [firmSettings?.city, firmSettings?.state, firmSettings?.postalCode]
      .filter((part) => part && part.trim())
      .join(', '),
  ].filter((line) => line && line.trim().length > 0) as string[]
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

  return (
    <section className="print-sheet">
      <header>
        <div>
          <strong>{firmName}</strong>
          {firmTagline ? <span>{firmTagline}</span> : null}
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
          <span>Issued</span>
          <strong>{issuedDate}</strong>
          {serviceLabel ? <small>{serviceLabel}</small> : null}
          <small>{invoice.periodLabel}</small>
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
          {display.lines.map((line, index) => (
            <tr key={`${line.label}-${line.detail}-${index}`}>
              <td>{line.label}</td>
              <td>{line.detail}</td>
              <td>{currency.format(line.amount)}</td>
            </tr>
          ))}
          {display.groupSubtotals.map((subtotal) => (
            <tr className="print-subtotal-row" key={`subtotal-${subtotal.label}`}>
              <td colSpan={2}>{subtotal.label} subtotal</td>
              <td>{currency.format(subtotal.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {showField('paymentTerms') && billingClient.paymentTerms ? (
        <div className="print-terms">
          <span>Payment terms:</span>
          <strong>{billingClient.paymentTerms}</strong>
        </div>
      ) : null}
      <footer>
        <span>Total due</span>
        <strong>{currency.format(invoice.total)}</strong>
      </footer>
      {showField('payLink') ? <PayButton client={billingClient} variant="print" /> : null}
      {footerText.trim() ? (
        <p className="print-footer-note">{footerText}</p>
      ) : (
        <p>Thank you for trusting {firmName}.</p>
      )}
    </section>
  )
}
