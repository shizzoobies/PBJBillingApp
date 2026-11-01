import { describe, expect, it } from 'vitest'

import { letterParagraphs } from './letter-bold.js'
import {
  ESIGNATURES_INITIALS_LABEL,
  SECTION_HEADING_MAX_LENGTH,
  escapeMarkdown,
  isClosingLine,
  isSectionHeading,
  letterMarkdown,
  startsClosing,
} from './letter-markdown.js'

/**
 * The FILLED engagement letter as eSignatures.io Markdown (task 18): the firm name as a heading, the
 * date, the addressee, then the body with bold as `**bold**`. SignWell's tags become eSignatures
 * fields: an initials tag a REQUIRED checkbox line, a text tag a text input, a check tag a checkbox;
 * signature and date tags are dropped (eSignatures adds one signature section at the end), and so
 * are the letter's own "Signature:" / "Date:" / blank-to-fill lines.
 */
const FIRM = { name: 'PB&J Strategic Accounting', email: 'hello@pbjsa.example' }
const CLIENT = { name: 'Acme Books', addressLine1: '9 Elm St', addressLine2: '', city: 'Franklin', state: 'TN', postalCode: '37064' }
const field = (config) => `\`${JSON.stringify(config)}\``

describe('letterMarkdown', () => {
  it('renders the whole letter deterministically (snapshot)', () => {
    const body = [
      'Dear Pat,',
      'Thank you for choosing us. **Fees** are due on receipt.\nA second line of the same paragraph.',
      '**Scope of work**',
      'We keep your books. Initial here: {{initial:1:y}}',
      'Payment terms apply. {{i:1:y}}',
      'Your EIN: {{text:1:y:EIN}}',
      'Optional: {{check:1:n:Send_paper_copies}}',
      'If this letter reflects your understanding, please sign electronically where indicated.',
      'Sincerely,\nBrittany',
      'Signature: ______________________\nDate: ______________\nPrinted name: ____________',
      '{{signature:1:y}} {{date:1:y}}',
    ].join('\n\n')
    const markdown = letterMarkdown({ paragraphs: letterParagraphs(body), client: CLIENT, firmSettings: FIRM, dateLabel: 'October 23, 2026' })
    expect(markdown).toBe(
      [
        '## PB&J Strategic Accounting',
        '',
        // The firm's contact lines under its name, as the letterhead prints them (here only the email).
        'hello@pbjsa.example',
        '',
        'October 23, 2026',
        '',
        'Acme Books  \n9 Elm St  \nFranklin, TN 37064',
        '',
        'Dear Pat,',
        '',
        'Thank you for choosing us. **Fees** are due on receipt.  \nA second line of the same paragraph.',
        '',
        '**Scope of work**',
        '',
        'We keep your books. Initial here:',
        '',
        `Initials: I have read and agree to the section above ${field({ line_type: 'checkbox', input_type: 'every_signer', input_required: 'yes', signer_field_id: 'initials_1' })}`,
        '',
        'Payment terms apply.',
        '',
        `Initials: I have read and agree to the section above ${field({ line_type: 'checkbox', input_type: 'every_signer', input_required: 'yes', signer_field_id: 'initials_2' })}`,
        '',
        'Your EIN:',
        '',
        `EIN ${field({ line_type: 'text-input', input_type: 'only_first_signer', input_required: 'yes', signer_field_id: 'text_1' })}`,
        '',
        'Optional:',
        '',
        `Send paper copies ${field({ line_type: 'checkbox', input_type: 'every_signer', input_required: 'no', signer_field_id: 'check_1' })}`,
        '',
        'If this letter reflects your understanding, please sign electronically where indicated.',
        '',
        'Sincerely,  \nBrittany',
        '',
      ].join('\n'),
    )
    // Same input, same output.
    expect(letterMarkdown({ paragraphs: letterParagraphs(body), client: CLIENT, firmSettings: FIRM, dateLabel: 'October 23, 2026' })).toBe(markdown)
  })

  it('the initials checkbox is the exact extended-markdown checkbox line, mandatory, one field per line', () => {
    expect(ESIGNATURES_INITIALS_LABEL).toBe('Initials: I have read and agree to the section above')
    const markdown = letterMarkdown({ paragraphs: letterParagraphs('A {{initial:1:y}} B {{INITIAL:1:N}}'), client: {}, firmSettings: FIRM })
    const lines = markdown.split('\n').filter((line) => line.includes('"line_type"'))
    expect(lines).toHaveLength(2)
    for (const [index, line] of lines.entries()) {
      // An initials tag is required whatever its own flag says: it stands for a mandatory initial.
      expect(line).toBe(`${ESIGNATURES_INITIALS_LABEL} \`{"line_type":"checkbox","input_type":"every_signer","input_required":"yes","signer_field_id":"initials_${index + 1}"}\``)
    }
    expect(markdown).toContain('A\n\n')
    expect(markdown).toContain('\n\nB\n\n')
  })

  it('drops signature and date tags and the letter\'s own signature, date and blank-to-fill lines', () => {
    const markdown = letterMarkdown({
      paragraphs: letterParagraphs('Agreed.\nSignature: ____\nDATE:\n_______________\nTitle: ______\n{{s:1:y}}{{d:1:y}}\n\nDated as of today.'),
      client: {},
      firmSettings: FIRM,
    })
    expect(markdown).not.toMatch(/signature|_{2,}|\{\{|title/i)
    expect(markdown).toContain('Agreed.')
    // A sentence that merely starts with a date-ish word stays.
    expect(markdown).toContain('Dated as of today.')
  })

  it('escapes Markdown in the letter text: * _ ` [ ] < \\ everywhere, # and > at a line start, and {{ that is not a tag', () => {
    const markdown = letterMarkdown({
      paragraphs: letterParagraphs('# not a heading\n> not a quote\nA*B_C `code` [link](x) <b> back\\slash {{not_a_tag}} 2 > 1 # 3'),
      client: {},
      firmSettings: { name: 'A*B #1' },
    })
    expect(markdown).toContain('## A\\*B #1')
    expect(markdown).toContain('\\# not a heading  \n\\> not a quote  \nA\\*B\\_C \\`code\\` \\[link\\](x) \\<b> back\\\\slash \\{\\{not\\_a\\_tag}} 2 > 1 # 3')
    expect(escapeMarkdown('**')).toBe('\\*\\*')
  })

  it('escapes list and rule markers at a line start, so a letter prints as typed (as the PDF does)', () => {
    const markdown = letterMarkdown({
      paragraphs: letterParagraphs('1. First\n2) Second\n- dash item\n+ plus item\n---\n  - indented\nA - B + C 3. D'),
      client: {},
      firmSettings: FIRM,
    })
    expect(markdown).toContain('1\\. First  \n2\\) Second  \n\\- dash item  \n\\+ plus item  \n\\-\\-\\-  \n\\- indented  \nA - B + C 3. D')
  })

  it('CommonMark flanking: a bold run that could not open or close is widened over the word it touches', async () => {
    const { esignPreviewHtml } = await import('./esign-preview-html.js')
    const cases = [
      // Ends in punctuation right before a letter: `**Fees:**due` would not close.
      [[{ text: 'Fees:', bold: true }, { text: 'due monthly. ', bold: false }, { text: 'Note.', bold: true }, { text: ' Then', bold: false }], '**Fees:due** monthly. **Note.** Then', '<strong>Fees:due</strong> monthly. <strong>Note.</strong> Then'],
      // Starts with punctuation right after a letter: `fee**(monthly)**` would not open.
      [[{ text: 'Our fee', bold: false }, { text: '(monthly)', bold: true }, { text: ' is due.', bold: false }], 'Our **fee(monthly)** is due.', 'Our <strong>fee(monthly)</strong> is due.'],
      // Both ends, and a neighbor emptied by the widening: one bold run.
      [[{ text: 'a', bold: true }, { text: 'x', bold: false }, { text: '(b)', bold: true }, { text: 'c d', bold: false }], '**ax(b)c** d', '<strong>ax(b)c</strong> d'],
      // Ending in a letter, or followed by punctuation: left alone.
      [[{ text: 'Fee', bold: true }, { text: 's apply', bold: false }, { text: 'Total:', bold: true }, { text: ', paid', bold: false }], '**Fee**s apply**Total:**, paid', '<strong>Fee</strong>s apply<strong>Total:</strong>, paid'],
    ]
    for (const [paragraph, markdownLine, htmlLine] of cases) {
      const markdown = letterMarkdown({ paragraphs: [paragraph], client: {}, firmSettings: FIRM })
      expect(markdown, markdownLine).toContain(markdownLine)
      // The preview draws it bold exactly where it is bold, no stray asterisks.
      const html = esignPreviewHtml(markdown)
      expect(html, htmlLine).toContain(htmlLine)
      expect(html.replace(/<style>[\s\S]*?<\/style>/, '')).not.toContain('*')
    }
  })

  it('keeps a "Date:" line that carries a date; drops only the blank Signature/Date lines', () => {
    const markdown = letterMarkdown({
      paragraphs: letterParagraphs('Date: October 1, 2026 is the start.\nSignature: Brittany\nSignature: ________\nDate:\nDate: ____'),
      client: {},
      firmSettings: FIRM,
    })
    expect(markdown).toContain('Date: October 1, 2026 is the start.  \nSignature: Brittany')
    expect(markdown).not.toMatch(/_{2,}/)
    expect(markdown.match(/Date:/g)).toHaveLength(1)
  })

  it('a filled value with asterisks prints literally; bold runs keep their spaces outside the markers', () => {
    const paragraphs = [[{ text: 'Client ', bold: false }, { text: ' A**B ', bold: true }, { text: 'signs.', bold: false }]]
    expect(letterMarkdown({ paragraphs, client: {}, firmSettings: FIRM })).toContain('Client  **A\\*\\*B** signs.')
  })

  it('reads the plain text when no runs are given, and leaves out an empty date or addressee', () => {
    const markdown = letterMarkdown({ bodyText: 'Hello **there**', client: {}, firmSettings: {} })
    expect(markdown).toBe('## PB&J Strategic Accounting\n\nHello **there**\n')
  })
})

describe('isSectionHeading (the one heading rule)', () => {
  // A block on its own, followed by more text.
  const alone = { nextLine: null, followedByText: true }
  // The first line of a block whose next line is a longer sentence.
  const first = { nextLine: 'The Client agrees to pay the following fees for the additional services:' }

  it.each([
    'Addendum to Engagement Letter',
    'Additional Scope of Services',
    'Client Responsibility',
    'Additional Fees',
    'Preservation of Original Engagement Letter',
    'Terms and Conditions of the Work',
    'Fees & Billing',
    '1. Scope of Services',
    'Tax',
    'A'.repeat(SECTION_HEADING_MAX_LENGTH),
  ])('%s is a heading, alone or as a first line', (line) => {
    expect(isSectionHeading(line, alone)).toBe(true)
    expect(isSectionHeading(line, first)).toBe(true)
  })

  it.each([
    ['Additional Services \u2013 Form 1099 Preparation and Filing for year-end 2026', 'digits, lowercase, over 60'],
    ['Addendum Effective Date: Date of signature below.', 'a colon and a period'],
    ['PB&J will provide the following additional services:', 'not Title Case, a colon'],
    ['Form 1099 Preparation and Filing: $250 + $25/1099 filed', 'digits, a colon, a dollar sign'],
    ['PB&J Strategic Accounting, LLC', 'a comma'],
    ['Brittany Ferguson, CPA', 'a comma'],
    ['Dear Pat,', 'a comma'],
    ['Dear Pat', 'a greeting'],
    ['Sincerely', 'a sign-off'],
    ['Respectfully', 'a sign-off'],
    ['Questions?', 'terminal punctuation'],
    ['Our Fees.', 'terminal punctuation'],
    ['Client Fees (Monthly)', 'terminal punctuation'],
    ['The Client\'s Duties', 'a quote'],
    ['The "Services"', 'a quote'],
    ['Year 2026 Services', 'a digit'],
    ['Scope of work', 'not Title Case'],
    ['of Services', 'a small word first'],
    ['By Signing Below', 'the closing'],
    ['Ab', 'under 3 characters'],
    ['A'.repeat(SECTION_HEADING_MAX_LENGTH + 1), 'over 60 characters'],
    ['', 'empty'],
  ])('%s is not (%s)', (line) => {
    expect(isSectionHeading(line, alone)).toBe(false)
    expect(isSectionHeading(line, first)).toBe(false)
  })

  it('alone it needs text after it; as a first line the next line must be longer or end with punctuation', () => {
    expect(isSectionHeading('Additional Fees', { nextLine: null, followedByText: false })).toBe(false)
    expect(isSectionHeading('Brittany Ferguson CPA', { nextLine: 'Owner' })).toBe(false)
    expect(isSectionHeading('Office Hours', { nextLine: 'Mon to Fri' })).toBe(false)
    expect(isSectionHeading('Office Hours', { nextLine: 'Weekdays.' })).toBe(true)
    expect(isSectionHeading('Office Hours', { nextLine: 'Monday to Friday' })).toBe(true)
  })

  it('a numbered line is a heading, unless the next line is another list line (a list\'s first item)', () => {
    expect(isSectionHeading('1. Scope of Services', { nextLine: 'We keep your books every month.' })).toBe(true)
    expect(isSectionHeading('1. First Item', { nextLine: '2. Second Item Here' })).toBe(false)
    expect(isSectionHeading('1. First Item', { nextLine: '- Another Thing Here' })).toBe(false)
  })

  it('isClosingLine knows the sign-offs; startsClosing also the "By signing below" paragraph', () => {
    for (const line of ['Sincerely,', 'Kind regards,', 'Very truly yours,', 'Thanks again!', 'Respectfully,']) expect(isClosingLine(line), line).toBe(true)
    for (const line of ['Best practices', 'Thanks to your team we finished early.', 'Regarding fees']) expect(isClosingLine(line), line).toBe(false)
    expect(startsClosing('By signing below, the parties agree.')).toBe(true)
    expect(startsClosing('Sincerely,')).toBe(true)
    expect(startsClosing('Signing is easy.')).toBe(false)
  })
})

describe('letterMarkdown: section headings in bold, the firm block under its name', () => {
  const FULL_FIRM = {
    name: 'PB&J Strategic Accounting',
    addressLine1: '100 Main St',
    addressLine2: 'Suite 2',
    city: 'Starke',
    state: 'FL',
    postalCode: '32091',
    phone: '(904) 555-0100',
    email: 'hello@pbjsa.example',
    tagline: 'Never printed',
  }

  // A synthetic letter shaped like Brittany's 1099 addendum (no client data): a title line, a subtitle
  // block, headings as the FIRST line of their blocks, a dashed list, a fee line, then "By signing below"
  // and the signature block.
  const ADDENDUM = [
    'Addendum to Engagement Letter',
    'Additional Services \u2013 Form 1099 Preparation and Filing for year-end 2026\nAddendum Effective Date: Date of signature below.',
    'This Addendum supplements the existing Engagement Letter between the Firm and the Client.\nIt adds Form 1099 services.',
    'Additional Scope of Services\nPB&J will provide the following additional services:\n-Review the books for 1099 needs.\n-File the forms.',
    'Client Responsibility\nThe Client remains responsible for complete, accurate and timely information.\nThe Firm relies on it.',
    'Any penalties from late information remain the responsibility of the Client.',
    'Additional Fees\nThe Client agrees to pay the following fees for the additional services:\nForm 1099 Preparation and Filing: $250 + $25/1099 filed',
    'Preservation of Original Engagement Letter\nExcept as supplemented here, all terms of the original letter remain in force.',
    'By signing below, the parties agree to the additional services and fees in this Addendum.',
    'PB&J Strategic Accounting, LLC\nBrittany Ferguson, CPA\nOwner',
  ].join('\n\n')

  it('bolds exactly the five headings of the addendum shape - in the Markdown and in the preview', async () => {
    const markdown = letterMarkdown({ paragraphs: letterParagraphs(ADDENDUM), client: {}, firmSettings: FIRM })
    const bold = [...markdown.matchAll(/\*\*(.+?)\*\*/g)].map((match) => match[1])
    expect(bold).toEqual([
      'Addendum to Engagement Letter',
      'Additional Scope of Services',
      'Client Responsibility',
      'Additional Fees',
      'Preservation of Original Engagement Letter',
    ])
    for (const plain of [
      'Additional Services \u2013 Form 1099 Preparation and Filing for year-end 2026',
      'Addendum Effective Date: Date of signature below.',
      'PB&J will provide the following additional services:',
      'Form 1099 Preparation and Filing: $250 + $25/1099 filed',
      'PB&J Strategic Accounting, LLC',
      'Brittany Ferguson, CPA',
      'Owner',
    ]) {
      expect(markdown, plain).toContain(plain)
      expect(markdown, plain).not.toContain(`**${plain}`)
    }
    // A first-line heading keeps its hard break: the block stays one paragraph.
    expect(markdown).toContain('\n\n**Additional Scope of Services**  \nPB&J will provide the following additional services:  \n\\-Review the books for 1099 needs.  \n\\-File the forms.\n\n')
    expect(markdown).toContain('\n\n**Addendum to Engagement Letter**\n\n')
    // The preview draws the same bold, from the same Markdown.
    const { esignPreviewHtml } = await import('./esign-preview-html.js')
    const html = esignPreviewHtml(markdown)
    expect([...html.matchAll(/<strong>(.+?)<\/strong>/g)].map((match) => match[1])).toEqual(bold)
    expect(html).toContain('<p><strong>Additional Scope of Services</strong><br>PB&amp;J will provide the following additional services:<br>-Review the books for 1099 needs.<br>-File the forms.</p>')
  })

  it('nothing at or after the first sign-off line is bold; a greeting never is', () => {
    const body = ['Dear Pat,', 'Next Steps\nWe will call you this week to begin.', 'Sincerely,', 'Brittany Ferguson CPA\nOwner', 'Closing Note\nWe value your business very much.'].join('\n\n')
    const markdown = letterMarkdown({ paragraphs: letterParagraphs(body), client: {}, firmSettings: FIRM })
    expect(markdown).toContain('**Next Steps**  \nWe will call you this week to begin.')
    expect(markdown).not.toContain('**Closing Note**')
    expect(markdown).not.toContain('**Brittany')
    expect(markdown).not.toContain('**Dear')
  })

  it('a line followed only by a signer field, or ending the letter, is not a heading; nor a later block of the same paragraph', () => {
    const markdown = letterMarkdown({
      paragraphs: letterParagraphs('Agreement\n\n{{initial:1:y}}\n\nTerms Apply {{initial:1:y}}\nPayment Terms\nThese are the payment terms we agreed.\n\nThe End'),
      client: {},
      firmSettings: FIRM,
    })
    expect(markdown).not.toMatch(/\*\*(Agreement|The End|Terms Apply|Payment Terms)\*\*/)
  })

  it('a dash, plus, asterisk or bullet line alone in its paragraph is a list item, not a heading', () => {
    expect(isSectionHeading('- Monthly Bookkeeping', { nextLine: null, followedByText: true })).toBe(false)
    expect(isSectionHeading('\u2022 Monthly Bookkeeping', { nextLine: null, followedByText: true })).toBe(false)
    const markdown = letterMarkdown({ paragraphs: letterParagraphs('- Monthly Bookkeeping\n\nWe keep the books every month.'), client: {}, firmSettings: FIRM })
    expect(markdown).not.toContain('**')
    // A numbered one stays a heading.
    expect(isSectionHeading('1. Monthly Bookkeeping', { nextLine: null, followedByText: true })).toBe(true)
  })

  it('more sign-offs end the bolding: Best wishes, Cheers, Respectfully submitted, Kind regards, Warm regards, Thank you', () => {
    for (const line of ['Best wishes,', 'Cheers,', 'Respectfully submitted,', 'Kind regards,', 'Warm regards,', 'Thank you,']) expect(isClosingLine(line), line).toBe(true)
  })

  it('a mid-letter "Thank You" or "By signing below" does not stop the bolding; only one in the last four paragraphs does', () => {
    const body = [
      'Dear Pat,',
      'Thank you',
      'By signing below you agree to the scope we discussed on our call last week.',
      'Our Services\nWe keep the books and file the returns each year for you.',
      'Additional Fees\nThe fees are listed in the schedule that came with this letter.',
      'Next Steps\nWe will call you this week to begin the work together.',
      'By signing below, you accept the terms of this letter.',
      'Sincerely,',
      'Brittany Ferguson CPA\nOwner',
    ].join('\n\n')
    const markdown = letterMarkdown({ paragraphs: letterParagraphs(body), client: {}, firmSettings: FIRM })
    expect([...markdown.matchAll(/\*\*(.+?)\*\*/g)].map((match) => match[1])).toEqual(['Our Services', 'Additional Fees', 'Next Steps'])
  })

  it('a heading typed partly bold is written bold once, as one run', () => {
    const paragraphs = [[{ text: 'Fees', bold: true }, { text: ' & Billing', bold: false }], [{ text: 'They are due monthly.', bold: false }]]
    expect(letterMarkdown({ paragraphs, client: {}, firmSettings: FIRM })).toContain('\n\n**Fees & Billing**\n\nThey are due monthly.\n')
  })

  it('prints the firm address, phone and email under its name - the letterhead\'s lines, never the tagline', () => {
    const markdown = letterMarkdown({ paragraphs: letterParagraphs('Hello.'), client: {}, firmSettings: FULL_FIRM, dateLabel: 'November 1, 2026' })
    expect(markdown).toBe(
      [
        '## PB&J Strategic Accounting',
        '',
        '100 Main St  \nSuite 2  \nStarke, FL 32091  \n(904) 555-0100  \nhello@pbjsa.example',
        '',
        'November 1, 2026',
        '',
        'Hello.',
        '',
      ].join('\n'),
    )
    expect(markdown).not.toContain('Never printed')
  })

  it('no firm details: no block (and the default name)', () => {
    expect(letterMarkdown({ bodyText: 'Hi.', client: {}, firmSettings: null })).toBe('## PB&J Strategic Accounting\n\nHi.\n')
  })
})
