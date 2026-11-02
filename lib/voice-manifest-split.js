/**
 * How the capability manifest reaches the VOICE agent's knowledge base.
 *
 * Since 2026-11-01 the voice agent reads the manifest by RETRIEVAL (ElevenLabs
 * RAG): the agent pulls the passages relevant to each turn instead of carrying
 * the whole document in its prompt. That removed the ~216,000-character cap the
 * prompt-mode upload had (the 2026-09-23 upload failed at 224,772), which is why
 * the manifest no longer has to be trimmed to fit.
 *
 * Retrieval can miss a rule that applies to every answer, so the manifest is
 * uploaded as TWO documents:
 *   - CORE: the header, the site-wide duration rule and the navigation map -
 *     everything before the first page section - always in the prompt
 *     (`usage_mode: 'prompt'`), so the basics never depend on a lookup;
 *   - BODY: every page section from the first one on - retrieval
 *     (`usage_mode: 'auto'`), indexed once per upload.
 *
 * The in-app assistant (lib/assistant.js) is untouched: it still reads the whole
 * file into a cached system prompt.
 *
 * Pure: no I/O. Shared by scripts/provision-voice-agent.mjs and the size
 * tripwire test, so the two cannot disagree about where the split falls.
 */

/** The heading that opens the first page section; everything before it is core. */
export const FIRST_PAGE_SECTION = '\n## Dashboard\n'

/** The always-loaded core must stay small: it rides in every voice turn. */
export const CORE_MAX_CHARS = 20_000

/**
 * @param {string} manifest the whole docs/capability-manifest.md text (any line ending)
 * @returns {{ core: string, body: string }}
 */
export function splitManifestForVoice(manifest) {
  const text = String(manifest ?? '').replace(/\r\n/g, '\n')
  const at = text.indexOf(FIRST_PAGE_SECTION)
  if (at === -1) {
    throw new Error(
      `capability manifest has no "${FIRST_PAGE_SECTION.trim()}" heading, so the always-loaded core cannot be split off`,
    )
  }
  const core = text.slice(0, at + 1)
  const body = text.slice(at + 1)
  if (core.length > CORE_MAX_CHARS) {
    throw new Error(
      `the manifest's always-loaded core is ${core.length} characters; keep everything before "${FIRST_PAGE_SECTION.trim()}" under ${CORE_MAX_CHARS}`,
    )
  }
  return { core, body }
}
