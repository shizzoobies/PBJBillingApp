import {
  ApiError,
  type ActivityEntry,
  type AppData,
  type Checklist,
  type ChecklistSkip,
  type ChecklistTemplate,
  type ChecklistTemplateItem,
  type Client,
  type NewClientInput,
  type InvoiceAiReview,
  type PersistedInvoice,
  type PersistedInvoiceLine,
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
import type { GroupAllocationMode } from '../../lib/group-allocation.js'
import type { SkipReasonCategory } from '../../lib/checklist-skip.js'

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
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to save firm settings (${response.status})`)
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

/**
 * Header carrying the workspace staleness fingerprint (see
 * `lib/workspace-version.js` on the server).
 */
const WORKSPACE_VERSION_HEADER = 'X-Workspace-Version'

/**
 * The fingerprint of the workspace this tab last saw. Captured from every
 * `GET /api/app-data` and refreshed from every successful `PUT`, then echoed
 * back on the next save so the server can refuse a stale snapshot.
 *
 * Module-level (like `previewModeActive`) rather than React state: it is a
 * property of the last network exchange, not of the render tree, and every
 * read/write of it already funnels through the two functions below.
 */
let workspaceVersion: string | null = null

/**
 * Thrown when the server refuses a bulk save because this tab's snapshot is out
 * of date. Distinguished from the other 409 the endpoint can return (the
 * empty-payload guard) by the body's `error` code, because the two need very
 * different handling: this one is unrecoverable without a reload.
 */
export class StaleWorkspaceApiError extends ApiError {
  constructor(message: string) {
    super(409, message)
    this.name = 'StaleWorkspaceApiError'
  }
}

export async function fetchAppData(signal: AbortSignal, previewAs?: string | null) {
  const url = previewAs
    ? `/api/app-data?previewAs=${encodeURIComponent(previewAs)}`
    : '/api/app-data'
  const response = await apiFetch(url, { credentials: 'same-origin', signal })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to load app data (${response.status})`)
  }
  // Keep the previous token if the header is absent (e.g. the test fetch mock)
  // rather than clearing it — a null token is refused by the server.
  workspaceVersion = response.headers.get(WORKSPACE_VERSION_HEADER) ?? workspaceVersion

  return (await response.json()) as AppData
}

export async function saveAppData(data: AppData) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (workspaceVersion) {
    headers[WORKSPACE_VERSION_HEADER] = workspaceVersion
  }
  const response = await apiFetch('/api/app-data', {
    credentials: 'same-origin',
    method: 'PUT',
    headers,
    body: JSON.stringify(data),
  })

  if (!response.ok) {
    if (response.status === 409) {
      const body = await response.json().catch(() => null)
      const code = (body as { error?: string } | null)?.error
      if (code === 'stale_workspace') {
        // Adopt the server's current fingerprint so a subsequent reload-free
        // recovery path (if one is ever added) starts from the truth.
        workspaceVersion = response.headers.get(WORKSPACE_VERSION_HEADER) ?? workspaceVersion
        throw new StaleWorkspaceApiError(
          (body as { message?: string } | null)?.message ??
            'This tab is out of date — please reload.',
        )
      }
      // The OTHER 409 (the empty-payload guard) already consumed the body
      // above, so safeErrorMessage below would read nothing — use `body`.
      const parsed = body as { message?: string; error?: string } | null
      throw new ApiError(
        response.status,
        parsed?.message || parsed?.error || `Failed to save app data (${response.status})`,
      )
    }
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to save app data (${response.status})`)
  }
  // The write moved the fingerprint; adopt the new one or this tab's very next
  // save would be refused as stale against its own change.
  workspaceVersion = response.headers.get(WORKSPACE_VERSION_HEADER) ?? workspaceVersion
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
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to request sign-in link (${response.status})`)
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
 * Mint a one-time desktop-app sign-in handoff. The server returns a
 * pbjsa:// URL carrying a fresh single-use login token for THIS session's
 * user; navigating to it launches the installed Windows app signed in.
 * (The shell keeps its own cookie jar, so the browser session can't just
 * be shared — the token rides the normal /verify flow, TOTP included.)
 */
