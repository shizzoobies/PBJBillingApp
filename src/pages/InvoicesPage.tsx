import { FileText, Printer } from 'lucide-react'
import { useAppContext } from '../AppContext'
import type { Client, Invoice, SubscriptionPlan, TimeEntry } from '../lib/types'
import {
  currency,
  formatHours,
  getBillingPeriodLabel,
  getInvoice,
} from '../lib/utils'

export function InvoicesPage() {
  const {
    data,
    selectedClientId,
    setSelectedClientId,
    billingPeriod,
    printInvoice,
    ownerMode,
  } = useAppContext()

  if (!ownerMode) {
    return null
  }

  const selectedClient =
    data.clients.find((client) => client.id === selectedClientId) ?? data.clients[0]
  const invoice = getInvoice(selectedClient, data.timeEntries, data.plans, billingPeriod)
  const billingPeriodLabel = getBillingPeriodLabel(billingPeriod)

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
            <span>{invoice.entryCount} billable entries</span>
            <span>{formatHours(invoice.billableMinutes)} tracked</span>
          </div>
          <InvoicePreview invoice={invoice} />
        </div>
        <BillingQueue
          billingPeriod={billingPeriod}
          clients={data.clients}
          entries={data.timeEntries}
          plans={data.plans}
        />
      </section>

      <div className="print-document" aria-hidden="true">
        <InvoiceDocument invoice={invoice} />
      </div>
    </>
  )
}

function InvoicePreview({ invoice }: { invoice: Invoice }) {
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
        {invoice.lines.map((line) => (
          <div className="invoice-line" key={`${line.label}-${line.detail}`}>
            <div>
              <strong>{line.label}</strong>
              <span>{line.detail}</span>
            </div>
            <span>{currency.format(line.amount)}</span>
          </div>
        ))}
      </div>
      <div className="invoice-total-row">
        <span>Total due</span>
        <strong>{currency.format(invoice.total)}</strong>
      </div>
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

function InvoiceDocument({ invoice }: { invoice: Invoice }) {
  const issuedDate = new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date())

  return (
    <section className="print-sheet">
      <header>
        <div>
          <strong>PB&amp;J Strategic Accounting</strong>
          <span>Strategic bookkeeping, payroll, and advisory support</span>
        </div>
        <FileText size={34} />
      </header>
      <div className="print-meta">
        <div>
          <span>Bill to</span>
          <strong>{invoice.client.name}</strong>
          <small>{invoice.client.contact}</small>
        </div>
        <div>
          <span>Issued</span>
          <strong>{issuedDate}</strong>
          <small>
            {invoice.client.billingMode === 'subscription' ? 'Subscription plan' : 'Billable hours'}
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
          {invoice.lines.map((line) => (
            <tr key={`${line.label}-${line.detail}`}>
              <td>{line.label}</td>
              <td>{line.detail}</td>
              <td>{currency.format(line.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <footer>
        <span>Total due</span>
        <strong>{currency.format(invoice.total)}</strong>
      </footer>
      <p>Thank you for trusting PB&amp;J Strategic Accounting.</p>
    </section>
  )
}
