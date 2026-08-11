/**
 * "Why isn't X working?" — read-only diagnostics for the owner assistant.
 *
 * Tier 0 of docs/autonomous-updates-scoping.md §5. The premise is evidence
 * from this project's own history: a meaningful slice of the things reported
 * as BROKEN were CONFIG, not code — a payroll outage caused by a locked
 * timesheet month, and two recurring recipes that silently never generated.
 * Neither needed a developer; both needed someone to look at the right row.
 * These functions do that looking and say the answer in plain English.
 *
 * Everything here is PURE: it takes a workspace snapshot (or activity rows)
 * plus a "today", and returns JSON-able data. No I/O, no store, no clock —
 * so the explanations are unit-testable, and so the rules can't drift from
 * the code that actually enforces them:
 *   - the weekly gate + week anchor come from `lib/time-entry.js`
 *     (`listBlockingWeeks`, `weekStartOf`) — the very functions POST
 *     /api/time-entries uses to return its 423;
 *   - the recurring gate comes from `lib/recurring-gate.js`, shared with the
 *     materializer's skip rules and the To-100% "never generates" detector.
 */

import { evaluateRecurringTemplate } from './recurring-gate.js'
import { listBlockingWeeks, weekStartOf } from './time-entry.js'

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/** 'YYYY-MM' -> 'June 2026'. Returns the input unchanged if it isn't a month. */
export function monthLabel(period) {
  const text = String(period ?? '')
  if (!/^\d{4}-\d{2}$/.test(text)) return text
  const month = Number(text.slice(5, 7))
  if (month < 1 || month > 12) return text
  return `${MONTH_NAMES[month - 1]} ${text.slice(0, 4)}`
}

const lower = (value) => String(value ?? '').trim().toLowerCase()

/** Join names/dates the way a person would: "a", "a and b", "a, b, and c". */
function joinList(items) {
  const list = items.filter(Boolean)
  if (list.length === 0) return ''
  if (list.length === 1) return list[0]
  if (list.length === 2) return `${list[0]} and ${list[1]}`
  return `${list.slice(0, -1).join(', ')}, and ${list[list.length - 1]}`
}

/**
 * Resolve a person by id, exact name, or partial name across the active and
 * former team. Returns `{ member, candidates }`: `member` is null when nothing
 * matched OR when a partial name matched several people (then `candidates`
 * names them so the caller can ask which one).
 */
export function resolveTeamMember(data, query) {
  const active = (data?.employees ?? []).map((e) => ({ ...e, isActive: true }))
  const former = (data?.inactiveEmployees ?? []).map((e) => ({ ...e, isActive: false }))
  const people = [...active, ...former]
  const target = lower(query)
  if (!target) return { member: null, candidates: [] }

  const byId = people.find((person) => lower(person.id) === target)
  if (byId) return { member: byId, candidates: [] }

  const exact = people.filter((person) => lower(person.name) === target)
  if (exact.length === 1) return { member: exact[0], candidates: [] }
  if (exact.length > 1) return { member: null, candidates: exact.map((p) => p.name) }

  const partial = people.filter((person) => lower(person.name).includes(target))
  if (partial.length === 1) return { member: partial[0], candidates: [] }
  return { member: null, candidates: partial.map((person) => person.name) }
}

/**
 * Can this person log time right now — and if not, exactly what is stopping
 * them? Mirrors the two gates POST /api/time-entries applies, in the order it
 * applies them: the month lock (423 "This timesheet month is locked") and then
 * the weekly-submission gate (423 naming the blocking weeks).
 *
 * @param {object} data   An appDataStore.read() snapshot.
 * @param {{ person: string, today: string }} options
 *   `person` is a name or user id; `today` is yyyy-mm-dd.
 * @returns {object} See the `found: false` and `found: true` shapes below.
 */
