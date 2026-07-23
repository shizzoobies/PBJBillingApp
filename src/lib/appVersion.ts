/**
 * Deploy detection for long-lived tabs. Vite fingerprints the entry bundle
 * (/assets/index-<hash>.js) and index.html references it, so "a new version
 * was deployed" is exactly "the served index.html names a different entry
 * script than the one this tab is running". No server support needed.
 *
 * Why this exists: twice a stale tab running an old bundle caused real
 * trouble — features reported missing that were live, and (June 2026) a
 * stale-tab bulk save that overwrote newer data. The toast this feeds gives
 * every open tab a refresh prompt within minutes of a deploy.
 */

const ENTRY_SCRIPT_PATTERN = /\/assets\/index-[A-Za-z0-9_-]+\.js/

/**
 * The entry-script path referenced by an index.html document, or null when
 * none is present (e.g. the dev server, which serves unfingerprinted files).
 */
export function extractEntryScript(html: string): string | null {
  const match = html.match(ENTRY_SCRIPT_PATTERN)
  return match ? match[0] : null
}

/** The entry-script path THIS tab is running, read from its own <script> tag. */
export function runningEntryScript(doc: Document = document): string | null {
  const scripts = doc.querySelectorAll<HTMLScriptElement>('script[src]')
  for (const script of scripts) {
    const src = script.getAttribute('src') ?? ''
    const match = src.match(ENTRY_SCRIPT_PATTERN)
    if (match) return match[0]
  }
  return null
}
