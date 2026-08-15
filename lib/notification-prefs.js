/**
 * Per-user EMAIL notification preferences.
 *
 * One source of truth for the toggle catalog: the server endpoint serves it to
 * the Settings/Notifications UI, and notify() consults it before sending the
 * email side of a notification. In-app bell notifications are never gated —
 * they remain the source of truth (lib/notify.js).
 *
 * Prefs are stored per user as a sparse object of { [prefKey]: boolean }.
 * A missing key means ENABLED — so new notification types default to on and
 * existing users never miss a new kind of email because of a stale prefs row.
 */

export const EMAIL_PREF_TYPES = [
  {
    key: 'taskAssigned',
    label: 'Task assigned to you',
    description: 'A checklist or workflow task is assigned to you.',
    events: ['task_assigned'],
  },
  {
    key: 'workflowProgress',
    label: 'Workflow progress',
    description: 'A workflow you opened moves forward or is completed by someone else.',
    events: ['case_advanced', 'case_completed'],
  },
  {
    key: 'waitingUpdates',
    label: 'Waiting-on updates',
    description: 'Someone is waiting on you, or a task you were waiting on is resolved.',
    events: ['waiting_on_requested', 'waiting_on_done', 'waiting_on_cancelled', 'waiting_cleared'],
  },
  {
    key: 'timeApprovals',
    label: 'Time entries needing approval',
    description: 'A manual time entry is submitted and needs your approval (owners).',
    events: ['time_entry_manual'],
  },
  {
    key: 'timeSentBack',
    label: 'Your time entry was sent back',
    description: 'A time entry you logged was rejected and needs your attention.',
    events: ['time_entry_rejected'],
  },
  {
    key: 'deletionRequests',
    label: 'Deletion requests',
    description: 'A team member asks to delete a checklist or checklist item (owners).',
    events: ['checklist_deletion_requested', 'checklist_item_deletion_requested'],
  },
  {
    key: 'editRequests',
    label: 'Edit requests and decisions',
    description: 'An edit awaits your approval, or your submitted edit was decided.',
    events: ['task_edit_requested', 'task_edit_approved', 'task_edit_rejected'],
  },
  {
    key: 'skippedTasks',
    label: 'Skipped recurring tasks',
    description:
      'A recurring task is skipped for a cycle, or a team member creates a task you may want to allow skipping on.',
    events: ['checklist_skipped', 'task_created_by_staff'],
  },
  {
    key: 'updatesTracker',
    label: 'Updates tracker activity',
    description:
      'A new update is logged, or one changes status — shipped, sent back to planned, picked up, and so on.',
    events: ['update_created', 'update_status_changed'],
  },
]

const EVENT_TO_PREF_KEY = new Map()
for (const type of EMAIL_PREF_TYPES) {
  for (const event of type.events) {
    EVENT_TO_PREF_KEY.set(event, type.key)
  }
}

const KNOWN_PREF_KEYS = new Set(EMAIL_PREF_TYPES.map((type) => type.key))

/**
 * Keep only known keys with strictly-boolean values. Anything else (junk keys,
 * strings, numbers) is dropped rather than coerced, so the stored object can
 * only ever contain deliberate toggles.
 */
export function sanitizeEmailPrefs(input) {
  const clean = {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return clean
  }
  for (const [key, value] of Object.entries(input)) {
    if (KNOWN_PREF_KEYS.has(key) && typeof value === 'boolean') {
      clean[key] = value
    }
  }
  return clean
}

/**
 * Should an email be sent to a user with `prefs` for this notification event?
 * Default is YES: unknown events, missing prefs, and unset keys all send —
 * only an explicit `false` on the event's pref key suppresses the email.
 */
export function isEmailEnabledForEvent(prefs, event) {
  const key = EVENT_TO_PREF_KEY.get(event)
  if (!key) return true
  if (!prefs || typeof prefs !== 'object') return true
  return prefs[key] !== false
}
