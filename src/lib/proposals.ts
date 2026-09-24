import type {
  Proposal,
  ProposalChatPatch,
  ProposalGroup,
  ProposalMultiplier,
  ProposalPatch,
  ProposalPricingKind,
  ProposalRole,
  ProposalSelection,
  ProposalService,
  ProposalStatus,
  ProposalTotals,
} from './types'

/**
 * Words for the proposal catalog's enums (featreq-311473e2). One place, so the
 * Settings table and the proposal editor can never name the same thing twice
 * two different ways.
 */
export const PROPOSAL_ROLE_LABELS: Record<ProposalRole, string> = {
  bookkeeper: 'Bookkeeper (B)',
  accountant: 'Accountant (A)',
  controller: 'Controller (C)',
}

export const PROPOSAL_MULTIPLIER_LABELS: Record<ProposalMultiplier, string> = {
  none: 'None',
  'weekly-x4': 'Weekly (x 4)',
  'quarterly-div3': 'Quarterly (/ 3)',
  'yearly-div12': 'Yearly (/ 12)',
  'per-cleanup-month': 'Per clean-up month',
  'per-report': 'Per report',
  'per-form': 'Per form',
  'per-count': 'Per count',
}

export const PROPOSAL_PRICING_LABELS: Record<ProposalPricingKind, string> = {
  formula: 'Formula',
  flat: 'Flat amount',
  payroll: 'Payroll block',
  'sales-tax': 'Sales tax block',
}

export const PROPOSAL_STATUS_LABELS: Record<ProposalStatus, string> = {
  draft: 'Draft',
  sent: 'Sent',
  accepted: 'Accepted',
  declined: 'Declined',
}

/** The name a proposal goes by in a list or a heading. */
export function proposalTitle(proposal: Pick<Proposal, 'prospect'>): string {
  return (
    proposal.prospect.company.trim() || proposal.prospect.contactName.trim() || 'Untitled prospect'
  )
}

/** "Sep 23, 2026" from an ISO timestamp; '' for anything else. */
export function proposalDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/* ---- The editor's tabs ------------------------------------------------- */

export type ProposalTab = 'estimate' | 'letter' | 'activity'

export const PROPOSAL_TABS: Array<{ key: ProposalTab; label: string }> = [
  { key: 'estimate', label: 'Estimate' },
  { key: 'letter', label: 'Letter' },
  { key: 'activity', label: 'Activity' },
]

/** `?tab=` wins when it names a tab; anything else is the Estimate. */
export function resolveProposalTab(param: string | null): ProposalTab {
  return PROPOSAL_TABS.some((tab) => tab.key === param) ? (param as ProposalTab) : 'estimate'
}

/**
 * A save built from the SERVER'S latest proposal rather than from whatever the
 * component last rendered (review C1) — so a save queued behind another one
 * still starts from the state that one produced, not a stale render's.
 */
export type ProposalPatchBuilder = (latest: Proposal) => ProposalPatch

/** The four totals, in the order the estimate and the PDF show them. */
export const PROPOSAL_TOTAL_LABELS: Array<[keyof ProposalTotals, string]> = [
  ['monthly', 'Monthly fee'],
  ['annual', 'Annual fees'],
  ['oneTime', 'One-time fees'],
  ['cleanup', 'Clean-up'],
]

/* ---- The service picker ------------------------------------------------ */

/**
 * One line of the picker: a service NAME within a group, with every tier of it
 * as an option. "Weekly transactions" is one row with Basic / Classes /
 * Advance; "Reconciliations" is one row with a single option.
 */
export type PickerRow = {
  key: string
  group: ProposalGroup
  name: string
  options: ProposalService[]
}

/**
 * The catalog, grouped for the picker, in catalog order: every active row,
 * PLUS any row a retired catalog change left selected on this proposal — a
 * row a client is already committed to does not vanish from the picker just
 * because it was retired (review I2). Its options render disabled with a
 * "Retired" tag; `selectService` still clears it via "None" or another tier,
 * and the Estimate table's Remove button clears it too (review I3).
 */
export function pickerGroups(
  services: readonly ProposalService[],
  selections: readonly ProposalSelection[] = [],
): Array<{ group: ProposalGroup; rows: PickerRow[] }> {
  const selectedIds = new Set(selections.map((entry) => entry.serviceId))
  const groups: Array<{ group: ProposalGroup; rows: PickerRow[] }> = []
  const sorted = services
    .filter((service) => service.active || selectedIds.has(service.id))
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
  for (const service of sorted) {
    let bucket = groups.find((entry) => entry.group === service.group)
    if (!bucket) {
      bucket = { group: service.group, rows: [] }
      groups.push(bucket)
    }
    const key = `${service.group}::${service.name}`
    const row = bucket.rows.find((entry) => entry.key === key)
    if (row) row.options.push(service)
    else bucket.rows.push({ key, group: service.group, name: service.name, options: [service] })
  }
  return groups
}