export async function desktopHandoffRequest() {
  const response = await apiFetch('/api/auth/desktop-handoff', {
    credentials: 'same-origin',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })

  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(
      response.status,
      message || `Could not prepare the desktop sign-in (${response.status})`,
    )
  }

  return (await response.json()) as { url: string }
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
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to log out (${response.status})`)
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
    // Surface the server's own sentence — the weekly-submission gate and the
    // month lock both refuse with a message that tells the person exactly how
    // to unblock themselves ("submit the week of August 9…"). Swallowing it
    // into a generic string turned a self-service nudge into a support email.
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to create time entry (${response.status})`)
  }

  return (await response.json()) as TimeEntry
}

export async function updateTimeEntryRequest(
  entryId: string,
  patch: {
    minutes?: number
    description?: string
    billable?: boolean
    clientId?: string
    isAdministrative?: boolean
    /** Out-of-scope one-off work. Owner-settable on anyone's entry at review. */
    isAdhoc?: boolean
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

/**
 * Split a time entry across clients in ONE atomic server call: the slices are
 * created and the source entry removed together, or nothing changes at all.
 * Replaces the old create-loop-then-delete that could leave both halves behind.
 *
 * `clientIds` names the targets for a REGULAR client entry. An unsplit group
 * holding block ignores it — its member clients were fixed when the timer
 * started, and the server refuses any other target for one.
 */
export async function splitTimeEntryRequest(
  entryId: string,
  body: {
    mode: GroupAllocationMode
    customMinutes?: Record<string, number>
    clientIds?: string[]
  },
) {
  const response = await apiFetch(`/api/time-entries/${encodeURIComponent(entryId)}/split`, {
    credentials: 'same-origin',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to split time entry (${response.status})`)
  }
  return (await response.json()) as { created: TimeEntry[]; deletedId: string }
}

/**
 * Adjust an EXISTING split: hand the server the whole new distribution and it
 * replaces the group's slices with it, in one transaction, under the same group
 * id. The total is allowed to change — an adjustment is a correction — and
 * dropping to a single client is allowed too (that's "unsplit this back to one
 * client"), unlike creating a split.
 */
export async function adjustSplitGroupRequest(
  groupId: string,
  body: {
    mode: GroupAllocationMode
    allocations: { clientId: string; minutes: number }[]
  },
) {
  const response = await apiFetch(
    `/api/time-entries/split-groups/${encodeURIComponent(groupId)}/adjust`,
    {
      credentials: 'same-origin',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  )
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to adjust split (${response.status})`)
  }
  return (await response.json()) as {
    created: TimeEntry[]
    deletedIds: string[]
    groupId: string
  }
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

/**
 * The covered-date half of a recurring reimbursement, as the setup form sends
 * it. Every field optional: an expense that does not name its covered period
 * simply omits them, and a PATCH that says nothing about coverage is not a
 * statement about it. `coverageHistory` is absent on purpose — the ledger is
 * the server's to write.
 */
export type RecurringReimbursementCoverageInput = {
  coverageEnabled?: boolean
  coverageTemplate?: string
  coverageStart?: string | null
  coverageEnd?: string | null
  coveragePaused?: boolean
}

/** Owner-only: create a recurring reimbursement on a client. */
export async function addRecurringReimbursementRequest(input: {
  clientId: string
  description: string
  amount: number
  frequency: RecurringReimbursementFrequency
  startDate: string
} & RecurringReimbursementCoverageInput) {
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
  } & RecurringReimbursementCoverageInput,
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
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to update checklist item (${response.status})`)
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
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to update checklist viewers (${response.status})`)
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
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to revoke session (${response.status})`)
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
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to revoke sessions (${response.status})`)
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
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to reorder checklist items (${response.status})`)
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
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to add checklist items (${response.status})`)
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
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to update checklist item (${response.status})`)
  }
  return (await response.json()) as TaskEditResult<Checklist>
}

export async function deleteChecklistItemRequest(checklistId: string, itemId: string) {
  const response = await apiFetch(`/api/checklists/${checklistId}/items/${itemId}`, {
    credentials: 'same-origin',
    method: 'DELETE',
  })
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to delete checklist item (${response.status})`)
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

/**
 * Flag a checklist step as waiting on a teammate — or on the task's own CLIENT
 * (`blockerType: 'client'`, in which case `blockerId` is omitted and the server
 * reads the client off the checklist). Returns the updated checklist.
 *
 * THE ONE WRITE that creates a wait. Who, the message and the task it waits for
 * are composed as a local draft and posted together, because after this call
 * every one of them is locked (featreq-8b7d06d7).
 */
