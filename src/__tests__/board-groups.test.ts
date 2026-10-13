import { describe, expect, it } from 'vitest'
import { groupBoardColumns, UNCATEGORIZED_ID, type BoardColumn } from '../lib/activeBoard'
import type { Checklist } from '../lib/types'

/**
 * featreq-54bf39b6: "Maybe Group Boards but have a main overview you can
 * quickly see main groups". `groupBoardColumns` folds the board's columns into
 * their groups (in board order), with the ungrouped ones last, and counts each
 * group's DISTINCT clients - a client open in two columns of one group is one.
 */

const column = (id: string, clientIds: string[] = []): BoardColumn => ({
  id,
  name: id,
  openClientCount: clientIds.length,
  clients: clientIds.map((clientId) => ({ clientId, name: clientId, checklists: [] as Checklist[] })),
})

const CATEGORIES = [
  { id: 'feed', groupName: 'Core Accounting' },
  { id: 'payroll', groupName: 'Accounting Operations' },
  { id: 'recon', groupName: 'Core Accounting' },
  { id: 'call', groupName: null },
  { id: 'tax', groupName: 'Accounting Operations' },
]

describe('groupBoardColumns', () => {
  it('orders groups by their first column on the board and keeps each group in board order', () => {
    const groups = groupBoardColumns(
      [column('feed'), column('payroll'), column('recon'), column('tax')],
      CATEGORIES,
    )
    expect(groups.map((group) => group.name)).toEqual(['Core Accounting', 'Accounting Operations'])
    expect(groups[0].columns.map((col) => col.id)).toEqual(['feed', 'recon'])
    expect(groups[1].columns.map((col) => col.id)).toEqual(['payroll', 'tax'])
  })

  it('puts ungrouped columns and the Uncategorized column in a null group, LAST', () => {
    const groups = groupBoardColumns(
      [column('call'), column('feed'), column(UNCATEGORIZED_ID), column('unknown-cat')],
      CATEGORIES,
    )
    expect(groups.map((group) => group.name)).toEqual(['Core Accounting', null])
    expect(groups[1].columns.map((col) => col.id)).toEqual(['call', UNCATEGORIZED_ID, 'unknown-cat'])
  })

  it('counts the DISTINCT clients across a group’s columns', () => {
    const groups = groupBoardColumns(
      [column('feed', ['acme', 'bolt']), column('recon', ['acme', 'zed']), column('call', ['acme'])],
      CATEGORIES,
    )
    expect(groups.map((group) => [group.name, group.openClientCount])).toEqual([
      ['Core Accounting', 3],
      [null, 1],
    ])
  })

  it('a group whose columns are all empty still appears, with 0', () => {
    const groups = groupBoardColumns([column('feed'), column('payroll', ['acme'])], CATEGORIES)
    expect(groups.map((group) => [group.name, group.openClientCount])).toEqual([
      ['Core Accounting', 0],
      ['Accounting Operations', 1],
    ])
  })

  it('a blank group name is no group', () => {
    const groups = groupBoardColumns([column('feed')], [{ id: 'feed', groupName: '   ' }])
    expect(groups.map((group) => group.name)).toEqual([null])
  })

  it('empty input is no groups', () => {
    expect(groupBoardColumns([], CATEGORIES)).toEqual([])
    expect(groupBoardColumns([], [])).toEqual([])
  })
})
