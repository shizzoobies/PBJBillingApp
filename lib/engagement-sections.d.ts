/**
 * Types for the plain-JS `lib/engagement-sections.js`: the Settings page edits the
 * same section library, with the same rules, that the server assembles letters from.
 */

export type EngagementSectionTrigger = {
  /** Always in the letter. */
  always?: boolean
  /** In the letter when the proposal has a line in one of these service groups. */
  groups?: string[]
  /** In the letter when the proposal has a line for one of these catalog services. */
  serviceIds?: string[]
}

export type EngagementSectionRole = 'email' | 'letter'

export type EngagementSectionDraft = {
  key: string
  title: string
  body: string
  trigger: EngagementSectionTrigger
  sortOrder: number
  /** Derived from the key (`email` -> 'email'), never stored. */
  role: EngagementSectionRole
  active: boolean
}

export declare const ENGAGEMENT_SECTION_KEY_MAX: number
export declare const ENGAGEMENT_SECTION_TITLE_MAX: number
export declare const ENGAGEMENT_SECTION_BODY_MAX: number
export declare const ENGAGEMENT_SECTION_TRIGGER_MAX: number
export declare const ENGAGEMENT_SECTIONS_MAX: number
export declare const EMAIL_SECTION_KEY: 'email'
export declare const INTRO_SECTION_KEY: 'intro'

export declare const DEFAULT_ENGAGEMENT_SECTIONS: ReadonlyArray<Readonly<EngagementSectionDraft>>

export declare function sanitizeEngagementSection(input: unknown): EngagementSectionDraft | null
export declare function sanitizeEngagementSections(list: unknown): EngagementSectionDraft[]
export declare function isEmailSection(
  section: { key?: string; role?: string } | null | undefined,
): boolean

type TriggerLine = { group?: string | null; serviceId?: string | null }

export declare function sectionFires(
  section: { trigger?: EngagementSectionTrigger } | null | undefined,
  snapshotLines: ReadonlyArray<TriggerLine | null | undefined> | null | undefined,
): boolean

export declare function triggeredSections<
  T extends { key: string; trigger?: EngagementSectionTrigger; sortOrder?: number; active?: boolean; role?: string },
>(
  sections: ReadonlyArray<T> | null | undefined,
  snapshotLines: ReadonlyArray<TriggerLine | null | undefined> | null | undefined,
): T[]
