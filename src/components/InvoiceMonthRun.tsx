import {
  AlertTriangle,
  Download,
  Link as LinkIcon,
  Mail,
  Plus,
  Printer,
  RefreshCw,
  RotateCcw,
  Trash2,
  Undo2,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from 'react'
import {
  createInvoicePaymentLinkRequest,
  generateInvoicesRequest,
  listInvoicesRequest,
  listUnappliedRetainersRequest,
  regenerateInvoicesRequest,
  sendInvoiceRequest,
  updateInvoiceRequest,
} from '../lib/api'
import { InvoiceRecipientPicker } from './InvoiceRecipientPicker'
import {
  adhocLineForMode,
  normalizeAdhocMode,
  renderedInvoiceLines,
  retainerCreditLine,
} from '../../lib/invoice-lines.js'
import {
  ApiError,
  type AdhocMode,
  type Client,
  type Contact,
  type PersistedInvoice,
  type PersistedInvoiceLine,
} from '../lib/types'
import {
  INVOICE_STATUS_LABELS,
  currency,
  formatInvoiceRecipient,
  formatSentOn,
  getBillingPeriodLabel,
  recipientCountLabel,
  resolveInvoiceRecipients,
  type ResolvedInvoiceRecipients,
} from '../lib/utils'

/**
 * The month run (I2): every client's stored invoice for a period, grouped into
 * status tabs, in INVOICE NUMBER order within a tab, each expanding to an
 * editor.
 *
 * Number order is deliberate even though flagged invoices are the interesting
 * ones — a list that rearranges itself while you work through it is
 * disorienting, and the "needs a look" count above does the surfacing instead
 * (Alex's call). Tabs don't break that rule: they split the run into groups
 * that each stay in number order, which is what makes a 45-client month
 * workable at all.
 *
 * These invoices are fetched directly rather than read off `data`, because they
 * are deliberately not part of the workspace bulk save — see the API module.
 */

type RunTabId = 'to-review' | 'reviewed' | 'sent' | 'paid' | 'voided'

/**
 * What the page can ask of the run from outside — History's "Open in month
 * run", and nothing else.
 *
 * Imperative rather than a `period` prop on purpose. The month is genuinely
 * this component's own: the picker, the loading and the in-flight guards all
 * hang off it, and lifting it to the page so one button could set it would put
 * the page in charge of state it has no other reason to hold. This is a tap on
 * the shoulder — "show August" — which is also the only shape that works when
 * she asks for the SAME month twice, having moved the picker herself in
 * between.
 *
 * `showPeriod` answers FALSE when it refused, which only happens when there
 * were unsaved edits open and she chose to keep them. The caller has to respect
 * that: putting her on a month view that did not move would be the worst of
 * both, so History stays where it is.
 */
export type InvoiceMonthRunHandle = {
  showPeriod: (period: string) => boolean
  /**
   * The month the run is sitting on right now. Only worth asking after a
   * refusal, so the page can name the month holding the edits instead of
   * pointing vaguely at "the month run".
   */
  showingPeriod: () => string
}

/**
 * Which tab an invoice lands in. Keyed by the status union rather than a
 * lookup with a fallback, so adding a status to `PersistedInvoice` fails the
 * build here instead of quietly dropping those invoices out of the run.
 *
 * Sent, Processing and Overdue share one tab: they are all "it has gone out",
 * and the row still shows its own status pill, so nothing is lost by grouping
 * them.
 */
const TAB_OF_STATUS: Record<PersistedInvoice['status'], RunTabId> = {
  draft: 'to-review',
  reviewed: 'reviewed',
  sent: 'sent',
  processing: 'sent',
  overdue: 'sent',
  paid: 'paid',
  void: 'voided',
}

const RUN_TABS: ReadonlyArray<{ id: RunTabId; label: string; empty: string }> = [
  { id: 'to-review', label: 'To review', empty: 'Nothing left to review this month.' },
  { id: 'reviewed', label: 'Reviewed', empty: 'Nothing reviewed and waiting to go out.' },
  { id: 'sent', label: 'Sent', empty: 'Nothing has gone out for this month yet.' },
  { id: 'paid', label: 'Paid', empty: 'Nothing paid for this month yet.' },
  { id: 'voided', label: 'Voided', empty: 'Nothing voided this month.' },
]

/**
 * What the owner can decide about one piece of ad hoc work, in the order the
 * decision usually goes: bill it, show it for nothing, or leave it off.
 * Wording is the client's-eye view, because that is what she is choosing.
 */
const ADHOC_CHOICES: ReadonlyArray<{ value: AdhocMode; label: string }> = [
  { value: 'billed', label: 'Invoice it' },
  { value: 'courtesy', label: 'Show detail only ($0.00)' },
  { value: 'omitted', label: 'Leave off the invoice' },
]

/**
 * What a save answers with.
 *
 * A refused save used to come back as `null`, which told the caller nothing —
 * and one refusal needs handling rather than reporting: a retainer credit the
 * server would not honor has to be taken back OUT of the editor's lines, or she
 * is left holding a credit that will be refused again on every save.
 */
type PatchResult =
  | { ok: true; invoice: PersistedInvoice }
  | { ok: false; message: string; retainer: boolean }

/**
 * The statuses in which a retainer credit may be ADDED. Mirrors
 * `RETAINER_CREDITABLE_STATUSES` in db/store.js — the server is what enforces
 * it; this only decides whether to hold out a button that would be refused.
 */
const RETAINER_CREDITABLE_STATUSES: ReadonlySet<PersistedInvoice['status']> = new Set([
  'draft',
  'reviewed',
])

/** The current month as YYYY-MM, in local time. */
function currentPeriod() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

function formatDue(due: string | null) {
  if (!due) return 'no due date'
  const parsed = new Date(`${due}T12:00:00`)
  if (Number.isNaN(parsed.getTime())) return 'no due date'
  return `due ${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(parsed)}`
}

export function InvoiceMonthRun({
  clients,
  contacts = [],
  onPrint,
  refreshToken = 0,
  ref,
}: {
  clients: Client[]
  /**
   * The contact directory, so each row can work out WHO its invoice would be
   * emailed to before anything is sent. Optional and defaulted: a caller that
   * has not got them yet gets rows that simply say nobody is on file rather
   * than a crash.
   */
  contacts?: Contact[]
  /** Hand a stored invoice up to the page, which owns the print document. */
  onPrint: (invoice: PersistedInvoice) => void
  /**
   * Bumped by the page when it changes an invoice outside this component — the
   * per-client "Email invoice" button sends through the same rail, and the two
   * sections must not disagree about whether something has been sent.
   */
  refreshToken?: number
  /** See `InvoiceMonthRunHandle` — the page's one way to move this run. */
  ref?: Ref<InvoiceMonthRunHandle>
}) {
  const [period, setPeriod] = useState(currentPeriod)
  const [invoices, setInvoices] = useState<PersistedInvoice[]>([])
  // Every retainer the firm is holding — paid and not yet given back. Kept
  // apart from `invoices` because these belong to no month: the one this August
  // invoice credits was probably issued in January.
  const [retainers, setRetainers] = useState<PersistedInvoice[]>([])
  // Bumped by a save, to re-ask what is still on account. A counter rather than
  // a callback so the fetch stays inside its effect, with the same cancellation
  // guard the invoice load has.
  const [retainerToken, setRetainerToken] = useState(0)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  // One status group at a time. Starts on the drafts, which is where the
  // month's work actually begins.
  const [activeTabId, setActiveTabId] = useState<RunTabId>('to-review')
  // Whether the open editor has typed-but-unsaved edits. Switching tabs
  // unmounts that row, so this is the only warning she would get before losing
  // them. Only one editor is ever open, so one flag is enough.
  const [openDirty, setOpenDirty] = useState(false)

  const clientName = useCallback(
    (clientId: string) => clients.find((c) => c.id === clientId)?.name ?? 'Unknown client',
    [clients],
  )

  /** Whether this invoice went out with a card option beside bank transfer. */
  const cardEnabled = useCallback(
    (clientId: string) => clients.find((c) => c.id === clientId)?.cardPaymentsEnabled ?? false,
    [clients],
  )

  /**
   * Who this client's invoice would be emailed to, right now — the SERVER's
   * resolver, so the row promises exactly what the send endpoint would do.
   * A client that has gone missing resolves to nobody with the reason attached,
   * which is the same shape a client with no addresses produces.
   */
  const recipientsFor = useCallback(
    (clientId: string): ResolvedInvoiceRecipients =>
      resolveInvoiceRecipients({
        client: clients.find((c) => c.id === clientId) ?? null,
        contacts,
      }),
    [clients, contacts],
  )

  /**
   * Move the run to another month — the ONE way the period changes, whether it
   * was the picker or History that asked.
   *
   * Changing months reloads the list, which unmounts the open editor and takes
   * any typed-but-unsaved line edits and note with it, silently, leaving the
   * row looking untouched when she comes back. That is the same loss switching
   * tabs causes, so it asks the same question. Answering "keep them" returns
   * false and nothing moves.
   *
   * The month is NAMED, because this can be asked from History — where the run
   * is off screen and "you have unsaved edits" would be about an invoice she
   * cannot see and may not remember opening.
   *
   * A request for the month already on screen is not a change: it prompts about
   * nothing and leaves her tab position alone.
   *
   * `openDirty` is deliberately NOT cleared here. It belongs to the editor, and
   * the editor clears it itself when the new list lands and the old row
   * unmounts. Clearing it up front would be claiming the change had happened:
   * if the reload then fails, the old row is still on screen with her edits
   * still in it, and the NEXT thing she does has to ask about them again.
   */
  const changePeriod = useCallback(
    (next: string) => {
      if (next === period) return true
      if (
        openDirty &&
        !window.confirm(
          `You have unsaved invoice edits in ${getBillingPeriodLabel(period)}. ` +
            'Discard them and change months?',
        )
      ) {
        return false
      }
      setPeriod(next)
      // A different month is a different pile of work — she has no position in
      // it to protect, so start at the drafts again.
      setActiveTabId('to-review')
      return true
    },
    [period, openDirty],
  )

  // Land on a month History asked for. Goes through the same guarded path the
  // picker uses, so "Open in month run" cannot discard edits the picker would
  // have asked about.
  useImperativeHandle(
    ref,
    () => ({ showPeriod: changePeriod, showingPeriod: () => period }),
    [changePeriod, period],
  )

  // The month the list on screen belongs to. The button handlers below are
  // async and the month picker is not frozen while they run, so they check this
  // before writing anything back — the effect's own `cancelled` flag only
  // covers the effect.
  const shownPeriod = useRef(period)

  // Load whenever the period changes, or the page tells us an invoice moved
  // under us. `cancelled` guards against a slow response for a month she has
  // already navigated away from landing on top of the newer one — same shape
  // as the Client Recap page.
  useEffect(() => {
    shownPeriod.current = period
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const rows = await listInvoicesRequest(period)
        if (!cancelled) setInvoices(rows)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load invoices.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [period, refreshToken])

  /**
   * Re-read the retainers on hand — on mount, and again after every save,
   * because applying a credit spends one and removing the line hands it back.
   * An offer that outlived its retainer would be an offer to double-spend, and
   * one that failed to reappear would look like the money had gone.
   *
   * A failure here is deliberately SILENT: this decides whether an optional
   * button is offered, and an error banner over the month run would be shouting
   * about something she was not doing.
   */
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const held = await listUnappliedRetainersRequest()
        if (!cancelled) setRetainers(held)
      } catch {
        /* the Apply affordance simply does not appear */
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [retainerToken, refreshToken])

  // Number order. A voided invoice keeps its number and its place, so the run
  // reads the same way before and after something is voided.
  const ordered = useMemo(
    () =>
      [...invoices].sort((a, b) =>
        String(a.number ?? '').localeCompare(String(b.number ?? '')),
      ),
    [invoices],
  )

  // The run split into its tabs. Each group keeps the number order above, so
  // moving between tabs never re-sorts anything.
  const byTab = useMemo(() => {
    const map = new Map<RunTabId, PersistedInvoice[]>()
    for (const tab of RUN_TABS) map.set(tab.id, [])
    for (const invoice of ordered) {
      // A money document must never vanish from the run. If the server ever
      // answers with a status this build does not know, it lands in To review
      // rather than nowhere — that tab forces eyes on it.
      const tabId: RunTabId = TAB_OF_STATUS[invoice.status] ?? 'to-review'
      map.get(tabId)?.push(invoice)
    }
    return map
  }, [ordered])

  // Derived at render rather than stored, so an unknown id can never strand the
  // panel on nothing. An EMPTY tab is still a valid place to stand: marking the
  // last draft reviewed must not yank her into another tab mid-pass — she is
  // working down this list, and the invoice simply leaves it.
  const activeTab = RUN_TABS.find((tab) => tab.id === activeTabId) ?? RUN_TABS[0]
  const activeInvoices = byTab.get(activeTab.id) ?? []

  // Flagged invoices sit in whichever tab their status puts them in, so the
  // "Need a look" count above needs somewhere to point: a tab holding any
  // flagged invoice gets an amber marker. Voided rows drop their flags (nothing
  // to decide about a voided invoice), same as the row rendering.
  const flaggedIn = (tabId: RunTabId) =>
    (byTab.get(tabId) ?? []).filter(
      (invoice) => invoice.status !== 'void' && invoice.scopeFlags.length > 0,
    ).length

  /**
   * Move to another tab. The open row unmounts on the way, taking any unsaved
   * line edits and note with it — silently, and the row would look untouched
   * when she came back — so a dirty editor asks first.
   */
  const selectTab = (tabId: RunTabId) => {
    if (tabId === activeTab.id) return
    if (
      openDirty &&
      !window.confirm('You have unsaved invoice edits. Discard them and switch tabs?')
    ) {
      return
    }
    setOpenDirty(false)
    setActiveTabId(tabId)
  }

  const live = ordered.filter((invoice) => invoice.status !== 'void')
  const toReview = live.filter((invoice) => invoice.status === 'draft').length
  const reviewed = live.filter((invoice) => invoice.status === 'reviewed').length
  const needALook = live.filter((invoice) => invoice.scopeFlags.length > 0).length
  const monthTotal = live.reduce((sum, invoice) => sum + invoice.total, 0)

  const generate = async () => {
    const target = period
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const result = await generateInvoicesRequest(target)
      const rows = await listInvoicesRequest(target)
      // She changed months while this was in the air. The work landed, but
      // saying so over September's list would be describing the wrong month.
      if (shownPeriod.current !== target) return
      setInvoices(rows)
      // Say what happened, including the nothing-case: running this and seeing
      // the list unchanged otherwise looks like a broken button.
      setNote(
        result.created.length > 0
          ? `Built ${result.created.length} invoice${result.created.length === 1 ? '' : 's'}.`
          : 'Nothing new to build — every client already has one for this month.',
      )
    } catch (err) {
      if (shownPeriod.current !== target) return
      setError(err instanceof Error ? err.message : 'Could not build this month.')
    } finally {
      setBusy(false)
    }
  }

  /**
   * Void this month's unsent invoices and build them again.
   *
   * The counts in the confirm are re-fetched FIRST rather than read off state.
   * There are two owners and a tab can sit open for hours: a sentence promising
   * to void "12 drafts" while the month has since become 12 reviewed invoices
   * with notes on them would be asking for consent to something else entirely.
   * Sent and paid invoices are not in the count because they are not touched —
   * but the edits, notes and review status on what this does void are genuinely
   * gone, which is why the sentence says so rather than implying a refresh.
   */
  const regenerate = async () => {
    const target = period
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      let fresh: PersistedInvoice[]
      try {
        fresh = await listInvoicesRequest(target)
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Could not check this month before rebuilding.',
        )
        return
      }
      if (shownPeriod.current !== target) return
      setInvoices(fresh)

      const freshDrafts = fresh.filter((invoice) => invoice.status === 'draft').length
      const freshReviewed = fresh.filter((invoice) => invoice.status === 'reviewed').length
      if (freshDrafts + freshReviewed === 0) {
        // The list she was looking at was out of date — nothing left to rebuild.
        setNote('Nothing to regenerate — this month has no unsent invoices.')
        return
      }

      const confirmed = window.confirm(
        `Void ${freshDrafts} draft${freshDrafts === 1 ? '' : 's'} and ${freshReviewed} reviewed invoice${
          freshReviewed === 1 ? '' : 's'
        } for ${getBillingPeriodLabel(target)} and rebuild them from current data? ` +
          'Sent and paid invoices are not touched. Edits, notes, and review status on the voided invoices are discarded.',
      )
      if (!confirmed) return

      const result = await regenerateInvoicesRequest(target)
      const rows = await listInvoicesRequest(target)
      if (shownPeriod.current !== target) return
      setInvoices(rows)
      // 'already-generated' after a regenerate means the client's live invoice
      // was one of the ones we deliberately left alone.
      const leftAlone = result.skipped.filter((row) => row.reason === 'already-generated').length
      const nothingToBill = result.skipped.filter((row) => row.reason === 'nothing-to-bill').length
      setNote(
        `Voided ${result.voided} and rebuilt ${result.created.length} invoice${
          result.created.length === 1 ? '' : 's'
        }.` +
          (leftAlone > 0
            ? ` ${leftAlone} sent or paid invoice${leftAlone === 1 ? '' : 's'} left alone.`
            : '') +
          (nothingToBill > 0
            ? ` ${nothingToBill} client${nothingToBill === 1 ? '' : 's'} had nothing to bill.`
            : ''),
      )
    } catch (err) {
      // Includes the half-done case: the server says the voids landed and that
      // Generate rebuilds the month, and that sentence has to reach her. Reload
      // anyway, because the list on screen may now be describing voided rows —
      // a failed reload must not replace the message that explains what to do.
      if (shownPeriod.current !== target) return
      setError(err instanceof Error ? err.message : 'Could not rebuild this month.')
      try {
        const rows = await listInvoicesRequest(target)
        if (shownPeriod.current === target) setInvoices(rows)
      } catch {
        /* keep the list we have; the message above is the important part */
      }
    } finally {
      setBusy(false)
    }
  }

  /** Replace one invoice in the list with a server-returned version. */
  const mergeInvoice = (updated: PersistedInvoice) =>
    setInvoices((current) =>
      current.map((invoice) => (invoice.id === updated.id ? updated : invoice)),
    )

  const patch = async (
    invoiceId: string,
    body: Parameters<typeof updateInvoiceRequest>[1],
  ): Promise<PatchResult> => {
    setBusy(true)
    setError(null)
    try {
      const updated = await updateInvoiceRequest(invoiceId, body)
      setInvoices((current) =>
        current.map((invoice) => (invoice.id === updated.id ? updated : invoice)),
      )
      // A save can have spent a retainer or handed one back. Re-ask rather than
      // guess: the server decides, and the offer on the next row has to agree
      // with what it decided.
      setRetainerToken((token) => token + 1)
      return { ok: true, invoice: updated }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not save that change.'
      // A refused retainer credit is answered by the editor, not by the run's
      // banner: it is about the lines she is looking at, the sentence names the
      // other invoice involved, and it comes with the credit line being taken
      // back out — none of which reads as a message about the month.
      const refusedRetainer = err instanceof ApiError && err.status === 409
      if (refusedRetainer) {
        // Whatever the server knows about that retainer, we now do not. Re-ask
        // before offering it to anybody else.
        setRetainerToken((token) => token + 1)
      } else {
        setError(message)
      }
      return { ok: false, message, retainer: refusedRetainer }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel invoice-month-run">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Monthly run</p>
          <h2>Invoices</h2>
        </div>
        <div className="invoice-run-actions">
          <label className="period-control">
            {/* `.sr-only` is not a class this app defines — the label was
                rendering as stray visible text next to the picker. */}
            <span className="visually-hidden">Billing month</span>
            <input
              type="month"
              className="input"
              value={period}
              // Controlled, so a refused change simply re-renders the old month
              // back into the input — there is no stray value left behind.
              onChange={(event) => changePeriod(event.target.value || currentPeriod())}
            />
          </label>
          <button type="button" className="secondary-action" disabled={busy} onClick={generate}>
            <RefreshCw size={15} />
            {busy ? 'Working…' : 'Generate'}
          </button>
          {/* Rebuilds a month that has moved on since it was generated.
              Disabled when there is nothing unsent to throw away — the button
              would otherwise look like it refreshes sent invoices too. */}
          <button
            type="button"
            className="secondary-action"
            disabled={busy || toReview + reviewed === 0}
            title={
              toReview + reviewed === 0
                ? 'Nothing to regenerate — no unsent invoices this month'
                : 'Void this month’s unsent invoices and build them again from current data'
            }
            onClick={() => void regenerate()}
          >
            <RotateCcw size={15} />
            Void &amp; regenerate
          </button>
          <a
            className="secondary-action"
            href={`/api/invoices/export.csv?period=${encodeURIComponent(period)}`}
          >
            <Download size={15} />
            Download for QBO
          </a>
        </div>
      </div>

      <div className="invoice-run-stats">
        <div className="invoice-run-stat">
          <span>To review</span>
          <strong>{toReview}</strong>
        </div>
        <div className="invoice-run-stat">
          <span>Reviewed</span>
          <strong>{reviewed}</strong>
        </div>
        <div className={needALook > 0 ? 'invoice-run-stat is-flagged' : 'invoice-run-stat'}>
          <span>Need a look</span>
          <strong>{needALook}</strong>
        </div>
        <div className="invoice-run-stat">
          <span>Month total</span>
          <strong>{currency.format(monthTotal)}</strong>
        </div>
      </div>

      {error ? (
        <p className="invoice-run-error" role="alert">
          {error}
        </p>
      ) : null}
      {note ? <p className="invoice-run-note">{note}</p> : null}

      {loading ? <p className="invoice-run-empty">Loading…</p> : null}
      {!loading && ordered.length === 0 ? (
        <p className="invoice-run-empty">
          Nothing for this month yet. Press Generate to build a draft for every client with
          something to bill.
        </p>
      ) : null}

      {ordered.length > 0 ? (
        <>
          {/* Reuses the shared tab-bar classes rather than a third copy of the
              same underline styling — see .task-area-tabs in App.css. */}
          <div className="task-area-tabs" role="tablist" aria-label="Filter invoices by status">
            {RUN_TABS.map((tab) => {
              const count = (byTab.get(tab.id) ?? []).length
              const flagged = flaggedIn(tab.id)
              const isActive = tab.id === activeTab.id
              // An empty tab stays visible and clickable — "Voided 0" is worth
              // knowing — but recedes so the eye lands on the groups with work
              // in them.
              const classes = [
                'task-area-tab',
                isActive ? 'is-active' : '',
                count === 0 ? 'is-empty' : '',
              ]
                .filter(Boolean)
                .join(' ')
              // Only the open tab's panel is in the DOM, so only the open tab
              // points at one — a dangling aria-controls is worse than none.
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  id={`invoice-run-tab-${tab.id}`}
                  aria-controls={isActive ? `invoice-run-panel-${tab.id}` : undefined}
                  aria-selected={isActive}
                  className={classes}
                  onClick={() => selectTab(tab.id)}
                >
                  {tab.label}
                  <span className="task-area-tab-count">{count}</span>
                  {flagged > 0 ? (
                    <>
                      <span
                        className="invoice-run-tab-flag"
                        title={`${flagged} invoice${flagged === 1 ? '' : 's'} here need${
                          flagged === 1 ? 's' : ''
                        } a look`}
                        aria-hidden="true"
                      />
                      <span className="visually-hidden">
                        — {flagged} need{flagged === 1 ? 's' : ''} a look
                      </span>
                    </>
                  ) : null}
                </button>
              )
            })}
          </div>
          <div
            className="invoice-run-panel"
            role="tabpanel"
            id={`invoice-run-panel-${activeTab.id}`}
            aria-labelledby={`invoice-run-tab-${activeTab.id}`}
          >
            {activeInvoices.length === 0 ? (
              <p className="invoice-run-empty">{activeTab.empty}</p>
            ) : (
              <ul className="invoice-run-list">
                {activeInvoices.map((invoice) => (
                  <InvoiceRow
                    key={invoice.id}
                    invoice={invoice}
                    clientName={clientName(invoice.clientId)}
                    cardEnabled={cardEnabled(invoice.clientId)}
                    recipients={recipientsFor(invoice.clientId)}
                    // A retainer invoice is not itself a thing you credit —
                    // offering to give it back on itself would be circular.
                    retainer={
                      invoice.kind === 'retainer'
                        ? null
                        : (retainers.find((held) => held.clientId === invoice.clientId) ?? null)
                    }
                    open={openId === invoice.id}
                    busy={busy}
                    onToggle={() => setOpenId(openId === invoice.id ? null : invoice.id)}
                    onPatch={(body) => patch(invoice.id, body)}
                    onInvoiceChanged={mergeInvoice}
                    onPrint={() => onPrint(invoice)}
                    onDirtyChange={setOpenDirty}
                  />
                ))}
              </ul>
            )}
          </div>
        </>
      ) : null}
    </div>
  )
}

