/**
 * Types for the plain-JS `lib/letter-template.js`, so the Letters page lists the
 * SAME placeholders the server fills in.
 */

export type LetterPlaceholder = {
  key: string
  label: string
  description: string
  /** A blank value stops the letter going to that client. */
  required: boolean
}

export type LetterTemplateText = {
  subject?: string
  emailBody?: string
  letterBody?: string
}

export type LetterValues = Record<string, string>

export declare const letterPlaceholders: ReadonlyArray<LetterPlaceholder>

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
): { text: string; missing: string[]; unknown: string[]; retired: string[] }

export declare function templateWarnings(template: LetterTemplateText | null | undefined): {
  unknown: string[]
  retired: string[]
}

/** Placeholders the app no longer fills in, with the reason a letter naming one is told. */
export declare const retiredPlaceholders: Readonly<Record<string, string>>

/** "{{hourly_rate}} is no longer filled in - hourly clients have no single rate; take it out" */
export declare function retiredSentence(keys: string[]): string

/** sha256 of the three boxes, 64 hex characters. */
export declare function letterTemplateHash(template: LetterTemplateText | null | undefined): string
