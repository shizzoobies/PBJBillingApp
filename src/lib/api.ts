import {
  ApiError,
  type ActivityEntry,
  type AppData,
  type Checklist,
  type ChecklistTemplate,
  type ChecklistTemplateItem,
  type Client,
  type ClientNote,
  type FeatureRequest,
  type FeatureRequestType,
  type ItemDeletionRequest,
  type PendingTaskEdit,
  type FirmSettings,
  type NotificationEntry,
  type PublicFirmSettings,
  type ServiceCategory,
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
  type WaitingOnMeItem,
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
    startAt?: string
    endAt?: string
    sessions?: { startAt: string; endAt: string }[]
    employeeId?: string
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

/** Owner reopens an APPROVED weekly submission (un-approve → back to pending). */
export async function reopenWeeklySubmissionRequest(submissionId: string) {
  const response = await apiFetch(
    `/api/timesheets/weekly-submissions/${encodeURIComponent(submissionId)}/reopen`,
    {
      credentials: 'same-origin',
      method: 'POST',
    },
  )
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(
      response.status,
      message || `Failed to reopen weekly submission (${response.status})`,
    )
  }
  return (await response.json()) as WeeklySubmission
}

// ---- "To 100%" setup-issue ignore list (owner-only) ----

/** The setup-issue ids the owner has ignored. */
export async function fetchDismissedSetupIssues(): Promise<string[]> {
  const response = await apiFetch('/api/setup/dismissed', { credentials: 'same-origin' })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to load ignored items (${response.status})`)
  }
  return ((await response.json()) as { ids: string[] }).ids ?? []
}

/** Ignore (dismiss) one setup issue by its stable id. */
export async function dismissSetupIssueRequest(issueId: string): Promise<void> {
  const response = await apiFetch('/api/setup/dismissed', {
    credentials: 'same-origin',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ issueId }),
  })
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to ignore item (${response.status})`)
  }
}

/** Restore (un-ignore) one setup issue. */
export async function restoreSetupIssueRequest(issueId: string): Promise<void> {
  const response = await apiFetch(`/api/setup/dismissed/${encodeURIComponent(issueId)}`, {
    credentials: 'same-origin',
    method: 'DELETE',
  })
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to restore item (${response.status})`)
  }
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

/**
 * Result of an item / sub-item / sub-sub-item DELETE call. For an OWNER the
 * item is removed immediately and the server returns the updated `Checklist`.
 * For a NON-owner the server instead files a deletion REQUEST (nothing removed)
 * and returns `{ request, checklist }` — the checklist is unchanged. Callers
 * branch on the `request` key.
 */
export type ItemDeleteResult =
  | Checklist
  | { request: ItemDeletionRequest; checklist: Checklist }

/** Type guard: the DELETE only FILED a deletion request (non-owner path). */
export function isItemDeletionFiled(
  result: ItemDeleteResult,
): result is { request: ItemDeletionRequest; checklist: Checklist } {
  return typeof result === 'object' && result !== null && 'request' in result
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
  return (await response.json()) as ItemDeleteResult
}

/** Update a sub-item's "waiting on" flag + note on a live-checklist item. */
export async function updateChecklistSubItemRequest(
  checklistId: string,
  itemId: string,
  subItemId: string,
  patch: { waiting?: boolean; waitingOn?: string | null; waitingForChecklistId?: string | null },
) {
  const response = await apiFetch(
    `/api/checklists/${checklistId}/items/${itemId}/sub-items/${subItemId}`,
    {
      credentials: 'same-origin',
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    },
  )
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to update sub-item (${response.status})`)
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
  return (await response.json()) as ItemDeleteResult
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

/**
 * Owner-only: set or clear a team member's cost rate ($/hour). Pass null to
 * clear. Informational only — powers assistant margin analytics, never
 * touches invoices.
 */
export async function setTeamMemberCostRate(userId: string, costRate: number | null) {
  const response = await apiFetch('/api/team/cost-rate', {
    credentials: 'same-origin',
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, costRate }),
  })
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to set cost rate (${response.status})`)
  }
  return (await response.json()) as { ok: boolean; userId: string; costRate: number | null }
}

/**
 * Owner-only: set/clear a team member's BILL rate ($/hour charged to clients
 * for this person's time). Unlike the cost rate, this DOES feed invoices.
 */
export async function setTeamMemberBillRate(userId: string, billRate: number | null) {
  const response = await apiFetch('/api/team/bill-rate', {
    credentials: 'same-origin',
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, billRate }),
  })
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to set bill rate (${response.status})`)
  }
  return (await response.json()) as { ok: boolean; userId: string; billRate: number | null }
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
  /** Active Checklists board column; omit/null for Uncategorized. */
  categoryId?: string | null
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

