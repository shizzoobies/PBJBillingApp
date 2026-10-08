import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { navItems, navSections } from '../components/navItems'

/**
 * Where Letters lives (featreq-5e195707): under an Engagements heading beside
 * Proposals, owner-only in the sidebar, in the route table and in the bounce
 * list that sends a non-owner away from an owner page.
 */

const appSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../App.tsx'),
  'utf8',
)

describe('the sidebar', () => {
  it('has an Engagements section holding Proposals then Letters', () => {
    const section = navSections.find((entry) => entry.label === 'Engagements')
    expect(section?.items.map((item) => [item.label, item.to])).toEqual([
      ['Proposals', '/proposals'],
      ['Letters', '/letters'],
    ])
  })

  it('makes Letters owner-only, so staff never see it', () => {
    const letters = navItems.find((item) => item.to === '/letters')
    expect(letters).toMatchObject({ label: 'Letters', ownerOnly: true })
  })

  it('lists Letters straight after Proposals in the flat list that names the pages', () => {
    const order = navItems.map((item) => item.to)
    expect(order.indexOf('/letters')).toBe(order.indexOf('/proposals') + 1)
  })

  it('shares the same item objects between the two views', () => {
    const grouped = navSections.flatMap((section) => section.items)
    for (const item of navItems) expect(grouped).toContain(item)
  })
})

describe('the routes', () => {
  it('serves /letters to an owner only', () => {
    expect(appSource).toMatch(
      /<Route\s+path="\/letters"\s+element=\{\s*<OwnerOnly ownerMode=\{ownerMode\}>\s*<LettersPage \/>\s*<\/OwnerOnly>\s*\}\s*\/>/,
    )
    expect(appSource).toContain("import { LettersPage } from './pages/LettersPage'")
  })

  it('bounces a non-owner off /letters and /proposals', () => {
    const start = appSource.indexOf('const ownerOnly = [')
    const end = appSource.indexOf(']', start)
    const list = appSource.slice(start, end)
    expect(list).toContain("'/letters'")
    expect(list).toContain("'/proposals'")
  })
})