export function diagnoseTimeLogging(data, { person, today } = {}) {
  const { member, candidates } = resolveTeamMember(data, person)
  if (!member) {
    return {
      found: false,
      asked: String(person ?? ''),
      candidates,
      summary: candidates.length
        ? `More than one team member matches “${person}”: ${joinList(candidates)}. Which one?`
        : `No team member matches “${person}”.`,
    }
  }

  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(String(today ?? ''))
    ? today
    : new Date().toISOString().slice(0, 10)
  const week = weekStartOf(asOf)
  const period = asOf.slice(0, 7)
  const isOwner = String(member.role ?? '').toLowerCase() === 'owner'

  const locks = (data?.timesheetLocks ?? []).filter((lock) => lock.userId === member.id)
  const lockedMonths = [...new Set(locks.map((lock) => lock.period))].sort()

  const base = {
    found: true,
    person: { id: member.id, name: member.name, role: member.role, active: member.isActive },
    asOf,
    week,
    lockedMonths,
  }

  // A removed team member can't sign in at all, so nothing below matters —
  // and "she isn't on the team anymore" is the answer, not a gate.
  if (member.isActive === false) {
    return {
      ...base,
      canLogTime: false,
      blockers: [{ kind: 'former-member', fix: 'Re-invite them from the Team page.' }],
      summary:
        `${member.name} is no longer an active team member, so they can't sign in or ` +
        'log time at all. Re-invite them from the Team page if that was not intended.',
    }
  }

  // Owners are exempt from BOTH gates — they're the approver and the person
  // who locks months, so neither ever applies to them.
  if (isOwner) {
    return {
      ...base,
      canLogTime: true,
      blockers: [],
      summary:
        `${member.name} is an owner, so nothing blocks them: owners are exempt from ` +
        'both the month lock and the weekly-timesheet gate.',
    }
  }

  const blockers = []
  if (lockedMonths.includes(period)) {
    blockers.push({
      kind: 'locked-month',
      period,
      label: monthLabel(period),
      fix: `An owner unlocks ${monthLabel(period)} on the Timesheet page.`,
    })
  }

  // Weeks inside a locked month never gate (locking auto-approves its entries
  // but leaves no submission row behind) — same `lockedPeriods` set the server
  // passes in.
  const priorWeeksWithTime = (data?.timeEntries ?? [])
    .filter((entry) => entry.employeeId === member.id)
    .map((entry) => weekStartOf(entry.date))
  const blockingWeeks = listBlockingWeeks(
    week,
    priorWeeksWithTime,
    (data?.weeklySubmissions ?? []).filter((entry) => entry.userId === member.id),
    new Set(lockedMonths),
    // The question this tool answers is "can they log time AS OF `asOf`?", so
    // the entry week and today's week are the same week — the past-week backfill
    // escape never applies here, and the verdict is unchanged.
    week,
  )
  for (const blocking of blockingWeeks) {
    blockers.push({
      kind: blocking.reason === 'rejected' ? 'rejected-week' : 'unsubmitted-week',
      weekStart: blocking.weekStart,
      fix:
        blocking.reason === 'rejected'
          ? `${member.name} fixes and RESUBMITS the week of ${blocking.weekStart} on the Timesheet page.`
          : `${member.name} submits the week of ${blocking.weekStart} on the Timesheet page.`,
    })
  }

  return { ...base, canLogTime: blockers.length === 0, blockers, summary: explainTimeLogging(member, asOf, blockers) }
}

/** Plain-English verdict for `diagnoseTimeLogging`, kept separate for tests. */
function explainTimeLogging(member, asOf, blockers) {
  if (blockers.length === 0) {
    return `Nothing is blocking ${member.name} — they can log time for ${asOf} right now.`
  }
  const parts = []
  const locked = blockers.filter((b) => b.kind === 'locked-month')
  if (locked.length) {
    parts.push(
      `${member.name}'s timesheet is LOCKED for ${joinList(locked.map((b) => b.label))}, so ` +
        `they can't log or change time dated in ${locked.length === 1 ? 'that month' : 'those months'}. ` +
        'Only an owner can unlock it, on the Timesheet page.',
    )
  }
  const rejected = blockers.filter((b) => b.kind === 'rejected-week').map((b) => b.weekStart)
  const unsubmitted = blockers.filter((b) => b.kind === 'unsubmitted-week').map((b) => b.weekStart)
  if (rejected.length) {
    parts.push(
      `The week${rejected.length === 1 ? '' : 's'} of ${joinList(rejected)} ` +
        `${rejected.length === 1 ? 'was' : 'were'} sent back for changes — ${member.name} has to fix and ` +
        'resubmit it on the Timesheet page before logging more time.',
    )
  }
  if (unsubmitted.length) {
    parts.push(
      `${unsubmitted.length === 1 ? 'An earlier week' : `${unsubmitted.length} earlier weeks`} with ` +
        `logged time ${unsubmitted.length === 1 ? 'has' : 'have'} never been submitted ` +
        `(${joinList(unsubmitted)}). ${member.name} submits ` +
        `${unsubmitted.length === 1 ? 'it' : 'them'} on the Timesheet page, then the timer works again.`,
    )
  }
  return parts.join(' ')
}

