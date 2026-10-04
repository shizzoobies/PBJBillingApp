/**
 * Types for the plain-JS `lib/proposal-questionnaire.js`, so `src/` can build and
 * read the same question list the server freezes onto a questionnaire.
 *
 * Keep these in sync with the actual exports in lib/proposal-questionnaire.js.
 */

import type { ProposalPricing, ProposalProspect } from './proposal-pricing.js'

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
export declare function questionnaireProblems(
  questions: QuestionnaireQuestion[],
  answers: Record<string, unknown>,
  options?: { mode?: 'link' | 'call' },
): string[]
export declare function answersToProposalSeed(
  questions: QuestionnaireQuestion[],
  answers: Record<string, unknown>,
): { prospect: ProposalProspect; inputs: Record<string, number> }
