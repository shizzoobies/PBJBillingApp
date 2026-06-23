import type { ReactNode } from 'react'
import { isSafeHttpUrl } from './utils'

/**
 * SAFE rich-text renderer for client notes.
 *
 * Renders a small markdown subset as REACT NODES — never HTML strings, and
 * NEVER `dangerouslySetInnerHTML`. Because every piece of user text ends up as
 * a React text child, React auto-escapes it: this is the XSS guarantee. A note
 * body that happens to contain `<script>` or `javascript:` can never execute.
 *
 * Supported subset (intentionally tiny):
 *   - **bold**            → <strong>
 *   - *italic* / _italic_ → <em>
 *   - lines starting `- ` or `* `  → bullet list (<ul>)
 *   - lines starting `1. ` (any digits) → numbered list (<ol>)
 *   - [label](url)        → <a> ONLY when the url passes a safe-scheme check
 *                           (http/https/mailto); otherwise the literal text is
 *                           rendered, never a link.
 *   - blank line          → paragraph break (<p>)
 *   - single newline      → <br/>
 *
 * Plain text with none of the above renders unchanged, so all existing notes
 * keep displaying exactly as before.
 */

const BULLET_RE = /^[-*]\s+(.*)$/
const NUMBERED_RE = /^\d+\.\s+(.*)$/

// mailto: is allowed for note links in addition to http(s); reuse the shared
// http(s) check for the absolute-URL case.
function isSafeLinkUrl(url: string): boolean {
  if (isSafeHttpUrl(url)) return true
  try {
    return new URL(url).protocol === 'mailto:'
  } catch {
    return false
  }
}

/**
 * Render the inline span markup (bold, italic, links) inside a single line of
 * text into React nodes. Scans left-to-right, emitting plain text between
 * matches.
 */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let remaining = text
  let cursor = 0

  // Ordered by specificity. Each matcher pulls one token off the FRONT of
  // `remaining` when it matches at index 0.
  const linkRe = /^\[([^\]]*)\]\(([^)\s]+)\)/
  const boldRe = /^\*\*([^*]+)\*\*/
  const italicStarRe = /^\*([^*]+)\*/
  const italicUnderRe = /^_([^_]+)_/

  while (remaining.length > 0) {
    const link = linkRe.exec(remaining)
    if (link) {
      const [, label, url] = link
      if (isSafeLinkUrl(url)) {
        nodes.push(
          <a key={`${keyPrefix}-a-${cursor}`} href={url} target="_blank" rel="noopener noreferrer">
            {label}
          </a>,
        )
      } else {
        // Unsafe scheme (e.g. javascript:) — render the literal markdown text,
        // never an <a>. No link, no execution.
        nodes.push(link[0])
      }
      remaining = remaining.slice(link[0].length)
      cursor += link[0].length
      continue
    }

    const bold = boldRe.exec(remaining)
    if (bold) {
      nodes.push(<strong key={`${keyPrefix}-b-${cursor}`}>{bold[1]}</strong>)
      remaining = remaining.slice(bold[0].length)
      cursor += bold[0].length
      continue
    }

    const italicStar = italicStarRe.exec(remaining)
    if (italicStar) {
      nodes.push(<em key={`${keyPrefix}-i-${cursor}`}>{italicStar[1]}</em>)
      remaining = remaining.slice(italicStar[0].length)
      cursor += italicStar[0].length
      continue
    }

    const italicUnder = italicUnderRe.exec(remaining)
    if (italicUnder) {
      nodes.push(<em key={`${keyPrefix}-iu-${cursor}`}>{italicUnder[1]}</em>)
      remaining = remaining.slice(italicUnder[0].length)
      cursor += italicUnder[0].length
      continue
    }

    // No token at the front — consume plain chars up to the next potential
    // token start (or the end of the string) and emit them as text.
    const next = remaining.slice(1).search(/[*_[]/)
    const take = next === -1 ? remaining.length : next + 1
    const chunk = remaining.slice(0, take)
    const last = nodes[nodes.length - 1]
    if (typeof last === 'string') {
      nodes[nodes.length - 1] = last + chunk
    } else {
      nodes.push(chunk)
    }
    remaining = remaining.slice(take)
    cursor += take
  }

  return nodes
}

// A single line that is part of a paragraph (joined with <br/> between lines).
function renderParagraphLines(lines: string[], keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = []
  lines.forEach((line, index) => {
    if (index > 0) out.push(<br key={`${keyPrefix}-br-${index}`} />)
    out.push(...renderInline(line, `${keyPrefix}-l${index}`))
  })
  return out
}

/**
 * Render a note body (lightweight markdown) as React nodes. Safe by
 * construction: no HTML strings, no dangerouslySetInnerHTML.
 */
export function renderRichNote(text: string): ReactNode {
  if (!text) return null

  // Split into blocks on blank lines (one or more). Each block becomes either a
  // list (if all its lines are list items) or a paragraph.
  const blocks = text.replace(/\r\n/g, '\n').split(/\n[ \t]*\n/)
  const out: ReactNode[] = []

  blocks.forEach((block, blockIndex) => {
    const lines = block.split('\n')
    const nonEmpty = lines.filter((line) => line.trim().length > 0)
    if (nonEmpty.length === 0) return

    const allBullets = nonEmpty.every((line) => BULLET_RE.test(line))
    const allNumbered = nonEmpty.every((line) => NUMBERED_RE.test(line))

    if (allBullets) {
      out.push(
        <ul key={`block-${blockIndex}`}>
          {nonEmpty.map((line, i) => {
            const content = BULLET_RE.exec(line)?.[1] ?? ''
            return <li key={i}>{renderInline(content, `b${blockIndex}-${i}`)}</li>
          })}
        </ul>,
      )
      return
    }

    if (allNumbered) {
      out.push(
        <ol key={`block-${blockIndex}`}>
          {nonEmpty.map((line, i) => {
            const content = NUMBERED_RE.exec(line)?.[1] ?? ''
            return <li key={i}>{renderInline(content, `o${blockIndex}-${i}`)}</li>
          })}
        </ol>,
      )
      return
    }

    out.push(
      <p key={`block-${blockIndex}`}>{renderParagraphLines(lines, `p${blockIndex}`)}</p>,
    )
  })

  return <>{out}</>
}
