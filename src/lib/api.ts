import {
  ApiError,
  type ActivityEntry,
  type AppData,
  type Checklist,
  type ChecklistTemplate,
  type LoginOption,
  type SessionUser,
  type TeamMember,
  type TimeEntry,
} from './types'

export async function fetchAppData(signal: AbortSignal) {
  const response = await fetch('/api/app-data', { credentials: 'same-origin', signal })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to load app data (${response.status})`)
  }

  return (await response.json()) as AppData
}

export async function saveAppData(data: AppData) {
  const response = await fetch('/api/app-data', {
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
  const response = await fetch('/api/session', { credentials: 'same-origin', signal })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to load session (${response.status})`)
  }

  return (await response.json()) as { user: SessionUser | null }
}

export async function fetchLoginOptions(signal: AbortSignal) {
  const response = await fetch('/api/login-options', { credentials: 'same-origin', signal })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to load login options (${response.status})`)
  }

  return (await response.json()) as { users: LoginOption[] }
}

export async function loginWithPassword(userId: string, password: string) {
  const response = await fetch('/api/login', {
    credentials: 'same-origin',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ userId, password }),
  })

  if (!response.ok) {
    throw new ApiError(response.status, `Failed to log in (${response.status})`)
  }

  return (await response.json()) as { user: SessionUser }
}

export async function logoutSession() {
  const response = await fetch('/api/logout', {
    credentials: 'same-origin',
    method: 'POST',
  })

  if (!response.ok && response.status !== 204) {
    throw new ApiError(response.status, `Failed to log out (${response.status})`)
  }
}

export async function createTimeEntry(entry: Omit<TimeEntry, 'id'>) {
  const response = await fetch('/api/time-entries', {
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

export async function toggleChecklistItemRequest(checklistId: string, itemId: string) {
  const response = await fetch(`/api/checklists/${checklistId}/items/${itemId}/toggle`, {
    credentials: 'same-origin',
    method: 'POST',
  })

  if (!response.ok) {
    throw new ApiError(response.status, `Failed to update checklist item (${response.status})`)
  }

  return (await response.json()) as Checklist
}

export async function setChecklistViewersRequest(
  checklistId: string,
  viewerIds: string[],
  editorIds: string[],
) {
  const response = await fetch(`/api/checklists/${checklistId}/viewers`, {
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
  const response = await fetch('/api/team', { credentials: 'same-origin', signal })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to load team (${response.status})`)
  }
  return (await response.json()) as { users: TeamMember[] }
}

export async function inviteTeamMember(payload: { name: string; email: string; role: string }) {
  const response = await fetch('/api/team/invite', {
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

export async function revokeTeamMember(userId: string) {
  const response = await fetch(`/api/team/${encodeURIComponent(userId)}/revoke`, {
    credentials: 'same-origin',
    method: 'POST',
  })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to revoke link (${response.status})`)
  }
  return (await response.json()) as { user: TeamMember }
}

export async function regenerateTeamMember(userId: string) {
  const response = await fetch(`/api/team/${encodeURIComponent(userId)}/regenerate`, {
    credentials: 'same-origin',
    method: 'POST',
  })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to regenerate link (${response.status})`)
  }
  return (await response.json()) as { user: TeamMember }
}

export async function restoreTeamMember(userId: string) {
  const response = await fetch(`/api/team/${encodeURIComponent(userId)}/restore`, {
    credentials: 'same-origin',
    method: 'POST',
  })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to restore access (${response.status})`)
  }
  return (await response.json()) as { user: TeamMember }
}

export async function deleteTeamMember(userId: string) {
  const response = await fetch(`/api/team/${encodeURIComponent(userId)}`, {
    credentials: 'same-origin',
    method: 'DELETE',
  })
  if (!response.ok && response.status !== 204) {
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `Failed to remove member (${response.status})`)
  }
}

export async function fetchTeamActivity(userId: string, limit = 20) {
  const response = await fetch(
    `/api/team/${encodeURIComponent(userId)}/activity?limit=${limit}`,
    { credentials: 'same-origin' },
  )
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to load activity (${response.status})`)
  }
  return (await response.json()) as { entries: ActivityEntry[] }
}

export async function reorderChecklistItemsRequest(checklistId: string, itemIds: string[]) {
  const response = await fetch(`/api/checklists/${checklistId}/items/reorder`, {
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

export async function appendChecklistItemsRequest(checklistId: string, titles: string[]) {
  const response = await fetch(`/api/checklists/${checklistId}/items`, {
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
  const response = await fetch(`/api/checklists/${checklistId}/items/${itemId}`, {
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
  const response = await fetch(`/api/checklists/${checklistId}/items/${itemId}`, {
    credentials: 'same-origin',
    method: 'DELETE',
  })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to delete checklist item (${response.status})`)
  }
  return (await response.json()) as Checklist
}

export async function recordClientProfileActivity(clientId: string) {
  const response = await fetch(`/api/clients/${encodeURIComponent(clientId)}/activity`, {
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

export async function setTemplateViewersRequest(
  templateId: string,
  viewerIds: string[],
  editorIds: string[],
) {
  const response = await fetch(`/api/checklist-templates/${templateId}/viewers`, {
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
