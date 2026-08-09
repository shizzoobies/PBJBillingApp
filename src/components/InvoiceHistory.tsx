import { ChevronDown, ChevronRight, Printer } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { listInvoicesRequest } from '../lib/api'
import type { Client, PersistedInvoice } from '../lib/types'
import {
  INVOICE_STATUS_LABELS,
  currency,
  formatSentOn,
  getBillingPeriodLabel,
  summarizeInvoiceMonth,
  type InvoiceMonthSummary,
} from '../lib/utils'

/**
 * The invoice archive (I5): every month that has ever been generated, newest
 * first, each one collapsed to a single line of totals until you open it.
 *
 * READ-ONLY on purpose. The month run is where invoices are edited, sent and
 * voided, and it can only ever be pointed at one month — so a view that spans
 * every month has to be a place you LOOK, not a second place to act, or the two
 * would end up disagreeing about which one owns an invoice. The only things a
 * row does are print (through the page's existing print document) and hand its
 * month back to the run.
 *
 * The whole archive is fetched in one call. Volume is a few hundred invoices a
 * year, which is nothing to group and sort in the browser, and paginating an
 * archive would mean the totals on screen described a page rather than a month.
 */

type SortKey = 'number' | 'client' | 'status' | 'total' | 'sent' | 'paid'
type SortDir = 'asc' | 'desc'

const COLUMNS: ReadonlyArray<{ key: SortKey; label: string }> = [
  { key: 'number', label: 'Number' },
  { key: 'client', label: 'Client' },
  { key: 'status', label: 'Status' },
  { key: 'total', label: 'Total' },
  { key: 'sent', label: 'Sent' },
  { key: 'paid', label: 'Paid' },
]

/** Every status, in the order they happen — the filter reads as a lifecycle. */
const STATUS_FILTERS: ReadonlyArray<PersistedInvoice['status']> = [
  'draft',
  'reviewed',
  'sent',
  'processing',
  'overdue',
  'paid',
  'void',
]

/** One month of the archive: its rows, plus what they add up to. */
type MonthGroup = InvoiceMonthSummary & {
  period: string
  label: string
  invoices: PersistedInvoice[]
}

/** The header line, built from parts so it can never claim a total it doesn't have. */
function summaryLine(group: MonthGroup) {
  const parts: string[] = []
  if (group.liveCount > 0) {
    parts.push(`${group.liveCount} invoice${group.liveCount === 1 ? '' : 's'}`)
    parts.push(`${currency.format(group.billed)} billed`)
    parts.push(`${currency.format(group.paid)} paid`)
    parts.push(`${currency.format(group.outstanding)} outstanding`)
  }
  if (group.voidCount > 0) {
    parts.push(`${group.voidCount} voided`)
  }
  return parts.join(' · ')
}

/** A short date, or an em dash — never a blank cell that reads as a rendering bug. */
function shortOrDash(iso: string | null) {
  if (!iso) return '—'
  return formatSentOn(iso) || '—'
}