export async function addWaitingOnRequest(
  checklistId: string,
  body: {
    itemId: string
    subItemId?: string | null
    subSubItemId?: string | null
    blockerId?: string
    blockerType?: 'employee' | 'client'
    note?: string
    /** The task this step waits for. Omit to leave the step's existing link alone. */
    waitingForChecklistId?: string | null
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

/**
 * Stage 2 — the person who asked confirms the work and closes the wait out. The
 * record is kept (struck through) so the name of whoever did the check stays on
 * the step. Refused with 409 until the blocker has marked it done.
 */
export async function waitingOnVerifyRequest(checklistId: string, waitingOnId: string) {
  const response = await apiFetch(
    `/api/checklists/${encodeURIComponent(checklistId)}/waiting-ons/${encodeURIComponent(
      waitingOnId,
    )}/verify`,
    {
      credentials: 'same-origin',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    },
  )
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to confirm (${response.status})`)
  }
  return ((await response.json()) as { checklist: Checklist }).checklist
}

/** Stage 1 — the person being waited on reports their part done. */
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

/**
 * Send back — the requester does NOT approve the reported work, so the wait
 * returns to the blocker carrying `note`. Refused with 400 when the note is
 * empty (a bare rejection tells the blocker nothing) and with 409 until the
 * blocker has marked it done.
 */
export async function waitingOnSendBackRequest(
  checklistId: string,
  waitingOnId: string,
  note: string,
) {
  const response = await apiFetch(
    `/api/checklists/${encodeURIComponent(checklistId)}/waiting-ons/${encodeURIComponent(
      waitingOnId,
    )}/send-back`,
    {
      credentials: 'same-origin',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note }),
    },
  )
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to send back (${response.status})`)
  }
  return ((await response.json()) as { checklist: Checklist }).checklist
}

/**
 * Question — the person being waited on asks the requester something WITHOUT
 * finishing. The wait does not move: the message is appended to the record and
 * the requester is notified, and it is still sitting on the blocker's Delayed
 * page afterwards. Refused with 400 when the message is empty.
 */
export async function waitingOnQuestionRequest(
  checklistId: string,
  waitingOnId: string,
  note: string,
) {
  const response = await apiFetch(
    `/api/checklists/${encodeURIComponent(checklistId)}/waiting-ons/${encodeURIComponent(
      waitingOnId,
    )}/question`,
    {
      credentials: 'same-origin',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note }),
    },
  )
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to send question (${response.status})`)
  }
  return ((await response.json()) as { checklist: Checklist }).checklist
}

// There is no cancel request. A saved wait is the shared record of who asked,
// who did it and who confirmed, so nothing in the app removes one — the server
// refuses the old `/cancel` route outright (see lib/waiting-on-state.js).

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

// ---- Quiet skip for recurring checklist tasks ----

/**
 * Skip this occurrence of a recurring task. Both fields are required and the
 * SERVER enforces that — the dialog's own validation is a courtesy, not the
 * boundary. Returns the stamped checklist and the audit record.
 */
export async function skipChecklistOccurrence(
  checklistId: string,
  input: { category: SkipReasonCategory; explanation: string },
) {
  const response = await apiFetch(`/api/checklists/${encodeURIComponent(checklistId)}/skip`, {
    credentials: 'same-origin',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to skip task (${response.status})`)
  }
  return (await response.json()) as { checklist: Checklist; skip: ChecklistSkip }
}

/** Owner-only: every skip record ever filed, newest first (reviewed included). */
export async function listChecklistSkips() {
  const response = await apiFetch('/api/checklists/skips', { credentials: 'same-origin' })
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to load skips (${response.status})`)
  }
  return ((await response.json()) as { skips: ChecklistSkip[] }).skips
}

/**
 * Owner-only: mark a skip reviewed. This clears it off the dashboard and
 * deletes nothing — the record is the audit trail.
 */
export async function reviewChecklistSkip(skipId: string) {
  const response = await apiFetch(
    `/api/checklists/skips/${encodeURIComponent(skipId)}/review`,
    {
      credentials: 'same-origin',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    },
  )
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to review skip (${response.status})`)
  }
  return ((await response.json()) as { skip: ChecklistSkip }).skip
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
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to delete checklist (${response.status})`)
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
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to approve deletion (${response.status})`)
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
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to reject deletion (${response.status})`)
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
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to restore checklist (${response.status})`)
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
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to empty recycle bin (${response.status})`)
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
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to record client activity (${response.status})`)
  }
}

