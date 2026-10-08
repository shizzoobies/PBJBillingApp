/** Types for the plain-JS `lib/recipient-addresses.js`. */

/** Every address in a stored recipient value, lower-cased. */
export declare function addressesIn(value: unknown): string[]

/** The entries that name no app user's address in any form (the reply-to mailbox excepted). */
export declare function withoutTeamAddresses<T extends { email: string }>(
  details: T[],
  teamEmails: Set<string> | undefined,
  replyTo?: string,
): T[]
