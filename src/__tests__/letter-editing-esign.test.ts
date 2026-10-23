import { describe, expect, it } from 'vitest'

import {
  esignFieldCount,
  unknownPlaceholderSentence,
  unknownPreviewNotes,
} from '../components/letters/letterEditing'

/**
 * SignWell field tags in the letter editors (task 17): the editor warning and the preview notes explain a
 * tag that cannot be sent the same way the server's Send refusal does.
 */
describe('e-sign field tags in the letter editors', () => {
  it('counts the tags in a letter body, and says nothing when there are none', () => {
    expect(esignFieldCount('Initial {{initial:1:y}} and {{INITIAL:1:Y}}, sign {{s:1}}')).toBe('E-sign fields in the body: 3')
    expect(esignFieldCount('Dear {{client_name}}')).toBe('')
  })

  it('the editor warning explains a second signer, spaces and a tag in the email, each once', () => {
    expect(unknownPlaceholderSentence(['nope', 'initial:2:y'])).toBe(
      '{{nope}} is not a placeholder the app fills in. {{initial:2:y}} names signer 2, but a letter goes to one signer - use signer 1, as in {{initial:1:y}}. Send will refuse until they are changed.',
    )
    expect(unknownPlaceholderSentence(['text:1:n:Your title'])).toBe(
      'An e-sign field cannot contain spaces: {{text:1:n:Your title}}. Send will refuse until it is changed.',
    )
    expect(unknownPlaceholderSentence(['initial:1:y', 's:1:y'])).toBe(
      'E-sign fields belong in the letter, not the email. Send will refuse until they are changed.',
    )
  })

  it('the preview notes explain a second signer the way the editor does', () => {
    expect(unknownPreviewNotes(['nope', 'initial:2:y'])).toEqual([
      'Not a placeholder the app fills in: {{nope}}. Send refuses until it is fixed.',
      '{{initial:2:y}} names signer 2, but a letter goes to one signer - use signer 1, as in {{initial:1:y}}. Send refuses until it is fixed.',
    ])
    expect(unknownPreviewNotes(['initial:1:y', 'signature:1:y'])).toEqual([
      'E-sign fields belong in the letter, not the email. Send refuses until it is fixed.',
    ])
    expect(unknownPreviewNotes([])).toEqual([])
  })
})