/**
 * The error body as BOTH halves — the sentence for the person and the code for
 * the caller. Separate from `safeErrorMessage` because a Response body can only
 * be read once: a helper that returned the sentence and left the code behind
 * would have to be called twice to get both.
 */
async function safeError(response: Response): Promise<{ message: string; code?: string }> {
  try {
    const body = await response.json()
    const code = body && typeof body.error === 'string' ? body.error : undefined
    if (body && typeof body.message === 'string' && body.message.trim()) {
      return { message: body.message, code }
    }
    if (code) return { message: code, code }
  } catch {
    // ignore
  }
  return { message: '' }
}

async function safeErrorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json()
    // Several endpoints answer with BOTH a machine-readable code and a sentence
    // meant for a person: { error: 'stripe_not_configured', message: 'Stripe is
    // not connected yet…' }. Prefer the sentence — showing the raw code put
    // "stripe_not_configured" in front of Brittany, and the same was true of
    // client_create_failed and invoice_generate_failed.
    if (body && typeof body.message === 'string' && body.message.trim()) {
      return body.message
    }
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
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to add stage (${response.status})`)
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
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to update stage (${response.status})`)
  }
  return (await response.json()) as ChecklistTemplate
}

/**
 * Append steps to one stage of a recurring template ("add to all future").
 * Append-only, so it's allowed for a team member assigned to the template's
 * client — not just the owner. Returns the created items with their ids.
 */
export async function appendTemplateStageItemsRequest(
  templateId: string,
  stageId: string,
  titles: string[],
) {
  const response = await apiFetch(
    `/api/checklist-templates/${encodeURIComponent(templateId)}/stages/${encodeURIComponent(stageId)}/items`,
    {
      credentials: 'same-origin',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ titles }),
    },
  )
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to add steps (${response.status})`)
  }
  return (await response.json()) as { items: { id: string; label: string }[] }
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
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to remove stage (${response.status})`)
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
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to reorder stages (${response.status})`)
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
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to update template viewers (${response.status})`)
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

/**
 * Owner-only: retire a client ('inactive') or bring them back ('active').
 * Nothing is deleted either way — the stage alone decides whether they are
 * offered for new work. Returns the updated client so the caller can merge it
 * into local state without a refetch.
 */
export async function setClientLifecycleStageRequest(
  clientId: string,
  stage: 'inactive' | 'active',
) {
  const response = await apiFetch(
    `/api/clients/${encodeURIComponent(clientId)}/lifecycle-stage`,
    {
      credentials: 'same-origin',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage }),
    },
  )
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(
      response.status,
      message || `Failed to update the client’s stage (${response.status})`,
    )
  }
  return (await response.json()) as { client: Client }
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
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to mark notification read (${response.status})`)
  }
  return (await response.json()) as NotificationEntry
}

export type EmailNotificationPrefType = {
  key: string
  label: string
  description: string
}

export type EmailNotificationPrefs = Record<string, boolean>

export async function fetchNotificationPrefs(signal?: AbortSignal) {
  const response = await apiFetch('/api/me/notification-prefs', {
    credentials: 'same-origin',
    signal,
  })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to load notification preferences (${response.status})`)
  }
  return (await response.json()) as {
    types: EmailNotificationPrefType[]
    prefs: EmailNotificationPrefs
  }
}

export async function updateNotificationPrefsRequest(prefs: EmailNotificationPrefs) {
  const response = await apiFetch('/api/me/notification-prefs', {
    credentials: 'same-origin',
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefs }),
  })
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to save notification preferences (${response.status})`)
  }
  return (await response.json()) as { prefs: EmailNotificationPrefs }
}

export async function markAllNotificationsReadRequest() {
  const response = await apiFetch('/api/notifications/read-all', {
    credentials: 'same-origin',
    method: 'POST',
  })
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to mark all read (${response.status})`)
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
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to clear conversation (${response.status})`)
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
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to resolve pending action (${response.status})`)
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
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to resolve pending report (${response.status})`)
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
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to resolve pending request (${response.status})`)
  }
  return (await response.json()) as { ok: boolean; removed: boolean }
}

// ---- Client Recap (per-client monthly/quarterly/yearly review) ----

export type ClientRecapPeriodType = 'month' | 'quarter' | 'year'
/**
 * `tier` is the fixed display grouping — 'CFO' | 'Accountant' | 'Bookkeeper' |
 * 'Other' — assigned server-side by `recapStaffTier` in lib/client-recap.js,
 * which is the single place the staff role -> tier mapping lives. Rows arrive
 * already sorted by tier then name; the page must not re-sort them.
 */