function InvoiceRow({
  invoice,
  clientName,
  cardEnabled,
  recipients,
  retainer,
  open,
  busy,
  onToggle,
  onPatch,
  onPrint,
  onInvoiceChanged,
  onDirtyChange,
}: {
  invoice: PersistedInvoice
  clientName: string
  /** This client is offered a card option, so its invoices go out with two ways to pay. */
  cardEnabled: boolean
  /** Every address this invoice would be emailed to, resolved before any click. */
  recipients: ResolvedInvoiceRecipients
  /** A paid retainer of this client's that has not been given back yet, if any. */
  retainer: PersistedInvoice | null
  open: boolean
  busy: boolean
  onToggle: () => void
  onPatch: (body: Parameters<typeof updateInvoiceRequest>[1]) => Promise<PatchResult>
  onPrint: () => void
  /** Push a server-returned invoice back into the list (payment link marks it sent). */
  onInvoiceChanged: (invoice: PersistedInvoice) => void
  /** Tell the run whether this row's open editor has unsaved edits. */
  onDirtyChange: (dirty: boolean) => void
}) {
  const isVoid = invoice.status === 'void'
  const flagged = invoice.scopeFlags.length > 0
  const adjustment = invoice.lineItems.find((line) => line.kind === 'adjustment')

  const rowClass = [
    'invoice-run-row',
    flagged && !isVoid ? 'is-flagged' : '',
    isVoid ? 'is-void' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <li className={rowClass}>
      <button type="button" className="invoice-run-summary" onClick={onToggle}>
        <span className="invoice-run-main">
          {/* Name and number share a line: a 40-row tab scans far better when
              each invoice is two lines rather than three. */}
          <span className="invoice-run-title">
            <span className="invoice-run-client">{clientName}</span>
            <span className="invoice-run-number">{invoice.number ?? '—'}</span>
            {/* A retainer sits in the month it was issued in, beside that
                client's real invoice for the same month. Without this tag the
                two read as a duplicate. */}
            {invoice.kind === 'retainer' ? (
              <span className="invoice-run-kind-tag">Retainer</span>
            ) : null}
          </span>
          <span className="invoice-run-meta">
            {/* What the client will SEE — an ad hoc line she left off is on the
                draft but not on their invoice, and counting it here would make
                the row promise a line that never prints. */}
            {renderedInvoiceLines(invoice.lineItems).length} line
            {renderedInvoiceLines(invoice.lineItems).length === 1 ? '' : 's'} ·{' '}
            {formatDue(invoice.dueDate)}
            {adjustment
              ? ` · carries ${currency.format(adjustment.amount)} from last month`
              : ''}
            {/* So she can tell at a glance which invoices went out with two ways
                to pay, without opening each one. */}
            {cardEnabled && !isVoid ? ' · card enabled' : ''}
            {/* How many people this would email, before she opens anything. A
                client with two contact addresses and one with a single address
                used to look identical from here. */}
            {!isVoid && recipients.to.length > 0
              ? ` · ${recipientCountLabel(recipients.to.length)}`
              : ''}
          </span>
          {/* Nobody on file is a flag in its own right — it used to surface as a
              409 only after she pressed Send. */}
          {!isVoid && recipients.to.length === 0 ? (
            <span className="invoice-run-flags">
              <span className="invoice-run-flag">
                <AlertTriangle size={13} />
                No email on file
              </span>
            </span>
          ) : null}
          {flagged && !isVoid ? (
            <span className="invoice-run-flags">
              {invoice.scopeFlags.map((flag) => (
                <span className="invoice-run-flag" key={flag.kind + flag.label}>
                  <AlertTriangle size={13} />
                  {flag.detail || flag.label}
                </span>
              ))}
            </span>
          ) : null}
        </span>
        <span className="invoice-run-amount">
          <strong>{currency.format(invoice.total)}</strong>
          <span className={`invoice-status is-${invoice.status}`}>
            {INVOICE_STATUS_LABELS[invoice.status] ?? invoice.status}
          </span>
        </span>
      </button>
      {/* Keyed on updatedAt so a fresh server version REMOUNTS the editor
          rather than syncing props into state inside an effect. */}
      {open ? (
        <InvoiceEditor
          key={invoice.updatedAt ?? invoice.id}
          invoice={invoice}
          clientName={clientName}
          recipients={recipients}
          retainer={retainer}
          busy={busy}
          onPatch={onPatch}
          onPrint={onPrint}
          onInvoiceChanged={onInvoiceChanged}
          onDirtyChange={onDirtyChange}
        />
      ) : null}
    </li>
  )
}

