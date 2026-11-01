import { describe, expect, it } from 'vitest'

import { letterParagraphs } from './letter-bold.js'
import {
  ESIGNATURES_INITIALS_LABEL,
  SECTION_HEADING_MAX_LENGTH,
  escapeMarkdown,
  isClosingLine,
  isSectionHeading,
  letterMarkdown,
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

  it('a bold run ending in punctuation, followed by a letter, gets a space so the bold still closes', () => {
    const paragraphs = [[{ text: 'Fees:', bold: true }, { text: 'due monthly. ', bold: false }, { text: 'Note.', bold: true }, { text: ' Then', bold: false }]]
    expect(letterMarkdown({ paragraphs, client: {}, firmSettings: FIRM })).toContain('**Fees:** due monthly. **Note.** Then')
    // Ending in a letter, or followed by punctuation: left alone.
    const plain = [[{ text: 'Fee', bold: true }, { text: 's apply', bold: false }, { text: 'Total:', bold: true }, { text: ', paid', bold: false }]]
    expect(letterMarkdown({ paragraphs: plain, client: {}, firmSettings: FIRM })).toContain('**Fee**s apply**Total:**, paid')
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
  const where = { aloneInParagraph: true, followedByText: true }

  it.each([
    'Addendum to Engagement Letter',
    'Additional Scope of Services',
    'Client Responsibility',
    'Fees:',
    'Questions?',
    'Re: 2026 year-end 1099 filing',
    '1. Scope of Services',
    'A'.repeat(SECTION_HEADING_MAX_LENGTH),
  ])('%s is a heading', (line) => {
    expect(isSectionHeading(line, where)).toBe(true)
  })

  it.each([
    ['Dear Pat,', 'a salutation'],
    ['Dear Pat', 'a salutation without its comma'],
    ['Hello Pat', 'a greeting'],
    ['To whom it may concern:', 'a greeting'],
    ['Sincerely,', 'a closing'],
    ['Sincerely', 'a closing without its comma'],
    ['Best regards', 'a closing'],
    ['Thank you!', 'a closing'],
    ['Thank you so much', 'a closing'],
    ['Our fee is due on receipt.', 'ends with a period'],
    ['Brittany Ferguson, CPA,', 'ends with a comma'],
    ['First; second;', 'ends with a semicolon'],
    ['A'.repeat(SECTION_HEADING_MAX_LENGTH + 1), 'over 80 characters'],
    ['$250 + $25', 'no letter'],
    ['', 'empty'],
  ])('%s is not (%s)', (line) => {
    expect(isSectionHeading(line, where)).toBe(false)
  })

  it('must stand alone in its paragraph and be followed by a paragraph or list', () => {
    expect(isSectionHeading('Additional Fees', { aloneInParagraph: false, followedByText: true })).toBe(false)
    expect(isSectionHeading('Additional Fees', { aloneInParagraph: true, followedByText: false })).toBe(false)
  })

  it('isClosingLine knows the sign-offs, and not ordinary text', () => {
    for (const line of ['Sincerely,', 'Kind regards,', 'Very truly yours,', 'Thanks again!', 'Respectfully']) expect(isClosingLine(line), line).toBe(true)
    for (const line of ['Best practices', 'Thanks to your team we finished early.', 'Regarding fees']) expect(isClosingLine(line), line).toBe(false)
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

  it('bolds a short line alone in its paragraph before more text; never a greeting, a closing, a sentence or what follows the sign-off', () => {
    const body = [
      'Dear Pat,',
      'Addendum to Engagement Letter',
      'This addendum supplements the original letter.',
      'Additional Scope of Services\nPB&J will review your books.',
      'Client Responsibility',
      '1. Send the W-9s\n2. Sign the letter',
      'Our fee is due on receipt.',
      'Initials',
      'Terms apply. {{initial:1:y}}',
      'Sincerely,',
      'Brittany Ferguson, CPA',
      'Owner',
    ].join('\n\n')
    const markdown = letterMarkdown({ paragraphs: letterParagraphs(body), client: {}, firmSettings: FIRM })
    expect(markdown).toContain('\n\n**Addendum to Engagement Letter**\n\n')
    // Followed by a numbered list (printed as typed): still a heading.
    expect(markdown).toContain('\n\n**Client Responsibility**\n\n1\\. Send the W-9s  \n2\\. Sign the letter\n\n')
    // The first line of a longer paragraph is not "alone".
    expect(markdown).toContain('\n\nAdditional Scope of Services  \nPB&J will review your books.\n\n')
    expect(markdown).toContain('\n\nDear Pat,\n\n')
    expect(markdown).toContain('\n\nOur fee is due on receipt.\n\n')
    // "Initials" is followed by a paragraph that STARTS with text, so it is a heading; the field itself is not text.
    expect(markdown).toContain('\n\n**Initials**\n\nTerms apply.\n\n')
    // After the sign-off nothing is a heading.
    expect(markdown).toMatch(/\n\nSincerely,\n\nBrittany Ferguson, CPA\n\nOwner\n$/)
  })

  it('a line followed only by a signer field, or ending the letter, is not a heading', () => {
    const markdown = letterMarkdown({ paragraphs: letterParagraphs('Agreement\n\n{{initial:1:y}}\n\nThe End'), client: {}, firmSettings: FIRM })
    expect(markdown).not.toContain('**Agreement**')
    expect(markdown).not.toContain('**The End**')
  })

  it('a heading typed partly bold is written bold once, its text escaped', () => {
    const paragraphs = [[{ text: 'Fees', bold: true }, { text: ' & *terms*', bold: false }], [{ text: 'They are due monthly.', bold: false }]]
    expect(letterMarkdown({ paragraphs, client: {}, firmSettings: FIRM })).toContain('\n\n**Fees & \\*terms\\***\n\nThey are due monthly.\n')
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