/**
 * The item add / edit endpoints now return `{ pending }` when a non-creator's
 * change was ROUTED for approval instead of applied. Callers branch on this
 * shape via {@link isTaskEditPending}.
 */
export type TaskEditResult<T> = T | { pending: PendingTaskEdit | PendingTaskEdit[] }

/** Type guard: the write only FILED a pending edit (non-creator routed path). */
export function isTaskEditPending<T>(
  result: TaskEditResult<T>,
): result is { pending: PendingTaskEdit | PendingTaskEdit[] } {
  return typeof result === 'object' && result !== null && 'pending' in result
}

export async function appendChecklistItemsRequest(
  checklistId: string,
  titles: string[],
): Promise<TaskEditResult<Checklist>> {
  const response = await apiFetch(`/api/checklists/${checklistId}/items`, {
    credentials: 'same-origin',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ titles }),
  })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to add checklist items (${response.status})`)
  }
  return (await response.json()) as TaskEditResult<Checklist>
}

export async function updateChecklistItemRequest(
  checklistId: string,
  itemId: string,
  patch: {
    title?: string
    dueDate?: string | null
    assigneeId?: string | null
    waitingOn?: string | null
    waiting?: boolean
    waitingForChecklistId?: string | null
  },
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
  return (await response.json()) as TaskEditResult<Checklist>
}

export async function deleteChecklistItemRequest(checklistId: string, itemId: string) {
  const response = await apiFetch(`/api/checklists/${checklistId}/items/${itemId}`, {
    credentials: 'same-origin',
    method: 'DELETE',
  })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to delete checklist item (${response.status})`)
  }
  return (await response.json()) as ItemDeleteResult
}

// ---- Item-level deletion requests (staff request → owner approves) ----

/** Every pending item-deletion request the caller can see. */
export async function listItemDeletionRequests() {
  const response = await apiFetch('/api/checklists/item-deletions', {
    credentials: 'same-origin',
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(
      response.status,
      body?.error ?? `Failed to load deletion requests (${response.status})`,
    )
  }
  return ((await response.json()) as { requests: ItemDeletionRequest[] }).requests
}

/** Owner-only: approve a pending item-deletion request. Returns the updated checklist. */
export async function approveItemDeletion(requestId: string) {
  const response = await apiFetch(
    `/api/checklists/item-deletions/${encodeURIComponent(requestId)}/approve`,
    {
      credentials: 'same-origin',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    },
  )
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(
      response.status,
      body?.error ?? `Failed to approve deletion (${response.status})`,
    )
  }
  return (await response.json()) as Checklist
}

/** Owner-only: reject a pending item-deletion request (clears it, deletes nothing). */
export async function rejectItemDeletion(requestId: string) {
  const response = await apiFetch(
    `/api/checklists/item-deletions/${encodeURIComponent(requestId)}/reject`,
    {
      credentials: 'same-origin',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    },
  )
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(
      response.status,
      body?.error ?? `Failed to reject deletion (${response.status})`,
    )
  }
  return (await response.json()) as { ok: true; removed: string }
}

// ---- Structured "waiting on a person" blockers ----

/** Flag a checklist step as waiting on an internal employee. Returns the updated checklist. */
export async function addWaitingOnRequest(
  checklistId: string,
  body: {
    itemId: string
    subItemId?: string | null
    subSubItemId?: string | null
    blockerId: string
    note?: string
  },
) {
  const response = await apiFetch(
    `/api/checklists/${encodeURIComponent(checklistId)}/waiting-ons`,
    {
      credentials: 'same-origin',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  )
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(
      response.status,
      message || `Failed to flag waiting on (${response.status})`,
    )
  }
  return ((await response.json()) as { checklist: Checklist }).checklist
}

