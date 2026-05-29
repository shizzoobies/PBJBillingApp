import {
  ApiError,
  type ActivityEntry,
  type AppData,
  type Checklist,
  type ChecklistTemplate,
  type ChecklistTemplateItem,
  type Client,
  type FirmSettings,
  type NotificationEntry,
  type PublicFirmSettings,
  type SessionUser,
  type TeamMember,
  type TeamSession,
  type RecurringReimbursement,
  type RecurringReimbursementFrequency,
  type Reimbursement,
  type TimeEntry,
  type TimesheetLock,
  type TotpSetupInit,
  type TotpStatus,
  type WeeklySubmission,
} from './types'

/**
 * Module-level preview state. `AppContext` calls `setPreviewModeActive`
 * whenever `previewMode` changes so that the central fetch wrapper can tag
 * every outgoing request with `X-Preview-Mode: 1`. The server rejects any
 * write verb carrying that header — a server-side guarantee that preview
 * mode stays strictly read-only even if a client-side guard is missed.
 */
let previewModeActive = false

export function setPreviewModeActive(active: boolean) {
  previewModeActive = active
}

/**
 * Central fetch wrapper. Identical to `fetch` except it injects the
 * `X-Preview-Mode` header while an owner is previewing another user.
 */
function apiFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  if (!previewModeActive) {
    return fetch(input, init)
  }
  const headers = new Headers(init.headers)
  headers.set('X-Preview-Mode', '1')
  return fetch(input, { ...init, headers })
}

export async function fetchFirmSettings(signal?: AbortSignal) {
  const response = await apiFetch('/api/firm-settings', { credentials: 'same-origin', signal })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to load firm settings (${response.status})`)
  }
  return (await response.json()) as FirmSettings
}

export async function updateFirmSettingsRequest(patch: Partial<FirmSettings>) {
  const response = await apiFetch('/api/firm-settings', {
    credentials: 'same-origin',
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to save firm settings (${response.status})`)
  }
  return (await response.json()) as FirmSettings
}

export async function fetchPublicFirmSettings(signal?: AbortSignal) {
  const response = await apiFetch('/api/firm-settings/public', {
    credentials: 'same-origin',
    signal,
  })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to load public firm settings (${response.status})`)
  }
  return (await response.json()) as PublicFirmSettings
}

export async function fetchAppData(signal: AbortSignal, previewAs?: string | null) {
  const url = previewAs
    ? `/api/app-data?previewAs=${encodeURIComponent(previewAs)}`
    : '/api/app-data'
  const response = await apiFetch(url, { credentials: 'same-origin', signal })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to load app data (${response.status})`)
  }

  return (await response.json()) as AppData
}

export async function saveAppData(data: AppData) {
  const response = await apiFetch('/api/app-data', {
    credentials: 'same-origin',
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  })

  if (!response.ok) {
    throw new ApiError(response.status, `Failed to save app data (${response.status})`)
  }
}

