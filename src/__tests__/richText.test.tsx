import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderRichNote } from '../lib/richText'

function html(text: string): string {
  const { container } = render(<div>{renderRichNote(text)}</div>)
  return container.innerHTML
}

describe('renderRichNote', () => {
  it('renders plain text unchanged (backward compatible)', () => {
    const { container } = render(<div>{renderRichNote('Just a plain note.')}</div>)
    expect(container.textContent).toBe('Just a plain note.')
    expect(container.innerHTML).not.toContain('<strong>')
    expect(container.innerHTML).not.toContain('<em>')
  })

  it('parses **bold**', () => {
    const out = html('Say **hello** now')
    expect(out).toContain('<strong>hello</strong>')
  })

  it('parses *italic* and _italic_', () => {
    expect(html('an *important* word')).toContain('<em>important</em>')
    expect(html('an _important_ word')).toContain('<em>important</em>')
  })

  it('parses a bullet list', () => {
    const out = html('- first\n- second')
    expect(out).toContain('<ul>')
    expect(out).toContain('<li>first</li>')
    expect(out).toContain('<li>second</li>')
  })

  it('parses a numbered list', () => {
    const out = html('1. alpha\n2. beta')
    expect(out).toContain('<ol>')
    expect(out).toContain('<li>alpha</li>')
    expect(out).toContain('<li>beta</li>')
  })

  it('renders a safe http link with secure rel/target', () => {
    const out = html('see [docs](https://example.com)')
    expect(out).toContain('href="https://example.com"')
    expect(out).toContain('target="_blank"')
    expect(out).toContain('rel="noopener noreferrer"')
    expect(out).toContain('>docs</a>')
  })

  it('does NOT render a javascript: link as an <a> (XSS guard)', () => {
    const { container } = render(
      <div>{renderRichNote('click [here](javascript:alert(1))')}</div>,
    )
    // No live link is produced for an unsafe scheme — that's the XSS guard.
    expect(container.querySelector('a')).toBeNull()
    expect(container.innerHTML).not.toContain('href')
    // the literal markdown text survives (as escaped text) instead of a link
    expect(container.textContent).toContain('[here](javascript:alert(1))')
  })

  it('never emits raw HTML from the note body (auto-escaped)', () => {
    const { container } = render(
      <div>{renderRichNote('<img src=x onerror=alert(1)>')}</div>,
    )
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
  })
})
