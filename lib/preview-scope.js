/**
 * PREVIEW: the session a route should SCOPE BY while an owner is previewing
 * another user. The one place the previewed identity is resolved.
 *
 * "Preview as <staffer>" used to travel on exactly one route —
 * `GET /api/app-data?previewAs=<id>`. The SPA's fetch wrapper sent only
 * `X-Preview-Mode: 1`, a boolean that says THAT an owner is previewing and
 * never WHO, so every surface that fetches its own endpoint answered with the
 * OWNER's scope while the banner named a staffer. That is what Brittany saw on
 * the Invoice Recap: Allison's name over all 37 of August's invoices.
 *
 * The client now sends `X-Preview-As: <id>` alongside, and a route opts in by
 * scoping through the session this returns instead of its own.
 *
 * USE IT FOR SCOPE ONLY. The real `session` stays the one that authenticated
 * and the one an audit entry names — nothing here grants access the owner did
 * not already have. It only ever NARROWS: the header is honored solely for a
 * real owner, and it never widens a non-owner's own session.
 *
 * IT FAILS CLOSED. An id this workspace cannot resolve used to fall back to
 * the caller's own session, which for an owner means the OWNER's data served
 * under somebody else's name — silently, which is the whole class of bug the
 * preview work exists to close. So an unresolvable id THROWS
 * {@link PreviewUnsupportedError} and the caller answers 403
 * `preview_unsupported`: a visible refusal is a bug report, a quiet owner
 * answer is a leak.
 *
 * This lives in `lib/` rather than `server.js` so it can be tested for
 * BEHAVIOR instead of by reading the route source. The lookups are injected:
 * `getTeamMember(id)` is the authoritative single-row read, and `employees` is
 * the workspace fallback that the JSON-file backend needs (in Postgres the
 * workspace's `employees` is read straight off `users`, so the two agree).
 */

/** Raised when `X-Preview-As` names someone this workspace cannot resolve. */
export class PreviewUnsupportedError extends Error {
  constructor(targetId) {
    super(`preview_unsupported: ${targetId}`)
    this.name = 'PreviewUnsupportedError'
    // A tag rather than an instanceof check at the call site: `server.js`
    // catches this across a module boundary, and a code survives bundling,
    // re-exports and subclassing where `instanceof` quietly does not.
    this.code = 'preview_unsupported'
    this.targetId = targetId
  }
}

/** True for the error above, however it reached the caller. */
export function isPreviewUnsupportedError(error) {
  return error?.code === 'preview_unsupported'
}

/**
 * @param {{ headers?: Record<string, string | string[] | undefined> }} request
 * @param {{ user?: { id?: string, role?: string } }} session
 * @param {{
 *   previewAs?: string | null,
 *   employees?: { id?: string, role?: string }[] | null,
 *   getTeamMember?: ((id: string) => Promise<{ id: string, role?: string } | null>) | null,
 * }} [lookups]
 */
export async function previewScopedSession(request, session, lookups = {}) {
  if (session?.user?.role !== 'owner') {
    return session
  }
  const { previewAs = null, employees = null, getTeamMember = null } = lookups
  const header = request?.headers?.['x-preview-as']
  const headerId = String((Array.isArray(header) ? header[0] : header) ?? '').trim()
  // `||`, not `??`: a header sent as an EMPTY string is not an identity, and
  // `??` let it suppress the `?previewAs=` query that `/api/app-data` still
  // accepts — an owner would have been scoped as themselves while the page
  // asked for somebody else.
  const targetId = headerId || String(previewAs ?? '').trim()
  if (!targetId) {
    return session
  }
  const target =
    (getTeamMember ? await getTeamMember(targetId) : null) ??
    (employees ?? []).find((employee) => employee.id === targetId) ??
    null
  if (!target) {
    throw new PreviewUnsupportedError(targetId)
  }
  return {
    ...session,
    user: {
      ...session.user,
      id: target.id,
      // Case-insensitive: workspace employee roles are display-cased
      // ('Owner') while a stored user role is 'owner', and the two must map
      // the same way or a preview scopes an owner as staff (or vice-versa).
      role: String(target.role).toLowerCase() === 'owner' ? 'owner' : 'employee',
    },
  }
}
