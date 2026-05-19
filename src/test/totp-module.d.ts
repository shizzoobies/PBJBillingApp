/**
 * Ambient type declaration for the backend TOTP module (`lib/totp.js`), which
 * is plain JavaScript living outside `src/` and so has no generated `.d.ts`.
 * This lets the test suite import it with types instead of `any`. It is a
 * test-support file only — it does not affect the shipped app.
 *
 * Keep the shapes here in sync with the actual exports in lib/totp.js.
 */
declare module '*/lib/totp.js' {
  export function generateSecret(): {
    base32: string
    otpauthUri(label: string, issuer: string): string
  }

  export function verifyCode(
    secret: string,
    code: string,
    options?: { window?: number },
  ): boolean

  export function generateBackupCodes(n?: number): {
    plain: string[]
    hashed: string[]
  }

  export function verifyBackupCode(
    plainCode: string,
    hashedList: string[],
  ): { ok: boolean; updatedHashedList: string[] }
}
