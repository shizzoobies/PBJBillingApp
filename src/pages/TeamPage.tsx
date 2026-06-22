import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronDown, ChevronUp, Eye, MailPlus, Send, Trash2, X } from 'lucide-react'
import { useAppContext } from '../AppContext'
import { CollapsibleSection } from '../components/SectionKit'
import {
  fetchTeam,
  fetchTeamActivity,
  fetchTeamSessions,
  inviteTeamMember,
  reorderTeamMembersRequest,
  resendTeamSignInLink,
  revokeAllTeamSessions,
  revokeTeamSession,
  setClientAssignedTeamRequest,
  setTeamMemberBillRate,
  setTeamMemberCostRate,
  teamTotpReset,
} from '../lib/api'
import {
  ApiError,
  type ActivityEntry,
  type Client,
  type TeamMember,
  type TeamSession,
} from '../lib/types'
import { describeActivityAction, formatActivityTimestamp, relativeTime } from '../lib/utils'

const STAFF_ROLES = ['Owner', 'Accountant', 'Bookkeeper'] as const

export function TeamPage() {
  const { data, deleteTeamMember, ownerMode, setPreviewUserId, updateClient } = useAppContext()
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
  const [sessions, setSessions] = useState<Record<string, TeamSession[]>>({})
  const [sessionsLoading, setSessionsLoading] = useState<string | null>(null)
  const [resendingId, setResendingId] = useState<string | null>(null)
  const [resendStatus, setResendStatus] = useState<Record<string, 'sent' | 'error'>>({})
  const [costDraft, setCostDraft] = useState<Record<string, string>>({})
  const [costSavingId, setCostSavingId] = useState<string | null>(null)
  const [billDraft, setBillDraft] = useState<Record<string, string>>({})
  const [billSavingId, setBillSavingId] = useState<string | null>(null)

  const handleSaveBillRate = async (member: TeamMember) => {
    const raw = billDraft[member.id]
    const value = raw === undefined ? '' : raw.trim()
    const billRate = value === '' ? null : Number(value)
    if (billRate !== null && (!Number.isFinite(billRate) || billRate < 0)) return
    setBillSavingId(member.id)
    try {
      const result = await setTeamMemberBillRate(member.id, billRate)
      setMembers((current) =>
        current.map((entry) =>
          entry.id === member.id ? { ...entry, billRate: result.billRate } : entry,
        ),
      )
      setBillDraft((current) => {
        const next = { ...current }
        delete next[member.id]
        return next
      })
    } catch {
      // Keep the draft so the owner can retry.
    } finally {
      setBillSavingId(null)
    }
  }

  const handleSaveCostRate = async (member: TeamMember) => {
    const raw = costDraft[member.id]
    const value = raw === undefined ? '' : raw.trim()
    const costRate = value === '' ? null : Number(value)
    if (costRate !== null && (!Number.isFinite(costRate) || costRate < 0)) return
    setCostSavingId(member.id)
    try {
      const result = await setTeamMemberCostRate(member.id, costRate)
      setMembers((current) =>
        current.map((entry) =>
          entry.id === member.id ? { ...entry, costRate: result.costRate } : entry,
        ),
      )
      setCostDraft((current) => {
        const next = { ...current }
        delete next[member.id]
        return next
      })
    } catch {
      // Keep the draft so the owner can retry.
    } finally {
      setCostSavingId(null)
    }
  }

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

  const moveMember = async (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= members.length) return
    const previous = members
    const reordered = [...members]
    const [moved] = reordered.splice(index, 1)
    reordered.splice(target, 0, moved)
    setMembers(reordered)
    try {
      const response = await reorderTeamMembersRequest(reordered.map((entry) => entry.id))
      setMembers(response.users)
    } catch (error) {
      setMembers(previous)
      window.alert(error instanceof ApiError ? error.message : 'Failed to reorder team')
    }
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

  const refreshSessions = async (memberId: string) => {
    setSessionsLoading(memberId)
    try {
      const response = await fetchTeamSessions(memberId)
      setSessions((current) => ({ ...current, [memberId]: response.sessions }))
    } catch {
      setSessions((current) => ({ ...current, [memberId]: [] }))
    } finally {
      setSessionsLoading(null)
    }
  }

  const handleResendLink = async (member: TeamMember) => {
    if (!member.email) return
    setResendingId(member.id)
    setResendStatus((current) => ({ ...current, [member.id]: 'sent' }))
    try {
      await resendTeamSignInLink(member.id)
      setResendStatus((current) => ({ ...current, [member.id]: 'sent' }))
    } catch {
      setResendStatus((current) => ({ ...current, [member.id]: 'error' }))
    } finally {
      setResendingId(null)
      window.setTimeout(() => {
        setResendStatus((current) => {
          const next = { ...current }
          delete next[member.id]
          return next
        })
      }, 4000)
    }
  }

  const handleRevokeSession = async (member: TeamMember, sessionId: string) => {
    const confirmed = window.confirm(
      `Sign this device out for ${member.name}? They'll need a new sign-in link to get back in from that device.`,
    )
    if (!confirmed) return
    try {
      await revokeTeamSession(member.id, sessionId)
      await refreshSessions(member.id)
    } catch (error) {
      window.alert(error instanceof ApiError ? error.message : 'Failed to revoke session')
    }
  }

  const handleRevokeAll = async (member: TeamMember) => {
    const confirmed = window.confirm(
      `Sign ${member.name} out of every device? They'll need a new sign-in link to get back in.`,
    )
    if (!confirmed) return
    try {
      await revokeAllTeamSessions(member.id)
      await refreshSessions(member.id)
    } catch (error) {
      window.alert(error instanceof ApiError ? error.message : 'Failed to revoke sessions')
    }
  }

  const handleDelete = async (member: TeamMember) => {
    // No barriers: the server reassigns their checklists, templates, and
    // time entries to you so nothing is lost, strips them from every
    // viewer / editor / assigned-team list, and revokes access immediately.
    // This is destructive (can't be undone) but data survives via reassign.
    const confirmed = window.confirm(
      `Remove ${member.name} from the team?\n\nTheir checklists and time entries will be reassigned to you so nothing is lost. They'll be stripped from every viewer / editor / assigned-team list and lose access immediately. This can't be undone.`,
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

  const handleResetTotp = async (member: TeamMember) => {
    const confirmed = window.confirm(
      `Reset two-factor for ${member.name}? They'll be prompted to set up again on next sign-in.`,
    )
    if (!confirmed) return
    try {
      await teamTotpReset(member.id)
      // Optimistically update the local cache so the badge flips immediately.
      setMembers((current) =>
        current.map((entry) =>
          entry.id === member.id ? { ...entry, totpEnabled: false } : entry,
        ),
      )
    } catch (error) {
      window.alert(error instanceof ApiError ? error.message : 'Failed to reset two-factor')
    }
  }

  const handleToggleExpand = async (member: TeamMember) => {
    const next = expandedId === member.id ? null : member.id
    setExpandedId(next)
    if (!next) return
    if (!activity[member.id]) {
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
    if (!sessions[member.id]) {
      void refreshSessions(member.id)
    }
  }

  return (
    <section className="content-grid single" id="team">
      <CollapsibleSection kicker="Team management" title="Invite bookkeeper">
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
        {lastInvited ? (
          <div className="team-invite-success">
            <div className="team-invite-success-header">
              <strong>Invitation sent to {lastInvited.email}</strong>
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
              {lastInvited.name} will get a one-time sign-in link in their inbox. The link expires
              in 15 minutes.
            </p>
          </div>
        ) : null}
      </CollapsibleSection>

      <CollapsibleSection kicker="Members" title="Team roster">
        {loading ? (
          <p className="team-muted">Loading team...</p>
        ) : loadError ? (
          <p className="team-error">{loadError}</p>
        ) : members.length === 0 ? (
          <p className="team-muted">No team members yet. Invite someone above.</p>
        ) : (
          <ul className="team-list">
            {members.map((member, index) => {
              const isExpanded = expandedId === member.id
              return (
                <li className="team-card" key={member.id}>
                  <div className="team-card-top">
                    {ownerMode ? (
                      <div className="team-card-reorder">
                        <button
                          type="button"
                          className="team-reorder-btn"
                          aria-label={`Move ${member.name} up`}
                          disabled={index === 0}
                          onClick={() => moveMember(index, -1)}
                        >
                          <ChevronUp size={14} />
                        </button>
                        <button
                          type="button"
                          className="team-reorder-btn"
                          aria-label={`Move ${member.name} down`}
                          disabled={index === members.length - 1}
                          onClick={() => moveMember(index, 1)}
                        >
                          <ChevronDown size={14} />
                        </button>
                      </div>
                    ) : null}
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
                        <span className="team-card-last-active">
                          Last login: {relativeTime(member.lastActiveAt)}
                        </span>
                      </div>
                    </button>
                  </div>
                  {isExpanded ? (
                    <div className="team-card-body">
                      {member.staffRole !== 'Owner' ? (
                        <p className="muted-text" style={{ marginTop: 0 }}>
                          <strong>2FA:</strong>{' '}
                          {member.totpEnabled ? (
                            <span style={{ color: '#1f7d4d' }}>Enabled</span>
                          ) : (
                            <span>Not enabled</span>
                          )}
                        </p>
                      ) : null}
                      {ownerMode ? (
                        <div className="team-cost-rate">
                          <label htmlFor={`bill-${member.id}`}>
                            <strong>Bill rate</strong>
                            <span className="team-cost-hint">$/hour billed to clients for this person's time.</span>
                          </label>
                          <div className="team-cost-input-row">
                            <span className="team-cost-prefix">$</span>
                            <input
                              id={`bill-${member.id}`}
                              type="number"
                              min="0"
                              step="1"
                              inputMode="decimal"
                              placeholder="—"
                              value={
                                billDraft[member.id] ??
                                (member.billRate != null ? String(member.billRate) : '')
                              }
                              onChange={(event) =>
                                setBillDraft((current) => ({
                                  ...current,
                                  [member.id]: event.target.value,
                                }))
                              }
                            />
                            <button
                              type="button"
                              className="team-icon-button"
                              disabled={billSavingId === member.id || billDraft[member.id] === undefined}
                              onClick={() => void handleSaveBillRate(member)}
                            >
                              {billSavingId === member.id ? 'Saving…' : 'Save'}
                            </button>
                          </div>
                        </div>
                      ) : null}
                      {ownerMode && member.staffRole !== 'Owner' ? (
                        <div className="team-cost-rate">
                          <label htmlFor={`cost-${member.id}`}>
                            <strong>Cost rate</strong>
                            <span className="team-cost-hint">$/hour — for margin reports only, never billed</span>
                          </label>
                          <div className="team-cost-input-row">
                            <span className="team-cost-prefix">$</span>
                            <input
                              id={`cost-${member.id}`}
                              type="number"
                              min="0"
                              step="1"
                              inputMode="decimal"
                              placeholder="—"
                              value={
                                costDraft[member.id] ??
                                (member.costRate != null ? String(member.costRate) : '')
                              }
                              onChange={(event) =>
                                setCostDraft((current) => ({
                                  ...current,
                                  [member.id]: event.target.value,
                                }))
                              }
                            />
                            <button
                              type="button"
                              className="team-icon-button"
                              disabled={costSavingId === member.id || costDraft[member.id] === undefined}
                              onClick={() => void handleSaveCostRate(member)}
                            >
                              {costSavingId === member.id ? 'Saving…' : 'Save'}
                            </button>
                          </div>
                        </div>
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
                        <button
                          className="team-icon-button"
                          disabled={resendingId === member.id || !member.email}
                          onClick={() => handleResendLink(member)}
                          type="button"
                          title={
                            member.email
                              ? 'Email a fresh sign-in link to this member'
                              : 'No email on file'
                          }
                        >
                          <MailPlus size={14} />
                          {resendingId === member.id ? ' Sending…' : ' Resend sign-in link'}
                        </button>
                        {resendStatus[member.id] === 'sent' ? (
                          <span className="team-success-copy">Email queued.</span>
                        ) : null}
                        {resendStatus[member.id] === 'error' ? (
                          <span className="team-error">Could not send.</span>
                        ) : null}
                        {ownerMode ? (
                          <button
                            className="team-icon-button"
                            onClick={() => handleResetTotp(member)}
                            type="button"
                            title="Wipe their 2FA enrollment so they can set up again"
                          >
                            Reset 2FA
                          </button>
                        ) : null}
                        <button
                          className="team-danger-button"
                          onClick={() => handleDelete(member)}
                          type="button"
                        >
                          <Trash2 size={14} /> Remove
                        </button>
                      </div>

                      <div className="team-activity">
                        <div className="team-sessions-heading">
                          <h4>Active sessions</h4>
                          {(sessions[member.id]?.length ?? 0) > 0 ? (
                            <button
                              className="team-icon-button"
                              onClick={() => handleRevokeAll(member)}
                              type="button"
                            >
                              <Send size={12} /> Sign out everywhere
                            </button>
                          ) : null}
                        </div>
                        {sessionsLoading === member.id ? (
                          <p className="team-muted">Loading sessions...</p>
                        ) : (sessions[member.id] ?? []).length === 0 ? (
                          <p className="team-muted">No active sessions.</p>
                        ) : (
                          <ul className="team-sessions-list">
                            {(sessions[member.id] ?? []).map((sessionEntry) => (
                              <li key={sessionEntry.id}>
                                <div className="team-session-row">
                                  <div className="team-session-meta">
                                    <strong>{describeUserAgent(sessionEntry.userAgent)}</strong>
                                    <span className="team-session-detail">
                                      Last seen {relativeTime(sessionEntry.lastSeenAt)} ·{' '}
                                      {sessionEntry.ipAddress || '—'}
                                    </span>
                                  </div>
                                  <button
                                    aria-label="Sign out this device"
                                    className="team-icon-button"
                                    onClick={() => handleRevokeSession(member, sessionEntry.id)}
                                    type="button"
                                  >
                                    <X size={14} />
                                  </button>
                                </div>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>

                      {member.staffRole !== 'Owner' ? (
                        <ClientsTheyCanSeeSection
                          memberId={member.id}
                          clients={data.clients}
                          onChangeClient={(clientId, nextIds) => {
                            updateClient(clientId, { assignedBookkeeperIds: nextIds })
                            void setClientAssignedTeamRequest(clientId, nextIds).catch(() => {
                              // best-effort; the next /api/app-data refresh reconciles
                            })
                          }}
                        />
                      ) : null}

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
      </CollapsibleSection>
    </section>
  )
}

/**
 * Best-effort UA -> human label. Keeps the Active sessions list readable
 * without pulling in a UA-parser dependency.
 */
function describeUserAgent(ua: string | null): string {
  if (!ua) return 'Unknown device'
  const platform = /Windows/.test(ua)
    ? 'Windows'
    : /Macintosh|Mac OS X/.test(ua)
      ? 'macOS'
      : /iPhone|iPad|iOS/.test(ua)
        ? 'iOS'
        : /Android/.test(ua)
          ? 'Android'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'Unknown'
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua) && !/Chromium\//.test(ua)
      ? 'Chrome'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser'
  return `${browser} on ${platform}`
}

/**
 * Per-team-member view of the inverse relationship: shows every client this
 * non-owner can currently see, with chips to remove a client from their
 * visibility list and a "+ Add client" pill to grant access.
 */
function ClientsTheyCanSeeSection({
  memberId,
  clients,
  onChangeClient,
}: {
  memberId: string
  clients: Client[]
  onChangeClient: (clientId: string, nextIds: string[]) => void
}) {
  const [adderOpen, setAdderOpen] = useState(false)

  const visibleClients = clients.filter((client) =>
    (client.assignedBookkeeperIds ?? []).includes(memberId),
  )
  const addableClients = clients.filter(
    (client) => !(client.assignedBookkeeperIds ?? []).includes(memberId),
  )

  const removeClient = (client: Client) => {
    const next = (client.assignedBookkeeperIds ?? []).filter((id) => id !== memberId)
    onChangeClient(client.id, next)
  }

  const addClient = (client: Client) => {
    const current = client.assignedBookkeeperIds ?? []
    if (current.includes(memberId)) {
      setAdderOpen(false)
      return
    }
    onChangeClient(client.id, [...current, memberId])
    setAdderOpen(false)
  }

  return (
    <div className="sharing-control">
      <p className="sharing-helper">Clients they can see</p>
      <div className="sharing-chips">
        {visibleClients.length === 0 ? (
          <span className="sharing-helper">No clients assigned yet.</span>
        ) : null}
        {visibleClients.map((client) => (
          <span className="sharing-chip" key={client.id}>
            <strong>{client.name}</strong>
            <button
              type="button"
              className="chip-remove"
              onClick={() => removeClient(client)}
              aria-label={`Remove ${client.name}`}
            >
              <X size={12} />
            </button>
          </span>
        ))}
        {addableClients.length > 0 ? (
          <div className="sharing-add">
            <button
              type="button"
              className="add-person-pill"
              onClick={() => setAdderOpen((open) => !open)}
            >
              + Add client
            </button>
            {adderOpen ? (
              <div className="sharing-add-menu" role="menu">
                {addableClients.map((client) => (
                  <button
                    key={client.id}
                    type="button"
                    role="menuitem"
                    onClick={() => addClient(client)}
                  >
                    {client.name}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
