import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronDown, ChevronUp, Eye, MailPlus, Send, Trash2, X } from 'lucide-react'
import { useAppContext } from '../AppContext'
import { highlightMatch } from '../lib/highlight'
import { ListSearch } from '../components/ListSearch'
import { CollapsibleSection } from '../components/SectionKit'
import {
  deleteBillRateVersion,
  deleteCostRateVersion,
  fetchRateVersions,
  fetchTeam,
  fetchTeamActivity,
  fetchTeamSessions,
  inviteTeamMember,
  reorderTeamMembersRequest,
  resendTeamSignInLink,
  revokeAllTeamSessions,
  revokeTeamSession,
  setClientAssignedTeamRequest,
  teamTotpReset,
  upsertBillRateVersion,
  upsertCostRateVersion,
} from '../lib/api'
import {
  ApiError,
  type ActivityEntry,
  type BillRateVersion,
  type Client,
  type CostRateVersion,
  type TeamMember,
  type TeamSession,
} from '../lib/types'
import {
  currency,
  describeActivityAction,
  formatActivityTimestamp,
  relativeTime,
} from '../lib/utils'
import { selectableClients } from '../lib/clientLifecycle'
import { taskClientIdsForUser } from '../../lib/data-scope.js'

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

  const [memberQuery, setMemberQuery] = useState('')
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

  /**
   * THE RATE HISTORY, fetched rather than read off the workspace snapshot:
   * `read()` deliberately does not select rate data, so it never reaches a
   * staff session at all. Same reasoning as ReportsPage's cost-rate map.
   */
  const [billVersions, setBillVersions] = useState<BillRateVersion[]>([])
  const [costVersions, setCostVersions] = useState<CostRateVersion[]>([])
  const [historyOpen, setHistoryOpen] = useState<Record<string, boolean>>({})
  /** Keyed `bill-<id>` / `cost-<id>`, so one box's refusal never blanks the other. */
  const [rateError, setRateError] = useState<Record<string, string>>({})
  // The common edit is a raise starting NOW, so the default is this month /
  // today and the owner types one number, exactly as before. Picking a
  // different month is the rarer case and costs one extra glance.
  const thisMonth = new Date().toISOString().slice(0, 7)
  const todayIso = new Date().toISOString().slice(0, 10)
  const [billFromDraft, setBillFromDraft] = useState<Record<string, string>>({})
  const [costFromDraft, setCostFromDraft] = useState<Record<string, string>>({})

  useEffect(() => {
    // Only an owner has rate boxes to fill, and only an owner may read the
    // versions — a preview-as session would spend a request to be told 403.
    if (!ownerMode) return
    const controller = new AbortController()
    void fetchRateVersions(controller.signal)
      .then(({ billRateVersions, costRateVersions }) => {
        setBillVersions(billRateVersions)
        setCostVersions(costRateVersions)
      })
      // Non-fatal: the boxes still save, the history list is simply empty.
      // A preview-as session 403s here and gets two empty lists, which is the
      // same shape — so previewing shows no history and no error either.
      .catch(() => {})
    return () => controller.abort()
  }, [ownerMode])

  const billVersionsFor = (userId: string) => billVersions.filter((row) => row.userId === userId)
  const costVersionsFor = (userId: string) => costVersions.filter((row) => row.userId === userId)
  /** Replace one person's slice wholesale — the endpoint returns their list. */
  const replaceBillVersions = (userId: string, rows: BillRateVersion[]) =>
    setBillVersions((current) => [...current.filter((row) => row.userId !== userId), ...rows])
  const replaceCostVersions = (userId: string, rows: CostRateVersion[]) =>
    setCostVersions((current) => [...current.filter((row) => row.userId !== userId), ...rows])

  const handleSaveBillRate = async (member: TeamMember) => {
    const raw = billDraft[member.id]
    const value = raw === undefined ? '' : raw.trim()
    const billRate = value === '' ? null : Number(value)
    if (billRate === null || !Number.isFinite(billRate) || billRate < 0) return
    const effectivePeriod = billFromDraft[member.id] ?? thisMonth
    if (!/^\d{4}-\d{2}$/.test(effectivePeriod)) return
    setBillSavingId(member.id)
    setRateError((current) => ({ ...current, [`bill-${member.id}`]: '' }))
    try {
      const result = await upsertBillRateVersion(member.id, effectivePeriod, billRate)
      replaceBillVersions(member.id, result.versions)
      // `users.bill_rate` mirrors the NEWEST version, which a backfill does not
      // move — so the card reads the mirror off the list rather than assuming
      // the rate just typed is now the current one.
      const newest = result.versions[result.versions.length - 1] ?? null
      setMembers((current) =>
        current.map((entry) =>
          entry.id === member.id ? { ...entry, billRate: newest?.rate ?? null } : entry,
        ),
      )
      setBillDraft((current) => {
        const next = { ...current }
        delete next[member.id]
        return next
      })
      // The month goes back to its default too. Leaving a backfilled month in
      // the box means the NEXT save in the same session silently lands on that
      // old month again, which is how you overwrite March while meaning today.
      setBillFromDraft((current) => {
        const next = { ...current }
        delete next[member.id]
        return next
      })
    } catch (error) {
      setRateError((current) => ({
        ...current,
        [`bill-${member.id}`]:
          error instanceof ApiError ? error.message : 'Could not save the rate.',
      }))
    } finally {
      setBillSavingId(null)
    }
  }

  const handleRemoveBillVersion = async (member: TeamMember, effectivePeriod: string) => {
    setRateError((current) => ({ ...current, [`bill-${member.id}`]: '' }))
    try {
      const result = await deleteBillRateVersion(member.id, effectivePeriod)
      replaceBillVersions(member.id, result.versions)
      const newest = result.versions[result.versions.length - 1] ?? null
      setMembers((current) =>
        current.map((entry) =>
          entry.id === member.id ? { ...entry, billRate: newest?.rate ?? null } : entry,
        ),
      )
    } catch (error) {
      setRateError((current) => ({
        ...current,
        [`bill-${member.id}`]:
          error instanceof ApiError ? error.message : 'Could not remove the rate.',
      }))
    }
  }

  const handleSaveCostRate = async (member: TeamMember) => {
    const raw = costDraft[member.id]
    const value = raw === undefined ? '' : raw.trim()
    const costRate = value === '' ? null : Number(value)
    if (costRate === null || !Number.isFinite(costRate) || costRate < 0) return
    const effectiveDate = costFromDraft[member.id] ?? todayIso
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) return
    setCostSavingId(member.id)
    setRateError((current) => ({ ...current, [`cost-${member.id}`]: '' }))
    try {
      const result = await upsertCostRateVersion(member.id, effectiveDate, costRate)
      replaceCostVersions(member.id, result.versions)
      // Same mirror rule as the bill rate: the headline follows the newest
      // version, so backfilling an older day leaves the card alone.
      const newest = result.versions[result.versions.length - 1] ?? null
      setMembers((current) =>
        current.map((entry) =>
          entry.id === member.id ? { ...entry, costRate: newest?.rate ?? null } : entry,
        ),
      )
      setCostDraft((current) => {
        const next = { ...current }
        delete next[member.id]
        return next
      })
      // Same reset as the bill box: a backfilled day must not stick around and
      // catch the next save.
      setCostFromDraft((current) => {
        const next = { ...current }
        delete next[member.id]
        return next
      })
    } catch (error) {
      setRateError((current) => ({
        ...current,
        [`cost-${member.id}`]:
          error instanceof ApiError ? error.message : 'Could not save the rate.',
      }))
    } finally {
      setCostSavingId(null)
    }
  }

  const handleRemoveCostVersion = async (member: TeamMember, effectiveDate: string) => {
    setRateError((current) => ({ ...current, [`cost-${member.id}`]: '' }))
    try {
      const result = await deleteCostRateVersion(member.id, effectiveDate)
      replaceCostVersions(member.id, result.versions)
      const newest = result.versions[result.versions.length - 1] ?? null
      setMembers((current) =>
        current.map((entry) =>
          entry.id === member.id ? { ...entry, costRate: newest?.rate ?? null } : entry,
        ),
      )
    } catch (error) {
      setRateError((current) => ({
        ...current,
        [`cost-${member.id}`]:
          error instanceof ApiError ? error.message : 'Could not remove the rate.',
      }))
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
        ) : (() => {
          const mq = memberQuery.trim().toLowerCase()
          const visibleMembers = mq
            ? members.filter(
                (m) =>
                  m.name.toLowerCase().includes(mq) ||
                  (m.email ?? '').toLowerCase().includes(mq) ||
                  (m.staffRole ?? '').toLowerCase().includes(mq),
              )
            : members
          return (
            <>
              <ListSearch
                value={memberQuery}
                onChange={setMemberQuery}
                placeholder="Search team…"
                resultCount={visibleMembers.length}
                total={members.length}
              />
              {memberQuery.trim() && visibleMembers.length === 0 ? (
                <p className="list-search-empty">
                  No team members match &ldquo;{memberQuery.trim()}&rdquo;.
                </p>
              ) : null}
              <ul className="team-list">
                {visibleMembers.map((member, index) => {
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
                        <strong>{highlightMatch(member.name, memberQuery)}</strong>
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
                      {/*
                        FIRST in the panel, right under the person's name:
                        rebuilding these lists is the job this page gets opened
                        for since the 2026-09-04 team reset, and it used to sit
                        below the rates, the actions and the session list.
                      */}
                      {member.staffRole !== 'Owner' ? (
                        <ClientsTheyCanSeeSection
                          memberId={member.id}
                          memberName={member.name}
                          clients={data.clients}
                          taskClientIds={taskClientIdsForUser(
                            {
                              checklists: data.checklists,
                              checklistTemplates: data.checklistTemplates,
                            },
                            member.id,
                          )}
                          onChangeClient={(clientId, nextIds) => {
                            updateClient(clientId, { assignedBookkeeperIds: nextIds })
                            void setClientAssignedTeamRequest(clientId, nextIds).catch(() => {
                              // best-effort; the next /api/app-data refresh reconciles
                            })
                          }}
                        />
                      ) : null}
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
                              // An empty box is not "clear this rate" any more —
                              // a version row has to carry a number — so Save
                              // stays off rather than doing nothing when pressed.
                              disabled={
                                billSavingId === member.id ||
                                (billDraft[member.id] ?? '').trim() === ''
                              }
                              onClick={() => void handleSaveBillRate(member)}
                            >
                              {billSavingId === member.id ? 'Saving…' : 'Save'}
                            </button>
                          </div>
                          <div className="team-cost-input-row team-rate-from">
                            <label htmlFor={`bill-from-${member.id}`} className="team-cost-hint">
                              Effective from
                            </label>
                            <input
                              id={`bill-from-${member.id}`}
                              type="month"
                              value={billFromDraft[member.id] ?? thisMonth}
                              onChange={(event) =>
                                setBillFromDraft((current) => ({
                                  ...current,
                                  [member.id]: event.target.value,
                                }))
                              }
                            />
                          </div>
                          <RateHistoryList
                            open={historyOpen[`bill-${member.id}`] === true}
                            onToggle={() =>
                              setHistoryOpen((current) => ({
                                ...current,
                                [`bill-${member.id}`]: !current[`bill-${member.id}`],
                              }))
                            }
                            rows={billVersionsFor(member.id).map((row) => ({
                              key: row.effectivePeriod,
                              when: row.effectivePeriod,
                              rate: row.rate,
                            }))}
                            onRemoveNewest={(key) => void handleRemoveBillVersion(member, key)}
                          />
                          {rateError[`bill-${member.id}`] ? (
                            <p className="team-error">{rateError[`bill-${member.id}`]}</p>
                          ) : null}
                        </div>
                      ) : null}
                      {/*
                        EVERY member gets this box, owners included
                        (featreq-6fdd9e98 — "I need to input a cost for me so I
                        can budget"). It used to be hidden for the Owner role on
                        the assumption that an owner draws no hourly wage; that
                        was never a rule the cost math enforced, only a box the
                        page withheld. An owner who leaves it blank still costs
                        nothing, exactly as before. Same gate as Bill rate above.
                      */}
                      {ownerMode ? (
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
                              // Same rule as the bill box above.
                              disabled={
                                costSavingId === member.id ||
                                (costDraft[member.id] ?? '').trim() === ''
                              }
                              onClick={() => void handleSaveCostRate(member)}
                            >
                              {costSavingId === member.id ? 'Saving…' : 'Save'}
                            </button>
                          </div>
                          <div className="team-cost-input-row team-rate-from">
                            <label htmlFor={`cost-from-${member.id}`} className="team-cost-hint">
                              Effective from
                            </label>
                            <input
                              id={`cost-from-${member.id}`}
                              type="date"
                              value={costFromDraft[member.id] ?? todayIso}
                              onChange={(event) =>
                                setCostFromDraft((current) => ({
                                  ...current,
                                  [member.id]: event.target.value,
                                }))
                              }
                            />
                          </div>
                          <RateHistoryList
                            open={historyOpen[`cost-${member.id}`] === true}
                            onToggle={() =>
                              setHistoryOpen((current) => ({
                                ...current,
                                [`cost-${member.id}`]: !current[`cost-${member.id}`],
                              }))
                            }
                            rows={costVersionsFor(member.id).map((row) => ({
                              key: row.effectiveDate,
                              when: row.effectiveDate,
                              rate: row.rate,
                            }))}
                            onRemoveNewest={(key) => void handleRemoveCostVersion(member, key)}
                          />
                          {rateError[`cost-${member.id}`] ? (
                            <p className="team-error">{rateError[`cost-${member.id}`]}</p>
                          ) : null}
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
            </>
          )
        })()}
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
 * Per-team-member view of the inverse relationship: every client this non-owner
 * is on the team of, with chips to take one away and a "+ Add client" pill to
 * put one on. It leads the expanded panel because re-picking these lists is the
 * open job — 13 of 55 clients still had an empty team on 2026-09-21.
 *
 * WHAT THIS FIELD IS. `assignedBookkeeperIds` is the EXPLICIT team and the
 * MONEY gate: since the 2026-09-04 team/visibility split it is the only thing
 * that puts a client's invoices on this person's Invoice Recap. What they can
 * SEE is computed separately and is deliberately wider — team ∪ every client
 * they hold live work on (`visibleClientIdsForUser`, lib/data-scope.js).
 *
 * WHY "Suggested" IS A SUGGESTION. The work-derived set used to be WRITTEN into
 * this field on every assignment, which is precisely how Lisa ended up able to
 * read the invoices of 33 clients nobody had ever put her on. So the block
 * below shows that set and nothing more: an owner adds each client (or all of
 * them) with a deliberate click, and only then does the money gate move. Do NOT
 * "optimize" this into an automatic backfill — that re-opens the leak the split
 * was built to close (docs/HANDOFF.md 2026-09-04,
 * docs/plans/team-visibility-split-2026-09.md).
 *
 * A billing master cannot turn up among the suggestions: the store refuses
 * tasks and recurring recipes against one (`_refuseBillingMasterWrite`), so a
 * master holds none of the work `taskClientIdsForUser` reads.
 */
function ClientsTheyCanSeeSection({
  memberId,
  memberName,
  clients,
  taskClientIds,
  onChangeClient,
}: {
  memberId: string
  memberName: string
  clients: Client[]
  /** Clients this person is assignee of live work on — the suggestion source. */
  taskClientIds: Set<string>
  onChangeClient: (clientId: string, nextIds: string[]) => void
}) {
  const [adderOpen, setAdderOpen] = useState(false)
  const [addedNote, setAddedNote] = useState('')
  const adderRef = useRef<HTMLDivElement | null>(null)

  // The add menu no longer closes on a pick — re-picking a team is a dozen
  // clients at a time and re-opening between each one was half the work. It
  // still needs the ordinary ways out, so they live here: click elsewhere,
  // Escape, or the pill itself.
  useEffect(() => {
    if (!adderOpen) return
    const handlePointer = (event: MouseEvent) => {
      if (!adderRef.current) return
      if (!adderRef.current.contains(event.target as Node)) setAdderOpen(false)
    }
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAdderOpen(false)
    }
    window.addEventListener('mousedown', handlePointer)
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('mousedown', handlePointer)
      window.removeEventListener('keydown', handleKey)
    }
  }, [adderOpen])

  const visibleClients = clients.filter((client) =>
    (client.assignedBookkeeperIds ?? []).includes(memberId),
  )
  // Nobody gets newly assigned to a retired client — that assignment's only
  // effect would be to put the client back in their time dropdown, which is
  // exactly what retiring took away. Existing assignments stay listed above
  // (and untouched on the record) so reactivating restores the team as it was.
  const addableClients = selectableClients(clients).filter(
    (client) => !(client.assignedBookkeeperIds ?? []).includes(memberId),
  )
  // Work they already hold, minus whoever is already on the team. Alphabetical
  // so the list reads the same way twice.
  const suggestedClients = addableClients
    .filter((client) => taskClientIds.has(client.id))
    .sort((a, b) => a.name.localeCompare(b.name))
  const firstName = memberName.trim().split(/\s+/)[0] || memberName

  const removeClient = (client: Client) => {
    const next = (client.assignedBookkeeperIds ?? []).filter((id) => id !== memberId)
    onChangeClient(client.id, next)
  }

  const addClient = (client: Client) => {
    const current = client.assignedBookkeeperIds ?? []
    if (current.includes(memberId)) return
    onChangeClient(client.id, [...current, memberId])
  }

  // One targeted save per client, in order — the same call a single add makes.
  // There is no bulk route for this on purpose: the workspace bulk save
  // rewrites every client, so a stale tab could clobber teams re-picked here.
  const addAllSuggested = () => {
    const count = suggestedClients.length
    if (count === 0) return
    for (const client of suggestedClients) addClient(client)
    setAddedNote(`Added ${count} client${count === 1 ? '' : 's'}.`)
  }

  return (
    <div className="sharing-control team-assigned-clients">
      <h4>Assigned clients</h4>
      <p className="sharing-helper">
        Who this person can see — and whose invoices they get on the Invoice Recap.
      </p>
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
          <div className="sharing-add" ref={adderRef}>
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
      {suggestedClients.length > 0 ? (
        <div className="team-suggested-clients">
          <p className="sharing-helper">
            <strong>Suggested.</strong> The {suggestedClients.length} client
            {suggestedClients.length === 1 ? '' : 's'} {firstName} currently has work on:
          </p>
          <div className="sharing-chips">
            {suggestedClients.map((client) => (
              <button
                key={client.id}
                type="button"
                className="add-person-pill"
                onClick={() => addClient(client)}
              >
                + {client.name}
              </button>
            ))}
            <button type="button" className="add-person-pill" onClick={addAllSuggested}>
              Add all {suggestedClients.length}
            </button>
          </div>
        </div>
      ) : null}
      {addedNote ? <span className="team-success-copy">{addedNote}</span> : null}
    </div>
  )
}

/** What the cost-rate migration stamps on a rate that predates the history. */
const EPOCH_DAY = '1970-01-01'

/**
 * The prior versions of one rate, behind a disclosure.
 *
 * REMOVE IS OFFERED ON THE NEWEST ROW ONLY, because that is the only one the
 * server will delete: an older version is what past months were billed or
 * costed at, and removing it would silently reprice them. The server refuses
 * regardless — this just stops the page offering a button that cannot work.
 *
 * `rows` arrive from the server already sorted oldest-first per person, so
 * nothing here re-sorts them.
 */
function RateHistoryList({
  open,
  onToggle,
  rows,
  onRemoveNewest,
}: {
  open: boolean
  onToggle: () => void
  rows: Array<{ key: string; when: string; rate: number }>
  onRemoveNewest: (key: string) => void
}) {
  if (rows.length === 0) return null
  const newest = rows[rows.length - 1]
  return (
    <div className="team-rate-history">
      <button type="button" className="team-icon-button" onClick={onToggle}>
        Rate history ({rows.length})
      </button>
      {open ? (
        <ul className="recap-list">
          {rows.map((row) => (
            <li key={row.key}>
              {/*
                The migration seeds every pre-existing cost rate at the epoch,
                so "1970-01-01" is not a date anyone chose — it means the rate
                has been in force for as long as the records go.
              */}
              <span>{row.when === EPOCH_DAY ? 'Since the start' : row.when}</span>
              <span>{currency.format(row.rate)}/hr</span>
              {row.key === newest.key ? (
                <button
                  type="button"
                  className="team-icon-button"
                  onClick={() => onRemoveNewest(row.key)}
                >
                  Remove
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
