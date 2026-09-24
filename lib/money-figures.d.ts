/** Types for the plain-JS `lib/money-figures.js`, so `src/` can read a
 *  letter's dollar figures through the exact same regex the server enforces
 *  with (final fix wave, Important 1). */
export declare function dollarFiguresInCents(text: string | null | undefined): number[]