export async function fetchSession(signal: AbortSignal) {
  const response = await apiFetch('/api/session', { credentials: 'same-origin', signal })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to load session (${response.status})`)
  }

  return (await response.json()) as { user: SessionUser | null }
}

/**
 * Email-gated sign-in: request a sign-in link. The server always returns the
 * same generic ok response so callers cannot infer whether the email is
 * registered or whether the role hint matched.
 */
/**
 * Send a magic sign-in link to the given email. The server no longer
 * cares about role — it looks the user up in the DB and sends to anyone
 * with a real account. Response is always a generic "ok" (no enumeration
 * of which addresses are registered).
 */
export async function requestSignInLink(email: string) {
  const response = await apiFetch('/api/auth/request-link', {
    credentials: 'same-origin',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  })

  if (!response.ok) {
    throw new ApiError(response.status, `Failed to request sign-in link (${response.status})`)
  }

  return (await response.json()) as { ok: boolean; message: string }
}

/**
 * Password sign-in. Returns the server's `next` directive so the caller
 * can route to home / two-factor / two-factor-setup. The session cookie
 * (or pending-2FA cookie) is set as a side effect — same-origin, no
 * additional handling needed by the caller. Errors carry a real message
 * (invalid creds, rate-limited, etc.) so the form can render it.
 */
export type PasswordSignInResult = {
  next: 'home' | 'two-factor' | 'two-factor-setup'
}

export async function signInWithPasswordRequest(email: string, password: string) {
  const response = await apiFetch('/api/auth/sign-in-with-password', {
    credentials: 'same-origin',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })

  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(
      response.status,
      message || `Sign-in failed (${response.status})`,
    )
  }

  return (await response.json()) as PasswordSignInResult
}

/**
 * Set or change the caller's own password. Session cookie is the
 * authorization. SECURITY (M4): once the user has set their own password the
 * server requires `currentPassword` and verifies it before allowing the
 * change (so a hijacked session can't silently lock the real user out). On a
 * first-time set — a magic-link user still on the random default — the server
 * ignores `currentPassword` and a valid session is enough. The caller always
 * passes the field (empty string when the user hasn't filled it in); the
 * server enforces a minimum length on the new password.
 */
export async function changePasswordRequest(newPassword: string, currentPassword = '') {
  const response = await apiFetch('/api/auth/change-password', {
    credentials: 'same-origin',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newPassword, currentPassword }),
  })
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(
      response.status,
      message || `Failed to change password (${response.status})`,
    )
  }
  return (await response.json()) as { ok: true }
}

export async function logoutSession() {
  const response = await apiFetch('/api/logout', {
    credentials: 'same-origin',
    method: 'POST',
  })

  if (!response.ok && response.status !== 204) {
    throw new ApiError(response.status, `Failed to log out (${response.status})`)
  }
}

export async function createTimeEntry(entry: Omit<TimeEntry, 'id' | 'approvalStatus'>) {
  const response = await apiFetch('/api/time-entries', {
    credentials: 'same-origin',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(entry),
  })

  if (!response.ok) {
    throw new ApiError(response.status, `Failed to create time entry (${response.status})`)
  }

  return (await response.json()) as TimeEntry
}

export async function updateTimeEntryRequest(
  entryId: string,
  patch: {
    minutes?: number
    description?: string
    billable?: boolean
    taskId?: string | null
    date?: string
  },
) {
  const response = await apiFetch(`/api/time-entries/${encodeURIComponent(entryId)}`, {
    credentials: 'same-origin',
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to update time entry (${response.status})`)
  }
  return (await response.json()) as TimeEntry
}

export async function deleteTimeEntryRequest(entryId: string) {
  const response = await apiFetch(`/api/time-entries/${encodeURIComponent(entryId)}`, {
    credentials: 'same-origin',
    method: 'DELETE',
  })
  if (!response.ok && response.status !== 204) {
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to delete time entry (${response.status})`)
  }
}

/** Owner-only: approve a single pending/rejected time entry. */
export async function approveTimeEntryRequest(entryId: string) {
  const response = await apiFetch(`/api/time-entries/${encodeURIComponent(entryId)}/approve`, {
    credentials: 'same-origin',
    method: 'POST',
  })
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to approve entry (${response.status})`)
  }
  return (await response.json()) as TimeEntry
}

/** Owner-only: reject a time entry. A note is required. */
export async function rejectTimeEntryRequest(entryId: string, note: string) {
  const response = await apiFetch(`/api/time-entries/${encodeURIComponent(entryId)}/reject`, {
    credentials: 'same-origin',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note }),
  })
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to reject entry (${response.status})`)
  }
  return (await response.json()) as TimeEntry
}

/** Owner-only: approve a batch of entries (e.g. "approve all for employee"). */
export async function approveTimeEntriesBatchRequest(entryIds: string[]) {
  const response = await apiFetch('/api/time-entries/approve-batch', {
    credentials: 'same-origin',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entryIds }),
  })
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to approve entries (${response.status})`)
  }
  return (await response.json()) as { ok: boolean; approved: number }
}

/** Owner-only: lock a month for an employee (auto-approves pending entries). */
export async function lockTimesheetRequest(userId: string, period: string) {
  const response = await apiFetch('/api/timesheets/lock', {
    credentials: 'same-origin',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, period }),
  })
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to lock timesheet (${response.status})`)
  }
  return (await response.json()) as { ok: boolean; lock: TimesheetLock | null }
}

/** Owner-only: unlock a previously locked month for an employee. */
export async function unlockTimesheetRequest(userId: string, period: string) {
  const response = await apiFetch('/api/timesheets/unlock', {
    credentials: 'same-origin',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, period }),
  })
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to unlock timesheet (${response.status})`)
  }
  return (await response.json()) as { ok: boolean; removed: boolean }
}