/**
 * Pick one option of a picker row (or none): every option of the row is
 * removed, then the chosen one is added back — keeping its typed fields if it
 * was already selected. A client is on Basic OR Advance, never both.
 *
 * `rowOptions` is the row `pickerGroups` built, so it already carries every
 * service sharing this row's `group::name` — active ones AND a retired one
 * that is currently selected — so choosing "None" or another tier here also
 * clears a retired selection (review I2).
 */
export function selectService(
  selections: readonly ProposalSelection[],
  rowOptions: readonly ProposalService[],
  serviceId: string | null,
): ProposalSelection[] {
  const optionIds = new Set(rowOptions.map((option) => option.id))
  const previous = serviceId ? selections.find((entry) => entry.serviceId === serviceId) : undefined
  const rest = selections.filter((entry) => !optionIds.has(entry.serviceId))
  return serviceId ? [...rest, previous ?? { serviceId }] : rest
}

/** Merge fields into one selection; a null or undefined value removes the field. */
export function updateSelection(
  selections: readonly ProposalSelection[],
  serviceId: string,
  patch: Partial<Record<Exclude<keyof ProposalSelection, 'serviceId'>, unknown>>,
): ProposalSelection[] {
  return selections.map((entry) => {
    if (entry.serviceId !== serviceId) return entry
    const next: Record<string, unknown> = { ...entry }
    for (const [field, value] of Object.entries(patch)) {
      if (value === null || value === undefined) delete next[field]
      else next[field] = value
    }
    return next as ProposalSelection
  })
}

/** A count typed into the inputs panel; blank removes it. */
export function withInput(
  inputs: Readonly<Record<string, number>>,
  key: string,
  value: number | null,
): Record<string, number> {
  const next = { ...inputs }
  if (value === null) delete next[key]
  else next[key] = value
  return next
}

/* ---- Activity ------------------------------------------------------------ */

const DELIVERY_WORDS: Record<string, string> = {
  sent: 'Accepted by the mail provider',
  delivered: 'Delivered',
  delayed: 'Delivery delayed',
  bounced: 'Bounced',
  complained: 'Marked as spam',
}

/** What happened to a proposal, oldest first: created, letter, sends, delivery, outcome. */
export function proposalActivity(
  proposal: Proposal,
): Array<{ at: string; text: string; href?: string }> {
  const entries: Array<{ at: string; text: string; href?: string }> = [
    {
      at: proposal.createdAt,
      text: proposal.copiedFromId ? `Created as a copy of ${proposal.copiedFromId}` : 'Created',
      href: proposal.copiedFromId ? `/proposals/${proposal.copiedFromId}` : undefined,
    },
  ]
  if (proposal.letterAt) entries.push({ at: proposal.letterAt, text: 'Letter drafted' })
  for (const entry of proposal.emailLog) {
    const to = entry.to.join(', ')
    if (entry.kind === 'send') {
      entries.push({
        at: entry.at,
        text: entry.ok ? `Sent to ${to}` : `Send to ${to} failed: ${entry.error ?? 'unknown error'}`,
      })
    } else {
      const word = DELIVERY_WORDS[entry.event ?? ''] ?? entry.event ?? 'Delivery event'
      entries.push({ at: entry.at, text: `${word}${to ? ` (${to})` : ''}` })
    }
  }
  if (proposal.acceptedAt) entries.push({ at: proposal.acceptedAt, text: 'Accepted' })
  if (proposal.declinedAt) {
    entries.push({
      at: proposal.declinedAt,
      text: `Declined${proposal.declineNote ? `: ${proposal.declineNote}` : ''}`,
    })
  }
  return entries.sort((a, b) => a.at.localeCompare(b.at))
}

/**
 * What one chat turn changed, as the keys the Estimate tab highlights:
 * `prospect:<field>`, `input:<key>`, `service:<id>`.
 */
export function changedKeys(patch: ProposalChatPatch | null | undefined): Set<string> {
  const keys = new Set<string>()
  for (const field of Object.keys(patch?.prospect ?? {})) keys.add(`prospect:${field}`)
  for (const key of Object.keys(patch?.inputs ?? {})) keys.add(`input:${key}`)
  for (const entry of patch?.selections?.add ?? []) keys.add(`service:${entry.serviceId}`)
  return keys
}

/**
 * The delivery badge beside "Send to prospect": what the mail provider last
 * said about the most recent successful send, or "Sent <date>" before it has
 * said anything. Null when nothing has gone out.
 */
export function proposalDeliveryBadge(proposal: Proposal): string | null {
  const lastSend = proposal.emailLog.filter((entry) => entry.kind === 'send' && entry.ok).at(-1)
  if (!lastSend) return null
  const latest = proposal.emailLog
    .filter(
      (entry) =>
        entry.kind === 'delivery' &&
        entry.providerId !== null &&
        entry.providerId === lastSend.providerId,
    )
    .at(-1)
  if (latest) return DELIVERY_WORDS[latest.event ?? ''] ?? latest.event ?? 'Sent'
  return `Sent ${proposalDate(lastSend.at)}`
}