export type ClientRecapStaffRow = {
  name: string
  tier: string
  hours: number
  billableHours: number
}
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
  /** 1 / 3 / 12 — what a per-month estimate is multiplied by for this period. */
  monthsInPeriod: number
  includeFinancials: boolean
  time: {
    totalHours: number
    billableHours: number
    adminHours: number
    priorHours: number
    deltaHours: number
    byStaff: ClientRecapStaffRow[]
    /**
     * The ESTIMATE | ACTUAL | OVER/UNDER table, one row per role, in the recap's
     * fixed order. Hours only — no rates, no money — so staff see it too.
     */
    byRole: ClientRecapRoleRow[]
    roleTotals: {
      estimatedHours: number | null
      actualHours: number
      deltaHours: number | null
      direction: ClientRecapDirection
    }
    /**
     * False = this payload has no estimate columns at all (a staff payload:
     * estimates are owner-side planning data and arrive em-dashed). Distinct
     * from `hasEstimate` — do not offer "go set them" when this is false.
     */
    estimatesVisible: boolean
    /** False = no estimates on file for this client; show the banner. */
    hasEstimate: boolean
    /**
     * Roles with real hours and no estimate. Their actual hours ARE in the
     * Total, so the Total's over/under runs ahead of the sum of the row
     * variances — say so on screen when this is non-empty.
     */
    unestimatedRoles: string[]
    whereToSetEstimates: string
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
  /**
   * `laborCost` counts only team members who have a cost rate on file — someone
   * without one (the owner, who draws no hourly wage) contributes zero rather
   * than making cost unknowable. Show LABOR_COST_BASIS_NOTE wherever these
   * appear.
   */
  profitability: {
    realizedRate: number | null
    laborCost: number
    margin: number
  } | null
  /**
   * Estimated vs. actual, owner-only (null for staff, and absent from their
   * payload entirely). `estimatedHours === null` on a tier means NO estimate is
   * set — render "No estimate set", never a variance against zero.
   */
  estimates: ClientRecapEstimates | null
  /**
   * Projected end-of-month invoice, owner-only. `null` for a quarterly recap —
   * the projection is a month-shaped question. Always render `method` beside
   * the figure; `isEstimate` false means the month is closed and the number is
   * the real one.
   */
  projection: ClientRecapProjection | null
}

/** How a tier's rate was resolved: its assigned team, or whoever logged time. */
export type ClientRecapRateBasis = 'assigned' | 'logged' | null
/** `null` when there is nothing to compare against — never a default 'over'. */
export type ClientRecapDirection = 'over' | 'under' | 'on' | null

/**
 * One role's plan against its reality, hours only.
 *
 * `actualHours` is the SUM OF THE DISPLAYED per-person rows in the role and
 * `deltaHours` is `actualHours − estimatedHours` at two decimals, so every row
 * subtracts by hand and the roles add to `roleTotals`.
 */
export type ClientRecapRoleRow = {
  tier: string
  /** The people who logged time in this role, in the recap's fixed order. */
  people: string[]
  /** Null = no estimate set for this role. Already scaled by monthsInPeriod. */
  estimatedHours: number | null
  actualHours: number
  deltaHours: number | null
  direction: ClientRecapDirection
}

/** A {@link ClientRecapRoleRow} with the money added — owner-only. */
export type ClientRecapEstimateTier = ClientRecapRoleRow & {
  /** Null = nobody in this role has a cost rate, so the role costs nothing. */
  costRate: number | null
  costRateBasis: ClientRecapRateBasis
  costRatePeopleCount: number
  /** Null = no estimate, or no cost rate for the role — either way, zero cost. */
  estimatedCost: number | null
  actualCost: number
}

export type ClientRecapEstimates = {
  hasEstimate: boolean
  monthsInPeriod: number
  whereToSet: string
  byTier: ClientRecapEstimateTier[]
  hours: {
    estimated: number | null
    actual: number
    delta: number | null
    direction: ClientRecapDirection
  }
  /**
   * The only reason an estimated figure here is null is that no estimate is
   * set. A role with no cost rate contributes zero cost, it does not make the
   * comparison unavailable.
   */
  profit: {
    estimatedRevenue: number | null
    estimatedCost: number | null
    estimatedProfit: number | null
    actualRevenue: number
    actualCost: number
    actualProfit: number
    delta: number | null
    direction: ClientRecapDirection
  }
}

