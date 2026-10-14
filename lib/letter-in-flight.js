/**
 * How long a send claim may sit at "sending" before it reads as one that died. Younger than
 * this, another owner's send to the same client is simply still running (the server answers
 * `sending_now`, the Letters list says "Sending..."); older, it never finished (`unfinished`,
 * "Did not finish"). One number for both, so the list and the result always agree. No imports:
 * the page bundles this file.
 */
export const LETTER_IN_FLIGHT_MS = 2 * 60 * 1000
