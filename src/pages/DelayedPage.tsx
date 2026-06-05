import { AlarmClock, ChevronDown, ChevronRight } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAppContext } from '../AppContext'
import { clientName, employeeName, shortDate } from '../lib/utils'

/**
 * Owner-only "Delayed" page. Surfaces every checklist step that's been flagged
 * "waiting on" (the per-item / per-sub-item toggle), grouped by client so the
 * owner can see — at a glance — which clients are stuck and why.
 */

type WaitingRow = {
  key: string
  checklistId: string
  checklistTitle: string
  /** The parent item label. */
  itemLabel: string
  /** Present when the waiting flag is on a sub-item rather than the item. */
  subLabel?: string
  note?: string
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
  const { data } = useAppContext()
  const { clients, employees, checklists } = data
  const today = new Date().toISOString().slice(0, 10)

  const groups = useMemo<ClientGroup[]>(() => {
    const byClient = new Map<string, Map<string, ChecklistGroup>>()

    for (const checklist of checklists) {
      if (checklist.deletedAt) continue
      const rows: WaitingRow[] = []
      for (const item of checklist.items) {
        if (item.waiting) {
          rows.push({
            key: `${checklist.id}:${item.id}`,
            checklistId: checklist.id,
            checklistTitle: checklist.title,
            itemLabel: item.label,
            note: item.waitingOn,
            assigneeId: item.assigneeId,
            dueDate: item.dueDate,
          })
        }
        for (const sub of item.subItems ?? []) {
          if (sub.waiting) {
            rows.push({
              key: `${checklist.id}:${item.id}:${sub.id}`,
              checklistId: checklist.id,
              checklistTitle: checklist.title,
              itemLabel: item.label,
              subLabel: sub.title,
              note: sub.waitingOn,
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
  }, [checklists, clients])

  const totalDelayed = groups.reduce((total, group) => total + group.count, 0)

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
      ) : (
        <div className="delayed-groups">
          {groups.map((group) => {
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
                                    {row.note ? row.note : 'Waiting (no note yet)'}
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