export type ClientRecapProjection = {
  /**
   * 'actual' — the month is closed, this is the invoice, not a projection.
   * 'plan' — fixed plan fee + reimbursements recorded so far.
   * 'hourly' — extrapolated from hours logged across the business days elapsed.
   * 'too_early' — an in-progress month with no elapsed business days to scale.
   */
  basis: 'actual' | 'plan' | 'hourly' | 'too_early'
  isEstimate: boolean
  amount: number | null
  serviceAmount: number | null
  reimbursementsToDate: number
  hoursToDate: number
  businessDaysElapsed: number
  businessDaysInMonth: number
  /** The one-line basis caption. Always shown next to the figure. */
  method: string
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
  /** Optional priority chosen at creation; the server defaults to 'medium'. */
  priority?: FeatureRequest['priority']
  /** True files the item into Britt's Brain (status 'brainstorm') instead of New. */
  brainstorm?: boolean
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
    clarificationQuestion: string
    clarificationAnswer: string
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

export type SpitballSession = {
  id: string
  messages: Array<{ role: 'user' | 'assistant'; text: string }>
}

export type SpitballSessionState = {
  session: SpitballSession | null
  pastSummaries: Array<{ id: string; at: string | null }>
}

/**
 * Owner-only: the brainstorm session as the SERVER holds it. The conversation
 * lives in `spitball_sessions`, so this is what makes it survive closing the
 * modal (and follow her to another device). `session` is null until she has
 * actually said something; `pastSummaries` is non-empty once she has archived
 * an earlier brainstorm the AI can now recall.
 */
export async function spitballSessionRequest(): Promise<SpitballSessionState> {
  const response = await apiFetch('/api/feature-requests/spitball/session', {
    credentials: 'same-origin',
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(
      response.status,
      body?.error ?? `Could not load your brainstorm (${response.status})`,
    )
  }
  return (await response.json()) as SpitballSessionState
}

/**
 * Owner-only: one turn of the "Just spitballing" thought-partner chat. Sends
 * just HER message — the server owns the conversation — and returns the AI's
 * reply plus an organized draft once the idea has enough shape (null until
 * then). The turn is persisted; the draft is not saved until she files it.
 */
export async function spitballRequest(text: string) {
  const response = await apiFetch('/api/feature-requests/spitball', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(
      response.status,
      body?.error ?? `The spitballing chat hit a snag (${response.status})`,
    )
  }
  return (await response.json()) as {
    reply: string
    draft: { title: string; description: string } | null
    sessionId: string
  }
}

/**
 * Owner-only "Start fresh": archives the current brainstorm (summarized, so
 * later sessions can recall it) and returns an empty one.
 */
export async function spitballNewSessionRequest(): Promise<SpitballSessionState> {
  const response = await apiFetch('/api/feature-requests/spitball/new', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(
      response.status,
      body?.error ?? `Could not start a fresh brainstorm (${response.status})`,
    )
  }
  return (await response.json()) as SpitballSessionState
}

/**
 * Owner-only: before a "Not approved" reason is filed, the AI restates it —
 * `confirmation` for the owner to confirm in her own terms, `forDeveloper` as
 * the dev-ready version filed with the review note once she confirms. Nothing
 * is saved by this call.
 */
export async function confirmRejectFeedbackRequest(id: string, note: string) {
  const response = await apiFetch(
    `/api/feature-requests/${encodeURIComponent(id)}/confirm-feedback`,
    {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note }),
    },
  )
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(
      response.status,
      body?.error ?? `Failed to review the feedback (${response.status})`,
    )
  }
  return (await response.json()) as { confirmation: string; forDeveloper: string }
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
/**
 * Create a client durably, server-side, instead of waiting for the debounced
 * bulk save. Returns the server's record — the caller should merge THAT into
 * local state rather than its own optimistic copy, so the id in the UI is the
 * id in the database.
 */
export async function createClientRequest(payload: NewClientInput) {
  const response = await apiFetch('/api/clients', {
    credentials: 'same-origin',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null
    throw new ApiError(response.status, body?.message ?? `Failed to add client (${response.status})`)
  }
  return ((await response.json()) as { client: Client }).client
}

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
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to dismiss suggestion (${response.status})`)
  }
  return (await response.json()) as { ok: boolean }
}

/**
 * Persisted invoices (I1/I2). These deliberately do NOT ride on /api/app-data:
 * invoices are money, and keeping them off the bulk-save payload is what stops
 * a stale owner tab from ever rewriting one. So the page fetches them itself.
 */
export async function listInvoicesRequest(period?: string) {
  const query = period ? `?period=${encodeURIComponent(period)}` : ''
  const response = await apiFetch(`/api/invoices${query}`, { credentials: 'same-origin' })
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to load invoices (${response.status})`)
  }
  return ((await response.json()) as { invoices: PersistedInvoice[] }).invoices
}

