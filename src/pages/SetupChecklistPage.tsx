import { useEffect, useMemo, useState } from 'react'
import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  EyeOff,
  RotateCcw,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { useAppContext } from '../AppContext'
import { ChipMultiSelect } from '../components/ChipMultiSelect'
import {
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

const SEVERITY_LABEL: Record<SetupSeverity, string> = {
  high: 'Needs attention',
  medium: 'Recommended',
  low: 'Nice to have',
}

/**
 * "To 100%" — an owner-only, per-TAB list of what is misconfigured or blocking
 * in each area of the app (see lib/completeness.ts). Only problems appear;
 * normal in-flight checklist work never shows here (owner feedback, round 4 —
 * this page answers "what parts of the site aren't working", nothing else).
 * A tab with nothing wrong shows as green, so working areas are visible too.
 * Each item can be fixed in a focused quick-fix modal (or deep-links when
 * there isn't a single field), or IGNORED (persisted per owner, restorable).
 */
export function SetupChecklistPage() {
  const { data, ownerMode } = useAppContext()

  // Hooks run unconditionally (before the ownerMode early return).
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  // Sections with issues are COLLAPSED by default; this holds what's opened.
  const [expandedCats, setExpandedCats] = useState<Set<string>>(new Set())
  const [showIgnored, setShowIgnored] = useState(false)
  const [fixTarget, setFixTarget] = useState<SetupIssue | null>(null)

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
        checklists: data.checklists,
      }),
    [
      data.clients,
      data.contacts,
      data.plans,
      data.employees,
      data.checklistTemplates,
      data.checklists,
    ],
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
  // Summary chips at the top jump to (and open) their section.
  const scrollTo = (id: string) =>
    requestAnimationFrame(() =>
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    )
  const jumpToCategory = (category: string) => {
    setExpandedCats((prev) => new Set(prev).add(category))
    scrollTo(`setup-cat-${category}`)
  }

  return (
    <section className="content-grid" id="setup-checklist">
      <div className="panel">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Getting to 100%</p>
            <h2>What&apos;s not working, by tab</h2>
          </div>
        </div>
        {activeIssues.length === 0 ? (
          <div className="setup-all-clear">
            <CheckCircle2 size={28} />
            <div>
              <strong>You&apos;re all set — 100%.</strong>
              <p className="muted-text" style={{ margin: 0 }}>
                Nothing is misconfigured or blocked anywhere in the app
                {ignoredIssues.length > 0 ? ` (${ignoredIssues.length} ignored)` : ''}.
              </p>
            </div>
          </div>
        ) : (
          <p className="muted-text" style={{ marginTop: 0 }}>
            {activeIssues.length} thing{activeIssues.length === 1 ? '' : 's'} to fix
            {highCount > 0 ? ` · ${highCount} need${highCount === 1 ? 's' : ''} attention` : ''}.
            Only problems show here — normal day-to-day checklist work never appears on this
            page. Green tabs are fully working.
          </p>
        )}
        {activeIssues.length > 0 ? (
          <div className="setup-overview">
            <div className="setup-stat-strip" role="group" aria-label="Problems by tab">
              {groups
                .filter((group) => group.issues.length > 0)
                .map((group) => (
                  <button
                    key={group.category}
                    type="button"
                    className="setup-stat"
                    onClick={() => jumpToCategory(group.category)}
                  >
                    <span className="setup-stat-num">{group.issues.length}</span>
                    <span className="setup-stat-label">{group.category}</span>
                  </button>
                ))}
            </div>
          </div>
        ) : null}
      </div>

      {groups.map((group) => {
        // A tab with nothing wrong renders as a slim green row — visible proof
        // that area is fully working, without a collapsible section to open.
        if (group.issues.length === 0) {
          return (
            <div className="panel setup-tab-clear" key={group.category}>
              <div className="setup-cat-header setup-cat-header--clear">
                <CheckCircle2 size={16} className="setup-tab-clear-icon" />
                <span className="section-kicker">{group.category}</span>
                <span className="setup-cat-count">Nothing missing</span>
              </div>
            </div>
          )
        }
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

      <p className="muted-text setup-coverage-note">
        Tabs not listed here (Time, Timesheet, Dashboard, reports) don&apos;t have automated
        checks yet — nothing is verified or broken there, they&apos;re just not scanned.
      </p>

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
    </section>
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