/** Mark a waiting-on blocker done (the blocker, or an owner). Returns the updated checklist. */
export async function waitingOnDoneRequest(checklistId: string, waitingOnId: string) {
  const response = await apiFetch(
    `/api/checklists/${encodeURIComponent(checklistId)}/waiting-ons/${encodeURIComponent(
      waitingOnId,
    )}/done`,
    {
      credentials: 'same-origin',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    },
  )
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to mark done (${response.status})`)
  }
  return ((await response.json()) as { checklist: Checklist }).checklist
}

/** Cancel a waiting-on blocker (the flagger, the step assignee, or an owner). */
export async function waitingOnCancelRequest(checklistId: string, waitingOnId: string) {
  const response = await apiFetch(
    `/api/checklists/${encodeURIComponent(checklistId)}/waiting-ons/${encodeURIComponent(
      waitingOnId,
    )}/cancel`,
    {
      credentials: 'same-origin',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    },
  )
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to cancel (${response.status})`)
  }
  return ((await response.json()) as { checklist: Checklist }).checklist
}

/** Every pending blocker where the caller is the person being waited on. */
export async function fetchWaitingOnMe() {
  const response = await apiFetch('/api/waiting-on-me', { credentials: 'same-origin' })
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(
      response.status,
      message || `Failed to load waiting-on-me (${response.status})`,
    )
  }
  return ((await response.json()) as { items: WaitingOnMeItem[] }).items
}

// ---- Task-edit approval routing (details edit + pending-edit queue) ----

/**
 * Edit a task's DETAILS (title / due date / assignee). For the OWNER or the
 * task's own creator the server applies it and returns `{ checklist }`. For any
 * other authorized editor the change is ROUTED and the server returns
 * `{ pending }`. Callers branch on the shape.
 */
export async function updateChecklistMetaRequest(
  checklistId: string,
  patch: {
    title?: string
    dueDate?: string | null
    assigneeId?: string | null
    /** Board column (service category); null/'' = Uncategorized. */
    categoryId?: string | null
  },
): Promise<{ checklist: Checklist } | { pending: PendingTaskEdit }> {
  const response = await apiFetch(`/api/checklists/${encodeURIComponent(checklistId)}`, {
    credentials: 'same-origin',
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to update task (${response.status})`)
  }
  return (await response.json()) as { checklist: Checklist } | { pending: PendingTaskEdit }
}

/** Every pending task edit the caller can approve (owner: all; staff: routed to them). */
export async function listPendingTaskEdits() {
  const response = await apiFetch('/api/checklists/pending-edits', {
    credentials: 'same-origin',
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(
      response.status,
      body?.error ?? `Failed to load pending edits (${response.status})`,
    )
  }
  return ((await response.json()) as { edits: PendingTaskEdit[] }).edits
}

/** Approve a pending task edit (applies it). Returns the updated checklist. */
export async function approvePendingTaskEdit(editId: string) {
  const response = await apiFetch(
    `/api/checklists/pending-edits/${encodeURIComponent(editId)}/approve`,
    {
      credentials: 'same-origin',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    },
  )
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(response.status, body?.error ?? `Failed to approve edit (${response.status})`)
  }
  return (await response.json()) as Checklist
}

/** Reject a pending task edit (discards it, applies nothing). */
export async function rejectPendingTaskEdit(editId: string) {
  const response = await apiFetch(
    `/api/checklists/pending-edits/${encodeURIComponent(editId)}/reject`,
    {
      credentials: 'same-origin',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    },
  )
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(response.status, body?.error ?? `Failed to reject edit (${response.status})`)
  }
  return (await response.json()) as { ok: true; removed: string }
}

/**
 * Delete an entire checklist. For an OWNER this soft-deletes it to the recycle
 * bin and the server returns `{ ok, removed }`. For an authorized NON-owner
 * (staff) the server instead records a deletion REQUEST and returns the
 * updated Checklist (now carrying `deletionRequestedBy/At`) — it is NOT
 * deleted. Callers branch on role to interpret the result.
 */
export async function deleteChecklistRequest(checklistId: string) {
  const response = await apiFetch(`/api/checklists/${encodeURIComponent(checklistId)}`, {
    credentials: 'same-origin',
    method: 'DELETE',
  })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to delete checklist (${response.status})`)
  }
  return (await response.json()) as { ok: true; removed: string } | Checklist
}

/**
 * Owner: approve a staff deletion request — soft-deletes the checklist to the
 * recycle bin. Returns `{ ok, removed }` like the owner delete path.
 */
