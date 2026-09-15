/**
 * Types for the plain-JS `lib/preview-scope.js`, so the tests (and any future
 * `src/` consumer) can import the one preview-identity rule without a second
 * TypeScript copy drifting away from the server's.
 */

export interface PreviewSessionUser {
  id: string
  role: string
  [key: string]: unknown
}

export interface PreviewSession {
  user: PreviewSessionUser
  [key: string]: unknown
}

export interface PreviewLookups {
  /** The `?previewAs=` query, still accepted by `/api/app-data` alone. */
  previewAs?: string | null
  /** Workspace fallback roster — what the JSON-file backend resolves against. */
  employees?: { id?: string; role?: string }[] | null
  /** Authoritative single-row read (the `users` table on Postgres). */
  getTeamMember?: ((id: string) => Promise<{ id: string; role?: string } | null>) | null
}

/** Raised when `X-Preview-As` names someone this workspace cannot resolve. */
export declare class PreviewUnsupportedError extends Error {
  constructor(targetId: string)
  code: 'preview_unsupported'
  targetId: string
}

export declare function isPreviewUnsupportedError(error: unknown): boolean

/**
 * The session to scope by. Returns the caller's own session for a non-owner or
 * when no identity was sent; THROWS {@link PreviewUnsupportedError} when an
 * owner names an id this workspace cannot resolve.
 */
export declare function previewScopedSession(
  request: { headers?: Record<string, string | string[] | undefined> },
  session: PreviewSession,
  lookups?: PreviewLookups,
): Promise<PreviewSession>