/**
 * Build the month's drafts. Idempotent — an existing invoice is never rewritten.
 *
 * `clientId` narrows it to one client (the per-client "Email invoice" button
 * offering to create the missing invoice). The answer keeps the same shape
 * either way; `created` and `skipped` just end up at most one entry long.
 */
export async function generateInvoicesRequest(period: string, clientId?: string) {
  const response = await apiFetch('/api/invoices/generate', {
    credentials: 'same-origin',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(clientId ? { period, clientId } : { period }),
  })
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to generate (${response.status})`)
  }
  return (await response.json()) as {
    period: string
    created: PersistedInvoice[]
    skipped: Array<{ clientId: string; reason: string }>
  }
}

/**
 * Void the month's unsent invoices and build them again from current data.
 *
 * Not the same button as Generate: Generate leaves an existing invoice alone,
 * which is right for a late time entry and wrong for a month whose drafts were
 * snapshotted weeks ago. Sent and paid invoices are never touched — but edits
 * on the drafts this voids are discarded, so the caller confirms first.
 */
export async function regenerateInvoicesRequest(period: string) {
  const response = await apiFetch('/api/invoices/regenerate', {
    credentials: 'same-origin',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ period }),
  })
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to regenerate (${response.status})`)
  }
  return (await response.json()) as {
    period: string
    voided: number
    created: PersistedInvoice[]
    skipped: Array<{ clientId: string; reason: string }>
  }
}

/**
 * Issue a retainer invoice for one client — the front end of an engagement.
 *
 * Manual on purpose: nothing in the app knows the engagement letter came back
 * signed, so pressing this IS that event. What comes back is an ordinary draft
 * that lives on the normal editor / send / pay rails from here on.
 */
export async function issueRetainerInvoiceRequest(
  clientId: string,
  amount: number,
  note?: string,
) {
  const response = await apiFetch('/api/invoices/retainer', {
    credentials: 'same-origin',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, amount, ...(note ? { note } : {}) }),
  })
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(
      response.status,
      message || `Could not issue the retainer invoice (${response.status})`,
    )
  }
  return ((await response.json()) as { invoice: PersistedInvoice }).invoice
}

/**
 * The retainers this firm is holding — paid, and not yet given back.
 *
 * Fetched apart from the month list because a retainer is not part of any one
 * month: January's retainer is what August's final invoice credits, and August's
 * list would never contain it. The answer only decides whether to OFFER the
 * credit; the save re-checks it server-side, because this can go stale between
 * the page loading and the owner pressing Save.
 */
