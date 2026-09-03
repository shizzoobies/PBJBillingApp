import { AlarmClock, Check, ChevronDown, ChevronRight } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAppContext } from '../AppContext'
import { ListSearch } from '../components/ListSearch'
import { inactiveClientIdSet } from '../lib/clientLifecycle'
import { WaitApprovalActions } from '../components/WaitApprovalActions'
import { WaitQuestionAction } from '../components/WaitQuestionAction'
import type { WaitingOn } from '../lib/types'
import {
  canAskWaitingOnQuestion,
  canMarkWaitingOnDone,
  canVerifyWaitingOn,
  isClientWait,
  legacyWaitBelongsOnTab,
  waitingOnStage,
  waitingsOnDelayedTab,
  type DelayedTab,
} from '../../lib/waiting-on-state.js'
import { DELAYED_TAB_KEYS, DELAYED_TAB_LABELS, resolveDelayedTab } from '../lib/delayedTabs'
import {
  clientName,
  employeeName,
  isChecklistItemDone,
  localDateOnly,
  shortDate,
  stepIsWaiting,
} from '../lib/utils'

/**
 * The "Delayed" page — every checklist step flagged as waiting, split by which
 * SIDE of the hand-off the viewer is on, then grouped by client.
 *
 * Her fourth round, verbatim (featreq-b05a2f3a):
 *
 *   "On the Delayed tab when person A sends it to Person B - Person B should be
 *    able to click done on their delayed tab and it goes away. On Person A's
 *    delayed tab it should show as delayed but no button to push done just so
 *    they can see and remember it (maybe a waiting on me and a I am waiting on
 *    others tabs within delayed to keep it organized). Then when person B
 *    pushes done it should show in Person A's delayed where they can push
 *    complete."
 *
 * So the page is two lists of the same waits seen from opposite ends:
 *
 *   Waiting on me         — you are the blocker. One plain Done per wait;
 *                           pressing it resolves the WAIT and the row leaves
 *                           this list. It does NOT tick the step off — that has
 *                           been the checkboxes' job since her first round.
 *   I'm waiting on others — you are the requester. Read-only while it is open
 *                           ("no button to push done just so they can see and
 *                           remember it"); Approve / Send back once the blocker
 *                           reports done.
 *
 * The one behavior that CHANGED here: this page's Done used to call the step's
 * own done-toggle, i.e. completing the checklist step from the Delayed list.
 * That is now the wait's Done. The step-toggle survives only for OLD free-text
 * waits, which have no wait record to resolve — see `row.legacy` below.
 *
 * Owners are filtered like everyone else rather than seeing the whole firm
 * (Alex's call), which is why the routing helpers are asked without the owner
 * override.
 */

type WaitingRow = {
  key: string
  checklistId: string
  checklistTitle: string
  /** The parent item's id. */
  itemId: string
  /** The parent item label. */
  itemLabel: string
  /** Sub-item id — present when the waiting flag is on a sub-item. */
  subItemId?: string
  /** Present when the waiting flag is on a sub-item rather than the item. */
  subLabel?: string
  /** The step's own free-text waiting note (the legacy field, not a wait's note). */
  note?: string
  /** The structured waits on this step that belong on the ACTIVE tab, for this viewer. */
  waits: WaitingOn[]
  /**
   * True for the old free-text flag (`waiting: true` with nobody attached).
   * These have no wait record, so the only thing that can retire them is the
   * step's own done-toggle — which is why they keep it and structured rows
   * don't.
   */
  legacy: boolean
  assigneeId?: string
  dueDate?: string
}

type ChecklistGroup = {
  checklistId: string
  title: string
  rows: WaitingRow[]
}

type ClientGroup = {
  clientId: string
  name: string
  count: number
  checklists: ChecklistGroup[]
}