export async function approveChecklistDeletionRequest(checklistId: string) {
  const response = await apiFetch(
    `/api/checklists/${encodeURIComponent(checklistId)}/deletion/approve`,
    {
      credentials: 'same-origin',
      method: 'POST',
    },
  )
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to approve deletion (${response.status})`)
  }
  return (await response.json()) as { ok: true; removed: string }
}

/**
 * Owner: reject a staff deletion request — clears the request fields and keeps
 * the checklist active. Returns the freshly-updated Checklist.
 */
export async function rejectChecklistDeletionRequest(checklistId: string) {
  const response = await apiFetch(
    `/api/checklists/${encodeURIComponent(checklistId)}/deletion/reject`,
    {
      credentials: 'same-origin',
      method: 'POST',
    },
  )
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to reject deletion (${response.status})`)
  }
  return (await response.json()) as Checklist
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

/**
 * Owner-only: open a client's 3-stage onboarding case (Proposal → Onboarding →
 * Client) and move the client to 'proposal'. Returns the new template, the
 * materialized Stage-1 checklist, and the updated client so the caller can
 * merge them into local state.
 */
export async function startOnboardingRequest(clientId: string) {
  const response = await apiFetch(
    `/api/clients/${encodeURIComponent(clientId)}/start-onboarding`,
    {
      credentials: 'same-origin',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    },
  )
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(
      response.status,
      message || `Failed to start onboarding (${response.status})`,
    )
  }
  return (await response.json()) as {
    template: ChecklistTemplate
    checklist: Checklist | null
    client: Client | null
  }
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

// ---- AI assistant (owner only) ----

export type AssistantChatMessage = { role: 'user' | 'assistant'; text: string }
export type AssistantFeatureRequestDraft = { title: string; description: string }
export type AssistantEmailReportDraft = { subject: string; body: string }
export type AssistantActionProposal = {
  id: string
  tool: string
  label: string
  summary: string
  params: Record<string, unknown>
}
export type AssistantReportSection = {
  heading: string
  paragraphs?: string[]
  stats?: Array<{ label: string; value: string }>
  table?: { columns: string[]; rows: string[][] }
}
export type AssistantReport = {
  title: string
  subtitle?: string
  sections: AssistantReportSection[]
}
export type AssistantChatResult = {
  reply: string
  featureRequestDraft: AssistantFeatureRequestDraft | null
  emailReportDraft: AssistantEmailReportDraft | null
  report: AssistantReport | null
  actionProposals: AssistantActionProposal[]
}

/**
 * Send a chat turn and stream the reply. The server responds with
 * Server-Sent Events over the POST body: `delta` events carry incremental
 * text (forwarded to onDelta as it arrives), and a final `done` event
 * carries the structured result. Pre-stream failures come back as JSON.
 */
export async function assistantChatRequest(
  messages: AssistantChatMessage[],
  onDelta?: (text: string) => void,
): Promise<AssistantChatResult> {
  const response = await apiFetch('/api/assistant/chat', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
  })
  if (!response.ok || !response.body) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(
      response.status,
      body?.error ?? `Assistant request failed (${response.status})`,
    )
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let result: AssistantChatResult = {
    reply: '',
    featureRequestDraft: null,
    emailReportDraft: null,
    report: null,
    actionProposals: [],
  }

  const handleEvent = (raw: string) => {
    const line = raw.split('\n').find((l) => l.startsWith('data:'))
    if (!line) return
    let event: { type?: string; text?: string; error?: string } & Partial<AssistantChatResult>
    try {
      event = JSON.parse(line.slice(5).trim())
    } catch {
      return
    }
    if (event.type === 'delta' && typeof event.text === 'string') {
      onDelta?.(event.text)
    } else if (event.type === 'done') {
      result = {
        reply: event.reply ?? '',
        featureRequestDraft: event.featureRequestDraft ?? null,
        emailReportDraft: event.emailReportDraft ?? null,
        report: event.report ?? null,
        actionProposals: event.actionProposals ?? [],
      }
    } else if (event.type === 'error') {
      throw new ApiError(502, event.error ?? 'The assistant had trouble answering.')
    }
  }

  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      handleEvent(buffer.slice(0, boundary))
      buffer = buffer.slice(boundary + 2)
      boundary = buffer.indexOf('\n\n')
    }
  }
  if (buffer.trim()) handleEvent(buffer)
  return result
}

