import { describe, expect, it } from 'vitest'
import { proposalOutcomeAction, proposalOutcomeWords } from './proposal-outcomes.js'

describe('proposal outcome words', () => {
  it('names a decided proposal Won or closed as lost, and leaves draft/sent as they are', () => {
    expect(proposalOutcomeWords('accepted')).toBe('Won')
    expect(proposalOutcomeWords('declined')).toBe('closed as lost')
    expect(proposalOutcomeWords('sent')).toBe('sent')
    expect(proposalOutcomeWords('draft')).toBe('draft')
  })

  it('says what was done: marked Won or closed as lost', () => {
    expect(proposalOutcomeAction('accepted')).toBe('marked Won')
    expect(proposalOutcomeAction('declined')).toBe('closed as lost')
    expect(proposalOutcomeAction('sent')).toBe('sent')
  })
})