export function InvoiceHistory({
  clients,
  note,
  onOpenMonth,
  onPrint,
}: {
  clients: Client[]
  /**
   * Why the last "Open in month run" click did nothing. Owned by the page,
   * because the page is what refused: the run would not let go of unsaved
   * edits. Without it the click is a silent no-op, which reads as a bug.
   */
  note?: string | null
  /** Send the month run to this period and put it back on screen. */
  onOpenMonth: (period: string) => void
  /** Print through the page's print document — the same one everything else uses. */
  onPrint: (invoice: PersistedInvoice) => void
}) {
  const [invoices, setInvoices] = useState<PersistedInvoice[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [openPeriods, setOpenPeriods] = useState<ReadonlySet<string>>(new Set())
  const [year, setYear] = useState('')
  const [clientId, setClientId] = useState('')
  const [status, setStatus] = useState('')
  // One sort for the whole archive, applied WITHIN each month — months
  // themselves always run newest first, because that is what makes this a
  // history rather than a list. Sorting per-month independently would mean the
  // header you clicked and the header you're looking at could disagree.
  const [sortKey, setSortKey] = useState<SortKey>('number')
  const [sortDir, setSortDir] = useState<SortDir>('asc')

  // Fetched once, when the view opens. Nothing here writes, so there is no
  // reason to reload; and this component is mounted fresh each time History is
  // chosen, which is what keeps the archive honest after a send or a void.
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const rows = await listInvoicesRequest()
        if (!cancelled) setInvoices(rows)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load the invoice history.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  // An archive outlives its clients. A deleted client's invoices are still real
  // documents, so they keep their rows — but they need names that TELL THEM
  // APART: two removed clients both reading "Unknown client" would give the
  // filter two identical options that select different invoices. The id
  // fragment is ugly on purpose; it is a tombstone, not a label.
  const clientName = useMemo(() => {
    const byId = new Map(clients.map((client) => [client.id, client.name]))
    return (id: string) => byId.get(id) ?? `Former client (${id.slice(-6)})`
  }, [clients])

  // A client that no longer exists still has invoices, and printing one would
  // fall through to the per-client live calculation — a different document
  // under the same number. Those rows are shown, just without a Print button.
  const knownClientIds = useMemo(() => new Set(clients.map((client) => client.id)), [clients])

  // Year and client are derived from what is actually IN the archive: offering
  // forty clients and six years when the file holds three months of invoices
  // would be pretending there is more here than there is. Status is not —
  // it is the fixed lifecycle list, so the options read the same every month.
  const years = useMemo(
    () =>
      [...new Set(invoices.map((invoice) => invoice.period.slice(0, 4)))].sort((a, b) =>
        b.localeCompare(a),
      ),
    [invoices],
  )
  const filterClients = useMemo(() => {
    const ids = new Set(invoices.map((invoice) => invoice.clientId))
    return [...ids]
      .map((id) => ({ id, name: clientName(id) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [invoices, clientName])

  const filtered = useMemo(
    () =>
      invoices.filter(
        (invoice) =>
          (!year || invoice.period.startsWith(year)) &&
          (!clientId || invoice.clientId === clientId) &&
          (!status || invoice.status === status),
      ),
    [invoices, year, clientId, status],
  )

  // Group, then summarize. Totals are computed from the FILTERED rows, so the
  // header always describes what is under it — filter to one client and the
  // month line becomes that client's year, which is the question people
  // actually bring to an archive.
  const groups = useMemo(() => {
    const byPeriod = new Map<string, PersistedInvoice[]>()
    for (const invoice of filtered) {
      const list = byPeriod.get(invoice.period)
      if (list) list.push(invoice)
      else byPeriod.set(invoice.period, [invoice])
    }
    return [...byPeriod.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([period, rows]) => ({
        period,
        label: getBillingPeriodLabel(period),
        invoices: rows,
        ...summarizeInvoiceMonth(rows),
      }))
  }, [filtered])

  const sortRows = (rows: PersistedInvoice[]) => {
    const direction = sortDir === 'asc' ? 1 : -1
    const value = (invoice: PersistedInvoice) => {
      switch (sortKey) {
        case 'client':
          return clientName(invoice.clientId).toLowerCase()
        // By where the invoice IS in its life, not by the first letter of the
        // word for it — alphabetical would file Draft between Paid and Sent.
        case 'status':
          return STATUS_FILTERS.indexOf(invoice.status)
        case 'total':
          return invoice.total
        // Dates sort on the raw ISO string, not the short label on screen —
        // "Aug 9" and "Aug 10" compare backwards as text.
        case 'sent':
          return invoice.sentAt ?? ''
        case 'paid':
          return invoice.paidAt ?? ''
        default:
          return invoice.number ?? ''
      }
    }
    const isDateColumn = sortKey === 'sent' || sortKey === 'paid'
    return [...rows].sort((a, b) => {
      const left = value(a)
      const right = value(b)
      // An invoice that was never sent has no date — it is not an EARLY one.
      // Blanks sit at the bottom whichever way the column is pointed, so
      // ascending does not open with a block of dashes and descending does not
      // bury the rows that still need doing.
      if (isDateColumn && (left === '' || right === '')) {
        if (left === right) return 0
        return left === '' ? 1 : -1
      }
      if (typeof left === 'number' && typeof right === 'number') {
        return (left - right) * direction
      }
      return String(left).localeCompare(String(right)) * direction
    })
  }

  /** Clicking the column you're already on flips the direction. */
  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((current) => (current === 'asc' ? 'desc' : 'asc'))
      return
    }
    setSortKey(key)
    setSortDir('asc')
  }

  const togglePeriod = (period: string) =>
    setOpenPeriods((current) => {
      const next = new Set(current)
      if (!next.delete(period)) next.add(period)
      return next
    })

  const filtersActive = Boolean(year || clientId || status)

  return (
    <div className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Every month</p>
          <h2>Invoice history</h2>
        </div>
      </div>

      {error ? (
        <p className="invoice-run-error" role="alert">
          {error}
        </p>
      ) : null}

      {invoices.length > 0 ? (
        <div className="filter-bar">
          <label className="filter-field">
            <span>Year</span>
            <select
              className="compact-input"
              onChange={(event) => setYear(event.target.value)}
              value={year}
            >
              <option value="">All</option>
              {years.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <label className="filter-field">
            <span>Client</span>
            <select
              className="compact-input"
              onChange={(event) => setClientId(event.target.value)}
              value={clientId}
            >
              <option value="">All</option>
              {filterClients.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
          </label>
          <label className="filter-field">
            <span>Status</span>
            <select
              className="compact-input"
              onChange={(event) => setStatus(event.target.value)}
              value={status}
            >
              <option value="">All</option>
              {STATUS_FILTERS.map((option) => (
                <option key={option} value={option}>
                  {INVOICE_STATUS_LABELS[option]}
                </option>
              ))}
            </select>
          </label>
          {filtersActive ? (
            <button
              type="button"
              className="clear-filters-link"
              onClick={() => {
                setYear('')
                setClientId('')
                setStatus('')
              }}
            >
              Clear filters
            </button>
          ) : null}
        </div>
      ) : null}

      {note ? <p className="invoice-run-note">{note}</p> : null}

      {loading ? <p className="invoice-run-empty">Loading…</p> : null}
      {!loading && invoices.length === 0 && !error ? (
        <p className="invoice-run-empty">
          Invoices appear here once months have been generated.
        </p>
      ) : null}
      {!loading && invoices.length > 0 && groups.length === 0 ? (
        <p className="invoice-run-empty">No invoices match these filters.</p>
      ) : null}

      {groups.map((group) => {
        const isOpen = openPeriods.has(group.period)
        return (
          <section className="invoice-history-month" key={group.period}>
            {/* Collapsed by default: the point of the header line is that you
                can read a year of months without opening any of them. */}
            <button
              type="button"
              className="invoice-history-head"
              aria-expanded={isOpen}
              onClick={() => togglePeriod(group.period)}
            >
              {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              <span className="invoice-history-month-label">{group.label}</span>
              <span className="invoice-history-month-summary">{summaryLine(group)}</span>
            </button>
            {isOpen ? (
              // Seven columns do not fit a phone. The table scrolls inside its
              // own box rather than pushing the whole page sideways.
              <div className="invoice-history-scroll">
                <table className="invoice-history-table">
                  <thead>
                    <tr>
                      {COLUMNS.map((column) => {
                        const active = column.key === sortKey
                        return (
                          <th
                            key={column.key}
                            scope="col"
                            aria-sort={
                              active
                                ? sortDir === 'asc'
                                  ? 'ascending'
                                  : 'descending'
                                : 'none'
                            }
                          >
                            <button
                              type="button"
                              className={
                                active
                                  ? 'invoice-history-sort is-active'
                                  : 'invoice-history-sort'
                              }
                              onClick={() => toggleSort(column.key)}
                            >
                              {column.label}
                              {active ? (
                                <span aria-hidden="true">{sortDir === 'asc' ? '↑' : '↓'}</span>
                              ) : null}
                            </button>
                          </th>
                        )
                      })}
                      <th scope="col">
                        <span className="visually-hidden">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortRows(group.invoices).map((invoice) => (
                      <tr
                        key={invoice.id}
                        className={
                          invoice.status === 'void'
                            ? 'invoice-history-row is-void'
                            : 'invoice-history-row'
                        }
                      >
                        <td>
                          {/* The number is the way back into the run: it is the
                              one thing on the row that identifies the document,
                              so it is the thing worth clicking. */}
                          <button
                            type="button"
                            className="invoice-history-open"
                            title={`Open the ${group.label} run`}
                            onClick={() => onOpenMonth(invoice.period)}
                          >
                            {invoice.number ?? '—'}
                          </button>
                        </td>
                        <td>{clientName(invoice.clientId)}</td>
                        <td>
                          <span className={`invoice-status is-${invoice.status}`}>
                            {INVOICE_STATUS_LABELS[invoice.status] ?? invoice.status}
                          </span>
                        </td>
                        <td className="invoice-history-amount">
                          {currency.format(invoice.total)}
                        </td>
                        <td>{shortOrDash(invoice.sentAt)}</td>
                        <td>{shortOrDash(invoice.paidAt)}</td>
                        <td className="invoice-history-actions">
                          {knownClientIds.has(invoice.clientId) ? (
                            <button
                              type="button"
                              className="icon-button"
                              // A never-numbered invoice would otherwise announce
                              // itself as just "Print invoice", which is every
                              // other button on the month.
                              aria-label={
                                invoice.number
                                  ? `Print invoice ${invoice.number}`
                                  : `Print ${clientName(invoice.clientId)}'s ${group.label} invoice`
                              }
                              title="Print this invoice"
                              onClick={() => onPrint(invoice)}
                            >
                              <Printer size={15} />
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </section>
        )
      })}
    </div>
  )
}