/** What each gate reason means, and what fixes it — in the owner's terms. */
const GATE_EXPLANATIONS = {
  'no-client': {
    problem: "It isn't attached to a client, so it can't generate anything.",
    fix: 'Open the checklist and pick the client it belongs to.',
  },
  'inactive-client': {
    problem:
      "Its client has been marked inactive, so nothing new is generated for them. Everything already generated is still there.",
    fix: 'Reactivate the client from the Clients page if they are coming back.',
  },
  inactive: {
    problem: "It's switched OFF, so it won't generate any new checklists.",
    fix: 'Turn it back on from the Checklists page (this one I can do for you).',
  },
  'no-stages': {
    problem: 'It has no stages set up, so there is nothing to generate.',
    fix: 'Open it and add the stage (and the steps) that should run each time.',
  },
  'no-steps': {
    problem: 'Its first stage has no steps, so it never generates.',
    fix: 'Open it and add the steps that should be done each time.',
  },
  'no-months': {
    problem: 'It repeats in specific months, but no months are selected, so it never generates.',
    fix: 'Open it and tick the months it should run in.',
  },
  'stale-year': {
    problem: '"Repeat every year" is off and its scheduled year is not this year.',
    fix: 'Turn "Repeat every year" back on, or set its scheduled year to this year.',
  },
  'no-due-date': {
    problem: 'It has no next due date, so the schedule never starts.',
    fix: 'Open it and set the next due date.',
  },
}

const WARNING_EXPLANATIONS = {
  'no-assignee': 'It generates, but its first stage has nobody assigned, so the checklists land on nobody and only an owner can complete the steps.',
  'no-board-column': 'It generates, but has no Board column, so its checklists pile into "Uncategorized".',
}

/**
 * Will each recurring checklist generate next cycle — and if not, exactly
 * which ingredient is missing? Runs the shared gate (`evaluateRecurringTemplate`),
 * the same one the materializer skips on and the To-100% page reports from.
 *
 * @param {object} data  An appDataStore.read() snapshot.
 * @param {{ subject?: string, today?: string }} options
 *   `subject` matches a client name OR a template title (partial, case-
 *   insensitive). Omit it to report every recipe that will NEVER generate.
 */
export function diagnoseRecurringChecklists(data, { subject, today } = {}) {
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(String(today ?? ''))
    ? today
    : new Date().toISOString().slice(0, 10)
  const currentYear = Number(asOf.slice(0, 4))
  const clients = data?.clients ?? []
  const clientNameById = new Map(clients.map((client) => [client.id, client.name]))
  // Retired clients are still fully searchable here — the whole point of this
  // tool is answering "why did X stop generating?", and "because you retired
  // them" is the answer most worth being able to give.
  const clientStageById = new Map(
    clients.map((client) => [client.id, client.lifecycleStage ?? 'active']),
  )

  const generatedCounts = new Map()
  for (const checklist of data?.checklists ?? []) {
    if (!checklist.templateId) continue
    generatedCounts.set(checklist.templateId, (generatedCounts.get(checklist.templateId) ?? 0) + 1)
  }

  const target = lower(subject)
  const scheduled = (data?.checklistTemplates ?? []).filter((template) => !template.isStandard)
  const matches = target
    ? scheduled.filter(
        (template) =>
          lower(template.title).includes(target) ||
          lower(clientNameById.get(template.clientId)).includes(target),
      )
    : scheduled

  const rows = matches.map((template) => {
    const verdict = evaluateRecurringTemplate(template, {
      currentYear,
      clientStage: template.clientId ? clientStageById.get(template.clientId) : undefined,
    })
    const generated = generatedCounts.get(template.id) ?? 0
    const explanation = verdict.reason ? GATE_EXPLANATIONS[verdict.reason] : null
    return {
      title: template.title,
      client: clientNameById.get(template.clientId) ?? null,
      frequency: template.frequency ?? null,
      switchedOn: template.active !== false,
      willGenerate: verdict.reason === null,
      missing: verdict.reason,
      problem: explanation?.problem ?? null,
      fix: explanation?.fix ?? null,
      hasEverGenerated: generated > 0,
      generatedCount: generated,
      warnings: verdict.warnings.map((warning) => WARNING_EXPLANATIONS[warning]).filter(Boolean),
    }
  })

  const broken = rows.filter((row) => !row.willGenerate)
  const healthy = rows.length - broken.length

  if (!target) {
    // No subject: the standing question — what will never generate at all?
    return {
      scope: 'all',
      checked: rows.length,
      brokenCount: broken.length,
      templates: broken,
      summary: broken.length
        ? `${broken.length} of ${rows.length} recurring checklists will never generate as set up: ` +
          `${joinList(broken.map((row) => (row.client ? `${row.title} (${row.client})` : row.title)))}. ` +
          `The other ${healthy} are fine.`
        : `All ${rows.length} recurring checklists are set up to generate — nothing is silently stuck.`,
    }
  }

  if (rows.length === 0) {
    return {
      scope: 'match',
      subject,
      checked: 0,
      brokenCount: 0,
      templates: [],
      summary: `No recurring checklist matches “${subject}” (checked titles and client names).`,
    }
  }

  return {
    scope: 'match',
    subject,
    checked: rows.length,
    brokenCount: broken.length,
    templates: rows,
    summary: broken.length
      ? `${broken.length} of the ${rows.length} matching recurring checklists will never generate: ` +
        joinList(broken.map((row) => `${row.title} — ${row.problem}`))
      : `All ${rows.length} matching recurring checklists will generate on schedule.`,
  }
}

