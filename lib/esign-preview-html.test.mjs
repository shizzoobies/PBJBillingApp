import { describe, expect, it } from 'vitest'

import { ESIGN_SIGNATURE_BLOCK_LABEL, esignPreviewHtml } from './esign-preview-html.js'
import { letterParagraphs } from './letter-bold.js'
import { ESIGNATURES_INITIALS_LABEL, letterMarkdown } from './letter-markdown.js'

/**
 * The e-sign Markdown drawn as eSignatures.io presents it, for the honest preview. Only what
 * letterMarkdown writes is read; every character of text is escaped.
 */
const body = (html) => html.replace(/^<style>[\s\S]*?<\/style>/, '')

describe('esignPreviewHtml', () => {
  it('draws the heading, paragraphs with hard breaks, bold, italic, and ends with the signature placeholder', () => {
    const html = body(esignPreviewHtml('## PB&J Strategic Accounting\n\n100 Main St  \nStarke, FL\n\n**Fees**\n\nDue *monthly* and _promptly_.\n'))
    expect(html).toBe(
      [
        '<div class="esign-doc">',
        '<h2>PB&amp;J Strategic Accounting</h2>',
        '<p>100 Main St<br>Starke, FL</p>',
        '<p><strong>Fees</strong></p>',
        '<p>Due <em>monthly</em> and <em>promptly</em>.</p>',
        `<div class="esign-signature">${ESIGN_SIGNATURE_BLOCK_LABEL}</div>`,
        '</div>',
      ].join(''),
    )
    expect(ESIGN_SIGNATURE_BLOCK_LABEL).toBe('Signature block added by the signing service')
  })

  it('prints backslash escapes as the character: the \\- list form reads "-Review", as eSignatures.io prints it', () => {
    const html = body(esignPreviewHtml('\\-Review the books  \n\\-File the 1099s  \n1\\. First\n'))
    expect(html).toContain('<p>-Review the books<br>-File the 1099s<br>1. First</p>')
    expect(html).not.toContain('<ul>')
  })

  it('draws a real list and a plain line break', () => {
    expect(body(esignPreviewHtml('- one\n- two\n'))).toContain('<ul><li>one</li><li>two</li></ul>')
    expect(body(esignPreviewHtml('1. one\n2. two\n'))).toContain('<ol><li>one</li><li>two</li></ol>')
    expect(body(esignPreviewHtml('a\nb\n'))).toContain('<p>a b</p>')
  })

  it('escapes <script>, raw HTML and attributes: nothing in a letter becomes markup', () => {
    const html = body(esignPreviewHtml('Hello <script>alert(1)</script> <img src=x onerror="alert(2)"> & <b>bold</b>\n\n## <i>x</i>\n'))
    expect(html).not.toMatch(/<script|<img|<b>|<i>/)
    expect(html).toContain('Hello &lt;script&gt;alert(1)&lt;/script&gt; &lt;img src=x onerror=&quot;alert(2)&quot;&gt; &amp; &lt;b&gt;bold&lt;/b&gt;')
    expect(html).toContain('<h2>&lt;i&gt;x&lt;/i&gt;</h2>')
    // An escaped < (as letterMarkdown writes it) is still escaped HTML.
    expect(body(esignPreviewHtml('\\<script>x\\</script>\n'))).toBe(
      `<div class="esign-doc"><p>&lt;script&gt;x&lt;/script&gt;</p><div class="esign-signature">${ESIGN_SIGNATURE_BLOCK_LABEL}</div></div>`,
    )
  })

  it('bold follows CommonMark\'s flanking rule: where eSignatures.io would print asterisks, so does the preview', () => {
    expect(body(esignPreviewHtml('Our fee**(monthly)** is due.\n'))).toContain('<p>Our fee**(monthly)** is due.</p>')
    expect(body(esignPreviewHtml('**Fees:**due now\n'))).toContain('<p>**Fees:**due now</p>')
    expect(body(esignPreviewHtml('Our **fee(monthly)** and (**x**) and a**b**c\n'))).toContain('<p>Our <strong>fee(monthly)</strong> and (<strong>x</strong>) and a<strong>b</strong>c</p>')
    // An escaped character beside the marker counts as punctuation (it is one).
    expect(body(esignPreviewHtml('a\\***b***\n'))).not.toContain('<strong>*b*</strong>')
  })

  it('prints {{...}} as text, never as anything filled or active', () => {
    expect(body(esignPreviewHtml('Fee \\{\\{fee}} and {{client_name}}\n'))).toContain('<p>Fee {{fee}} and {{client_name}}</p>')
  })

  it('a private-use marker in the text cannot smuggle an escape', () => {
    expect(body(esignPreviewHtml('a\uE0000\uE001 \\<b>\n'))).toContain('<p>a0 &lt;b&gt;</p>')
  })

  it('draws a signer field as the field: the initials checkbox (required), a text box with its label', () => {
    const markdown = letterMarkdown({
      paragraphs: letterParagraphs('Terms. {{initial:1:y}}\n\nEIN: {{text:1:n:Your_EIN}}'),
      client: {},
      firmSettings: { name: 'Firm' },
    })
    const html = body(esignPreviewHtml(markdown))
    expect(html).toContain(
      `<div class="esign-field"><span class="esign-check" aria-hidden="true"></span><span>${ESIGNATURES_INITIALS_LABEL} <span class="esign-required" aria-label="required">*</span></span></div>`,
    )
    expect(html).toContain('<div class="esign-field"><label><span>Your EIN</span><span class="esign-input" aria-hidden="true"></span></label></div>')
    expect(html).not.toContain('line_type')
  })

  it('draws the logo first when one goes with the contract, its address escaped', () => {
    expect(body(esignPreviewHtml('## Firm\n', { logoSrc: '/esign-logo/abc.png' }))).toMatch(/^<div class="esign-doc"><img class="esign-logo" src="\/esign-logo\/abc\.png" alt="Firm logo"><h2>Firm<\/h2>/)
    expect(body(esignPreviewHtml('## Firm\n', { logoSrc: '"><script>' }))).toContain('src="&quot;&gt;&lt;script&gt;"')
    expect(body(esignPreviewHtml('## Firm\n'))).not.toContain('<img')
  })

  it('carries its own plain style', () => {
    expect(esignPreviewHtml('x')).toMatch(/^<style>[^<]*\.esign-doc[^<]*<\/style>/)
  })
})