export function DelayedPage() {
  const {
    data,
    toggleChecklistItem,
    toggleSubItem,
    waitingOnDone,
    waitingOnVerify,
    waitingOnSendBack,
    waitingOnQuestion,
    activeEmployeeId: meId,
  } = useAppContext()
  const { clients, employees, checklists } = data
  const today = localDateOnly()

  // A client wait names the CLIENT — its blockerId points at the client record,
  // so resolving it against employees would print "Unknown" for the one thing
  // the row is about.
  const blockerLabel = useCallback(
    (entry: WaitingOn, ownerClientId: string) =>
      isClientWait(entry)
        ? clientName(clients, ownerClientId)
        : employeeName(employees, entry.blockerId),
    [clients, employees],
  )

  // Every waiting mutation goes through here so a server refusal surfaces on
  // the page instead of dying as an unhandled rejection — a swallowed rejection
  // is exactly what "the button does nothing" looks like from the outside.
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /**
   * `rethrow` is for the callers that also need to know it failed — the question
   * composer keeps what was typed when the send is refused, which it can only do
   * if the rejection reaches it. The red line above shows the reason either way.
   */
  const run = async (work: () => Promise<void> | void, { rethrow = false } = {}) => {
    setError(null)
    setBusy(true)
    try {
      await work()
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? err.message
          : "Couldn't update this wait — please try again.",
      )
      if (rethrow) throw err
    } finally {
      setBusy(false)
    }
  }

  const buildGroups = useCallback(
    (tab: DelayedTab): ClientGroup[] => {
      const byClient = new Map<string, Map<string, ChecklistGroup>>()

      for (const checklist of checklists) {
        if (checklist.deletedAt) continue
        const rows: WaitingRow[] = []
        for (const item of checklist.items) {
          const assigneeId = item.assigneeId ?? null
          // A completed step isn't "delayed" any more.
          if (stepIsWaiting(item) && !isChecklistItemDone(item)) {
            const waits = waitingsOnDelayedTab(item, { userId: meId, assigneeId, tab })
            const legacy = legacyWaitBelongsOnTab(item, { userId: meId, assigneeId, tab })
            if (waits.length > 0 || legacy) {
              rows.push({
                key: `${checklist.id}:${item.id}`,
                checklistId: checklist.id,
                checklistTitle: checklist.title,
                itemId: item.id,
                itemLabel: item.label,
                note: item.waitingOn,
                waits,
                legacy,
                assigneeId: item.assigneeId,
                dueDate: item.dueDate,
              })
            }
          }
          for (const sub of item.subItems ?? []) {
            if (!stepIsWaiting(sub) || sub.done) continue
            const waits = waitingsOnDelayedTab(sub, { userId: meId, assigneeId, tab })
            const legacy = legacyWaitBelongsOnTab(sub, { userId: meId, assigneeId, tab })
            if (waits.length === 0 && !legacy) continue
            rows.push({
              key: `${checklist.id}:${item.id}:${sub.id}`,
              checklistId: checklist.id,
              checklistTitle: checklist.title,
              itemId: item.id,
              itemLabel: item.label,
              subItemId: sub.id,
              subLabel: sub.title,
              note: sub.waitingOn,
              waits,
              legacy,
              assigneeId: item.assigneeId,
              dueDate: sub.dueDate ?? item.dueDate,
            })
          }
        }
        if (rows.length === 0) continue

        const clientId = checklist.clientId
        const checklistMap = byClient.get(clientId) ?? new Map<string, ChecklistGroup>()
        checklistMap.set(checklist.id, {
          checklistId: checklist.id,
          title: checklist.title,
          rows,
        })
        byClient.set(clientId, checklistMap)
      }

      return [...byClient.entries()]
        .map(([clientId, checklistMap]) => {
          const checklistGroups = [...checklistMap.values()].sort((a, b) =>
            a.title.localeCompare(b.title),
          )
          const count = checklistGroups.reduce((total, group) => total + group.rows.length, 0)
          return {
            clientId,
            name: clientName(clients, clientId),
            count,
            checklists: checklistGroups,
          }
        })
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    },
    [checklists, clients, meId],
  )

  // Both tabs are built every render: the counts live in the tab labels, so the
  // quiet one has to be measured even while the busy one is showing.
  const groupsByTab = useMemo(
    () => ({
      blocking: buildGroups('blocking'),
      requesting: buildGroups('requesting'),
    }),
    [buildGroups],
  )

  const tabCounts = useMemo(
    () =>
      ({
        blocking: groupsByTab.blocking.reduce((total, group) => total + group.count, 0),
        requesting: groupsByTab.requesting.reduce((total, group) => total + group.count, 0),
      }) as Record<DelayedTab, number>,
    [groupsByTab],
  )

  const [searchParams, setSearchParams] = useSearchParams()
  const activeTab = resolveDelayedTab({
    tabParam: searchParams.get('tab'),
    counts: tabCounts,
  })
  const showTab = (tab: DelayedTab) => {
    // Written even for the tab that would have been the default — otherwise
    // clicking a quiet tab bounces straight back to the busy one.
    const next = new URLSearchParams(searchParams)
    next.set('tab', tab)
    setSearchParams(next, { replace: true })
  }

  const groups = groupsByTab[activeTab]

  const [query, setQuery] = useState('')

  const visibleGroups = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return groups
    // featreq-60f24838: a typed search must not surface a retired client's group.
    const inactiveIds = inactiveClientIdSet(clients)
    return groups
      .filter((group) => !inactiveIds.has(group.clientId))
      .map((group) => {
        const clientMatch = group.name.toLowerCase().includes(q)
        const filteredChecklists = group.checklists
          .map((checklist) => {
            const titleMatch = checklist.title.toLowerCase().includes(q)
            const filteredRows =
              clientMatch || titleMatch
                ? checklist.rows
                : checklist.rows.filter((row) => {
                    const noteMatch = (row.note ?? '').toLowerCase().includes(q)
                    const waitNoteMatch = row.waits.some((entry) =>
                      (entry.note ?? '').toLowerCase().includes(q),
                    )
                    return noteMatch || waitNoteMatch
                  })
            return { ...checklist, rows: filteredRows }
          })
          .filter((checklist) => checklist.rows.length > 0)
        return {
          ...group,
          checklists: filteredChecklists,
          count: filteredChecklists.reduce((sum, c) => sum + c.rows.length, 0),
        }
      })
      .filter((group) => group.checklists.length > 0)
  }, [groups, query, clients])

  const totalDelayed = tabCounts.blocking + tabCounts.requesting
  const tabTotal = tabCounts[activeTab]
  const visibleTotal = visibleGroups.reduce((total, group) => total + group.count, 0)

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const toggleClient = (clientId: string) => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(clientId)) next.delete(clientId)
      else next.add(clientId)
      return next
    })
  }

  // The ONLY remaining step-completing action on this page, and only for a
  // free-text wait with no record behind it. A structured wait is retired by
  // its own Done — the step stays for its owner to tick off.
  const markLegacyDone = (row: WaitingRow) => {
    if (row.subItemId) {
      void toggleSubItem(row.checklistId, row.itemId, row.subItemId)
    } else {
      void toggleChecklistItem(row.checklistId, row.itemId)
    }
  }

  return (
    <section className="content-grid" id="delayed">
      <header className="page-header">
        <div>
          <p className="section-kicker">Stuck work</p>
          <h1>Delayed</h1>
        </div>
        <div className="page-header-actions">
          <span className="delayed-total">
            <AlarmClock size={16} />
            {totalDelayed} waiting {totalDelayed === 1 ? 'item' : 'items'}
          </span>
          <ListSearch
            value={query}
            onChange={setQuery}
            placeholder="Search delayed…"
            resultCount={visibleTotal}
            total={tabTotal}
          />
        </div>
      </header>

      {/* The shared underline bar — the same one the approvals page and the
          month run use. Deliberately not a fourth copy of the styling. */}
      <div className="task-area-tabs" role="tablist" aria-label="Delayed sections">
        {DELAYED_TAB_KEYS.map((tab) => {
          const isActive = tab === activeTab
          const count = tabCounts[tab]
          const classes = ['task-area-tab', isActive ? 'is-active' : '', count === 0 ? 'is-empty' : '']
            .filter(Boolean)
            .join(' ')
          return (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={classes}
              onClick={() => showTab(tab)}
            >
              {DELAYED_TAB_LABELS[tab]}
              <span className="task-area-tab-count">{count}</span>
            </button>
          )
        })}
      </div>

      <p className="panel-intro">
        {activeTab === 'blocking'
          ? 'Steps a colleague is waiting on YOU for. Press Done when your part is finished — it leaves this list and goes back to whoever asked, who has the final say. Not sure what they need? Question sends them a message and leaves the item right here.'
          : "Steps YOU are waiting on. Nothing to press until they mark their part done — then you can approve it or send it back with a note."}
      </p>

      {error ? (
        <p className="waiting-editor-error" role="alert">
          {error}
        </p>
      ) : null}

      {groups.length === 0 ? (
        <div className="panel">
          <p className="empty-state">
            {activeTab === 'blocking'
              ? 'Nobody is waiting on you right now.'
              : 'You are not waiting on anybody right now. Flag a step with the ⏳ on a checklist item or sub-item to add one.'}
          </p>
        </div>
      ) : visibleGroups.length === 0 ? (
        <div className="panel">
          <p className="empty-state">No delayed items match "{query.trim()}".</p>
        </div>
      ) : (
        <div className="delayed-groups">
          {visibleGroups.map((group) => {
            const isCollapsed = collapsed.has(group.clientId)
            return (
              <div className="panel delayed-client-group" key={group.clientId}>
                <button
                  type="button"
                  className="delayed-client-header"
                  onClick={() => toggleClient(group.clientId)}
                  aria-expanded={!isCollapsed}
                >
                  {isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                  <strong>{group.name}</strong>
                  <span className="delayed-client-count">
                    {group.count} {group.count === 1 ? 'item' : 'items'}
                  </span>
                </button>
                {!isCollapsed ? (
                  <div className="delayed-client-body">
                    {group.checklists.map((checklist) => (
                      <div className="delayed-checklist" key={checklist.checklistId}>
                        <Link
                          className="delayed-checklist-title"
                          to={`/checklists?focus=${encodeURIComponent(checklist.checklistId)}`}
                        >
                          {checklist.title}
                        </Link>
                        <ul className="delayed-row-list">
                          {checklist.rows.map((row) => {
                            const overdue = row.dueDate ? row.dueDate < today : false
                            return (
                              <li className="delayed-row" key={row.key}>
                                <div className="delayed-row-main">
                                  <span className="delayed-row-step">
                                    {row.itemLabel}
                                    {row.subLabel ? (
                                      <span className="delayed-row-sub"> › {row.subLabel}</span>
                                    ) : null}
                                  </span>
                                  {row.legacy ? (
                                    <span className="delayed-row-note">
                                      {row.note ? row.note : 'Waiting (no note yet)'}
                                    </span>
                                  ) : null}
                                  {row.waits.length > 0 ? (
                                    <ul className="delayed-wait-list">
                                      {row.waits.map((entry) => (
                                        <DelayedWaitRow
                                          key={entry.id}
                                          entry={entry}
                                          tab={activeTab}
                                          busy={busy}
                                          blockerName={blockerLabel(entry, group.clientId)}
                                          assigneeId={row.assigneeId ?? null}
                                          meId={meId}
                                          employees={employees.map((e) => ({
                                            id: e.id,
                                            name: e.name,
                                          }))}
                                          onDone={() =>
                                            void run(() => waitingOnDone(row.checklistId, entry.id))
                                          }
                                          onApprove={() =>
                                            void run(() =>
                                              waitingOnVerify(row.checklistId, entry.id),
                                            )
                                          }
                                          onSendBack={(note) =>
                                            void run(() =>
                                              waitingOnSendBack(row.checklistId, entry.id, note),
                                            )
                                          }
                                          onAsk={(note) =>
                                            run(
                                              () =>
                                                waitingOnQuestion(
                                                  row.checklistId,
                                                  entry.id,
                                                  note,
                                                ),
                                              { rethrow: true },
                                            )
                                          }
                                        />
                                      ))}
                                    </ul>
                                  ) : null}
                                </div>
                                <div className="delayed-row-meta">
                                  {row.assigneeId ? (
                                    <span className="task-chip">
                                      {employeeName(employees, row.assigneeId)}
                                    </span>
                                  ) : null}
                                  {row.dueDate ? (
                                    <span className={overdue ? 'task-chip overdue' : 'task-chip'}>
                                      Due {shortDate.format(new Date(`${row.dueDate}T12:00:00`))}
                                    </span>
                                  ) : null}
                                  {row.legacy && row.waits.length === 0 ? (
                                    <button
                                      type="button"
                                      className="delayed-row-done"
                                      onClick={() => markLegacyDone(row)}
                                      title="Mark this step done (same as checking it off on the Checklists page)"
                                    >
                                      <Check size={14} /> Done
                                    </button>
                                  ) : null}
                                </div>
                              </li>
                            )
                          })}
                        </ul>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

/**
 * One structured wait inside a Delayed row, with whatever the viewer is allowed
 * to press on this tab — which is the whole point of the split:
 *
 *   blocking / waiting    → Done (yours to finish) and Question (ask first).
 *                           Her annotated screenshot has both, and only Done
 *                           finishes anything — a question leaves the row here.
 *   requesting / waiting  → nothing. "no button to push done just so they can
 *                           see and remember it". The one exception is a CLIENT
 *                           wait, which has no second party: whoever chased the
 *                           client closes it themselves, as it has since round 1.
 *   requesting / resolved → Approve or Send back, and nothing else.
 */
function DelayedWaitRow({
  entry,
  tab,
  busy,
  blockerName,
  assigneeId,
  meId,
  employees,
  onDone,
  onApprove,
  onSendBack,
  onAsk,
}: {
  entry: WaitingOn
  tab: DelayedTab
  busy: boolean
  blockerName: string
  assigneeId: string | null
  meId: string
  employees: Array<{ id: string; name: string }>
  onDone: () => void
  onApprove: () => void
  onSendBack: (note: string) => void
  /** The question composer's Send — appends a message, finishes nothing. */
  onAsk: (note: string) => void
}) {
  const stage = waitingOnStage(entry)
  // The owner override is deliberately off: this page shows everyone their own
  // part in the hand-off, owners included.
  const permission = { entry, userId: meId, isOwner: false, assigneeId }
  const lastSendBack = entry.sendBacks?.[entry.sendBacks.length - 1]
  const lastQuestion = entry.questions?.[entry.questions.length - 1]
  const nameOf = (id: string) => employees.find((e) => e.id === id)?.name ?? 'A team member'

  return (
    <li className={`delayed-wait is-${stage}`}>
      <span className="delayed-row-note">
        {`Waiting on ${blockerName}`}
        {entry.note ? ` — ${entry.note}` : ''}
      </span>
      {/* Why it came back. Shown on both tabs: B needs to know what to redo, and
          A needs to remember what they asked for. */}
      {lastSendBack ? (
        <span className="delayed-wait-sendback">
          {`Sent back by ${nameOf(lastSendBack.by)}${
            lastSendBack.note ? ` — ${lastSendBack.note}` : ''
          }`}
        </span>
      ) : null}
      {/* The other direction of the same conversation: what the person being
          waited on still needs to know. Shown on both tabs — A has to read the
          question, and B has to remember they asked it. */}
      {lastQuestion ? (
        <span className="delayed-wait-question">
          {`Question from ${nameOf(lastQuestion.by)}${
            lastQuestion.note ? ` — ${lastQuestion.note}` : ''
          }`}
        </span>
      ) : null}
      {stage === 'resolved' ? (
        <span className="waiting-blocker-pending">
          {entry.resolvedBy ? `${nameOf(entry.resolvedBy)} says done` : 'reported done'}
        </span>
      ) : null}
      {tab === 'blocking' && canMarkWaitingOnDone(permission) ? (
        <button
          type="button"
          className="delayed-row-done"
          disabled={busy}
          title="My part is finished — hands it back to whoever asked, and it leaves this list. It does not tick the step off."
          onClick={onDone}
        >
          <Check size={14} /> Done
        </button>
      ) : null}
      {/* Beside Done, never instead of it: asking appends a message and leaves
          the row exactly here. */}
      {tab === 'blocking' && canAskWaitingOnQuestion(permission) ? (
        <WaitQuestionAction
          busy={busy}
          requesterName={entry.requestedBy ? nameOf(entry.requestedBy) : 'whoever asked'}
          onAsk={onAsk}
        />
      ) : null}
      {tab === 'requesting' && stage === 'resolved' && canVerifyWaitingOn(permission) ? (
        <WaitApprovalActions
          busy={busy}
          blockerName={blockerName}
          onApprove={onApprove}
          onSendBack={onSendBack}
        />
      ) : null}
      {tab === 'requesting' && stage === 'waiting' && canMarkWaitingOnDone(permission) ? (
        <button
          type="button"
          className="delayed-row-done"
          disabled={busy}
          title="The client came back — close this out. Clients have no login, so there is nobody to hand it back to."
          onClick={onDone}
        >
          <Check size={14} /> Heard back
        </button>
      ) : null}
    </li>
  )
}
