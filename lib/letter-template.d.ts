/**
 * Types for the plain-JS `lib/letter-template.js`, so the Letters page lists the
 * SAME placeholders the server fills in.
 */

/** Where a placeholder can be used: 'both' (Letters and engagement letters) or 'engagement' only. */
export type PlaceholderScope = 'both' | 'engagement'

export type LetterPlaceholder = {
  key: string
  label: string
  description: string
  /** A blank value stops the letter going to that client. */
  required: boolean
  scope: PlaceholderScope
}

export type LetterTemplateText = {
  subject?: string
  emailBody?: string
  letterBody?: string
}

export type LetterValues = Record<string, string>

export declare const letterPlaceholders: ReadonlyArray<LetterPlaceholder>

/** The engagement-only keys (scope 'engagement'); re-exported as ENGAGEMENT_PLACEHOLDERS by lib/engagement-values.js. */
export declare const engagementPlaceholders: ReadonlyArray<LetterPlaceholder>

/** 'letter' = the Letters page's list (the 'both' keys); 'engagement' = both + engagement-only. */
export declare function placeholdersFor(scope: 'letter' | 'engagement'): ReadonlyArray<LetterPlaceholder>

/** The letters' money format: "$1,234.50", or '' for zero, negative or missing. */
export declare function letterMoney(amount: unknown): string

type PlaceholderList = ReadonlyArray<Pick<LetterPlaceholder, 'key' | 'required'>>

export declare function letterValues(args: {
  client: object | null | undefined
  contacts?: object[]
  firmSettings?: object | null
  now?: Date
  senderName?: string
}): LetterValues

export declare function fillTemplate(
  text: string | null | undefined,
  values: LetterValues,
  /** The keys the text may use; the Letters list when omitted. */
  placeholders?: PlaceholderList | null,
): { text: string; missing: string[]; unknown: string[]; retired: string[]; esignTags: string[] }

export declare function templateWarnings(
  template: LetterTemplateText | null | undefined,
  /** The keys the text may use; the Letters list when omitted. */
  placeholders?: PlaceholderList | null,
): {
  unknown: string[]
  retired: string[]
  /** The SignWell field tags in the three boxes, as typed, every one (not a warning). */
  esignTags: string[]
}

/** True for one whole SignWell field tag the app sends, e.g. `{{initial:1:y}}` (signer 1 only). */
export declare function isEsignTag(token: string | null | undefined): boolean

/** Why an unknown key that reads as a field tag (`initial:2:y`) cannot be sent, or null. */
export declare function esignTagProblem(key: string): string | null

/** Placeholders the app no longer fills in, with the reason a letter naming one is told. */
export declare const retiredPlaceholders: Readonly<Record<string, string>>

/** "{{hourly_rate}} is no longer filled in - hourly clients have no single rate; take it out" */
export declare function retiredSentence(keys: string[]): string

/** sha256 of the three boxes, 64 hex characters. */
export declare function letterTemplateHash(template: LetterTemplateText | null | undefined): string
