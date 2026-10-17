import { dateOnlyInZone } from '../../lib/firm-time.js'
import { formatProposalMoney } from '../../lib/proposal-pricing.js'
import { ApiError, type Engagement, type EngagementKind, type EngagementStatus } from './types'

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

/** The engagement a 409 names (Draft the engagement when one exists already), or null. */
export function refusedEngagementId(err: unknown): string | null {
  const id = (err as { engagementId?: unknown } | null)?.engagementId
  return typeof id === 'string' && id ? id : null
}

/**
 * Send's refusals, each as a plain sentence for the page. The server's own
 * sentence is used where it names something specific (the placeholders, the
 * status); the rest say what to do next.
 */
export function engagementSendRefusalSentence(err: unknown): string {
  if (!(err instanceof ApiError)) return 'Could not send the engagement letter. Nothing was sent.'
  switch (err.code) {
    case 'engagement_changed':
      return 'The engagement changed since this page loaded, so nothing was sent. The page now shows the saved version: check it and send again.'
    case 'unknown_placeholder':
    case 'missing_placeholder':
      return err.message
    case 'engagement_empty':
      return 'Write the subject, the email and the letter before sending. Nothing was sent.'
    case 'engagement_refused':
      if (err.reason === 'sending') {
        return 'A send of this letter is already under way - wait a minute, then check Activity. Nothing more was sent.'
      }
      return err.reason === 'just_sent'
        ? 'This letter went out a moment ago - check the Activity list before sending again.'
        : /Nothing was sent\.?$/.test(err.message)
          ? err.message
          : `${err.message} Nothing was sent.`
    case 'team_address':
      return "That address belongs to someone on your team. An engagement letter goes to the client only: choose the client's address. Nothing was sent."
    case 'no_recipient':
      return "There is no email address to send to. Add the client's address to the party, or add it for this send at Send. Nothing was sent."
    case 'engagement_invalid':
      return 'The chosen addresses could not be read. Choose who it goes to again. Nothing was sent.'
    case 'pdf_failed':
      return 'The PDF could not be built, so nothing was sent. Open Preview to see what is wrong, or try again in a minute.'
    case 'engagement_send_failed':
      return 'Email is not set up yet (no sending address), so nothing was sent.'
    default:
      if (err.status === 404) return 'This engagement no longer exists. Nothing was sent.'
      return err.message || 'Could not send the engagement letter. Nothing was sent.'
  }
}
