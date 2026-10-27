/**
 * Types for the plain-JS `lib/proposal-questionnaire.js`, so `src/` can build and
 * read the same question list the server freezes onto a questionnaire.
 *
 * Keep these in sync with the actual exports in lib/proposal-questionnaire.js.
 */

import type { ProposalPricing, ProposalProspect, ProposalSelection } from './proposal-pricing.js'

export type QuestionnaireQuestionType =
  | 'text'
  | 'longtext'
  | 'email'
  | 'phone'
  | 'number'
  | 'choice'
  | 'multi'

export type QuestionnaireQuestion = {
  id: string
  label: string
  type: QuestionnaireQuestionType
  help?: string
  options?: Array<{ value: string; label: string }>
  /** Only asked on a call - a prospect cannot know it. */
  callOnly?: boolean
  /** The prospect field this answer fills. */
  prospect?: keyof ProposalProspect
  /** The calculator input this count fills. */
  inputKey?: string
  /** One of her own follow-up questions (featreq-fccf901f). */
  custom?: boolean
  /** A follow-up she marked required: needed on the link whenever it is asked. */
  required?: boolean
  /** Asked only when that question was answered this way (`any` = answered at all). */
  when?: QuestionnaireCondition
}

export type QuestionnaireCondition = { questionId: string; answer: string }

export type CustomQuestionType = 'yes_no' | 'short_text' | 'long_text' | 'choice'

/** One of her follow-up questions as Settings stores it (featreq-fccf901f). */
export type QuestionnaireCustomQuestion = {
  id: string
  label: string
  help?: string
  type: CustomQuestionType
  /** Choice only. */
  options?: string[]
  required: boolean
  active: boolean
  when?: QuestionnaireCondition
}

export type QuestionnaireSection = {
  id: string
  title: string
  questions: QuestionnaireQuestion[]
}

export type Questionnaire = { welcome: string; sections: QuestionnaireSection[] }

export declare const QUESTIONNAIRE_WELCOME: string
export declare const QUESTIONNAIRE_NOTES_MARKER: string
export declare const QUESTIONNAIRE_EXPIRY_DAYS: number

export declare function buildQuestionnaire(
  catalog: Pick<ProposalPricing, 'inputs' | 'services'> | null | undefined,
): Questionnaire
export declare const CUSTOM_QUESTION_TYPES: readonly CustomQuestionType[]
export declare const CUSTOM_QUESTION_SECTION_ID: string
export declare const CUSTOM_QUESTION_SECTION_TITLE: string
export declare const ANY_ANSWER: 'any'
export declare function newCustomQuestionId(): string
export declare function cleanCustomQuestions(raw: unknown): QuestionnaireCustomQuestion[]
export declare function withCustomQuestions(
  questionnaire: Questionnaire,
  customQuestions: unknown,
): Questionnaire
export declare function questionConditionMet(
  question: Pick<QuestionnaireQuestion, 'id' | 'when'>,
  questions: QuestionnaireQuestion[],
  answers: Record<string, unknown> | null | undefined,
): boolean
export declare function customConditionAnswers(
  questionId: string,
  appQuestions: QuestionnaireQuestion[],
  customQuestions: unknown,
): Array<{ value: string; label: string }>
export declare function customQuestionProblems(
  customQuestions: unknown,
  appQuestions: QuestionnaireQuestion[],
): string[]
export declare function flattenQuestions(
  questionnaire: Questionnaire | null | undefined,
): QuestionnaireQuestion[]
export declare function publicQuestionnaire(
  questionnaire: Questionnaire | null | undefined,
): Questionnaire
export declare function cleanQuestionnaireAnswers(
  questions: QuestionnaireQuestion[],
  raw: unknown,
  options?: { includeCallOnly?: boolean; lenient?: boolean },
): Record<string, string | number | string[]>
export declare const QUESTIONNAIRE_LINK_REQUIRED: ReadonlyArray<readonly [string, string]>
export declare function isRequiredOnLink(id: string): boolean
export declare function questionnaireMissingAnswers(
  questions: QuestionnaireQuestion[],
  answers: Record<string, unknown>,
  options?: { mode?: 'link' | 'call' },
): Array<{ id: string; message: string }>
export declare function questionnaireProblems(
  questions: QuestionnaireQuestion[],
  answers: Record<string, unknown>,
  options?: { mode?: 'link' | 'call' },
): string[]
export declare const GROUP_INPUTS: Readonly<Record<string, readonly string[]>>
export declare const GROUP_STARTER_POLICY: Readonly<
  Record<string, { all?: boolean; preferId?: string; prefer?: Readonly<Record<string, string>> }>
>
export declare function questionnaireStepOne(
  questionnaire: Questionnaire | null | undefined,
): Questionnaire
export declare function questionnaireStepTwo(
  questionnaire: Questionnaire | null | undefined,
  answers: Record<string, unknown> | null | undefined,
): Questionnaire & { picked: Array<{ value: string; label: string }> }
export declare function selectionsForServiceGroups(
  groups: readonly string[] | null | undefined,
  catalog: Pick<ProposalPricing, 'services'> | null | undefined,
): ProposalSelection[]
export declare function answersToProposalSeed(
  questions: QuestionnaireQuestion[],
  answers: Record<string, unknown>,
  catalog?: Pick<ProposalPricing, 'services'> | null,
): {
  prospect: ProposalProspect
  inputs: Record<string, number>
  selections: ProposalSelection[]
}
