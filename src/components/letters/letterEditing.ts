import type { KeyboardEvent } from 'react'
import { wrapBold } from '../../../lib/letter-bold.js'
import { esignTagProblem, fillTemplate } from '../../../lib/letter-template.js'

/**
 * The pieces every letter editor shares (Letters, the engagement editor and the
 * engagement section library in Settings): placeholder chips that drop a
 * `{{token}}` at the caret, and the B button / Ctrl+B that put `**` around the
 * selection - the same `**bold**` rule the server renders (lib/letter-bold.js).
 */

export type TextBox = HTMLInputElement | HTMLTextAreaElement

/**
 * Put `{{key}}` where the caret is (over any selection) and put the caret after it.
 * `box` reads the element at call time and again after the re-render.
 */
export function insertPlaceholder(
  box: () => TextBox | null,
  text: string,
  key: string,
  setText: (next: string) => void,
) {
  const token = `{{${key}}}`
  const element = box()
  const start = element?.selectionStart ?? text.length
  const end = element?.selectionEnd ?? start
  setText(text.slice(0, start) + token + text.slice(end))
  window.requestAnimationFrame(() => {
    const target = box()
    if (!target) return
    target.focus()
    target.setSelectionRange(start + token.length, start + token.length)
  })
}

/** The B button and Ctrl/Cmd+B: `**` around the selection, or off again; the selection is kept. */
export function toggleBold(box: () => TextBox | null, text: string, setText: (next: string) => void) {
  const element = box()
  const start = element?.selectionStart ?? text.length
  const end = element?.selectionEnd ?? start
  const next = wrapBold(text, start, end)
  setText(next.value)
  window.requestAnimationFrame(() => {
    const target = box()
    if (!target) return
    target.focus()
    target.setSelectionRange(next.start, next.end)
  })
}

/** Ctrl+B (Cmd+B on a Mac), without Alt. */
export function isBoldShortcut(event: KeyboardEvent<HTMLElement>) {
  return (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'b'
}

/**
 * "{{a}} is / {{a}}, {{b}} are not placeholders the app fills in. Send will refuse ..." A key that
 * reads as a SignWell field tag (`{{initial:2:y}}`) gets the sentence saying why instead.
 */
export function unknownPlaceholderSentence(unknown: string[]): string {
  const sentences = [
    ...new Set(unknown.map(esignTagProblem).filter((problem): problem is string => Boolean(problem))),
  ]
  const tokens = unknown.filter((key) => !esignTagProblem(key)).map((key) => `{{${key}}}`)
  if (tokens.length > 0) {
    sentences.unshift(
      tokens.length > 1
        ? `${tokens.join(', ')} are not placeholders the app fills in`
        : `${tokens[0]} is not a placeholder the app fills in`,
    )
  }
  return `${sentences.join('. ')}. Send will refuse until ${unknown.length > 1 ? 'they are' : 'it is'} changed.`
}

/** "E-sign fields in the body: 2" for the SignWell field tags in a letter body, or '' when it has none. */
export function esignFieldCount(letterBody: string): string {
  const count = fillTemplate(letterBody, {}).esignTags.length
  return count > 0 ? `E-sign fields in the body: ${count}` : ''
}