/**
 * Submit the caller's own Sun-Sat week for owner review. The server takes
 * the userId from the session, so the body only carries `weekStart` (the
 * Sunday that anchors the week, YYYY-MM-DD). Re-submitting an already
 * pending or rejected week upgrades the same row back to pending.
 */
export async function submitWeeklyTimesheetRequest(weekStart: string) {
  const response = await apiFetch('/api/timesheets/weekly-submissions', {
    credentials: 'same-origin',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ weekStart }),
  })
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(
      response.status,
      message || `Failed to submit weekly timesheet (${response.status})`,
    )
  }
  return (await response.json()) as WeeklySubmission
}

/** Owner approves a pending weekly submission. */
export async function approveWeeklySubmissionRequest(submissionId: string) {
  const response = await apiFetch(
    `/api/timesheets/weekly-submissions/${encodeURIComponent(submissionId)}/approve`,
    {
      credentials: 'same-origin',
      method: 'POST',
    },
  )
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(
      response.status,
      message || `Failed to approve weekly submission (${response.status})`,
    )
  }
  return (await response.json()) as WeeklySubmission
}

/** Owner-only: create a new reimbursement line on a client. */
export async function addReimbursementRequest(input: {
  clientId: string
  date: string
  description: string
  amount: number
}) {
  const response = await apiFetch('/api/reimbursements', {
    credentials: 'same-origin',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(
      response.status,
      message || `Failed to add reimbursement (${response.status})`,
    )
  }
  return (await response.json()) as Reimbursement
}

/** Owner-only: update an existing reimbursement. Patch fields are optional. */
export async function updateReimbursementRequest(
  id: string,
  patch: { date?: string; description?: string; amount?: number },
) {
  const response = await apiFetch(`/api/reimbursements/${encodeURIComponent(id)}`, {
    credentials: 'same-origin',
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(
      response.status,
      message || `Failed to update reimbursement (${response.status})`,
    )
  }
  return (await response.json()) as Reimbursement
}

/** Owner-only: delete a reimbursement. */
export async function deleteReimbursementRequest(id: string) {
  const response = await apiFetch(`/api/reimbursements/${encodeURIComponent(id)}`, {
    credentials: 'same-origin',
    method: 'DELETE',
  })
  if (!response.ok && response.status !== 204) {
    const message = await safeErrorMessage(response)
    throw new ApiError(
      response.status,
      message || `Failed to delete reimbursement (${response.status})`,
    )
  }
}

/**
 * Owner-only subscription plan delete. Returns the affected client ids so
 * the caller can flip their `planId` to null locally — the FK already does
 * that server-side via `on delete set null`.
 */
export async function deletePlanRequest(id: string) {
  const response = await apiFetch(`/api/plans/${encodeURIComponent(id)}`, {
    credentials: 'same-origin',
    method: 'DELETE',
  })
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(
      response.status,
      message || `Failed to delete plan (${response.status})`,
    )
  }
  return (await response.json()) as { removedPlanId: string; unlinkedClientIds: string[] }
}

/** Owner-only: create a recurring reimbursement on a client. */
export async function addRecurringReimbursementRequest(input: {
  clientId: string
  description: string
  amount: number
  frequency: RecurringReimbursementFrequency
  startDate: string
}) {
  const response = await apiFetch('/api/recurring-reimbursements', {
    credentials: 'same-origin',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(
      response.status,
      message || `Failed to add recurring reimbursement (${response.status})`,
    )
  }
  return (await response.json()) as RecurringReimbursement
}

/** Owner-only: update an existing recurring reimbursement. */
export async function updateRecurringReimbursementRequest(
  id: string,
  patch: {
    description?: string
    amount?: number
    frequency?: RecurringReimbursementFrequency
    startDate?: string
  },
) {
  const response = await apiFetch(
    `/api/recurring-reimbursements/${encodeURIComponent(id)}`,
    {
      credentials: 'same-origin',
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    },
  )
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(
      response.status,
      message || `Failed to update recurring reimbursement (${response.status})`,
    )
  }
  return (await response.json()) as RecurringReimbursement
}

/** Owner-only: delete a recurring reimbursement. */
export async function deleteRecurringReimbursementRequest(id: string) {
  const response = await apiFetch(
    `/api/recurring-reimbursements/${encodeURIComponent(id)}`,
    {
      credentials: 'same-origin',
      method: 'DELETE',
    },
  )
  if (!response.ok && response.status !== 204) {
    const message = await safeErrorMessage(response)
    throw new ApiError(
      response.status,
      message || `Failed to delete recurring reimbursement (${response.status})`,
    )
  }
}

/** Owner rejects a pending weekly submission with a note (the rationale). */
export async function rejectWeeklySubmissionRequest(submissionId: string, note: string) {
  const response = await apiFetch(
    `/api/timesheets/weekly-submissions/${encodeURIComponent(submissionId)}/reject`,
    {
      credentials: 'same-origin',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note }),
    },
  )
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(
      response.status,
      message || `Failed to reject weekly submission (${response.status})`,
    )
  }
  return (await response.json()) as WeeklySubmission
}

