/**
 * Which successful API writes ping every open tab (the SSE "data changed" event
 * that makes each tab re-read the workspace). Every `/api/` write does, except:
 *   - `/api/auth*`: signing in and out changes no workspace data;
 *   - `/api/events`: the stream itself;
 *   - `/api/me/*`: a person's own settings (email toggles, Dashboard
 *     arrangement) are not workspace data, so saving one must not make every
 *     open tab re-read everything;
 *   - `/api/week-plan`: a person's own plan for the week (My Week). It is
 *     hers alone, changes no shared data, and is saved on every day click, so
 *     it must not make every open tab of every person re-read the workspace.
 * The method half (no GET / HEAD / OPTIONS) stays at the call site in server.js.
 */
export function writeBroadcastsDataChange(normalizedPath) {
  return (
    typeof normalizedPath === 'string' &&
    normalizedPath.startsWith('/api/') &&
    !normalizedPath.startsWith('/api/auth') &&
    normalizedPath !== '/api/events' &&
    !normalizedPath.startsWith('/api/me/') &&
    normalizedPath !== '/api/week-plan' &&
    !normalizedPath.startsWith('/api/week-plan/')
  )
}
