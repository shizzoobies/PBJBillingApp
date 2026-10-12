import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { navItems, navSections } from '../components/navItems'

/**
 * Where Letters lives (featreq-5e195707) and, since stage 2C of
 * docs/plans/engagements-2026-10.md, the Engagements pages: under an Engagements
 * heading (Proposals, Engagements, Letters), owner-only in the sidebar, in the
 * route table and in the bounce list that sends a non-owner away from an owner page.
 */

const appSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../App.tsx'),
  'utf8',
)

describe('the sidebar', () => {
  it('has an Engagements section holding Proposals, Engagements, then Letters', () => {
    const section = navSections.find((entry) => entry.label === 'Engagements')
    expect(section?.items.map((item) => [item.label, item.to])).toEqual([
      ['Proposals', '/proposals'],
      ['Engagements', '/engagements'],
      ['Letters', '/letters'],
    ])
  })

  it('makes Engagements owner-only, with an icon of its own (not the Letters one)', () => {
    const engagements = navItems.find((item) => item.to === '/engagements')
    const letters = navItems.find((item) => item.to === '/letters')
    expect(engagements).toMatchObject({ label: 'Engagements', ownerOnly: true })
    expect(engagements?.icon).not.toBe(letters?.icon)
  })

  it('makes Letters owner-only, so staff never see it', () => {
    const letters = navItems.find((item) => item.to === '/letters')
    expect(letters).toMatchObject({ label: 'Letters', ownerOnly: true })
  })

  it('lists Engagements then Letters straight after Proposals in the flat list that names the pages', () => {
    const order = navItems.map((item) => item.to)
    expect(order.indexOf('/engagements')).toBe(order.indexOf('/proposals') + 1)
    expect(order.indexOf('/letters')).toBe(order.indexOf('/proposals') + 2)
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

  it('serves the engagements list to an owner only, and no longer redirects /engagements to Proposals', () => {
    expect(appSource).toMatch(
      /<Route\s+path="\/engagements"\s+element=\{\s*<OwnerOnly ownerMode=\{ownerMode\}>\s*<EngagementsPage \/>\s*<\/OwnerOnly>\s*\}\s*\/>/,
    )
    expect(appSource).not.toMatch(/path="\/engagements"\s+element=\{<Navigate/)
  })

  it('bounces a non-owner off /letters, /engagements and /proposals', () => {
    const start = appSource.indexOf('const ownerOnly = [')
    const end = appSource.indexOf(']', start)
    const list = appSource.slice(start, end)
    expect(list).toContain("'/letters'")
    expect(list).toContain("'/engagements'")
    expect(list).toContain("'/proposals'")
  })
})