export async function toggleChecklistItemRequest(
  checklistId: string,
  itemId: string,
  subItemId?: string,
  subSubItemId?: string,
) {
  // A sub-sub-item toggle must carry its parent `subItemId` too so the server
  // can locate it; a sub-item toggle carries just `subItemId`.
  const body =
    subItemId && subSubItemId
      ? { subItemId, subSubItemId }
      : subItemId
        ? { subItemId }
        : null
  const response = await apiFetch(`/api/checklists/${checklistId}/items/${itemId}/toggle`, {
    credentials: 'same-origin',
    method: 'POST',
    ...(body
      ? {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  })

  if (!response.ok) {
    throw new ApiError(response.status, `Failed to update checklist item (${response.status})`)
  }

  return (await response.json()) as Checklist
}

/** Add a sub-item (one nested level) under a live-checklist item. */
export async function addChecklistSubItemRequest(
  checklistId: string,
  itemId: string,
  title: string,
) {
  const response = await apiFetch(
    `/api/checklists/${checklistId}/items/${itemId}/sub-items`,
    {
      credentials: 'same-origin',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    },
  )
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to add sub-item (${response.status})`)
  }
  return (await response.json()) as Checklist
}

/** Remove a sub-item from a live-checklist item. */
export async function removeChecklistSubItemRequest(
  checklistId: string,
  itemId: string,
  subItemId: string,
) {
  const response = await apiFetch(
    `/api/checklists/${checklistId}/items/${itemId}/sub-items/${subItemId}`,
    {
      credentials: 'same-origin',
      method: 'DELETE',
    },
  )
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to remove sub-item (${response.status})`)
  }
  return (await response.json()) as Checklist
}

/** Add a sub-sub-item (the deepest level) under a sub-item of a live checklist. */
export async function addChecklistSubSubItemRequest(
  checklistId: string,
  itemId: string,
  subItemId: string,
  title: string,
) {
  const response = await apiFetch(
    `/api/checklists/${checklistId}/items/${itemId}/sub-items/${subItemId}/sub-items`,
    {
      credentials: 'same-origin',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    },
  )
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(
      response.status,
      message || `Failed to add sub-sub-item (${response.status})`,
    )
  }
  return (await response.json()) as Checklist
}

/** Remove a sub-sub-item from a sub-item of a live checklist. */
export async function removeChecklistSubSubItemRequest(
  checklistId: string,
  itemId: string,
  subItemId: string,
  subSubItemId: string,
) {
  const response = await apiFetch(
    `/api/checklists/${checklistId}/items/${itemId}/sub-items/${subItemId}/sub-items/${subSubItemId}`,
    {
      credentials: 'same-origin',
      method: 'DELETE',
    },
  )
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(
      response.status,
      message || `Failed to remove sub-sub-item (${response.status})`,
    )
  }
  return (await response.json()) as Checklist
}

export async function setChecklistViewersRequest(
  checklistId: string,
  viewerIds: string[],
  editorIds: string[],
) {
  const response = await apiFetch(`/api/checklists/${checklistId}/viewers`, {
    credentials: 'same-origin',
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ viewerIds, editorIds }),
  })

  if (!response.ok) {
    throw new ApiError(response.status, `Failed to update checklist viewers (${response.status})`)
  }

  return (await response.json()) as Checklist
}

