import { dateOnlyInZone } from '../../lib/firm-time.js'
import { formatProposalMoney } from '../../lib/proposal-pricing.js'
import type { Engagement, EngagementKind, EngagementStatus } from './types'

/**
 * Engagements (docs/plans/engagements-2026-10.md, stage 2): the words the list and
 * the editor use for an engagement, in one place.
 */

export const ENGAGEMENT_STATUS_LABELS: Record<EngagementStatus, string> = {
  draft: 'Draft',
  sent: 'Sent',
  signed: 'Signed',
  superseded: 'Superseded',
  void: 'Void',
}

export const ENGAGEMENT_STATUSES = Object.keys(ENGAGEMENT_STATUS_LABELS) as EngagementStatus[]

export const ENGAGEMENT_KIND_LABELS: Record<EngagementKind, string> = {
  original: 'Original',
  amendment: 'Amendment',
  superseding: 'Superseding',
}

/** Who the letter is to: the company, else the contact, else a plain stand-in. */
export function engagementPartyName(engagement: Pick<Engagement, 'party'> | null | undefined): string {
  const party = engagement?.party
  return String(party?.company || party?.contactName || '').trim() || 'Unnamed party'
}

/** "2026-10-08" -> "Oct 8, 2026" (a firm calendar day, never shifted by the browser's zone). */
export function engagementDayLabel(day: string | null | undefined): string {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return day ?? ''
  return new Date(`${day}T12:00:00`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

/** An instant as the firm's calendar day, "Oct 8, 2026"; '' when there is none. */
export function engagementInstantLabel(instant: string | null | undefined): string {
  if (!instant) return ''
  const day = dateOnlyInZone(new Date(instant))
  return day ? engagementDayLabel(day) : ''
}

/** The monthly fee the engagement carries from its proposal, or a dash when there is none. */
export function engagementMonthlyFee(engagement: Pick<Engagement, 'figures'>): string {
  const monthly = Number(engagement.figures?.totals?.monthly ?? 0)
  return monthly > 0 ? formatProposalMoney(monthly) : '-'
}