export type AssistantHistoryMessage = { id: string; role: 'user' | 'assistant'; text: string }

export async function assistantHistoryRequest() {
  const response = await apiFetch('/api/assistant/history', { credentials: 'same-origin' })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to load conversation (${response.status})`)
  }
  return (await response.json()) as { messages: AssistantHistoryMessage[] }
}

export async function assistantClearHistory() {
  const response = await apiFetch('/api/assistant/history', {
    method: 'DELETE',
    credentials: 'same-origin',
  })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to clear conversation (${response.status})`)
  }
  return (await response.json()) as { ok: boolean }
}

export async function assistantRunAction(proposal: AssistantActionProposal) {
  const response = await apiFetch('/api/assistant/action', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: proposal.tool, params: proposal.params }),
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null
    throw new ApiError(response.status, body?.message ?? `Action failed (${response.status})`)
  }
  return (await response.json()) as { ok: boolean; message: string }
}

/**
 * Owner-only: action proposals filed by the VOICE agent, awaiting her tap.
 * The panel polls this during a live call; each renders as a confirm card.
 */
export async function fetchPendingVoiceActions() {
  const response = await apiFetch('/api/assistant/pending-actions', { credentials: 'same-origin' })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to load pending actions (${response.status})`)
  }
  return (await response.json()) as { proposals: AssistantActionProposal[] }
}

/** Remove a pending voice proposal once its card was run or dismissed. */
export async function resolvePendingVoiceAction(id: string) {
  const response = await apiFetch('/api/assistant/pending-actions/resolve', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to resolve pending action (${response.status})`)
  }
  return (await response.json()) as { ok: boolean; removed: boolean }
}

/** Owner-only: reports the VOICE agent generated, awaiting display in the modal. */
export async function fetchPendingReports() {
  const response = await apiFetch('/api/assistant/pending-reports', { credentials: 'same-origin' })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to load pending reports (${response.status})`)
  }
  return (await response.json()) as { reports: Array<{ id: string; report: AssistantReport }> }
}

/** Remove a pending voice report once it has been shown. */
export async function resolvePendingReport(id: string) {
  const response = await apiFetch('/api/assistant/pending-reports/resolve', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to resolve pending report (${response.status})`)
  }
  return (await response.json()) as { ok: boolean; removed: boolean }
}

/** Owner-only: feature-request drafts the VOICE agent created, awaiting a tap. */
export async function fetchPendingFeatureRequests() {
  const response = await apiFetch('/api/assistant/pending-feature-requests', {
    credentials: 'same-origin',
  })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to load pending requests (${response.status})`)
  }
  return (await response.json()) as {
    drafts: Array<{ id: string; draft: AssistantFeatureRequestDraft }>
  }
}

/** Remove a pending voice feature-request draft once it has been shown. */
export async function resolvePendingFeatureRequest(id: string) {
  const response = await apiFetch('/api/assistant/pending-feature-requests/resolve', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to resolve pending request (${response.status})`)
  }
  return (await response.json()) as { ok: boolean; removed: boolean }
}

// ---- Client Recap (per-client monthly/quarterly review) ----

export type ClientRecapPeriodType = 'month' | 'quarter'
export type ClientRecapStaffRow = { name: string; hours: number; billableHours: number }
export type ClientRecapTask = {
  title: string
  dueDate: string
  assignee: string | null
  done: boolean
  overdue: boolean
}
export type SalesTaxFigures = {
  taxableSales: number | null
  taxCollected: number | null
  taxOwed: number | null
  notes: string
  updatedAt: string | null
}
export type ClientRecap = {
  client: { id: string; name: string; billingMode: string }
  periodType: ClientRecapPeriodType
  period: string
  periodLabel: string
  range: { start: string; end: string }
  includeFinancials: boolean
  time: {
    totalHours: number
    billableHours: number
    adminHours: number
    priorHours: number
    deltaHours: number
    byStaff: ClientRecapStaffRow[]
  }
  tasks: {
    dueThisPeriod: ClientRecapTask[]
    dueCount: number
    completedCount: number
    overdueCount: number
    openCount: number
  }
  salesTax: {
    status: 'not_started' | 'open' | 'overdue' | 'done'
    taskTitle: string | null
    dueDate: string | null
    figures: SalesTaxFigures | null
  }
  billing: {
    billingMode: string
    hourlyRate: number | null
    monthlyRate: number | null
    monthsInPeriod: number
    planNames: string[]
    revenue: number
    reimbursements: Array<{ date: string; description: string; amount: number }>
    reimbursementTotal: number
  } | null
  profitability: {
    realizedRate: number | null
    marginAvailable: boolean
    laborCost: number | null
    margin: number | null
  } | null
}