export async function fetchTeam(signal?: AbortSignal) {
  const response = await apiFetch('/api/team', { credentials: 'same-origin', signal })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to load team (${response.status})`)
  }
  return (await response.json()) as { users: TeamMember[] }
}

/** Owner-only: persist a new top-to-bottom order for the team roster. */
export async function reorderTeamMembersRequest(userIds: string[]) {
  const response = await apiFetch('/api/team/reorder', {
    credentials: 'same-origin',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userIds }),
  })
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to reorder team (${response.status})`)
  }
  return (await response.json()) as { users: TeamMember[] }
}

export async function inviteTeamMember(payload: { name: string; email: string; role: string }) {
  const response = await apiFetch('/api/team/invite', {
    credentials: 'same-origin',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to invite member (${response.status})`)
  }
  return (await response.json()) as { user: TeamMember }
}

/** Owner-only: resend a one-time email sign-in link to a team member. */
export async function resendTeamSignInLink(userId: string) {
  const response = await apiFetch(`/api/team/${encodeURIComponent(userId)}/resend-link`, {
    credentials: 'same-origin',
    method: 'POST',
  })
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(
      response.status,
      message || `Failed to resend sign-in link (${response.status})`,
    )
  }
  return (await response.json()) as { ok: boolean }
}

/** Owner-only: list a team member's active (non-revoked) sessions. */
export async function fetchTeamSessions(userId: string, signal?: AbortSignal) {
  const response = await apiFetch(`/api/team/${encodeURIComponent(userId)}/sessions`, {
    credentials: 'same-origin',
    signal,
  })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to load sessions (${response.status})`)
  }
  return (await response.json()) as { sessions: TeamSession[] }
}

/** Owner-only: revoke one specific session for a team member. */
export async function revokeTeamSession(userId: string, sessionId: string) {
  const response = await apiFetch(
    `/api/team/${encodeURIComponent(userId)}/sessions/${encodeURIComponent(sessionId)}/revoke`,
    { credentials: 'same-origin', method: 'POST' },
  )
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to revoke session (${response.status})`)
  }
  return (await response.json()) as { ok: boolean }
}

/** Owner-only: revoke every active session for a team member at once. */
export async function revokeAllTeamSessions(userId: string) {
  const response = await apiFetch(
    `/api/team/${encodeURIComponent(userId)}/sessions/revoke-all`,
    { credentials: 'same-origin', method: 'POST' },
  )
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to revoke sessions (${response.status})`)
  }
  return (await response.json()) as { revoked: number }
}

export async function deleteTeamMember(userId: string) {
  const response = await apiFetch(`/api/team/${encodeURIComponent(userId)}`, {
    credentials: 'same-origin',
    method: 'DELETE',
  })
  if (!response.ok && response.status !== 204) {
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to remove member (${response.status})`)
  }
}

export type AuthStatus = {
  ownerEmailConfigured: boolean
  adminEmailConfigured: boolean
  sendingDomain: string | null
  appUrl: string
}

export async function fetchAuthStatus(signal?: AbortSignal) {
  const response = await apiFetch('/api/auth/status', { credentials: 'same-origin', signal })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to load auth status (${response.status})`)
  }
  return (await response.json()) as AuthStatus
}

export async function fetchGlobalActivity(limit = 15, signal?: AbortSignal) {
  const response = await apiFetch(`/api/activity?limit=${limit}`, {
    credentials: 'same-origin',
    signal,
  })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to load activity (${response.status})`)
  }
  return (await response.json()) as { entries: ActivityEntry[] }
}

export async function fetchActivityRange(
  fromIso: string,
  toIso: string,
  limit = 2000,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({ from: fromIso, to: toIso, limit: String(limit) })
  const response = await apiFetch(`/api/activity/range?${params.toString()}`, {
    credentials: 'same-origin',
    signal,
  })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to load activity range (${response.status})`)
  }
  return (await response.json()) as { entries: ActivityEntry[] }
}

export async function fetchTeamActivity(userId: string, limit = 20) {
  const response = await apiFetch(
    `/api/team/${encodeURIComponent(userId)}/activity?limit=${limit}`,
    { credentials: 'same-origin' },
  )
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to load activity (${response.status})`)
  }
  return (await response.json()) as { entries: ActivityEntry[] }
}

export async function reorderChecklistItemsRequest(checklistId: string, itemIds: string[]) {
  const response = await apiFetch(`/api/checklists/${checklistId}/items/reorder`, {
    credentials: 'same-origin',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemIds }),
  })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to reorder checklist items (${response.status})`)
  }
  return (await response.json()) as Checklist
}

