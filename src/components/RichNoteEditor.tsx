import { Bold, Italic, Link, List, ListOrdered } from 'lucide-react'
import { useRef } from 'react'

/**
 * Lightweight controlled rich-text editor for note bodies. It's a plain
 * <textarea> plus a small toolbar that inserts the markdown subset understood
 * by `renderRichNote` (bold, italic, bullet/numbered lists, links). No
 * contentEditable, no extra deps — the stored value stays a plain string.
 */
export function RichNoteEditor({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Replace [start,end) of the current value, then restore focus + selection
  // to the supplied range on the next tick (after React re-renders the value).
  const applyChange = (next: string, selStart: number, selEnd: number) => {
    onChange(next)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(selStart, selEnd)
    })
  }

  // Wrap the current selection in `before`/`after` (e.g. **…**). When nothing
  // is selected, insert the wrappers with the caret between them.
  const wrapSelection = (before: string, after: string) => {
    const el = textareaRef.current
    if (!el) return
    const start = el.selectionStart
    const end = el.selectionEnd
    const selected = value.slice(start, end)
    const next = `${value.slice(0, start)}${before}${selected}${after}${value.slice(end)}`
    applyChange(next, start + before.length, start + before.length + selected.length)
  }

  // Prefix every selected line (or the current line) with `prefix`.
  const prefixLines = (makePrefix: (index: number) => string) => {
    const el = textareaRef.current
    if (!el) return
    const start = el.selectionStart
    const end = el.selectionEnd
    // Expand the selection to whole lines.
    const lineStart = value.lastIndexOf('\n', start - 1) + 1
    const lineEndIdx = value.indexOf('\n', end)
    const lineEnd = lineEndIdx === -1 ? value.length : lineEndIdx
    const block = value.slice(lineStart, lineEnd)
    const prefixed = block
      .split('\n')
      .map((line, index) => `${makePrefix(index)}${line}`)
      .join('\n')
    const next = `${value.slice(0, lineStart)}${prefixed}${value.slice(lineEnd)}`
    applyChange(next, lineStart, lineStart + prefixed.length)
  }

  const insertLink = () => {
    const el = textareaRef.current
    if (!el) return
    const start = el.selectionStart
    const end = el.selectionEnd
    const selected = value.slice(start, end) || 'label'
    const placeholderUrl = 'https://'
    const snippet = `[${selected}](${placeholderUrl})`
    const next = `${value.slice(0, start)}${snippet}${value.slice(end)}`
    // Put the caret inside the url so the user can type/paste the address.
    const urlStart = start + selected.length + 3 // `[` + selected + `](`
    applyChange(next, urlStart, urlStart + placeholderUrl.length)
  }

  return (
    <div className="rich-note-editor">
      <div className="rich-note-toolbar">
        <button
          type="button"
          className="rich-note-tool"
          title="Bold"
          aria-label="Bold"
          onClick={() => wrapSelection('**', '**')}
        >
          <Bold size={14} />
        </button>
        <button
          type="button"
          className="rich-note-tool"
          title="Italic"
          aria-label="Italic"
          onClick={() => wrapSelection('*', '*')}
        >
          <Italic size={14} />
        </button>
        <button
          type="button"
          className="rich-note-tool"
          title="Bulleted list"
          aria-label="Bulleted list"
          onClick={() => prefixLines(() => '- ')}
        >
          <List size={14} />
        </button>
        <button
          type="button"
          className="rich-note-tool"
          title="Numbered list"
          aria-label="Numbered list"
          onClick={() => prefixLines((index) => `${index + 1}. `)}
        >
          <ListOrdered size={14} />
        </button>
        <button
          type="button"
          className="rich-note-tool"
          title="Link"
          aria-label="Link"
          onClick={insertLink}
        >
          <Link size={14} />
        </button>
      </div>
      <textarea
        ref={textareaRef}
        className="input"
        rows={3}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  )
}
