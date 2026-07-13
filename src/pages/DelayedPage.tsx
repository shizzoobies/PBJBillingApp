import { AlarmClock, Check, ChevronDown, ChevronRight } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAppContext } from '../AppContext'
import { ListSearch } from '../components/ListSearch'
import {
  clientName,
  employeeName,
  isChecklistItemDone,
  localDateOnly,
  shortDate,
  stepIsWaiting,
} from '../lib/utils'

/**
 * Owner-only "Delayed" page. Surfaces every checklist step that's been flagged
 * "waiting on" (the per-item / per-sub-item toggle), grouped by client so the
 * owner can see — at a glance — which clients are stuck and why.
 */

type WaitingRow = {
  key: string
  checklistId: string
  checklistTitle: string
  /** The parent item's id (target of the Done toggle for an item row). */
  itemId: string
  /** The parent item label. */
  itemLabel: string
  /** Sub-item id — present when the waiting flag is on a sub-item. */
  subItemId?: string
  /** Present when the waiting flag is on a sub-item rather than the item. */
  subLabel?: string
  note?: string
  /** Names of the internal people this step is structurally waiting on. */
  blockerNames?: string[]
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
  const { data, toggleChecklistItem, toggleSubItem } = useAppContext()
  const { clients, employees, checklists } = data
  const today = localDateOnly()

  // Mark a delayed step done from here — the SAME toggle used on the dashboard /
  // Checklists page. Once done it no longer counts as an open waiting step, so
  // it drops off this list on the next render.
  const markDone = (row: WaitingRow) => {
    if (row.subItemId) {
      void toggleSubItem(row.checklistId, row.itemId, row.subItemId)
    } else {
      void toggleChecklistItem(row.checklistId, row.itemId)
    }
  }

  const groups = useMemo<ClientGroup[]>(() => {
    const byClient = new Map<string, Map<string, ChecklistGroup>>()

    for (const checklist of checklists) {
      if (checklist.deletedAt) continue
      const rows: WaitingRow[] = []
      for (const item of checklist.items) {
        // A completed step isn't "delayed" any more — hide it so marking a step
        // done here makes it drop off the list.
        if (stepIsWaiting(item) && !isChecklistItemDone(item)) {
          rows.push({
            key: `${checklist.id}:${item.id}`,
            checklistId: checklist.id,
            checklistTitle: checklist.title,
            itemId: item.id,
            itemLabel: item.label,
            note: item.waitingOn,
            blockerNames: (item.waitingOns ?? []).map((w) => employeeName(employees, w.blockerId)),
            assigneeId: item.assigneeId,
            dueDate: item.dueDate,
          })
        }
        for (const sub of item.subItems ?? []) {
          if (stepIsWaiting(sub) && !sub.done) {
            rows.push({
              key: `${checklist.id}:${item.id}:${sub.id}`,
              checklistId: checklist.id,
              checklistTitle: checklist.title,
              itemId: item.id,
              itemLabel: item.label,
              subItemId: sub.id,
              subLabel: sub.title,
              note: sub.waitingOn,
              blockerNames: (sub.waitingOns ?? []).map((w) =>
                employeeName(employees, w.blockerId),
              ),
              assigneeId: item.assigneeId,
              dueDate: sub.dueDate ?? item.dueDate,
            })
          }
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
  }, [checklists, clients, employees])

  const [query, setQuery] = useState('')

  const visibleGroups = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return groups
    return groups
      .map((group) => {
        const clientMatch = group.name.toLowerCase().includes(q)
        const filteredChecklists = group.checklists
          .map((checklist) => {
            const titleMatch = checklist.title.toLowerCase().includes(q)
            const filteredRows = clientMatch || titleMatch
              ? checklist.rows
              : checklist.rows.filter((row) => {
                  const noteMatch = (row.note ?? '').toLowerCase().includes(q)
                  return noteMatch
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
  }, [groups, query])

  const totalDelayed = groups.reduce((total, group) => total + group.count, 0)
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
            total={totalDelayed}
          />
        </div>
      </header>

      <p className="panel-intro">
        Every checklist step flagged <strong>“waiting on”</strong> — grouped by client — so you can
        see what’s blocked and why. Clear a flag on the Checklists tab (or under the client) once
        it’s unblocked.
      </p>

      {groups.length === 0 ? (
        <div className="panel">
          <p className="empty-state">
            Nothing is flagged as waiting right now. Toggle the ⏳ on a checklist item or sub-item
            to flag it as delayed.
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
                                  <span className="delayed-row-note">
                                    {row.blockerNames && row.blockerNames.length > 0
                                      ? `Waiting on ${row.blockerNames.join(', ')}${
                                          row.note ? ` — ${row.note}` : ''
                                        }`
                                      : row.note
                                        ? row.note
                                        : 'Waiting (no note yet)'}
                                  </span>
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
                                  <button
                                    type="button"
                                    className="delayed-row-done"
                                    onClick={() => markDone(row)}
                                    title="Mark this step done (same as checking it off on the Checklists page)"
                                  >
                                    <Check size={14} /> Done
                                  </button>
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
