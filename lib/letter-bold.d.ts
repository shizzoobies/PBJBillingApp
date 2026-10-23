/**
 * Types for the plain-JS `lib/letter-bold.js`: the Letters page's B button uses
 * the same `**bold**` rule the server renders.
 */

/** `esignTag`: a SignWell field tag such as `{{initial:1:y}}`, printed invisibly in the PDF. */
export type BoldRun = { text: string; bold: boolean; esignTag?: true }

export declare function boldRuns(text: string | null | undefined): BoldRun[]

export declare const PARAGRAPH_SPLIT: RegExp

export declare function letterParagraphs(
  text: string | null | undefined,
  fill?: (text: string) => string,
): BoldRun[][]

export declare function withoutBoldMarks(text: string | null | undefined): string

export declare function wrapBold(
  value: string,
  start: number,
  end: number,
): { value: string; start: number; end: number }
