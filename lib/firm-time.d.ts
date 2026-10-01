/**
 * Types for the plain-JS `lib/firm-time.js`, so `src/` reads a recipe's
 * creation stamp in the same zone the server does.
 */

/** The zone the firm keeps its calendar in. */
export declare const DEFAULT_FIRM_TIME_ZONE: string

/**
 * `FIRM_TIME_ZONE` when the server sets it to a zone the runtime knows,
 * otherwise US Eastern. Always the default in the browser.
 */
export declare function firmTimeZone(): string

/**
 * The calendar date (`YYYY-MM-DD`) an instant falls on in `timeZone` (the
 * firm's when omitted). `null` when `instant` is not a real Date.
 */
export declare function dateOnlyInZone(instant: Date, timeZone?: string): string | null

/**
 * Today (`YYYY-MM-DD`) on the firm's calendar. Always a string: a `now` that is
 * not a real Date is replaced by the current instant.
 */
export declare function firmToday(now?: Date): string
