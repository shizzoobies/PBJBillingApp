/** Types for the plain-JS `lib/esign-signer.js` (who signs an engagement letter sent for e-signature). */

export declare const MAX_ESIGN_SIGNER_NAME: number

export type EsignSignerChoice = { email: string; name: string; oneTime: boolean }

type SignerParty = { email?: string | null; contactName?: string | null; company?: string | null } | null

export declare function cleanSignerName(value: unknown): string

export declare function isSignerEmail(value: unknown): boolean

export declare function esignSignerChoiceOf(raw: unknown): EsignSignerChoice | null | undefined

export declare function esignSignerName(args: {
  email: string
  details?: Array<{ email: string; source: string }>
  party?: SignerParty
}): string

export declare function isReplyToSigner(args: { email: string; party?: SignerParty; replyTo?: string | null }): boolean

export declare function esignSignerNeedsName(args: {
  email: string
  details?: Array<{ email: string; source: string }>
  party?: SignerParty
  oneTime?: boolean
}): boolean

export declare function chooseEsignSigner(args: {
  choice: EsignSignerChoice
  details?: Array<{ email: string; source: string }>
  party?: SignerParty
  teamEmails?: Set<string>
  replyTo?: string | null
}):
  | { ok: true; email: string; name: string; oneTime: boolean }
  | { ok: false; status: number; error: string; message: string; recipients?: Array<{ email: string; source: string }> }
