/**
 * Deterministic "watch and learn" pattern detection for the AI assistant.
 *
 * Pure functions over workspace data — no model calls. The assistant's
 * suggestion cards and its get_usage_patterns chat tool both consume this,
 * so what the owner sees in cards and what the model reasons about are
 * always the same facts.
 *
 * Every suggestion carries a stable `key` so a dismissal sticks: the same
 * underlying pattern never re-surfaces once dismissed.
 */

const MONTH_WORDS =
  /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\b/g

/** Normalize a title/description so periodic variants group together
 * ("Payroll June 2026" ≈ "Payroll July 2026"). */
export function normalizeLabel(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(MONTH_WORDS, ' ')
    .replace(/20\d\d/g, ' ')
    .replace(/\d+/g, ' ')
    .replace(/[^a-z]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function monthOf(dateOnly) {
  return typeof dateOnly === 'string' && dateOnly.length >= 7 ? dateOnly.slice(0, 7) : null
}

/**
 * Detect repeated manual work worth automating.
 *
 * @param {object} data Workspace data (clients, checklists, checklistTemplates, timeEntries)
 * @param {{ today?: string }} [options] `today` as YYYY-MM-DD (injectable for tests)
 * @returns {Array<{key: string, kind: string, title: string, body: string, link: string}>}
 */
export function detectUsagePatterns(data, options = {}) {
  const today = options.today ?? new Date().toISOString().slice(0, 10)
  const clients = data.clients ?? []
  const checklists = data.checklists ?? []
  const templates = data.checklistTemplates ?? []
  const timeEntries = data.timeEntries ?? []

  const clientName = (id) => clients.find((client) => client.id === id)?.name ?? 'a client'
  const suggestions = []

  // A. Recurring-template candidates: the same task created BY HAND for the
  // same client in 2+ distinct months, with no active template covering it.
  const manualGroups = new Map()
  for (const checklist of checklists) {
    if (checklist.templateId) continue
    const norm = normalizeLabel(checklist.title)
    if (!norm) continue
    const groupKey = `${checklist.clientId ?? ''}:${norm}`
    const group = manualGroups.get(groupKey) ?? {
      clientId: checklist.clientId,
      norm,
      months: new Set(),
      latestTitle: checklist.title,
    }
    const month = monthOf(checklist.dueDate)
    if (month) group.months.add(month)
    group.latestTitle = checklist.title
    manualGroups.set(groupKey, group)
  }
  for (const group of manualGroups.values()) {
    if (group.months.size < 2) continue
    const templateExists = templates.some(
      (template) =>
        template.active !== false &&
        template.clientId === group.clientId &&
        normalizeLabel(template.title) === group.norm,
    )
    if (templateExists) continue
    suggestions.push({
      key: `recurring_template:${group.clientId ?? 'none'}:${group.norm}`,
      kind: 'recurring_template',
      title: `Make “${group.latestTitle}” a recurring template?`,
      body: `You've created this task by hand for ${clientName(group.clientId)} in ${group.months.size} different months. A recurring template would create it automatically each period.`,
      link: '/checklists',
    })
  }

  // B. Repeated manual time entries: same description logged manually 3+
  // times in the last 90 days — a task (or the timer) would track it better.
  const cutoff = new Date(`${today}T00:00:00Z`)
  cutoff.setUTCDate(cutoff.getUTCDate() - 90)
  const cutoffDate = cutoff.toISOString().slice(0, 10)
  const manualTime = new Map()
  for (const entry of timeEntries) {
    if (entry.entryMethod !== 'manual') continue
    if (typeof entry.date !== 'string' || entry.date < cutoffDate) continue
    const norm = normalizeLabel(entry.description)
    if (!norm) continue
    const groupKey = `${entry.clientId ?? ''}:${norm}`
    const group = manualTime.get(groupKey) ?? {
      clientId: entry.clientId,
      norm,
      count: 0,
      latestDescription: entry.description,
    }
    group.count += 1
    group.latestDescription = entry.description
    manualTime.set(groupKey, group)
  }
  for (const group of manualTime.values()) {
    if (group.count < 3) continue
    suggestions.push({
      key: `repeated_manual_time:${group.clientId ?? 'none'}:${group.norm}`,
      kind: 'repeated_manual_time',
      title: 'Recurring manual time entry spotted',
      body: `“${group.latestDescription}” has been logged manually ${group.count} times in the last 90 days for ${clientName(group.clientId)}. A recurring task would let the timer track it (and feed reports) automatically.`,
      link: '/time',
    })
  }

  // C. Stale recurring templates: active but the next due date slipped well
  // into the past — worth a look at the schedule. Blueprints (standard,
  // client-agnostic templates) never generate on their own, so a stale next-due
  // on them is noise — skip them. Each card names its CLIENT and deep-links to
  // the specific template, so several stalled templates that share a title
  // (e.g. "Monthly Reconciliations" on different clients) stay distinguishable
  // and one-click actionable.
  //
  // CRITICAL: a template's `nextDueDate` field is unreliable — it often doesn't
  // advance even while the template keeps generating instances every period. So
  // the old "nextDueDate is old" check alone false-flagged dozens of perfectly
  // healthy templates. We now cross-check ACTUAL generated instances: if the
  // template has produced a checklist due on/after its recorded nextDueDate (or
  // recently), it's demonstrably still running — not stalled — so skip it. Only
  // a template that truly hasn't generated its next occurrence is flagged.
  const latestInstanceDueByTemplate = new Map()
  for (const checklist of checklists) {
    if (!checklist.templateId || checklist.deletedAt) continue
    const due = typeof checklist.dueDate === 'string' ? checklist.dueDate : ''
    if (!due) continue
    const prev = latestInstanceDueByTemplate.get(checklist.templateId)
    if (!prev || due > prev) latestInstanceDueByTemplate.set(checklist.templateId, due)
  }
  for (const template of templates) {
    if (template.active === false) continue
    if (template.isStandard) continue
    if (typeof template.nextDueDate !== 'string' || !template.nextDueDate) continue
    const staleBefore = new Date(`${today}T00:00:00Z`)
    staleBefore.setUTCDate(staleBefore.getUTCDate() - 21)
    const staleBeforeIso = staleBefore.toISOString().slice(0, 10)
    if (template.nextDueDate >= staleBeforeIso) continue
    // Still generating? An instance at/after the recorded next-due, or a
    // recently-generated one, proves the template isn't actually stuck.
    const latestInstanceDue = latestInstanceDueByTemplate.get(template.id)
    if (
      latestInstanceDue &&
      (latestInstanceDue >= template.nextDueDate || latestInstanceDue >= staleBeforeIso)
    ) {
      continue
    }
    const forClient = clientName(template.clientId)
    suggestions.push({
      key: `stale_template:${template.id}`,
      kind: 'stale_template',
      title: `“${template.title}” for ${forClient} looks stalled`,
      body: `This recurring checklist for ${forClient} has a next due date of ${template.nextDueDate} — several weeks in the past — so it may have stopped generating. Open it to confirm the schedule, or turn it off if it's no longer needed.`,
      link: `/checklists?focusTemplate=${encodeURIComponent(template.id)}`,
    })
  }

  return suggestions
}