export async function createChecklistRequest(payload: {
  title: string
  clientId: string
  assigneeId: string
  dueDate: string
  /**
   * Checklist items. May carry a nested `subItems` tree (sub-steps and
   * sub-sub-steps) built in the outliner-style create form — the server
   * normalizes the tree (fresh ids, roll-up done) on persist.
   */
  items: Array<Pick<ChecklistTemplateItem, 'label' | 'subItems'>>
}) {
  const response = await apiFetch('/api/checklists', {
    credentials: 'same-origin',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(
      response.status,
      message || `Failed to create checklist (${response.status})`,
    )
  }
  return (await response.json()) as Checklist
}

export async function appendChecklistItemsRequest(checklistId: string, titles: string[]) {
  const response = await apiFetch(`/api/checklists/${checklistId}/items`, {
    credentials: 'same-origin',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ titles }),
  })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to add checklist items (${response.status})`)
  }
  return (await response.json()) as Checklist
}

export async function updateChecklistItemRequest(
  checklistId: string,
  itemId: string,
  patch: { title?: string; dueDate?: string | null; assigneeId?: string | null },
) {
  const response = await apiFetch(`/api/checklists/${checklistId}/items/${itemId}`, {
    credentials: 'same-origin',
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to update checklist item (${response.status})`)
  }
  return (await response.json()) as Checklist
}

export async function deleteChecklistItemRequest(checklistId: string, itemId: string) {
  const response = await apiFetch(`/api/checklists/${checklistId}/items/${itemId}`, {
    credentials: 'same-origin',
    method: 'DELETE',
  })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to delete checklist item (${response.status})`)
  }
  return (await response.json()) as Checklist
}

/**
 * Soft-delete an entire checklist (move it to the owner's recycle bin).
 * Owner-only on the server; the client also gates the UI affordance.
 * Returns `{ ok, removed }` so callers don't have to re-parse the URL.
 */
export async function deleteChecklistRequest(checklistId: string) {
  const response = await apiFetch(`/api/checklists/${encodeURIComponent(checklistId)}`, {
    credentials: 'same-origin',
    method: 'DELETE',
  })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to delete checklist (${response.status})`)
  }
  return (await response.json()) as { ok: true; removed: string }
}

/**
 * Restore a soft-deleted checklist from the recycle bin. Owner-only. The
 * server returns the freshly-active Checklist so the client can drop it
 * straight back into `data.checklists` without a full refetch.
 */
export async function restoreChecklistRequest(checklistId: string) {
  const response = await apiFetch(
    `/api/checklists/${encodeURIComponent(checklistId)}/restore`,
    {
      credentials: 'same-origin',
      method: 'POST',
    },
  )
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to restore checklist (${response.status})`)
  }
  return (await response.json()) as Checklist
}

/**
 * Permanently delete every checklist in the owner's recycle bin. Owner-only.
 * Returns the count of removed rows so the UI can confirm what happened.
 */
export async function emptyChecklistRecycleBinRequest() {
  const response = await apiFetch('/api/checklists/recycle-bin', {
    credentials: 'same-origin',
    method: 'DELETE',
  })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to empty recycle bin (${response.status})`)
  }
  return (await response.json()) as { ok: true; removed: number }
}

export async function setClientAssignedTeamRequest(clientId: string, bookkeeperIds: string[]) {
  const response = await apiFetch(
    `/api/clients/${encodeURIComponent(clientId)}/assigned-team`,
    {
      credentials: 'same-origin',
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookkeeperIds }),
    },
  )
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(
      response.status,
      message || `Failed to update assigned team (${response.status})`,
    )
  }
  return (await response.json()) as Client
}

export async function recordClientProfileActivity(clientId: string) {
  const response = await apiFetch(`/api/clients/${encodeURIComponent(clientId)}/activity`, {
    credentials: 'same-origin',
    method: 'POST',
  })
  if (!response.ok && response.status !== 204) {
    throw new ApiError(response.status, `Failed to record client activity (${response.status})`)
  }
}

async function safeErrorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json()
    if (body && typeof body.error === 'string') {
      return body.error
    }
  } catch {
    // ignore
  }
  return ''
}

// ---- Phase 3: stages + cases ----

