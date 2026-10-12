import { formatProposalMoney } from '../../lib/proposal-pricing.js'
import { engagementPartyName } from './engagements'
import { ApiError, type Engagement, type EngagementFeeMode } from './types'

/**
 * The words Mark as signed uses wherever it is offered - the engagement editor and the
 * client's Engagements card (featreq-b2142264) - kept in one place so the two never drift.
 */

/** "A", "A and B", "A, B and C". */
function listWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/**
 * What Mark as signed will do, for its confirm (engagements stage 3), ending in a
 * space when there is anything to say: a letter with no client creates one; a
 * letter to a client brings it the fee, plans, software and retainer.
 */
export function signingSentence(engagement: Engagement, feeLine: string | null = null): string {
  const figures = engagement.figures ?? {}
  const monthly = Number(figures.totals?.monthly ?? 0)
  const software = (figures.lines ?? []).filter(
    (line) => line?.group === 'Software' && !line.flag && Number(line.amount) > 0,
  )
  const retainer = Number(engagement.retainerAmount ?? 0)
  const brings = [
    ...(engagement.packageId || (engagement.planIds ?? []).length > 0
      ? ['the plans and package, with their checklists']
      : []),
    ...(software.length > 0 ? ['the software as monthly expenses'] : []),
    ...(retainer > 0 ? [`a draft retainer invoice of ${formatProposalMoney(retainer)} to review`] : []),
  ]
  if (!engagement.clientId) {
    return `This creates ${engagementPartyName(engagement)} as a client in Onboarding, with its contact${
      brings.length > 0 ? `, ${listWords(brings)}` : ''
    }, and opens its onboarding checklist at the Onboarding stage. `
  }
  // The fee as she chose it, with amounts, for a monthly client; else the bare words.
  const existing = [...(monthly > 0 && !feeLine ? ['the monthly fee'] : []), ...brings]
  // A superseding letter (stage 4) replaces the client's current engagement.
  const replaces =
    engagement.kind === 'superseding'
      ? "It replaces the client's current engagement: that one is marked Superseded, and the client's plans become this letter's plans (a letter naming none leaves them). "
      : ''
  return `${replaces}${existing.length > 0 ? `This brings ${listWords(existing)} to the client. ` : ''}${feeLine ? `Monthly fee: ${feeLine}. ` : ''}`
}

/**
 * The three things signing can do to an existing monthly client's fee, with amounts:
 * "Replace the current fee ($1,200.00 -> $150.00)", "Add to it ($1,200.00 + $150.00 =
 * $1,350.00)", "Keep $1,200.00".
 */
export function feeChoiceLines(current: number, letter: number): Record<EngagementFeeMode, string> {
  const money = (value: number) => formatProposalMoney(value)
  return {
    replace: `Replace the current fee (${money(current)} -> ${money(letter)})`,
    add: `Add to it (${money(current)} + ${money(letter)} = ${money(Math.round((current + letter) * 100) / 100)})`,
    keep: `Keep ${money(current)}`,
  }
}

/**
 * The fee choices when they matter - an existing client billed monthly and a letter with a
 * monthly fee - else null (a prospect, a client not billed monthly, a letter with none).
 */
export function engagementFeeChoices(
  engagement: Engagement,
  client: { billingMode?: string | null; monthlyRate?: number | null } | null | undefined,
): Record<EngagementFeeMode, string> | null {
  const monthly = Number(engagement.figures?.totals?.monthly ?? 0)
  return client && client.billingMode === 'subscription' && monthly > 0
    ? feeChoiceLines(Number(client.monthlyRate ?? 0), monthly)
    : null
}

/** The sentence a failed Mark as signed shows: the server's own, or a plain fallback. */
export function signRefusalSentence(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Could not mark the engagement as signed.'
}
