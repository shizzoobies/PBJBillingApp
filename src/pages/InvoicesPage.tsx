import { ExternalLink, FileText, Printer } from 'lucide-react'
import { useMemo } from 'react'
import { useAppContext } from '../AppContext'
import type {
  Client,
  Invoice,
  InvoiceLine,
  SubscriptionPlan,
  TimeEntry,
} from '../lib/types'
import {
  currency,
  formatHours,
  getBillingPeriodLabel,
  getInvoice,
  isInBillingPeriod,
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

  const entryLines: DisplayLine[] = clientEntries
    .slice()
    .sort((a, b) => (a.date === b.date ? a.category.localeCompare(b.category) : a.date.localeCompare(b.date)))
    .map((entry) => {
      const amount = entry.billable ? (entry.minutes / 60) * client.hourlyRate : 0
      const detail = entry.billable
        ? `${formatHours(entry.minutes)} at ${currency.format(client.hourlyRate)}/hr · ${formatEntryDate(entry.date)}`
        : `${formatHours(entry.minutes)} · ${formatEntryDate(entry.date)} · internal`
      return {
        label: entry.category,
        detail: entry.description ? `${detail} · ${entry.description}` : detail,
        amount,
        groupKey: entry.category,
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
  } = useAppContext()

  const selectedClient =
    data.clients.find((client) => client.id === selectedClientId) ?? data.clients[0]
  const baseInvoice = useMemo(
    () =>
      selectedClient
        ? getInvoice(selectedClient, data.timeEntries, data.plans, billingPeriod)
        : null,
    [selectedClient, data.timeEntries, data.plans, billingPeriod],
  )
  const display = useMemo(
    () =>
      baseInvoice ? buildDisplayInvoice(baseInvoice, data.timeEntries, billingPeriod) : null,
    [baseInvoice, data.timeEntries, billingPeriod],
  )
  const billingPeriodLabel = getBillingPeriodLabel(billingPeriod)

  if (!ownerMode || !selectedClient || !baseInvoice || !display) {
    return null
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
            <button className="primary-action" onClick={printInvoice} type="button">
              <Printer size={16} />
              Print invoice
            </button>
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
          <InvoicePreview display={display} />
        </div>
        <BillingQueue
          billingPeriod={billingPeriod}
          clients={data.clients}
          entries={data.timeEntries}
          plans={data.plans}
        />
      </section>

      <div className="print-document" aria-hidden="true">
        <InvoiceDocument display={display} />
      </div>
    </>
  )
}

function PayButton({ client, variant }: { client: Client; variant: 'screen' | 'print' }) {
  if (!client.quickbooksPayUrl) {
    return null
  }

  if (variant === 'print') {
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
      rel="noreferrer"
      target="_blank"
    >
      <ExternalLink size={16} />
      Pay via QuickBooks
    </a>
  )
}

function InvoicePreview({ display }: { display: DisplayInvoice }) {
  const { invoice } = display
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
      {invoice.client.paymentTerms ? (
        <div className="invoice-payment-terms">
          <span>Payment terms</span>
          <strong>{invoice.client.paymentTerms}</strong>
        </div>
      ) : null}
      <div className="invoice-total-row">
        <span>Total due</span>
        <strong>{currency.format(invoice.total)}</strong>
      </div>
      <div className="invoice-pay-row">
        <PayButton client={invoice.client} variant="screen" />
      </div>
      {invoice.client.footerNote ? (
        <p className="invoice-footer-note">{invoice.client.footerNote}</p>
      ) : null}
    </div>
  )
}

function BillingQueue({
  billingPeriod,
  clients,
  entries,
  plans,
}: {
  billingPeriod: string
  clients: Client[]
  entries: TimeEntry[]
  plans: SubscriptionPlan[]
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
          const invoice = getInvoice(client, entries, plans, billingPeriod)
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

function InvoiceDocument({ display }: { display: DisplayInvoice }) {
  const { invoice } = display
  const issuedDate = new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date())

  const billingClient = invoice.client
  const addressLines = [
    billingClient.addressLine1,
    billingClient.addressLine2,
    [billingClient.city, billingClient.state, billingClient.postalCode]
      .filter((part) => part && part.trim())
      .join(', '),
  ].filter((line) => line && line.trim().length > 0)

  return (
    <section className="print-sheet">
      <header>
        <div>
          <strong>PB&amp;J Strategic Accounting</strong>
          <span>Strategic bookkeeping, payroll, and advisory support</span>
        </div>
        {billingClient.logoUrl ? (
          <img alt={`${billingClient.name} logo`} className="print-logo" src={billingClient.logoUrl} />
        ) : (
          <FileText size={34} />
        )}
      </header>
      <div className="print-meta">
        <div>
          <span>Bill to</span>
          <strong>{billingClient.name}</strong>
          {billingClient.contactName ? <small>{billingClient.contactName}</small> : null}
          {billingClient.email ? <small>{billingClient.email}</small> : null}
          {billingClient.phone ? <small>{billingClient.phone}</small> : null}
          {addressLines.map((line) => (
            <small key={line}>{line}</small>
          ))}
        </div>
        <div>
          <span>Issued</span>
          <strong>{issuedDate}</strong>
          <small>
            {billingClient.billingMode === 'subscription' ? 'Subscription plan' : 'Billable hours'}
          </small>
          <small>{invoice.periodLabel}</small>
        </div>
      </div>
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
      {billingClient.paymentTerms ? (
        <div className="print-terms">
          <span>Payment terms:</span>
          <strong>{billingClient.paymentTerms}</strong>
        </div>
      ) : null}
      <footer>
        <span>Total due</span>
        <strong>{currency.format(invoice.total)}</strong>
      </footer>
      <PayButton client={billingClient} variant="print" />
      {billingClient.footerNote ? (
        <p className="print-footer-note">{billingClient.footerNote}</p>
      ) : (
        <p>Thank you for trusting PB&amp;J Strategic Accounting.</p>
      )}
    </section>
  )
}