export type CaseDetail = {
  caseId: string
  template: ChecklistTemplate
  client: { id: string; name: string } | null
  stages: Array<{ stage: NonNullable<ChecklistTemplate['stages']>[number]; checklist: Checklist | null }>
  activity: ActivityEntry[]
}

export async function fetchCase(caseId: string, signal?: AbortSignal) {
  const response = await apiFetch(`/api/cases/${encodeURIComponent(caseId)}`, {
    credentials: 'same-origin',
    signal,
  })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to load case (${response.status})`)
  }
  return (await response.json()) as CaseDetail
}

export async function addTemplateStageRequest(
  templateId: string,
  payload: {
    name?: string
    assigneeId?: string
    offsetDays?: number
    viewerIds?: string[]
    editorIds?: string[]
  },
) {
  const response = await apiFetch(`/api/checklist-templates/${templateId}/stages`, {
    credentials: 'same-origin',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to add stage (${response.status})`)
  }
  return (await response.json()) as ChecklistTemplate
}

export async function patchTemplateStageRequest(
  templateId: string,
  stageId: string,
  patch: {
    name?: string
    assigneeId?: string
    offsetDays?: number
    viewerIds?: string[]
    editorIds?: string[]
  },
) {
  const response = await apiFetch(
    `/api/checklist-templates/${templateId}/stages/${encodeURIComponent(stageId)}`,
    {
      credentials: 'same-origin',
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    },
  )
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to update stage (${response.status})`)
  }
  return (await response.json()) as ChecklistTemplate
}

export async function deleteTemplateStageRequest(templateId: string, stageId: string) {
  const response = await apiFetch(
    `/api/checklist-templates/${templateId}/stages/${encodeURIComponent(stageId)}`,
    {
      credentials: 'same-origin',
      method: 'DELETE',
    },
  )
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to remove stage (${response.status})`)
  }
  return (await response.json()) as ChecklistTemplate
}

export async function reorderTemplateStagesRequest(templateId: string, stageIds: string[]) {
  const response = await apiFetch(`/api/checklist-templates/${templateId}/stages/reorder`, {
    credentials: 'same-origin',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stageIds }),
  })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to reorder stages (${response.status})`)
  }
  return (await response.json()) as ChecklistTemplate
}

export async function setTemplateViewersRequest(
  templateId: string,
  viewerIds: string[],
  editorIds: string[],
) {
  const response = await apiFetch(`/api/checklist-templates/${templateId}/viewers`, {
    credentials: 'same-origin',
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ viewerIds, editorIds }),
  })

  if (!response.ok) {
    throw new ApiError(response.status, `Failed to update template viewers (${response.status})`)
  }

  return (await response.json()) as ChecklistTemplate
}

// ---- Wave 2: standard templates, apply/copy to client, on-demand generate ----

/** Owner-only: create a standard (client-agnostic) reusable blueprint template. */
export async function createStandardTemplateRequest(
  payload: Omit<ChecklistTemplate, 'id' | 'clientId' | 'isStandard'> &
    Partial<Pick<ChecklistTemplate, 'clientId' | 'isStandard'>>,
) {
  const response = await apiFetch('/api/checklist-templates/standard', {
    credentials: 'same-origin',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(
      response.status,
      message || `Failed to create standard template (${response.status})`,
    )
  }
  return (await response.json()) as ChecklistTemplate
}

/**
 * Owner-only: copy a standard OR regular template onto a client, producing a
 * new regular client-bound template.
 */
export async function applyTemplateToClientRequest(
  templateId: string,
  payload: { clientId: string; firstDueDate?: string; frequency?: string },
) {
  const response = await apiFetch(
    `/api/checklist-templates/${encodeURIComponent(templateId)}/apply-to-client`,
    {
      credentials: 'same-origin',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  )
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(
      response.status,
      message || `Failed to apply template to client (${response.status})`,
    )
  }
  return (await response.json()) as ChecklistTemplate
}

/**
 * Owner-only: materialize a Stage-1 checklist instance from a template on
 * demand ("Generate a task now" / "Start the first one now").
 */
export async function generateChecklistFromTemplateRequest(
  templateId: string,
  payload: { dueDate?: string } = {},
) {
  const response = await apiFetch(
    `/api/checklist-templates/${encodeURIComponent(templateId)}/generate`,
    {
      credentials: 'same-origin',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  )
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(
      response.status,
      message || `Failed to generate task (${response.status})`,
    )
  }
  return (await response.json()) as Checklist
}

// ---- Phase 5: notifications ----

export async function fetchNotifications(
  { unreadOnly = false, limit = 50 }: { unreadOnly?: boolean; limit?: number } = {},
  signal?: AbortSignal,
) {
  const params = new URLSearchParams()
  if (unreadOnly) params.set('unreadOnly', 'true')
  if (limit) params.set('limit', String(limit))
  const response = await apiFetch(`/api/notifications?${params.toString()}`, {
    credentials: 'same-origin',
    signal,
  })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to load notifications (${response.status})`)
  }
  return (await response.json()) as { entries: NotificationEntry[] }
}