export async function fetchClientRecap(
  clientId: string,
  periodType: ClientRecapPeriodType,
  period: string,
) {
  const params = new URLSearchParams({ clientId, periodType, period })
  const response = await apiFetch(`/api/client-recap?${params.toString()}`, {
    credentials: 'same-origin',
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(response.status, body?.error ?? `Failed to load recap (${response.status})`)
  }
  return (await response.json()) as ClientRecap
}

/** Owner-only: record sales-tax figures for a client + period. */
export async function saveSalesTaxRecord(input: {
  clientId: string
  periodType: ClientRecapPeriodType
  period: string
  taxableSales: number | null
  taxCollected: number | null
  taxOwed: number | null
  notes: string
}) {
  const response = await apiFetch('/api/client-recap/sales-tax', {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(response.status, body?.error ?? `Failed to save sales tax (${response.status})`)
  }
  return (await response.json()) as { ok: boolean; record: unknown }
}

// ---- Active Checklists board: service categories (the columns) ----

/** Every service category (board column), sorted for display. Any signed-in user. */
export async function fetchServiceCategories() {
  const response = await apiFetch('/api/service-categories', { credentials: 'same-origin' })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(
      response.status,
      body?.error ?? `Failed to load board columns (${response.status})`,
    )
  }
  return ((await response.json()) as { categories: ServiceCategory[] }).categories
}

/** Owner-only: create a new board column. */
export async function createServiceCategory(name: string) {
  const response = await apiFetch('/api/service-categories', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(response.status, body?.error ?? `Failed to add column (${response.status})`)
  }
  return ((await response.json()) as { category: ServiceCategory }).category
}

/** Owner-only: rename and/or reorder a board column. */
export async function updateServiceCategory(
  id: string,
  patch: { name?: string; sortOrder?: number },
) {
  const response = await apiFetch(`/api/service-categories/${encodeURIComponent(id)}`, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(response.status, body?.error ?? `Failed to update column (${response.status})`)
  }
  return ((await response.json()) as { category: ServiceCategory }).category
}

/** Owner-only: delete a board column (its checklists become Uncategorized). */
export async function deleteServiceCategory(id: string) {
  const response = await apiFetch(`/api/service-categories/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(response.status, body?.error ?? `Failed to delete column (${response.status})`)
  }
  return (await response.json()) as { ok: boolean }
}

// ---- Updates tracker: feature requests / bug reports (owner-only) ----

/** Every update, ordered by priority level then by rank. Owner-only. */
export async function fetchFeatureRequests() {
  const response = await apiFetch('/api/feature-requests', { credentials: 'same-origin' })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(response.status, body?.error ?? `Failed to load updates (${response.status})`)
  }
  return ((await response.json()) as { requests: FeatureRequest[] }).requests
}

/** Owner-only: create an update. Returns the created item. */
export async function createFeatureRequest(input: {
  title: string
  description: string
  type: FeatureRequestType
}) {
  const response = await apiFetch('/api/feature-requests', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(response.status, body?.error ?? `Failed to add update (${response.status})`)
  }
  return ((await response.json()) as { request: FeatureRequest }).request
}

/** Owner-only: patch any field of an update. Returns the updated item. */
export async function updateFeatureRequest(
  id: string,
  patch: Partial<{
    title: string
    description: string
    type: FeatureRequestType
    status: FeatureRequest['status']
    priority: FeatureRequest['priority']
    priorityRank: number
    devNotes: string
    reviewNote: string
  }>,
) {
  const response = await apiFetch(`/api/feature-requests/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(response.status, body?.error ?? `Failed to update item (${response.status})`)
  }
  return ((await response.json()) as { request: FeatureRequest }).request
}

/** Owner-only: re-rank updates by the given id order. Returns the new list. */
export async function reorderFeatureRequests(orderedIds: string[]) {
  const response = await apiFetch('/api/feature-requests/reorder', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderedIds }),
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(response.status, body?.error ?? `Failed to reorder (${response.status})`)
  }
  return ((await response.json()) as { requests: FeatureRequest[] }).requests
}

