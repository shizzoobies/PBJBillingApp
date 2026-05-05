import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Copy, Eye, KeyRound, RefreshCw, Trash2, UserPlus, X } from 'lucide-react'
import { useAppContext } from '../AppContext'
import {
  deleteTeamMember,
  fetchTeam,
  fetchTeamActivity,
  inviteTeamMember,
  regenerateTeamMember,
  restoreTeamMember,
  revokeTeamMember,
} from '../lib/api'
import { ApiError, type ActivityEntry, type TeamMember } from '../lib/types'
import { describeActivityAction, formatActivityTimestamp, relativeTime } from '../lib/utils'

const STAFF_ROLES = ['Owner', 'Senior Bookkeeper', 'Bookkeeper'] as const

export function TeamPage() {
  const { ownerMode, setPreviewUserId } = useAppContext()
  const navigate = useNavigate()
  const [members, setMembers] = useState<TeamMember[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<(typeof STAFF_ROLES)[number]>('Bookkeeper')
  const [inviteError, setInviteError] = useState('')
  const [invitePending, setInvitePending] = useState(false)
  const [lastInvited, setLastInvited] = useState<TeamMember | null>(null)

  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [activity, setActivity] = useState<Record<string, ActivityEntry[]>>({})
  const [activityLoading, setActivityLoading] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const response = await fetchTeam()
        if (!active) return
        setMembers(response.users)
      } catch (error) {
        if (!active) return
        setLoadError(error instanceof ApiError ? error.message : 'Failed to load team')
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [])

  const upsertMember = (member: TeamMember) => {
    setMembers((current) => {
      const exists = current.some((entry) => entry.id === member.id)
      if (exists) {
        return current.map((entry) => (entry.id === member.id ? member : entry))
      }
      return [...current, member]
    })
  }

  const handleInvite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!name.trim() || !email.trim() || invitePending) return

    setInvitePending(true)
    setInviteError('')
    try {
      const response = await inviteTeamMember({ name: name.trim(), email: email.trim(), role })
      upsertMember(response.user)
      setLastInvited(response.user)
      setName('')
      setEmail('')
      setRole('Bookkeeper')
    } catch (error) {
      setInviteError(error instanceof ApiError ? error.message : 'Failed to invite member')
    } finally {
      setInvitePending(false)
    }
  }

  const handleCopy = async (text: string | null, key: string) => {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopiedId(key)
      window.setTimeout(() => {
        setCopiedId((current) => (current === key ? null : current))
      }, 1500)
    } catch {
      // ignore clipboard errors
    }
  }

  const handleRevoke = async (member: TeamMember) => {
    const confirmed = window.confirm(
      `This will immediately log out ${member.name} and invalidate their link. Continue?`,
    )
    if (!confirmed) return
    try {
      const response = await revokeTeamMember(member.id)
      upsertMember(response.user)
    } catch (error) {
      window.alert(error instanceof ApiError ? error.message : 'Failed to revoke link')
    }
  }

  const handleRegenerate = async (member: TeamMember) => {
    try {
      const response = await regenerateTeamMember(member.id)
      upsertMember(response.user)
    } catch (error) {
      window.alert(error instanceof ApiError ? error.message : 'Failed to regenerate link')
    }
  }

  const handleRestore = async (member: TeamMember) => {
    try {
      const response = await restoreTeamMember(member.id)
      upsertMember(response.user)
    } catch (error) {
      window.alert(error instanceof ApiError ? error.message : 'Failed to restore access')
    }
  }

  const handleDelete = async (member: TeamMember) => {
    const confirmed = window.confirm(
      `Remove ${member.name} from the team? Only allowed if they have no assigned checklists.`,
    )
    if (!confirmed) return
    try {
      await deleteTeamMember(member.id)
      setMembers((current) => current.filter((entry) => entry.id !== member.id))
      if (expandedId === member.id) setExpandedId(null)
    } catch (error) {
      window.alert(error instanceof ApiError ? error.message : 'Failed to remove member')
    }
  }

  const handleToggleExpand = async (member: TeamMember) => {
    const next = expandedId === member.id ? null : member.id
    setExpandedId(next)
    if (next && !activity[member.id]) {
      setActivityLoading(member.id)
      try {
        const response = await fetchTeamActivity(member.id, 20)
        setActivity((current) => ({ ...current, [member.id]: response.entries }))
      } catch {
        setActivity((current) => ({ ...current, [member.id]: [] }))
      } finally {
        setActivityLoading(null)
      }
    }
  }

  return (
    <section className="content-grid single" id="team">
      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Team management</p>
            <h2>
              <UserPlus size={18} /> Invite bookkeeper
            </h2>
          </div>
        </div>
        <form className="team-invite-form" onSubmit={handleInvite}>
          <label className="field">
            <span>Name</span>
            <input
              className="input"
              onChange={(event) => setName(event.target.value)}
              placeholder="Full name"
              type="text"
              value={name}
            />
          </label>
          <label className="field">
            <span>Email</span>
            <input
              className="input"
              onChange={(event) => setEmail(event.target.value)}
              placeholder="name@firm.com"
              type="email"
              value={email}
            />
          </label>
          <label className="field">
            <span>Role</span>
            <select
              className="input"
              onChange={(event) => setRole(event.target.value as (typeof STAFF_ROLES)[number])}
              value={role}
            >
              {STAFF_ROLES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <button className="primary-action" disabled={invitePending} type="submit">
            {invitePending ? 'Inviting...' : 'Send invite'}
          </button>
        </form>
        {inviteError ? <p className="team-error">{inviteError}</p> : null}
        {lastInvited && lastInvited.magicUrl ? (
          <div className="team-invite-success">
            <div className="team-invite-success-header">
              <strong>Invite ready for {lastInvited.name}</strong>
              <button
                className="team-icon-button"
                onClick={() => setLastInvited(null)}
                type="button"
                aria-label="Dismiss invite"
              >
                <X size={14} />
              </button>
            </div>
            <p className="team-success-copy">
              Copy this magic link and send it to them directly. It signs them in instantly.
            </p>
            <div className="team-magic-row">
              <code className="team-magic-url">{lastInvited.magicUrl}</code>
              <button
                className="primary-action"
                onClick={() => handleCopy(lastInvited.magicUrl, `invite-${lastInvited.id}`)}
                type="button"
              >
                <Copy size={14} />{' '}
                {copiedId === `invite-${lastInvited.id}` ? 'Copied' : 'Copy link'}
              </button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Members</p>
            <h2>Team roster</h2>
          </div>
        </div>
        {loading ? (
          <p className="team-muted">Loading team...</p>
        ) : loadError ? (
          <p className="team-error">{loadError}</p>
        ) : members.length === 0 ? (
          <p className="team-muted">No team members yet. Invite someone above.</p>
        ) : (
          <ul className="team-list">
            {members.map((member) => {
              const revoked = Boolean(member.tokenRevokedAt)
              const isExpanded = expandedId === member.id
              return (
                <li className="team-card" key={member.id}>
                  <button
                    className="team-card-header"
                    onClick={() => handleToggleExpand(member)}
                    type="button"
                    aria-expanded={isExpanded}
                  >
                    <div className="team-card-identity">
                      <strong>{member.name}</strong>
                      <span className="team-card-email">{member.email}</span>
                    </div>
                    <div className="team-card-meta">
                      <span className="team-role-badge">{member.staffRole}</span>
                      <span
                        className={
                          revoked
                            ? 'team-status-badge team-status-revoked'
                            : 'team-status-badge team-status-active'
                        }
                      >
                        {revoked ? 'Revoked' : 'Active'}
                      </span>
                      <span className="team-card-last-active">
                        Last login: {relativeTime(member.lastActiveAt)}
                      </span>
                    </div>
                  </button>
                  {isExpanded ? (
                    <div className="team-card-body">
                      {!revoked && member.magicUrl ? (
                        <div className="team-magic-row">
                          <code className="team-magic-url">{member.magicUrl}</code>
                          <button
                            className="team-icon-button"
                            onClick={() => handleCopy(member.magicUrl, `link-${member.id}`)}
                            type="button"
                          >
                            <Copy size={14} />{' '}
                            {copiedId === `link-${member.id}` ? 'Copied' : 'Copy invite link'}
                          </button>
                        </div>
                      ) : revoked ? (
                        <p className="team-muted">Access revoked. Restore to issue a new link.</p>
                      ) : null}

                      <div className="team-actions">
                        {ownerMode && member.staffRole !== 'Owner' ? (
                          <button
                            className="team-icon-button"
                            onClick={() => {
                              setPreviewUserId(member.id)
                              navigate('/dashboard')
                            }}
                            type="button"
                          >
                            <Eye size={14} /> Preview their dashboard
                          </button>
                        ) : null}
                        {revoked ? (
                          <button
                            className="primary-action"
                            onClick={() => handleRestore(member)}
                            type="button"
                          >
                            <KeyRound size={14} /> Restore access
                          </button>
                        ) : (
                          <>
                            <button
                              className="team-icon-button"
                              onClick={() => handleRegenerate(member)}
                              type="button"
                            >
                              <RefreshCw size={14} /> Regenerate link
                            </button>
                            <button
                              className="team-danger-button"
                              onClick={() => handleRevoke(member)}
                              type="button"
                            >
                              Revoke link
                            </button>
                          </>
                        )}
                        <button
                          className="team-danger-button"
                          onClick={() => handleDelete(member)}
                          type="button"
                        >
                          <Trash2 size={14} /> Remove
                        </button>
                      </div>

                      <div className="team-activity">
                        <h4>Recent activity</h4>
                        {activityLoading === member.id ? (
                          <p className="team-muted">Loading activity...</p>
                        ) : (activity[member.id] ?? []).length === 0 ? (
                          <p className="team-muted">No recent activity recorded.</p>
                        ) : (
                          <ul className="team-activity-list">
                            {(activity[member.id] ?? []).map((entry) => (
                              <li key={entry.id}>
                                <span>
                                  {describeActivityAction(entry.action)}
                                  {entry.target ? ` ${entry.target}` : ''}
                                </span>
                                <span className="team-activity-time">
                                  {formatActivityTimestamp(entry.timestamp)}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </section>
  )
}
