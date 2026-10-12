/**
 * Types for the plain-JS `lib/engagement-values.js`: the engagement editor lists the
 * same placeholders the server fills in.
 */

import type { LetterPlaceholder, LetterTemplateText, LetterValues } from './letter-template.js'

/** The engagement-only placeholders (scope 'engagement'). */
export declare const ENGAGEMENT_PLACEHOLDERS: ReadonlyArray<LetterPlaceholder>

export type EngagementFigures = {
  totals?: {
    monthly?: number
    annual?: number
    oneTime?: number
    cleanup?: number
    software?: number
  } | null
  lines?: ReadonlyArray<{
    serviceId?: string | null
    group?: string | null
    name?: string
    amount?: number
    cadence?: string | null
    formula?: string
    flag?: string | null
    role?: string | null
    hours?: number | null
    count?: number | null
  }> | null
  hoursByRole?: { bookkeeper?: number; accountant?: number; controller?: number } | null
  paymentTerms?: string
  inputs?: Record<string, number> | null
}

export type EngagementParty = {
  company?: string
  contactName?: string
  title?: string
  email?: string
  phone?: string
  addressLine1?: string
  addressLine2?: string
  city?: string
  state?: string
  postalCode?: string
}

export declare function engagementValues(args?: {
  engagement?: {
    party?: EngagementParty | null
    figures?: EngagementFigures | null
    retainerAmount?: number | string | null
    /** "YYYY-MM" (or a YYYY-MM-DD day in that month); default = the month after today. */
    startMonth?: string | null
  } | null
  snapshot?: EngagementFigures | null
  party?: EngagementParty | null
  client?: object | null
  contacts?: object[]
  firmSettings?: object | null
  now?: Date
  senderName?: string
  paymentTerms?: string
  inputs?: Record<string, number> | null
}): LetterValues

/**
 * The proposal lines the letter's service lists leave out (retired, unpriced, $0, no
 * count typed), with why - "Not in the letter: Budget (no count typed)".
 */
export declare function skippedEngagementLines(snapshot: EngagementFigures | null | undefined): Array<{
  name: string
  /** null for a selection the catalog no longer names. */
  group: string | null
  serviceId: string | null
  reason: string
}>

/** sha256 of the three boxes - the same hash as `letterTemplateHash`. */
export declare function engagementTemplateHash(template: LetterTemplateText | null | undefined): string
