/**
 * Unit tests for `src/lib/clientLifecycle.ts` — the ONE list every "pick a
 * client" dropdown in the app is supposed to be built from.
 *
 * The contract that matters: retiring a client removes them from pickers and
 * NOTHING else, and reactivating them puts them straight back. Before this
 * helper existed, nine surfaces derived their own client list, so a retired
 * client would have kept appearing in whichever one was missed — and the fix
 * for that only holds as long as the helper itself behaves.
 */
import { describe, expect, it } from 'vitest'
import {
  isInactiveClient,
  lifecycleOf,
  markInactiveConfirm,
  selectableClients,
} from '../lib/clientLifecycle'
import type { Client, LifecycleStage } from '../lib/types'

function makeClient(id: string, stage?: LifecycleStage): Client {
  return {
    id,
    name: id.toUpperCase(),
    contact: '',
    billingMode: 'hourly',
    hourlyRate: 100,
    ...(stage ? { lifecycleStage: stage } : {}),
  } as Client
}

describe('lifecycleOf', () => {
  it('treats an absent stage as active — existing clients predate the field', () => {
    expect(lifecycleOf(makeClient('c1'))).toBe('active')
  })

  it('returns the stage as set', () => {
    expect(lifecycleOf(makeClient('c1', 'proposal'))).toBe('proposal')
    expect(lifecycleOf(makeClient('c1', 'inactive'))).toBe('inactive')
  })
})

describe('isInactiveClient', () => {
  it('is true only for the retirement stage', () => {
    expect(isInactiveClient(makeClient('c1', 'inactive'))).toBe(true)
    for (const stage of ['proposal', 'onboarding', 'active'] as LifecycleStage[]) {
      expect(isInactiveClient(makeClient('c1', stage))).toBe(false)
    }
    expect(isInactiveClient(makeClient('c1'))).toBe(false)
  })
})

describe('selectableClients', () => {
  it('drops retired clients and keeps everyone else', () => {
    const clients = [
      makeClient('c1'),
      makeClient('c2', 'active'),
      makeClient('c3', 'proposal'),
      makeClient('c4', 'onboarding'),
      makeClient('c5', 'inactive'),
    ]
    expect(selectableClients(clients).map((c) => c.id)).toEqual(['c1', 'c2', 'c3', 'c4'])
  })

  it('preserves order — pickers do their own sorting', () => {
    const clients = [makeClient('zed'), makeClient('gone', 'inactive'), makeClient('abe')]
    expect(selectableClients(clients).map((c) => c.id)).toEqual(['zed', 'abe'])
  })

  it('re-admits a retired client that the record being edited already points at', () => {
    const clients = [makeClient('c1'), makeClient('c5', 'inactive')]
    // Without this, a select bound to c5 would render blank and silently
    // re-point the entry/template to another client on the next save.
    expect(selectableClients(clients, ['c5']).map((c) => c.id)).toEqual(['c1', 'c5'])
  })

  it('ignores null/undefined keepIds rather than matching on them', () => {
    const clients = [makeClient('c1'), makeClient('c5', 'inactive')]
    expect(selectableClients(clients, [null, undefined, '']).map((c) => c.id)).toEqual(['c1'])
  })

  it('does not re-admit a retired client just because some OTHER id was kept', () => {
    const clients = [makeClient('c1'), makeClient('c5', 'inactive')]
    expect(selectableClients(clients, ['c1']).map((c) => c.id)).toEqual(['c1'])
  })

  it('reactivation makes a client selectable again, with nothing else changed', () => {
    const retired = makeClient('c5', 'inactive')
    expect(selectableClients([retired])).toHaveLength(0)

    // Reactivate = set the one flag back. This is exactly what the server's
    // setClientLifecycleStage does; every other field is untouched.
    const reactivated = { ...retired, lifecycleStage: 'active' as const }
    expect(selectableClients([reactivated]).map((c) => c.id)).toEqual(['c5'])
    expect({ ...reactivated, lifecycleStage: 'inactive' }).toEqual(retired)
  })

  it('is empty-safe', () => {
    expect(selectableClients([])).toEqual([])
  })
})

describe('markInactiveConfirm', () => {
  it('names the client and promises nothing is deleted', () => {
    const message = markInactiveConfirm('Acme Co')
    expect(message).toContain('Mark Acme Co inactive?')
    expect(message).toContain('Nothing is deleted')
    expect(message).toContain('reactivate')
  })
})
