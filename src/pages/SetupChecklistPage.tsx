import { useEffect, useMemo, useState } from 'react'
import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  EyeOff,
  ListChecks,
  RotateCcw,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { useAppContext } from '../AppContext'
import { ChipMultiSelect } from '../components/ChipMultiSelect'
import {
  computeIncompleteChecklists,
  computeSetupIssues,
  groupSetupIssues,
  type SetupIssue,
  type SetupSeverity,
} from '../lib/completeness'
import {
  dismissSetupIssueRequest,
  fetchDismissedSetupIssues,
  restoreSetupIssueRequest,
} from '../lib/api'
import { isChecklistItemDone } from '../lib/utils'

const SEVERITY_LABEL: Record<SetupSeverity, string> = {
  high: 'Needs attention',
  medium: 'Recommended',
  low: 'Nice to have',
}

/**
 * "To 100%" — a live, owner-only checklist of everything still missing for the
 * workspace to be fully set up. Pure derived view (see lib/completeness.ts).
 * Each item can be fixed in a focused quick-fix modal (or deep-links when there
 * isn't a single field), or IGNORED (persisted per owner, restorable). Category
 * sections collapse.
 */
export function SetupChecklistPage() {
  const { data, ownerMode } = useAppContext()

  // Hooks run unconditionally (before the ownerMode early return).
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  // Everything is COLLAPSED by default; these Sets hold what the owner has
  // opened. (Empty = all collapsed.)
  const [expandedCats, setExpandedCats] = useState<Set<string>>(new Set())
  const [expandedClients, setExpandedClients] = useState<Set<string>>(new Set())
  const [checklistOpen, setChecklistOpen] = useState(false)
  const [showIgnored, setShowIgnored] = useState(false)
  const [fixTarget, setFixTarget] = useState<SetupIssue | null>(null)
  // Id of the checklist shown in the quick-preview modal (null = closed).
  const [previewChecklistId, setPreviewChecklistId] = useState<string | null>(null)

  useEffect(() => {
    if (!ownerMode) return
    let alive = true
    fetchDismissedSetupIssues()
      .then((ids) => {
        if (alive) setDismissed(new Set(ids))
      })
      .catch(() => {
        /* non-fatal: just show everything if the ignore list can't load */
      })
    return () => {
      alive = false
    }
  }, [ownerMode])

  const allIssues = useMemo(
    () =>
      computeSetupIssues({
        clients: data.clients,
        contacts: data.contacts,
        plans: data.plans,
        employees: data.employees,
        checklistTemplates: data.checklistTemplates,
      }),
    [data.clients, data.contacts, data.plans, data.employees, data.checklistTemplates],
  )

  // The operational side of "to 100%": actual unchecked checklist steps, named
  // and grouped by client (distinct from the setup-config issues above).
  const incompleteChecklists = useMemo(
    () => computeIncompleteChecklists(data.checklists, data.clients),
    [data.checklists, data.clients],
  )
  const totalIncompleteSteps = incompleteChecklists.reduce(
    (sum, group) => sum + group.totalIncomplete,
    0,
  )

  if (!ownerMode) {
    return null
  }

  const activeIssues = allIssues.filter((issue) => !dismissed.has(issue.id))
  const ignoredIssues = allIssues.filter((issue) => dismissed.has(issue.id))
  const groups = groupSetupIssues(activeIssues)
  const highCount = activeIssues.filter((issue) => issue.severity === 'high').length

  // Optimistic ignore/restore, reverting on a failed request.
  const ignore = async (id: string) => {
    setDismissed((prev) => new Set(prev).add(id))
    try {
      await dismissSetupIssueRequest(id)
    } catch {
      setDismissed((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }
  const restore = async (id: string) => {
    setDismissed((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    try {
      await restoreSetupIssueRequest(id)
    } catch {
      setDismissed((prev) => new Set(prev).add(id))
    }
  }
  const toggleCategory = (category: string) =>
    setExpandedCats((prev) => {
      const next = new Set(prev)
      if (next.has(category)) next.delete(category)
      else next.add(category)
      return next
    })
  const toggleClient = (clientId: string) =>
    setExpandedClients((prev) => {
      const next = new Set(prev)
      if (next.has(clientId)) next.delete(clientId)
      else next.add(clientId)
      return next
    })
  // Summary chips at the top jump to (and open) their section.
  const scrollTo = (id: string) =>
    requestAnimationFrame(() =>
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    )
  const jumpToCategory = (category: string) => {
    setExpandedCats((prev) => new Set(prev).add(category))
    scrollTo(`setup-cat-${category}`)
  }
  const jumpToChecklists = () => {
    setChecklistOpen(true)
    scrollTo('setup-checklist-work')
  }

  return (
    <section className="content-grid" id="setup-checklist">
      <div className="panel">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Getting to 100%</p>
            <h2>Setup checklist</h2>
          </div>
        </div>
        {activeIssues.length === 0 ? (
          <div className="setup-all-clear">
            <CheckCircle2 size={28} />
            <div>
              <strong>You&apos;re all set — 100%.</strong>
              <p className="muted-text" style={{ margin: 0 }}>
                Every client, team member, plan, and contact is fully configured
                {ignoredIssues.length > 0 ? ` (${ignoredIssues.length} ignored)` : ''}.
              </p>
            </div>
          </div>
        ) : (
          <p className="muted-text" style={{ marginTop: 0 }}>
            {activeIssues.length} item{activeIssues.length === 1 ? '' : 's'} left to set up
            {highCount > 0 ? ` · ${highCount} need${highCount === 1 ? 's' : ''} attention` : ''}.
            This list updates itself as you fill things in.
          </p>
        )}
        {groups.length > 0 || totalIncompleteSteps > 0 ? (
          <div className="setup-summary">
            {groups.map((group) => (
              <button
                key={group.category}
                type="button"
                className="setup-summary-chip"
                onClick={() => jumpToCategory(group.category)}
              >
                <span>{group.category}</span>
                <span className="setup-summary-num">{group.issues.length}</span>
              </button>
            ))}
            {totalIncompleteSteps > 0 ? (
              <button
                type="button"
                className="setup-summary-chip setup-summary-chip--checklist"
                onClick={jumpToChecklists}
              >
                <span>Checklist items open</span>
                <span className="setup-summary-num">{totalIncompleteSteps}</span>
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {groups.map((group) => {
        const isCollapsed = !expandedCats.has(group.category)
        return (
          <div className="panel" key={group.category} id={`setup-cat-${group.category}`}>
            <button
              type="button"
              className="setup-cat-header"
              aria-expanded={!isCollapsed}
              onClick={() => toggleCategory(group.category)}
            >
              {isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
              <span className="section-kicker">{group.category}</span>
              <span className="setup-cat-count">
                {group.issues.length} item{group.issues.length === 1 ? '' : 's'}
              </span>
            </button>
            {isCollapsed ? null : (
              <ul className="setup-issue-list">
                {group.issues.map((issue) => (
                  <li key={issue.id} className={`setup-issue setup-issue--${issue.severity}`}>
                    <CircleAlert size={16} className="setup-issue-icon" />
                    <div className="setup-issue-body">
                      <strong>{issue.title}</strong>
                      {issue.detail ? <span className="muted-text">{issue.detail}</span> : null}
                      {issue.items && issue.items.length > 0 ? (
                        <ul className="setup-issue-items">
                          {issue.items.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      ) : null}
                      <span className="setup-issue-sev">{SEVERITY_LABEL[issue.severity]}</span>
                    </div>
                    <div className="setup-issue-actions">
                      {issue.fix ? (
                        <button
                          type="button"
                          className="setup-issue-fix"
                          onClick={() => setFixTarget(issue)}
                        >
                          Fix
                        </button>
                      ) : (
                        <Link to={issue.to} className="setup-issue-fix">
                          Fix <ArrowRight size={14} />
                        </Link>
                      )}
                      <button
                        type="button"
                        className="setup-issue-ignore"
                        title="Ignore — you know about this and don't need to fix it"
                        onClick={() => void ignore(issue.id)}
                      >
                        <EyeOff size={13} /> Ignore
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )
      })}

      <div className="panel" id="setup-checklist-work">
        <button
          type="button"
          className="setup-cat-header"
          aria-expanded={checklistOpen}
          onClick={() => setChecklistOpen((value) => !value)}
        >
          {checklistOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          <span className="section-kicker">Checklist items to finish</span>
          <span className="setup-cat-count">
            {totalIncompleteSteps > 0
              ? `${totalIncompleteSteps} step${totalIncompleteSteps === 1 ? '' : 's'}`
              : 'All done'}
          </span>
        </button>
        {!checklistOpen ? null : incompleteChecklists.length === 0 ? (
          <div className="setup-all-clear">
            <CheckCircle2 size={28} />
            <div>
              <strong>Every checklist step is done.</strong>
              <p className="muted-text" style={{ margin: 0 }}>
                No active checklist has any unchecked steps right now.
              </p>
            </div>
          </div>
        ) : (
          <>
            <p className="muted-text" style={{ marginTop: 8 }}>
              Every unchecked step across your active checklists, by client. Completed steps
              aren&apos;t shown. Open a checklist to check things off without leaving this page.
            </p>
            {incompleteChecklists.map((group) => {
              const isCollapsed = !expandedClients.has(group.clientId)
              return (
                <div className="setup-checklist-client" key={group.clientId}>
                  <button
                    type="button"
                    className="setup-cat-header"
                    aria-expanded={!isCollapsed}
                    onClick={() => toggleClient(group.clientId)}
                  >
                    {isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                    <span className="section-kicker">{group.clientName}</span>
                    <span className="setup-cat-count">
                      {group.totalIncomplete} step{group.totalIncomplete === 1 ? '' : 's'}
                    </span>
                  </button>
                  {isCollapsed
                    ? null
                    : group.checklists.map((checklist) => (
                        <div className="setup-checklist" key={checklist.checklistId}>
                          <div className="setup-checklist-head">
                            <ListChecks size={15} className="setup-issue-icon" />
                            <button
                              type="button"
                              className="setup-checklist-title"
                              onClick={() => setPreviewChecklistId(checklist.checklistId)}
                              title="Open a quick view of this checklist"
                            >
                              {checklist.title}
                            </button>
                            <span className="setup-checklist-meta">
                              {checklist.incompleteCount}/{checklist.totalCount} left
                              {checklist.dueDate ? ` · due ${checklist.dueDate}` : ''}
                            </span>
                          </div>
                          <ul className="setup-issue-items">
                            {checklist.incompleteItems.map((label, index) => (
                              <li key={`${checklist.checklistId}:${index}`}>{label}</li>
                            ))}
                          </ul>
                        </div>
                      ))}
                </div>
              )
            })}
          </>
        )}
      </div>

      {ignoredIssues.length > 0 ? (
        <div className="panel">
          <button
            type="button"
            className="setup-cat-header"
            aria-expanded={showIgnored}
            onClick={() => setShowIgnored((value) => !value)}
          >
            {showIgnored ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            <span className="section-kicker">Ignored</span>
            <span className="setup-cat-count">
              {ignoredIssues.length} item{ignoredIssues.length === 1 ? '' : 's'}
            </span>
          </button>
          {showIgnored ? (
            <ul className="setup-issue-list">
              {ignoredIssues.map((issue) => (
                <li key={issue.id} className="setup-issue setup-issue--ignored">
                  <div className="setup-issue-body">
                    <strong>{issue.title}</strong>
                  </div>
                  <button
                    type="button"
                    className="setup-issue-ignore"
                    onClick={() => void restore(issue.id)}
                  >
                    <RotateCcw size={13} /> Restore
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {fixTarget && fixTarget.fix ? (
        <QuickFixModal issue={fixTarget} onClose={() => setFixTarget(null)} />
      ) : null}

      {previewChecklistId ? (
        <ChecklistPreviewModal
          checklistId={previewChecklistId}
          onClose={() => setPreviewChecklistId(null)}
        />
      ) : null}
    </section>
  )
}

/**
 * Quick, in-place view of one checklist: its steps with checkboxes you can tick
 * off (top-level items and one level of sub-steps, via the same context
 * handlers the full page uses — so the To-100% counts update live), plus a
 * button to open the full checklist page only if the owner wants the complete
 * editor (due dates, waiting-on, notes, deeper nesting).
 */
function ChecklistPreviewModal({
  checklistId,
  onClose,
}: {
  checklistId: string
  onClose: () => void
}) {
  const { data, toggleChecklistItem, toggleSubItem } = useAppContext()
  const checklist = data.checklists.find((c) => c.id === checklistId)
  const client = checklist ? data.clients.find((c) => c.id === checklist.clientId) : undefined

  if (!checklist) {
    return null
  }

  const items = checklist.items ?? []
  const doneCount = items.filter((item) => isChecklistItemDone(item)).length

  return (
    <div className="modal-overlay" role="presentation" onClick={onClose}>
      <div
        className="modal-panel setup-preview-modal"
        role="dialog"
        aria-modal="true"
        aria-label={checklist.title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="setup-preview-head">
          <div>
            <h2 className="modal-title" style={{ marginBottom: 2 }}>
              {checklist.title}
            </h2>
            <p className="muted-text" style={{ margin: 0 }}>
              {client?.name ?? 'Client'} · {doneCount}/{items.length} done
              {checklist.dueDate ? ` · due ${checklist.dueDate}` : ''}
            </p>
          </div>
        </div>

        <ul className="setup-preview-items">
          {items.map((item) => {
            const subItems = item.subItems ?? []
            const hasSubs = subItems.length > 0
            return (
              <li key={item.id} className="setup-preview-item">
                <label className={`task-row${item.done ? ' done' : ''}`}>
                  <input
                    type="checkbox"
                    checked={item.done}
                    title={hasSubs ? 'Checking this checks every sub-step' : undefined}
                    onChange={() => void toggleChecklistItem(checklist.id, item.id)}
                  />
                  <span className="task-row-body">
                    <span className="task-row-title">
                      {item.label}
                      {hasSubs ? (
                        <span className="sub-item-count">
                          {subItems.filter((sub) => isChecklistItemDone(sub)).length}/
                          {subItems.length}
                        </span>
                      ) : null}
                    </span>
                  </span>
                </label>
                {hasSubs ? (
                  <ul className="setup-preview-subs">
                    {subItems.map((sub) => (
                      <li key={sub.id}>
                        <label className={`sub-item-row${sub.done ? ' done' : ''}`}>
                          <input
                            type="checkbox"
                            checked={sub.done}
                            onChange={() => void toggleSubItem(checklist.id, item.id, sub.id)}
                          />
                          <span>{sub.title}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            )
          })}
        </ul>

        <div className="button-row">
          <Link
            to={`/checklists?focus=${checklist.id}`}
            className="primary-action"
            onClick={onClose}
          >
            Open full checklist <ArrowRight size={14} />
          </Link>
          <button type="button" className="secondary-action" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Focused quick-fix modal: renders only the missing field(s) for one setup
 * issue and saves via the same context handlers the full pages use — so the
 * item disappears from the list the moment it's filled in.
 */
function QuickFixModal({ issue, onClose }: { issue: SetupIssue; onClose: () => void }) {
  const { data, updateClient, applyTemplateToClient } = useAppContext()
  const fix = issue.fix!
  const client =
    'clientId' in fix ? data.clients.find((c) => c.id === fix.clientId) : undefined

  const [numberValue, setNumberValue] = useState(() => {
    if (fix.kind === 'clientNumber') {
      const current = client?.[fix.field]
      return typeof current === 'number' && current > 0 ? String(current) : ''
    }
    return ''
  })
  const [textValue, setTextValue] = useState(() =>
    fix.kind === 'clientText' ? String(client?.[fix.field] ?? '') : '',
  )
  const [teamIds, setTeamIds] = useState<string[]>(() =>
    fix.kind === 'clientTeam' ? client?.assignedEmployeeIds ?? [] : [],
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const employeeOptions = useMemo(
    () => data.employees.map((employee) => ({ id: employee.id, label: employee.name })),
    [data.employees],
  )

  const save = async () => {
    setError('')
    try {
      setBusy(true)
      if (fix.kind === 'clientNumber') {
        const value = Number(numberValue)
        if (!Number.isFinite(value) || value <= 0) {
          setError('Enter an amount greater than 0.')
          setBusy(false)
          return
        }
        updateClient(
          fix.clientId,
          fix.field === 'monthlyRate' ? { monthlyRate: value } : { annualRate: value },
        )
      } else if (fix.kind === 'clientText') {
        const value = textValue.trim()
        if (!value) {
          setError('Enter a billing email.')
          setBusy(false)
          return
        }
        updateClient(fix.clientId, { email: value })
      } else if (fix.kind === 'clientTeam') {
        if (teamIds.length === 0) {
          setError('Pick at least one team member.')
          setBusy(false)
          return
        }
        // Set the owner-managed assigned team AND the visibility list, so the
        // issue clears and the assigned staff can actually see the client.
        updateClient(fix.clientId, {
          assignedEmployeeIds: teamIds,
          assignedBookkeeperIds: teamIds,
        })
      } else if (fix.kind === 'planChecklists') {
        for (const templateId of fix.templateIds) {
          await applyTemplateToClient(templateId, { clientId: fix.clientId })
        }
      }
      onClose()
    } catch {
      setError('Could not save — try again, or use the full page.')
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" role="presentation" onClick={onClose}>
      <div
        className="modal-panel setup-fix-modal"
        role="dialog"
        aria-modal="true"
        aria-label={issue.title}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="modal-title">{issue.title}</h2>

        {fix.kind === 'clientNumber' ? (
          <label className="field">
            <span>{fix.label}</span>
            <div className="setup-fix-money">
              <span aria-hidden="true">$</span>
              <input
                className="input"
                type="number"
                min="0"
                step="any"
                autoFocus
                value={numberValue}
                onChange={(event) => setNumberValue(event.target.value)}
              />
            </div>
          </label>
        ) : null}

        {fix.kind === 'clientText' ? (
          <label className="field">
            <span>{fix.label}</span>
            <input
              className="input"
              type="email"
              autoFocus
              placeholder="billing@client.com"
              value={textValue}
              onChange={(event) => setTextValue(event.target.value)}
            />
          </label>
        ) : null}

        {fix.kind === 'clientTeam' ? (
          <div className="field">
            <span>Assigned team</span>
            <ChipMultiSelect
              selectedIds={teamIds}
              options={employeeOptions}
              onChange={setTeamIds}
              addLabel="+ Add team member"
              emptyHelper="No one assigned yet."
            />
          </div>
        ) : null}

        {fix.kind === 'planChecklists' ? (
          <div className="field">
            <span>These plan checklists will be added to {client?.name ?? 'the client'}:</span>
            <ul className="setup-issue-items">
              {(issue.items ?? []).map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {error ? <p className="auth-error">{error}</p> : null}

        <div className="button-row">
          <button type="button" className="primary-action" disabled={busy} onClick={() => void save()}>
            {busy
              ? 'Saving…'
              : fix.kind === 'planChecklists'
                ? 'Set them up'
                : 'Save'}
          </button>
          <button type="button" className="secondary-action" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