/**
 * Activity-log action codes whose raw form reads badly, or whose meaning
 * matters for tracing a surprise. Anything not listed falls back to the code
 * with underscores swapped for spaces, which reads fine for the rest
 * ("client_created" -> "client created").
 */
const ACTION_LABELS = {
  timesheet_locked: 'locked a timesheet month',
  timesheet_unlocked: 'unlocked a timesheet month',
  weekly_timesheet_submitted: 'submitted a weekly timesheet',
  weekly_timesheet_approved: 'approved a weekly timesheet',
  weekly_timesheet_rejected: 'sent a weekly timesheet back for changes',
  weekly_timesheet_reopened: 'reopened a weekly timesheet',
  time_entry_approved: 'approved a time entry',
  time_entry_rejected: 'sent a time entry back',
  time_entries_batch_approved: 'approved a batch of time entries',
  time_entry_split: 'split a time entry',
  time_entry_manual_submitted: 'logged time by hand',
  bulk_save_refused_stale: 'had a save refused because the page was out of date',
  checklist_created: 'created a checklist',
  checklist_edited: 'edited a checklist',
  checklist_deleted: 'deleted a checklist',
  checklist_restored: 'restored a checklist from the bin',
  checklist_bin_emptied: 'emptied the checklist recycle bin',
  template_copied_to_client: 'attached a recurring checklist to a client',
  template_stage_edited: 'edited a checklist stage',
  template_viewers_updated: 'changed who can see a checklist',
  client_team_updated: "changed a client's assigned team",
  client_profile_updated: 'updated a client profile',
  client_created: 'added a client',
  team_invited: 'invited a team member',
  team_removed: 'removed a team member',
  firm_settings_updated: 'changed firm settings',
  feature_request_sent: 'sent a request to Alex',
}

/** 'assistant_action:assign_client' -> 'ran an assistant action (assign client)'. */
function humanizeAction(action) {
  const code = String(action ?? '')
  if (ACTION_LABELS[code]) return ACTION_LABELS[code]
  if (code.startsWith('assistant_action:')) {
    return `ran an assistant action (${code.slice('assistant_action:'.length).replace(/_/g, ' ')})`
  }
  return code.replace(/_/g, ' ') || 'did something'
}

const MAX_CHANGES = 40

/**
 * "What changed recently?" — activity-log rows turned into plain English, for
 * tracing a surprise back to the change that caused it.
 *
 * @param {Array<{userId: string, action: string, target: string, timestamp: string}>} entries
 *   Rows from `appDataStore.getActivityRange` (newest first is fine; this
 *   re-sorts).
 * @param {{ subject?: string, days?: number, now?: string, nameById?: Map|object }} options
 *   `subject` filters on the actor's name, the action, or the target text.
 *   `days` defaults to 7. `now` is an ISO timestamp (defaults to the clock).
 */
export function summarizeRecentChanges(entries, { subject, days, now, nameById } = {}) {
  const windowDays = Number(days) > 0 ? Math.min(Math.floor(Number(days)), 365) : 7
  const nowIso = typeof now === 'string' && now ? now : new Date().toISOString()
  const since = new Date(new Date(nowIso).getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString()
  const lookup =
    nameById instanceof Map ? nameById : new Map(Object.entries(nameById ?? {}))
  const target = lower(subject)

  const rows = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && typeof entry.timestamp === 'string' && entry.timestamp >= since)
    .map((entry) => ({
      when: entry.timestamp,
      date: entry.timestamp.slice(0, 10),
      who: lookup.get(entry.userId) ?? entry.userId ?? 'someone',
      what: humanizeAction(entry.action),
      detail: String(entry.target ?? ''),
    }))
    .filter((row) => {
      if (!target) return true
      return (
        lower(row.who).includes(target) ||
        lower(row.what).includes(target) ||
        lower(row.detail).includes(target)
      )
    })
    .sort((a, b) => (a.when < b.when ? 1 : -1))

  const shown = rows.slice(0, MAX_CHANGES)
  const scope = target ? ` mentioning “${subject}”` : ''
  return {
    windowDays,
    since,
    subject: subject ? String(subject) : null,
    count: rows.length,
    changes: shown,
    truncated: rows.length > shown.length,
    summary: rows.length
      ? `${rows.length} change${rows.length === 1 ? '' : 's'}${scope} in the last ${windowDays} days` +
        `${rows.length > shown.length ? ` (showing the ${shown.length} most recent)` : ''}.`
      : `Nothing${scope} changed in the last ${windowDays} days.`,
  }
}