/** Owner-only: delete an update. */
export async function deleteFeatureRequest(id: string) {
  const response = await apiFetch(`/api/feature-requests/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(response.status, body?.error ?? `Failed to delete item (${response.status})`)
  }
  return (await response.json()) as { ok: boolean }
}

/**
 * Owner-only: ask the AI to refine an update into a clean dev-ready spec.
 * Returns the suggested `{ title, description }` WITHOUT saving — the UI shows
 * it and the owner accepts (which then PATCH-saves it).
 */
export async function refineFeatureRequest(id: string) {
  const response = await apiFetch(`/api/feature-requests/${encodeURIComponent(id)}/refine`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(response.status, body?.error ?? `Failed to refine (${response.status})`)
  }
  return ((await response.json()) as { suggestion: { title: string; description: string } })
    .suggestion
}

// ---- Client notes: a timestamped, attributed, append-only log per client ----

/** Notes for a client, newest first. Owner or the client's assigned staff. */
export async function listClientNotes(clientId: string) {
  const response = await apiFetch(
    `/api/clients/${encodeURIComponent(clientId)}/notes`,
    { credentials: 'same-origin' },
  )
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(response.status, body?.error ?? `Failed to load notes (${response.status})`)
  }
  return ((await response.json()) as { notes: ClientNote[] }).notes
}

/** Append a note to a client's log. Returns the created note. */
export async function addClientNote(clientId: string, body: string) {
  const response = await apiFetch(`/api/clients/${encodeURIComponent(clientId)}/notes`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  })
  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(response.status, errorBody?.error ?? `Failed to add note (${response.status})`)
  }
  return ((await response.json()) as { note: ClientNote }).note
}

/** Delete a note. Owner can delete any note; staff only their own. */
export async function deleteClientNote(clientId: string, noteId: string) {
  const response = await apiFetch(
    `/api/clients/${encodeURIComponent(clientId)}/notes/${encodeURIComponent(noteId)}`,
    { method: 'DELETE', credentials: 'same-origin' },
  )
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(response.status, body?.error ?? `Failed to delete note (${response.status})`)
  }
  return (await response.json()) as { ok: boolean }
}

export async function assistantFeatureRequestSend(draft: AssistantFeatureRequestDraft) {
  const response = await apiFetch('/api/assistant/feature-request', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(draft),
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(
      response.status,
      body?.error ?? `Could not send the request (${response.status})`,
    )
  }
  return (await response.json()) as { ok: boolean; id: string; emailSent: boolean }
}

/**
 * Owner-only: get a short-lived signed URL to open a voice session with the
 * agent, plus the per-session dynamic variables (owner name, date, and the
 * cross-call memory digest) the agent's prompt expects.
 */
export async function fetchVoiceSignedUrl() {
  const response = await apiFetch('/api/assistant/voice/signed-url', { credentials: 'same-origin' })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(response.status, body?.error ?? `Voice unavailable (${response.status})`)
  }
  return (await response.json()) as {
    signedUrl: string
    dynamicVariables: Record<string, string>
  }
}

/** Owner confirms: email an assistant-generated report to herself (OWNER_EMAIL). */
export async function assistantEmailReportSend(draft: AssistantEmailReportDraft) {
  const response = await apiFetch('/api/assistant/email-report', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(draft),
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(
      response.status,
      body?.error ?? `Could not email the report (${response.status})`,
    )
  }
  return (await response.json()) as { ok: boolean; emailSent: boolean; message: string }
}

export type AssistantSuggestion = {
  key: string
  kind: string
  title: string
  body: string
  link: string
}

export async function assistantInsightsRequest() {
  const response = await apiFetch('/api/assistant/insights', { credentials: 'same-origin' })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to load insights (${response.status})`)
  }
  return (await response.json()) as { suggestions: AssistantSuggestion[] }
}

export async function assistantDismissSuggestion(key: string) {
  const response = await apiFetch('/api/assistant/insights/dismiss', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to dismiss suggestion (${response.status})`)
  }
  return (await response.json()) as { ok: boolean }
}