export async function fetchUnreadNotificationCount(signal?: AbortSignal) {
  const response = await apiFetch('/api/notifications/unread-count', {
    credentials: 'same-origin',
    signal,
  })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to load unread count (${response.status})`)
  }
  return (await response.json()) as { count: number }
}

export async function markNotificationReadRequest(notificationId: string) {
  const response = await apiFetch(
    `/api/notifications/${encodeURIComponent(notificationId)}/read`,
    { credentials: 'same-origin', method: 'POST' },
  )
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to mark notification read (${response.status})`)
  }
  return (await response.json()) as NotificationEntry
}

export async function markAllNotificationsReadRequest() {
  const response = await apiFetch('/api/notifications/read-all', {
    credentials: 'same-origin',
    method: 'POST',
  })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to mark all read (${response.status})`)
  }
  return (await response.json()) as { updated: number }
}

// ---- TOTP two-factor authentication ----

export async function fetchTotpStatus(signal?: AbortSignal) {
  const response = await apiFetch('/api/auth/totp/status', { credentials: 'same-origin', signal })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to load 2FA status (${response.status})`)
  }
  return (await response.json()) as TotpStatus
}

export async function totpSetupInit() {
  const response = await apiFetch('/api/auth/totp/setup-init', {
    credentials: 'same-origin',
    method: 'POST',
  })
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to start setup (${response.status})`)
  }
  return (await response.json()) as TotpSetupInit
}

export async function totpSetupVerify(code: string) {
  const response = await apiFetch('/api/auth/totp/setup-verify', {
    credentials: 'same-origin',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Could not verify code (${response.status})`)
  }
  return (await response.json()) as {
    ok: boolean
    backupCodes: string[]
    needsSessionFinalize: boolean
  }
}

export async function totpSetupComplete() {
  const response = await apiFetch('/api/auth/totp/setup-complete', {
    credentials: 'same-origin',
    method: 'POST',
  })
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to finalize sign-in (${response.status})`)
  }
  return (await response.json()) as { ok: boolean; redirectTo: string }
}

export async function totpVerifyChallenge(code: string) {
  const response = await apiFetch('/api/auth/totp/verify', {
    credentials: 'same-origin',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Could not verify code (${response.status})`)
  }
  return (await response.json()) as { ok: boolean; redirectTo: string }
}

export async function totpVerifyBackupChallenge(code: string) {
  const response = await apiFetch('/api/auth/totp/verify-backup', {
    credentials: 'same-origin',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(
      response.status,
      message || `Could not verify backup code (${response.status})`,
    )
  }
  return (await response.json()) as {
    ok: boolean
    redirectTo: string
    remainingBackupCodes: number
  }
}

export async function totpDisable(code: string) {
  const response = await apiFetch('/api/auth/totp/disable', {
    credentials: 'same-origin',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to disable 2FA (${response.status})`)
  }
  return (await response.json()) as { ok: boolean }
}

export async function totpRegenerateBackups(code: string) {
  const response = await apiFetch('/api/auth/totp/regenerate-backups', {
    credentials: 'same-origin',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(
      response.status,
      message || `Failed to regenerate backup codes (${response.status})`,
    )
  }
  return (await response.json()) as { ok: boolean; backupCodes: string[] }
}

export async function teamTotpReset(userId: string) {
  const response = await apiFetch(`/api/team/${encodeURIComponent(userId)}/totp/reset`, {
    credentials: 'same-origin',
    method: 'POST',
  })
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to reset 2FA (${response.status})`)
  }
  return (await response.json()) as { ok: boolean }
}
