import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MasterInvoiceRecipientBody } from '../pages/ClientDetailPage'
import type { Client } from '../lib/types'

/**
 * The "Combined invoice recipient" picker on a billing master's Billing tab —
 * the ONE place `invoiceRecipientClientId` is written from the UI. Until it
 * shipped the field was migration-set only, and a master with it unset cannot
 * send at all (409 `master_recipient_unset`), so what this picker offers and
 * what it commits are both load-bearing:
 *
 *   - offered: the master's own subs, active ones plus the current pick even
 *     if retired (a dropped current pick renders a blank select that silently
 *     re-points on the next save — same rule as `workableClients`' keepIds);
 *   - committed: a sub's id, or null for "Not set" — never '' (the store's
 *     sanitizer treats only strings naming a live sub as meaningful, but null
 *     is the honest shape the column holds).
 */

// `SaveSelectField`'s save badge reads `dataSyncState` through the context;
// nothing else here touches it.
vi.mock('../AppContext', () => ({ useAppContext: () => ({ dataSyncState: 'idle' }) }))

const master = { id: 'client-master', name: 'KLC Master', isBillingMaster: true } as Client

const sub = (over: Partial<Client>): Client =>
  ({ billToClientId: master.id, ...over }) as Client

const KLC = sub({ id: 'client-klc', name: 'KLC Floors & More' })
const CHEMTREX = sub({ id: 'client-chemtrex', name: 'Chemtrex' })
const RETIRED = sub({ id: 'client-old', name: 'Bright Tower', lifecycleStage: 'inactive' })
const STRANGER = { id: 'client-other', name: 'Unrelated LLC' } as Client

describe('the combined invoice recipient picker', () => {
  it('offers exactly the master’s active subs, alphabetically, plus Not set', () => {
    render(
      <MasterInvoiceRecipientBody
        client={master}
        clients={[master, KLC, CHEMTREX, RETIRED, STRANGER]}
        onCommit={vi.fn()}
      />,
    )
    const select = screen.getByLabelText<HTMLSelectElement>(/send the combined invoice to/i)
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
      'Not set — sending is refused',
      'Chemtrex',
      'KLC Floors & More',
    ])
    // Unset master ⇒ the select sits on Not set, matching the server's answer.
    expect(select.value).toBe('')
  })

  it('commits the picked sub’s id through the client-write patch', () => {
    const onCommit = vi.fn()
    render(
      <MasterInvoiceRecipientBody
        client={master}
        clients={[master, KLC, CHEMTREX]}
        onCommit={onCommit}
      />,
    )
    fireEvent.change(screen.getByLabelText(/send the combined invoice to/i), {
      target: { value: KLC.id },
    })
    expect(onCommit).toHaveBeenCalledWith({ invoiceRecipientClientId: KLC.id })
  })

  it('commits null — not the empty string — when set back to Not set', () => {
    const onCommit = vi.fn()
    render(
      <MasterInvoiceRecipientBody
        client={{ ...master, invoiceRecipientClientId: KLC.id }}
        clients={[master, KLC, CHEMTREX]}
        onCommit={onCommit}
      />,
    )
    fireEvent.change(screen.getByLabelText(/send the combined invoice to/i), {
      target: { value: '' },
    })
    expect(onCommit).toHaveBeenCalledWith({ invoiceRecipientClientId: null })
  })

  it('keeps a retired sub in the list ONLY while it is the current pick', () => {
    render(
      <MasterInvoiceRecipientBody
        client={{ ...master, invoiceRecipientClientId: RETIRED.id }}
        clients={[master, KLC, RETIRED]}
        onCommit={vi.fn()}
      />,
    )
    const select = screen.getByLabelText<HTMLSelectElement>(/send the combined invoice to/i)
    expect(select.value).toBe(RETIRED.id)
    expect(screen.getByText('Bright Tower (inactive)')).toBeInTheDocument()
  })

  it('shows a value naming a non-sub as Not set — how the server will treat it', () => {
    render(
      <MasterInvoiceRecipientBody
        client={{ ...master, invoiceRecipientClientId: STRANGER.id }}
        clients={[master, KLC, STRANGER]}
        onCommit={vi.fn()}
      />,
    )
    expect(screen.getByLabelText<HTMLSelectElement>(/send the combined invoice to/i).value).toBe('')
  })

  it('explains an empty master instead of rendering an empty select', () => {
    render(<MasterInvoiceRecipientBody client={master} clients={[master, STRANGER]} onCommit={vi.fn()} />)
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.getByText(/no companies bill to this master yet/i)).toBeInTheDocument()
  })
})

describe('the picker’s wiring on the client page', () => {
  // This file runs under jsdom, where `import.meta.url` is not a file: URL —
  // so resolve from the repo root vitest runs in, not from the module.
  const pageSource = readFileSync(
    path.resolve(process.cwd(), 'src/pages/ClientDetailPage.tsx'),
    'utf8',
  )

  // A behavior test on the body proves nothing if the page never renders it.
  // The section is gated on `isBillingMaster` and lives in the owner-only
  // Billing tab, where `commit` is the same patch path every other billing
  // field saves through.
  it('renders the section for a master, through the shared commit path', () => {
    expect(pageSource).toMatch(
      /\{client\.isBillingMaster \? \(\s*<CollapsibleSection\s*id="client-section-invoice-recipient"/,
    )
    expect(pageSource).toMatch(
      /<MasterInvoiceRecipientBody\s*client=\{client\}\s*clients=\{data\.clients\}\s*onCommit=\{commit\}\s*\/>/,
    )
  })
})
