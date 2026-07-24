/**
 * The clarification loop's mapping layer: `mapFeatureRequest` must carry the
 * developer's blocking question and the owner's answer through both row shapes
 * (snake_case pg rows and camelCase file-backend records), and default them to
 * null on legacy rows that predate the columns — so the Updates page can rely
 * on the fields existing.
 */
// @ts-expect-error - plain-JS module without type declarations
import { AppDataStore } from '../../db/store.js'
import { describe, expect, it } from 'vitest'

const base = {
  id: 'featreq-test',
  user_id: 'emp-patrice',
  title: 'T',
  description: 'D',
  type: 'feature',
  status: 'needs_input',
  priority: 'medium',
  priority_rank: 0,
  created_at: '2026-07-23T00:00:00.000Z',
}

describe('mapFeatureRequest clarification fields', () => {
  it('maps snake_case pg columns', () => {
    const mapped = AppDataStore.mapFeatureRequest({
      ...base,
      clarification_question: 'Which list do you mean?',
      clarification_answer: 'The time approvals list.',
    })
    expect(mapped.status).toBe('needs_input')
    expect(mapped.clarificationQuestion).toBe('Which list do you mean?')
    expect(mapped.clarificationAnswer).toBe('The time approvals list.')
  })

  it('maps camelCase file-backend records', () => {
    const mapped = AppDataStore.mapFeatureRequest({
      ...base,
      clarificationQuestion: 'Q?',
      clarificationAnswer: 'A.',
    })
    expect(mapped.clarificationQuestion).toBe('Q?')
    expect(mapped.clarificationAnswer).toBe('A.')
  })

  it('defaults to null on legacy rows without the columns', () => {
    const mapped = AppDataStore.mapFeatureRequest(base)
    expect(mapped.clarificationQuestion).toBeNull()
    expect(mapped.clarificationAnswer).toBeNull()
    expect(mapped.shippedAt).toBeNull()
  })

  it('maps shipped_at through both row shapes as an ISO string', () => {
    const pg = AppDataStore.mapFeatureRequest({
      ...base,
      shipped_at: '2026-07-24T01:30:00.000Z',
    })
    expect(pg.shippedAt).toBe('2026-07-24T01:30:00.000Z')
    const file = AppDataStore.mapFeatureRequest({
      ...base,
      shippedAt: '2026-07-24T01:30:00.000Z',
    })
    expect(file.shippedAt).toBe('2026-07-24T01:30:00.000Z')
  })
})
