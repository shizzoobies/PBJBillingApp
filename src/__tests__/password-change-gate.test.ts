import { describe, expect, it } from 'vitest'
// @ts-expect-error - plain-JS module without type declarations
import { evaluatePasswordChange } from '../../db/store.js'

/**
 * SECURITY (M4): unit tests for the pure change-password gate decision. The
 * store method supplies the facts (password_set_at, whether a current password
 * was provided, whether it verified) and this helper decides allow/reject +
 * the HTTP status the endpoint should send. No DB or crypto involved.
 */
describe('evaluatePasswordChange', () => {
  it('allows a first-time set when password_set_at is null (no current pw needed)', () => {
    const result = evaluatePasswordChange({
      passwordSetAt: null,
      currentPasswordProvided: false,
      currentPasswordValid: false,
    })
    expect(result.allowed).toBe(true)
  })

  it('allows a first-time set even if a current password is (pointlessly) supplied', () => {
    const result = evaluatePasswordChange({
      passwordSetAt: undefined,
      currentPasswordProvided: true,
      currentPasswordValid: false,
    })
    expect(result.allowed).toBe(true)
  })

  it('rejects with 400 when a password is already set but no current pw is provided', () => {
    const result = evaluatePasswordChange({
      passwordSetAt: '2026-01-01T00:00:00.000Z',
      currentPasswordProvided: false,
      currentPasswordValid: false,
    })
    expect(result.allowed).toBe(false)
    expect(result.status).toBe(400)
    expect(result.error).toMatch(/required/i)
  })

  it('rejects with 403 when a password is set and the current pw is wrong', () => {
    const result = evaluatePasswordChange({
      passwordSetAt: '2026-01-01T00:00:00.000Z',
      currentPasswordProvided: true,
      currentPasswordValid: false,
    })
    expect(result.allowed).toBe(false)
    expect(result.status).toBe(403)
    expect(result.error).toMatch(/incorrect/i)
  })

  it('allows the change when a password is set and the current pw verifies', () => {
    const result = evaluatePasswordChange({
      passwordSetAt: '2026-01-01T00:00:00.000Z',
      currentPasswordProvided: true,
      currentPasswordValid: true,
    })
    expect(result.allowed).toBe(true)
  })

  it('treats any truthy password_set_at (e.g. a Date) as "already set"', () => {
    const result = evaluatePasswordChange({
      passwordSetAt: new Date(),
      currentPasswordProvided: false,
      currentPasswordValid: false,
    })
    expect(result.allowed).toBe(false)
    expect(result.status).toBe(400)
  })
})
