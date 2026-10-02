/**
 * Types for the plain-JS `lib/mailing-address.js`, so the printed invoice sheet
 * in `src/` and the emailed PDF share one address-formatting rule.
 */

export declare function mailingAddressLines(
  source:
    | {
        addressLine1?: string | null
        addressLine2?: string | null
        city?: string | null
        state?: string | null
        postalCode?: string | null
      }
    | null
    | undefined,
): string[]
