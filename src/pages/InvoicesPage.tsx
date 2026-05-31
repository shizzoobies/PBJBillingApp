import { ExternalLink, FileText, Mail, Plus, Printer, RotateCcw, Sliders, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppContext } from '../AppContext'
import { ReimbursementsCard } from '../components/ReimbursementsCard'
import type {
  Client,
  Invoice,
  InvoiceLine,
  RecurringReimbursement,
  Reimbursement,
  SubscriptionPlan,
  TimeEntry,
} from '../lib/types'
import {
  currency,
  formatHours,
  getBillingPeriodLabel,
  getInvoice,
  isInBillingPeriod,
  isSafeHttpUrl,
  isSafeImageSrc,
} from '../lib/utils'

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

// Build a clean plain-text invoice for the body of an email. Reflects the
// prepared/customized invoice (lines, total, intro/footer, included fields)
// so "Email invoice" matches what would print.
function buildEmailParts(
  display: DisplayInvoice,
  custom: CustomMeta | null,
  firmName: string,
): { to: string; subject: string; body: string } {
  const { invoice } = display
  const client = invoice.client
  const show = (key: keyof IncludeFlags) => (custom ? custom.include[key] : true)
  const greetingName =
    (show('contactName') && hasText(client.contactName) ? client.contactName!.trim() : '') ||
    client.name
  const footer = custom
    ? custom.include.footerNote
      ? custom.footer
      : ''
    : client.footerNote ?? ''

  const lines: string[] = [
    `Hi ${greetingName},`,
    '',
    `Please find your invoice for ${invoice.periodLabel} below.`,
  ]
  if (custom && custom.intro.trim()) {
    lines.push('', custom.intro.trim())
  }
  lines.push('', `${firmName}`, `Invoice — ${invoice.periodLabel}`, `Bill to: ${client.name}`, '', 'Line items:')
  for (const line of display.lines) {
    const detail = line.detail ? ` (${line.detail})` : ''
    lines.push(`  • ${line.label}${detail} — ${currency.format(line.amount)}`)
  }
  lines.push('', `Total due: ${currency.format(invoice.total)}`)
  if (show('paymentTerms') && hasText(client.paymentTerms)) {
    lines.push(`Payment terms: ${client.paymentTerms!.trim()}`)
  }
  if (show('payLink') && hasText(client.quickbooksPayUrl)) {
    lines.push(`Pay online: ${client.quickbooksPayUrl!.trim()}`)
  }
  if (footer.trim()) {
    lines.push('', footer.trim())
  }
  lines.push('', 'Thank you,', firmName)

  const to = show('email') && hasText(client.email) ? client.email!.trim() : ''
  const subject = `${firmName} invoice — ${invoice.periodLabel}`
  return { to, subject, body: lines.join('\n') }
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
          )
        : null,
    [
      selectedClient,
      data.timeEntries,
      data.plans,
      billingPeriod,
      data.reimbursements,
      data.recurringReimbursements,
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

  const firmName = firmSettings?.name || 'PB&J Strategic Accounting'
  const emailInvoice = () => {
    const { to, subject, body } = buildEmailParts(effectiveDisplay, customMeta, firmName)
    const href = `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
    window.location.href = href
  }

  return (
    <>
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
              <button className="ghost-action" onClick={emailInvoice} type="button">
                <Mail size={16} />
                Email invoice
              </button>
              <button className="primary-action" onClick={printInvoice} type="button">
                <Printer size={16} />
                Print invoice
              </button>
            </div>
          </div>
          <label className="field">
            <span>Client</span>
            <select
              className="input"
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
          billingPeriod={billingPeriod}
          clients={data.clients}
          entries={data.timeEntries}
          plans={data.plans}
          reimbursements={data.reimbursements ?? []}
          recurringReimbursements={data.recurringReimbursements ?? []}
        />
      </section>

      <div className="print-document" aria-hidden="true">
        <InvoiceDocument display={effectiveDisplay} custom={customMeta} />
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
  billingPeriod,
  clients,
  entries,
  plans,
  reimbursements,
  recurringReimbursements,
}: {
  billingPeriod: string
  clients: Client[]
  entries: TimeEntry[]
  plans: SubscriptionPlan[]
  reimbursements: Reimbursement[]
  recurringReimbursements: RecurringReimbursement[]
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
          )
          return (
            <article className="queue-row" key={client.id}>
              <div>
                <strong>{client.name}</strong>
                <span>
                  {client.billingMode === 'subscription' ? 'Subscription plan' : 'Billable hours'} ·{' '}
                  {formatHours(invoice.billableMinutes)}
                </span>
              </div>
              <strong>{currency.format(invoice.total)}</strong>
            </article>
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
