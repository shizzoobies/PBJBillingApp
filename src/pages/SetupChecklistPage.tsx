import { ArrowRight, CheckCircle2, CircleAlert } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useAppContext } from '../AppContext'
import {
  computeSetupIssues,
  groupSetupIssues,
  type SetupSeverity,
} from '../lib/completeness'

const SEVERITY_LABEL: Record<SetupSeverity, string> = {
  high: 'Needs attention',
  medium: 'Recommended',
  low: 'Nice to have',
}

/**
 * "To 100%" — a live, owner-only checklist of everything still missing for the
 * workspace to be fully set up. Pure derived view (see lib/completeness.ts);
 * each item deep-links to where it's fixed.
 */
export function SetupChecklistPage() {
  const { data, ownerMode } = useAppContext()
  if (!ownerMode) {
    return null
  }

  const issues = computeSetupIssues({
    clients: data.clients,
    contacts: data.contacts,
    plans: data.plans,
    employees: data.employees,
    checklistTemplates: data.checklistTemplates,
  })
  const groups = groupSetupIssues(issues)
  const highCount = issues.filter((issue) => issue.severity === 'high').length

  return (
    <section className="content-grid" id="setup-checklist">
      <div className="panel">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Getting to 100%</p>
            <h2>Setup checklist</h2>
          </div>
        </div>
        {issues.length === 0 ? (
          <div className="setup-all-clear">
            <CheckCircle2 size={28} />
            <div>
              <strong>You&apos;re all set — 100%.</strong>
              <p className="muted-text" style={{ margin: 0 }}>
                Every client, team member, plan, and contact is fully configured.
              </p>
            </div>
          </div>
        ) : (
          <p className="muted-text" style={{ marginTop: 0 }}>
            {issues.length} item{issues.length === 1 ? '' : 's'} left to set up
            {highCount > 0 ? ` · ${highCount} need${highCount === 1 ? 's' : ''} attention` : ''}.
            This list updates itself as you fill things in.
          </p>
        )}
      </div>

      {groups.map((group) => (
        <div className="panel" key={group.category}>
          <div className="section-heading">
            <div>
              <p className="section-kicker">{group.category}</p>
              <h2>
                {group.issues.length} item{group.issues.length === 1 ? '' : 's'}
              </h2>
            </div>
          </div>
          <ul className="setup-issue-list">
            {group.issues.map((issue) => (
              <li key={issue.id} className={`setup-issue setup-issue--${issue.severity}`}>
                <CircleAlert size={16} className="setup-issue-icon" />
                <div className="setup-issue-body">
                  <strong>{issue.title}</strong>
                  {issue.detail ? <span className="muted-text">{issue.detail}</span> : null}
                  <span className="setup-issue-sev">{SEVERITY_LABEL[issue.severity]}</span>
                </div>
                <Link to={issue.to} className="setup-issue-fix">
                  Fix <ArrowRight size={14} />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  )
}