/**
 * One editable line. Shared by the scoped block and the ad hoc block so the two
 * cannot drift into different-looking rows; the only difference is the ad hoc
 * one carries the three-way decision beneath its description.
 */
function InvoiceLineRow({
  line,
  index,
  onChange,
  onRemove,
  onModeChange,
}: {
  line: PersistedInvoiceLine
  /** Position in the SAVED array — every edit addresses a line by this. */
  index: number
  onChange: (index: number, patch: Partial<PersistedInvoiceLine>) => void
  onRemove: (index: number) => void
  /** Passed for ad hoc lines only; its absence is what makes a row scoped. */
  onModeChange?: (index: number, mode: AdhocMode) => void
}) {
  const mode = normalizeAdhocMode(line.adhocMode)
  return (
    <tr>
      <td>
        <input
          className="input"
          value={line.label}
          aria-label="Line description"
          onChange={(event) => onChange(index, { label: event.target.value })}
        />
        <input
          className="input invoice-run-detail"
          value={line.detail}
          aria-label="Line detail"
          placeholder="Detail (optional)"
          onChange={(event) => onChange(index, { detail: event.target.value })}
        />
        {onModeChange ? (
          <div className="invoice-run-adhoc-choice">
            <label>
              <span className="visually-hidden">What to do with this ad hoc work</span>
              <select
                className="compact-input"
                value={mode}
                onChange={(event) => onModeChange(index, event.target.value as AdhocMode)}
              >
                {ADHOC_CHOICES.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </label>
            {/* What she is giving away. The amount box reads $0.00 for both
                non-billed choices, so without this the only way to see the
                figure would be to switch back and look. */}
            {mode !== 'billed' ? (
              <span className="invoice-run-adhoc-reserve">
                would be {currency.format(Number(line.adhocAmount) || 0)}
              </span>
            ) : null}
          </div>
        ) : null}
      </td>
      <td className="invoice-run-amount-cell">
        {/* A line that is not being charged has no amount to type: it reads
            $0.00, which is what the client's invoice will say. What it WOULD
            have charged is shown beside the choice above.

            A retainer credit's amount is not hers to type either, for a
            different reason: the server sizes it from the retainer and the rest
            of the invoice, and rewrites whatever it is sent. An editable box
            there would accept a number and then silently replace it on save.
            The label stays hers. */}
        <input
          className="input"
          type="number"
          step="0.01"
          value={line.amount}
          aria-label="Amount"
          readOnly={
            (Boolean(onModeChange) && mode !== 'billed') || line.kind === 'retainer_credit'
          }
          onChange={(event) => onChange(index, { amount: Number(event.target.value) })}
        />
      </td>
      <td>
        <button
          type="button"
          className="icon-button"
          aria-label={`Remove ${line.label || 'line'}`}
          onClick={() => onRemove(index)}
        >
          <Trash2 size={15} />
        </button>
      </td>
    </tr>
  )
}

/**
 * The per-invoice editor. Lines are edited locally and saved in one go, so a
 * half-typed amount never round-trips as a charge; the server recomputes the
 * totals from whatever it is sent.
 */
function InvoiceEditor({
  invoice,
  clientName,
  recipients,
  retainer,
  busy,
  onPatch,
  onPrint,
  onInvoiceChanged,
  onDirtyChange,
}: {
  invoice: PersistedInvoice
  clientName: string
  /** Who this would go to, resolved by the same code the send endpoint uses. */
  recipients: ResolvedInvoiceRecipients
  /** A paid retainer of this client's with nothing spent against it yet. */
  retainer: PersistedInvoice | null
  busy: boolean
  onPatch: (body: Parameters<typeof updateInvoiceRequest>[1]) => Promise<PatchResult>
  onPrint: () => void
  /** Push a server-returned invoice back into the list — creating a payment
   *  link marks it sent, and the row must show that immediately. */
  onInvoiceChanged: (invoice: PersistedInvoice) => void
  /** Report unsaved edits upward so switching tabs can warn before this
   *  editor is unmounted out from under them. */
  onDirtyChange: (dirty: boolean) => void
}) {
  const [lines, setLines] = useState<PersistedInvoiceLine[]>(invoice.lineItems)
  const [blurb, setBlurb] = useState(invoice.blurb)
  const [saved, setSaved] = useState(false)
  const [paymentLink, setPaymentLink] = useState<string | null>(null)
  const [payBusy, setPayBusy] = useState(false)
  const [payError, setPayError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [sendBusy, setSendBusy] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  // Open only when there is a choice to make — see `startSend`.
  const [picking, setPicking] = useState(false)
  // Why the last save's retainer credit was refused. Kept here rather than on
  // the run, because it is about the lines on this screen and it arrives with
  // the credit line being removed from them.
  const [retainerError, setRetainerError] = useState<string | null>(null)

  // The last send that actually landed. Read off the invoice rather than local
  // state on purpose: a send remounts this editor, so anything transient is gone
  // by the time she looks, and this line has to survive that.
  const lastSent = [...(invoice.emailLog ?? [])].reverse().find((entry) => entry.ok) ?? null

  /**
   * Ask the server for a hosted Checkout URL. Deliberately does NOT open it —
   * the owner sends this to the client; opening it here would just show her a
   * payment page for her own client's invoice.
   */
  const createLink = async () => {
    setPayBusy(true)
    setPayError(null)
    setCopied(false)
    try {
      const result = await createInvoicePaymentLinkRequest(invoice.id)
      setPaymentLink(result.url)
      // The invoice is now 'sent' server-side; reflect that in the list.
      onInvoiceChanged(result.invoice)
    } catch (err) {
      // Stripe not configured, or Stripe declined — either way say which.
      setPayError(err instanceof Error ? err.message : 'Could not create a payment link.')
    } finally {
      setPayBusy(false)
    }
  }

  /**
   * Email the invoice to the client. The server picks the recipients, mints a
   * fresh pay link and writes the send log, so there is nothing to hand it but
   * the id — and on failure we keep the invoice we have, because pushing a new
   * one up would remount this editor and wipe the message before it was read.
   */
  const sendInvoice = async (to?: string[]) => {
    setSendBusy(true)
    setSendError(null)
    try {
      const result = await sendInvoiceRequest(invoice.id, to)
      setPicking(false)
      onInvoiceChanged(result.invoice)
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Could not send the invoice.')
    } finally {
      setSendBusy(false)
    }
  }

  /**
   * What the Send button does. One address on file goes straight out — a dialog
   * asking a question with one possible answer is friction, not a safeguard.
   * Two or more opens the picker with everyone ticked, so the default is still
   * "send to all of them" and unticking is the deliberate act.
   */
  const startSend = () => {
    if (recipients.to.length === 0) return
    if (recipients.to.length === 1) {
      void sendInvoice()
      return
    }
    setSendError(null)
    setPicking(true)
  }

  const dirty =
    JSON.stringify(lines) !== JSON.stringify(invoice.lineItems) || blurb !== invoice.blurb
  const localTotal = lines.reduce((sum, line) => sum + (Number(line.amount) || 0), 0)

  // Keep the run's copy of "this editor has unsaved edits" in step, and clear
  // it on the way out — an unmounted editor cannot have anything unsaved, and a
  // stale true would ask her to discard work that is no longer there.
  useEffect(() => {
    onDirtyChange(dirty)
    return () => onDirtyChange(false)
  }, [dirty, onDirtyChange])

  const setLine = (index: number, patch: Partial<PersistedInvoiceLine>) => {
    setLines((current) =>
      current.map((line, i) => {
        if (i !== index) return line
        const next = { ...line, ...patch }
        // Overtyping the amount of a BILLED ad hoc line moves its reserve too.
        // The server's sanitizer resolves a billed line from `amount` and
        // rewrites `adhocAmount` to match; without this the two sides would
        // disagree about which field is authoritative, and flipping the line to
        // courtesy and back would hand her the rate calculation instead of the
        // number she typed — silently, and permanently once saved.
        if (
          next.kind === 'adhoc' &&
          patch.amount !== undefined &&
          normalizeAdhocMode(next.adhocMode) === 'billed'
        ) {
          next.adhocAmount = Number(patch.amount) || 0
        }
        return next
      }),
    )
    setSaved(false)
  }

  /**
   * Change what happens to one piece of ad hoc work. The amount follows through
   * the SHARED rule the server's sanitizer uses, so the running total below
   * matches what the save will store — courtesy and omit both go to $0.00, and
   * flipping back to billed restores the figure the line was holding.
   */
  const setAdhocMode = (index: number, mode: AdhocMode) => {
    setLines((current) =>
      current.map((line, i) => (i === index ? adhocLineForMode(line, mode) : line)),
    )
    setSaved(false)
  }

  // Ad hoc work is shown apart from scoped work — the owner asked for the
  // separation to review it. Original indices travel with the lines, because
  // everything that edits a line addresses it by its position in the saved
  // array; splitting the display must not renumber the data.
  const numbered = lines.map((line, index) => ({ line, index }))
  const scopedRows = numbered.filter((row) => row.line.kind !== 'adhoc')
  const adhocRows = numbered.filter((row) => row.line.kind === 'adhoc')

  const removeLine = (index: number) => {
    setLines((current) => current.filter((_, i) => i !== index))
    setSaved(false)
  }

  /**
   * Whether to offer the retainer credit, and what it would be worth right now.
   *
   * THE APP OFFERS; SHE DECIDES. There is no "final invoice" flag for this to
   * key off — which invoice ends an engagement is her judgment, made once, on a
   * month that looks like any other from here. So the offer stands on every
   * invoice for a client whose retainer is still on account, and nothing applies
   * it on her behalf.
   *
   * The figure comes from the shared calculator, off the lines AS TYPED rather
   * than the saved ones, so the button promises what pressing it would actually
   * add. It is a preview either way: the server re-sizes the credit on save.
   *
   * Only offered while the invoice is a draft or reviewed, mirroring the rule
   * the server enforces: crediting an invoice that has already gone out would
   * leave the client's copy and the copy of record disagreeing about the amount.
   * A credit already applied is untouched by that — it travels with the invoice
   * through sent and paid like any other line.
   */
  const creditLine = lines.find((line) => line.kind === 'retainer_credit') ?? null
  const offeredCredit =
    retainer && !creditLine && RETAINER_CREDITABLE_STATUSES.has(invoice.status)
      ? retainerCreditLine({
          lines,
          retainerAmount: retainer.total,
          retainerId: retainer.id,
          retainerNumber: retainer.number,
        })
      : null

  const applyRetainerCredit = () => {
    if (!offeredCredit) return
    setLines((current) => [...current, offeredCredit as PersistedInvoiceLine])
    setRetainerError(null)
    setSaved(false)
  }

  const save = async () => {
    setRetainerError(null)
    const result = await onPatch({ lineItems: lines, blurb })
    if (result.ok) {
      setSaved(true)
      return
    }
    if (!result.retainer) return
    // The server would not honor the credit — most often because that retainer
    // was given back somewhere else while this tab sat open. Say so HERE, beside
    // the lines it is about, and take the credit back out: leaving it in would
    // mean every subsequent save failed the same way, and the note to the client
    // she typed alongside it would never land either.
    setRetainerError(result.message)
    setLines((current) => current.filter((line) => line.kind !== 'retainer_credit'))
  }

  return (
    <div className="invoice-run-editor">
      <table className="invoice-run-lines">
        <tbody>
          {scopedRows.map(({ line, index }) => (
            <InvoiceLineRow
              key={`${line.kind}-${index}`}
              line={line}
              index={index}
              onChange={setLine}
              onRemove={removeLine}
            />
          ))}
        </tbody>
        {/* Out-of-scope work, set off in its own block so it can be reviewed as
            a group. Each line carries its own decision: bill it, show it for
            nothing, or leave it off entirely. */}
        {adhocRows.length > 0 ? (
          <tbody className="invoice-run-adhoc">
            <tr className="invoice-run-adhoc-heading">
              <th colSpan={3} scope="colgroup">
                Ad hoc — outside scope
              </th>
            </tr>
            {adhocRows.map(({ line, index }) => (
              <InvoiceLineRow
                key={`${line.kind}-${index}`}
                line={line}
                index={index}
                onChange={setLine}
                onRemove={removeLine}
                onModeChange={setAdhocMode}
              />
            ))}
          </tbody>
        ) : null}
      </table>

      <div className="invoice-run-line-actions">
        <button
          type="button"
          className="secondary-action"
          onClick={() => {
            setLines((current) => [
              ...current,
              { kind: 'custom', label: '', detail: '', amount: 0 },
            ])
            setSaved(false)
          }}
        >
          <Plus size={15} />
          Add a line
        </button>
        {/* The credit, offered and never taken. Disabled rather than hidden when
            there is nothing left to credit, so a $0 invoice explains itself
            instead of quietly dropping the button she was looking for.

            The retainer is NAMED, not just priced. A client can hold more than
            one, and "Apply retainer credit ($500.00)" would not say which — this
            offers the oldest one, and she should be able to see that before
            pressing it rather than after saving. Picking between several is
            deferred; naming the one on offer is what makes that deferral safe. */}
        {offeredCredit ? (
          <button
            type="button"
            className="secondary-action"
            disabled={offeredCredit.amount === 0}
            title={
              offeredCredit.amount === 0
                ? 'There is nothing on this invoice left to credit'
                : `Give back the retainer ${retainer?.number ?? ''} held for this client`.trim()
            }
            onClick={applyRetainerCredit}
          >
            <Undo2 size={15} />
            {retainer?.number
              ? `Apply retainer ${retainer.number} credit (${currency.format(Math.abs(offeredCredit.amount))})`
              : `Apply retainer credit (${currency.format(Math.abs(offeredCredit.amount))})`}
          </button>
        ) : null}
      </div>
      {/* The whole retainer does not always fit. Saying so beside the button is
          what stops the remainder looking like a rounding error later. */}
      {offeredCredit && retainer && Math.abs(offeredCredit.amount) < retainer.total ? (
        <p className="invoice-run-retainer-note">
          {currency.format(retainer.total)} is held on account; this invoice can take{' '}
          {currency.format(Math.abs(offeredCredit.amount))} of it. Applying it here settles the
          retainer in full — the rest is yours to return outside the app.
        </p>
      ) : null}
      {/* The credit the last save would not honor. It sits with the lines rather
          than in the run's banner because it is about them, and because the
          credit line has just been taken back out — the message is the only
          record of why the table changed. */}
      {retainerError ? (
        <p className="invoice-run-error" role="alert">
          {retainerError}
        </p>
      ) : null}

      <label className="field invoice-run-blurb">
        <span>Note to the client</span>
        <textarea
          className="input"
          rows={2}
          value={blurb}
          placeholder="Carried over from last month once you've written one."
          onChange={(event) => {
            setBlurb(event.target.value)
            setSaved(false)
          }}
        />
      </label>

      {payError ? (
        <p className="invoice-run-error" role="alert">
          {payError}
        </p>
      ) : null}

      {sendError ? (
        <p className="invoice-run-error" role="alert">
          {sendError}
        </p>
      ) : null}

      {paymentLink ? (
        <div className="invoice-run-paylink">
          <span className="invoice-run-paylink-label">
            Send this to the client — they pay by bank transfer. It clears in about 4 business
            days, so the invoice will read “processing” until then.
          </span>
          <div className="invoice-run-paylink-row">
            <input className="input" readOnly value={paymentLink} aria-label="Payment link" />
            <button
              type="button"
              className="secondary-action"
              onClick={() => {
                void navigator.clipboard?.writeText(paymentLink)
                setCopied(true)
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      ) : null}

      {/* Who this would go to, BEFORE anything is sent. Named, not counted:
          "the contacts on file" was never something she could check. */}
      <div className="invoice-run-recipients">
        {recipients.to.length > 0 ? (
          <>
            <span className="invoice-run-recipients-label">
              Goes to {recipientCountLabel(recipients.to.length)}
            </span>
            <ul>
              {recipients.details.map((detail) => (
                <li key={detail.email}>{formatInvoiceRecipient(detail)}</li>
              ))}
            </ul>
          </>
        ) : (
          <p className="invoice-run-error" role="alert">
            {recipients.reason}
          </p>
        )}
      </div>

      {/* The durable receipt for a send — there is no toast, because the editor
          remounts on the server's new invoice and a toast would not survive it.
          Collapsed to the headline, because the addresses are the answer to a
          question that only comes up when someone says it never arrived. */}
      {lastSent ? (
        <details className="invoice-run-sent">
          <summary>
            Sent {formatSentOn(lastSent.at)} to {recipientCountLabel(lastSent.to.length)}
          </summary>
          <ul>
            {lastSent.to.map((email) => (
              <li key={email}>{email}</li>
            ))}
          </ul>
        </details>
      ) : null}

      {picking ? (
        <InvoiceRecipientPicker
          invoiceLabel={`${invoice.number ? `Invoice ${invoice.number}` : 'This invoice'} for ${clientName}`}
          details={recipients.details}
          busy={sendBusy}
          onSend={(to) => void sendInvoice(to)}
          onCancel={() => setPicking(false)}
        />
      ) : null}

      <div className="invoice-run-editor-footer">
        <span className="invoice-run-running-total">
          Total {currency.format(localTotal)}
          {dirty ? ' · unsaved' : ''}
        </span>
        <div className="invoice-run-editor-actions">
          {/* Prints through the SAME document the per-client view uses, so
              there is one printed format rather than two that drift. */}
          <button
            type="button"
            className="secondary-action"
            disabled={dirty}
            title={dirty ? 'Save your changes first' : 'Print this invoice'}
            onClick={onPrint}
          >
            <Printer size={15} />
            Print
          </button>
          <button type="button" className="secondary-action" disabled={busy || !dirty} onClick={save}>
            {saved && !dirty ? 'Saved' : 'Save changes'}
          </button>
          {invoice.status === 'draft' ? (
            <button
              type="button"
              className="primary-action"
              disabled={busy || dirty}
              title={dirty ? 'Save your changes first' : 'Mark this invoice reviewed'}
              onClick={() => void onPatch({ status: 'reviewed' })}
            >
              Mark reviewed
            </button>
          ) : null}
          {invoice.status === 'reviewed' ? (
            <button
              type="button"
              className="secondary-action"
              disabled={busy}
              onClick={() => void onPatch({ status: 'draft' })}
            >
              Back to draft
            </button>
          ) : null}
          {/* Payment link. Brittany is not the payer, so this does NOT open
              Checkout — it hands back a URL for her to send. Creating one marks
              the invoice sent, which is why it waits until after review. */}
          {invoice.status !== 'void' && invoice.total > 0 ? (
            <button
              type="button"
              className="secondary-action"
              disabled={busy || payBusy || dirty}
              title={
                dirty
                  ? 'Save your changes first'
                  : 'Create a bank-transfer payment link to send to this client'
              }
              onClick={() => void createLink()}
            >
              <LinkIcon size={15} />
              {payBusy ? 'Creating…' : paymentLink ? 'New payment link' : 'Payment link'}
            </button>
          ) : null}
          {/* Emails the invoice. The pay link inside it is minted fresh by the
              server on every send, so "Send again" is safe — the client never
              gets an expired Checkout URL. A draft is shown but not sendable:
              review comes before send, and the button that does it is right
              here. */}
          {invoice.status !== 'void' ? (
            <button
              type="button"
              className="secondary-action"
              disabled={
                busy ||
                sendBusy ||
                dirty ||
                invoice.status === 'draft' ||
                recipients.to.length === 0
              }
              title={
                dirty
                  ? 'Save your changes first'
                  : invoice.status === 'draft'
                    ? 'Mark this invoice reviewed first'
                    : // Say WHY rather than sit there dead: a 409 after the
                      // click was the old answer to this.
                      (recipients.reason ?? 'Email this invoice to the client')
              }
              onClick={startSend}
            >
              <Mail size={15} />
              {sendBusy ? 'Sending…' : lastSent ? 'Send again' : 'Send'}
            </button>
          ) : null}
          {invoice.status !== 'void' ? (
            <button
              type="button"
              className="secondary-action"
              disabled={busy}
              title="Void this invoice — it stays on the record and can be rebuilt by generating again"
              onClick={() => void onPatch({ status: 'void' })}
            >
              Void
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