export async function listUnappliedRetainersRequest() {
  const response = await apiFetch('/api/invoices/unapplied-retainers', {
    credentials: 'same-origin',
  })
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to load retainers (${response.status})`)
  }
  return ((await response.json()) as { retainers: PersistedInvoice[] }).retainers
}

/**
 * Edit one invoice. Totals are NOT sent — the server recomputes them from the
 * lines, so what is stored can never disagree with what is printed.
 */
export async function updateInvoiceRequest(
  invoiceId: string,
  patch: {
    // The real line type, not a structural stand-in: an ad hoc line carries the
    // owner's billed/courtesy/omitted choice, and a declaration that stops at
    // label/amount would let a future refactor rebuild the array and drop it.
    lineItems?: PersistedInvoiceLine[]
    blurb?: string
    dueDate?: string
    status?: 'draft' | 'reviewed' | 'void'
  },
) {
  const response = await apiFetch(`/api/invoices/${encodeURIComponent(invoiceId)}`, {
    credentials: 'same-origin',
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!response.ok) {
    const { message, code } = await safeError(response)
    throw new ApiError(response.status, message || `Failed to save (${response.status})`, code)
  }
  return ((await response.json()) as { invoice: PersistedInvoice }).invoice
}

/**
 * Owner-only: answer "confirm the covered dates" on one reimbursed-expense
 * line. Omit the dates to accept the window the invoice already proposes.
 *
 * Separate from `updateInvoiceRequest` because it writes somewhere the line
 * edit does not — the expense's own ledger, which is what the NEXT cycle
 * advances from. Returns the invoice with the line settled.
 */
export async function confirmInvoiceCoverageRequest(
  invoiceId: string,
  recurringId: string,
  range?: { coverageStart: string; coverageEnd: string },
) {
  const response = await apiFetch(
    `/api/invoices/${encodeURIComponent(invoiceId)}/confirm-coverage`,
    {
      credentials: 'same-origin',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recurringId, ...(range ?? {}) }),
    },
  )
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(
      response.status,
      message || `Failed to confirm the covered dates (${response.status})`,
    )
  }
  return ((await response.json()) as { invoice: PersistedInvoice }).invoice
}

/**
 * Create the ACH payment link for an invoice and return its URL.
 *
 * The server does the Stripe work; this only hands back the hosted Checkout URL
 * to open. Refuses with a readable message when Stripe is not configured (503)
 * or when Stripe itself declines (502), so the page can say what happened.
 */
export async function createInvoicePaymentLinkRequest(invoiceId: string) {
  const response = await apiFetch(
    `/api/invoices/${encodeURIComponent(invoiceId)}/payment-link`,
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
      message || `Could not create a payment link (${response.status})`,
    )
  }
  return (await response.json()) as { url: string; invoice: PersistedInvoice }
}

/**
 * Email an invoice to the client (I4). The server owns the whole act — it picks
 * the recipients, mints a fresh pay link and writes the send log — so there is
 * nothing to pass but the id, and the returned invoice is the one to trust.
 */
/**
 * Email an invoice. `to` is what the owner left ticked in the send dialog — a
 * FILTER, not an address book: the server intersects it with the addresses the
 * invoice's own client resolves to and drops anything else. Omit it to send to
 * every address on file, which is what a single-recipient send does.
 */
export async function sendInvoiceRequest(invoiceId: string, to?: string[]) {
  const response = await apiFetch(`/api/invoices/${encodeURIComponent(invoiceId)}/send`, {
    credentials: 'same-origin',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(to ? { to } : {}),
  })
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Could not send the invoice (${response.status})`)
  }
  return (await response.json()) as { invoice: PersistedInvoice }
}

/**
 * Every current AI confidence rating for one month — the latest per invoice,
 * superseded ones left behind.
 *
 * Asked for the whole period in one go rather than per row: ratings land in the
 * background after Generate, and forty rows each asking for their own would be
 * forty requests to say "not rated yet" the first time she opens the month.
 *
 * A month with no ratings answers with an empty list, which is also what a
 * pre-feature month answers — the caller cannot tell them apart and does not
 * need to: both mean no badges.
 */
export async function listInvoiceAiReviewsRequest(period: string) {
  const response = await apiFetch(
    `/api/invoices/ai-reviews?period=${encodeURIComponent(period)}`,
    { credentials: 'same-origin' },
  )
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(
      response.status,
      message || `Failed to load AI reviews (${response.status})`,
    )
  }
  return ((await response.json()) as { reviews: InvoiceAiReview[] }).reviews
}

/**
 * Rate (or re-rate) one invoice now. SYNCHRONOUS and slow — the model reads the
 * whole draft, so this can sit for half a minute; the caller is expected to show
 * that rather than look broken.
 *
 * Answers 503 when there is no API key configured, which is a real state in
 * local development and would otherwise arrive as an opaque failure.
 */
export async function rateInvoiceRequest(invoiceId: string) {
  const response = await apiFetch(
    `/api/invoices/${encodeURIComponent(invoiceId)}/ai-review`,
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
      message || `Could not rate this invoice (${response.status})`,
    )
  }
  return ((await response.json()) as { review: InvoiceAiReview }).review
}

/**
 * Answer — or deliberately skip — one of the rating's questions.
 *
 * Skipping is stored rather than ignored: "she looked at this and decided it
 * did not need answering" is the fact the learning corpus needs, and it is not
 * the same fact as silence. Returns the whole review back, so the card and the
 * badge move together.
 */
export async function answerInvoiceAiReviewQuestionRequest(
  invoiceId: string,
  body: { questionId: string; answer?: string; skipped?: boolean },
) {
  const response = await apiFetch(
    `/api/invoices/${encodeURIComponent(invoiceId)}/ai-review/answer`,
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
      message || `Could not save that answer (${response.status})`,
    )
  }
  return ((await response.json()) as { review: InvoiceAiReview }).review
}
