# Proposals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Proposals section from `docs/plans/proposals-2026-09.md` (featreq-311473e2 / featreq-ef18a38e): an editable pricing catalog in firm settings, saved prospect proposals priced by a pure calculator, an Opus 5.5 intake chat and letter, the proposal emailed as a branded PDF, and Accept turning a prospect into a client in Onboarding.

**Architecture:** One pure calculator (`lib/proposal-pricing.js`) owns every price; the store snapshots its answer on every edit (`pricing_snapshot`), and the letter, PDF, list and chat only ever read that snapshot. Proposals are endpoint-managed like `packages` (their own `proposals` table on Postgres, `authState.proposals` on the file backend), outside the bulk save and the workspace fingerprint. The AI never computes: the chat returns a patch the server validates and applies through the same re-pricing write the form uses, and the letter validator refuses any dollar figure the snapshot does not contain.

**Tech Stack:** React 19 + TypeScript + Vite (`src/`), plain-Node `http` server (`server.js`), dual-backend `db/store.js` (Postgres + JSON file), pdfkit + svg-to-pdfkit, Resend via `sendInvoiceEmail`, Anthropic SDK structured outputs on `claude-opus-5-5`, vitest (happy-dom) with `*.test.mjs` beside `lib/` and `db/` and `*.test.ts(x)` under `src/__tests__`.

## Global Constraints

- `db/store.js` has TWO backends — Postgres (`DATABASE_URL` set) and the JSON file; every persisted change touches both, and every store test covers both (file backend for behavior, a recorder pool for the Postgres SQL).
- Every proposal route is owner-only (`session.user.role !== 'owner'` → 403) and every write checks `isCrossSiteOrigin(request)` (→ 403 `Origin not allowed`) and calls `broadcastDataChanged()`.
- Proposals are excluded from `BULK_SAVE_SLICES` / `BULK_SAVE_TABLES` and the workspace fingerprint; nothing here calls `appDataStore.write(`.
- AI schemas carry no `minimum` / `maximum` / `minItems` / `maxItems` (the claude-opus-5-5 validator 400s on them); caps live in the validators; `minLength` and `enum` are allowed.
- Every AI call runs on `process.env.ASSISTANT_MODEL || 'claude-opus-5-5'` with `modelFallback: false`, through `runStructuredModel`.
- Prices come only from `priceProposal` (the calculator): the chat never prices, the letter may quote only snapshot figures, the page never multiplies anything.
- Rates and the catalog are owner-only: `/api/firm-settings/public` never carries them, and the staff copy of `/api/app-data` strips them.
- The prospect's email is only ever the pre-filled value of a To address the owner confirms per send.
- CRLF: the repo is mixed per file (`core.autocrlf=true`, the index is LF). Edit existing files with the Edit tool so each keeps its own endings; new files may be LF. Never reformat a whole file.
- American spelling everywhere (labor, color, labeled, canceled); do not copy British spellings from old comments.
- `npm run verify` (eslint + `tsc -b && vite build` + vitest) is green before every commit.
- Commit messages open with a statement of behavior (no conventional-commit prefix) and end with the executing session's trailer; this plan writes it as `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (the model these tasks are dispatched on — use your own session's attribution if it differs). Do not push; the orchestrator ships.
- `docs/capability-manifest.md` is updated for the user-visible change (Task 15) and stays under the voice agent's ~216 KB knowledge-base cap; the voice agent is re-provisioned (`node scripts/provision-voice-agent.mjs`) after the orchestrator deploys.

## File Structure

**Created**
- `lib/proposal-pricing.js` — the seed catalog, the calculator (`priceProposal`), the catalog sanitizer, the proposal data cleaners and `applyProposalPatch`. Pure.
- `lib/proposal-pricing.d.ts` — types for the above, so `src/` can import the same code.
- `lib/proposal-pricing.test.mjs` — the worked sheet, payroll, sales tax, multipliers, overrides, sanitizer, patch.
- `lib/firm-lines.js` — `firmDetailLines(firm)`: the one copy of the firm's address/contact lines.
- `lib/firm-lines.test.mjs` — its order and blanks.
- `lib/proposal-pdf.js` — `buildProposalPdf` / `proposalPdfFilename` (pdfkit).
- `lib/proposal-pdf.test.mjs` — asserts on the real PDF bytes.
- `lib/proposal-email.js` — `buildProposalEmail`: the short email that carries the PDF.
- `lib/proposal-email.test.mjs` — the email and the `proposal_id` Resend tag.
- `src/lib/proposals.ts` — client helpers: enum labels, tabs, picker grouping, selection edits, activity, delivery badge, chat highlight keys.
- `src/pages/ProposalsPage.tsx` — the list (replaces the Engagements placeholder).
- `src/pages/ProposalEditorPage.tsx` — one proposal: header actions + Estimate / Letter / Activity tabs.
- `src/components/proposals/EstimateTab.tsx` — prospect, inputs, service picker, priced lines, overrides, totals.
- `src/components/proposals/LetterTab.tsx` — draft / regenerate / edit / copy / preview PDF / send / delivery badge.
- `src/components/proposals/ActivityTab.tsx` — the timeline and the chat transcript.
- `src/components/proposals/ChatPanel.tsx` — the intake chat beside the estimate.
- `src/__tests__/settings-proposal-pricing.test.tsx` — the Settings catalog table round-trips through the sanitizer.
- `src/__tests__/proposal-routes.test.ts` — source-reading route glue tests.
- `src/__tests__/proposals-page.test.tsx` — list, editor tabs, picker, override, totals, letter, send, accept, chat.

**Modified**
- `db/store.js` — `proposal_pricing` column + read/write, file-backend bulk save keeps stored firm settings, `proposals` table + CRUD, status, email log, letter, accept, chat turns, `setClientMonthlyRate`, `ProposalStateError`.
- `db/store-staleness.test.mjs` — store tests for all of the above, both backends.
- `server.js` — `proposalPricing` patch field, app-data strip, all `/api/proposals*` routes, the Resend webhook proposal branch.
- `lib/assistant.js` — validator `hint` in `runStructuredModel`; letter (schema, validator, prompt, `draftProposalLetter`); chat (schema, `validateProposalPatch`, context, `proposalChat`).
- `lib/assistant.test.mjs` — letter + chat tests and the schema bounds tripwires.
- `lib/invoice-pdf.js`, `lib/invoice-email.js` — use `lib/firm-lines.js` (their two private copies go away).
- `lib/notify.js` — `sendInvoiceEmail` accepts `proposalId` and tags `proposal_id`.
- `src/lib/types.ts` — proposal types; `FirmSettings.proposalPricing`.
- `src/lib/api.ts` — proposal request wrappers.
- `src/pages/SettingsPage.tsx` — the "Proposal pricing" section.
- `src/components/navItems.ts`, `src/App.tsx` — Proposals replaces Engagements; `/proposals`, `/proposals/:proposalId`; `/engagements` redirects.
- `src/App.css` — catalog table, editor, chat styles.
- `src/__tests__/audit-backlog-hardening.test.ts` — drift test + public/app-data catalog guards.
- `src/__tests__/assistant.test.tsx` — manifest section + size tripwire.
- `docs/capability-manifest.md` — `## Proposals (owner only)`, Settings bullet, navigation.

**Deleted**
- `src/pages/EngagementsPage.tsx` — the placeholder.

---

### Task 1: The proposal calculator and its seed catalog

**Files:**
- Create: `lib/proposal-pricing.js`
- Create: `lib/proposal-pricing.d.ts`
- Create: `lib/proposal-pricing.test.mjs`

**Interfaces:**
- Consumes: nothing (pure module).
- Produces: `defaultProposalPricing(): ProposalPricing`, `DEFAULT_PROPOSAL_PRICING` (frozen copy), `priceProposal({ catalog, rates, inputs, selections }) -> { lines: PricedLine[], totals: { monthly, annual, oneTime, cleanup } }`, `formatProposalMoney(amount: number): string`, `roundCents(value: number): number`, the enum arrays `PROPOSAL_GROUPS`, `MONTHLY_GROUPS`, `ANNUAL_GROUP`, `CLEANUP_GROUP`, `PROPOSAL_TIERS`, `PROPOSAL_ROLES`, `PROPOSAL_PRICING_KINDS`, `PROPOSAL_MULTIPLIERS`, `PROPOSAL_CADENCES`, `PAYROLL_RUNS`, and the constants `PAYROLL_BONUS_FACTOR = 0.13`, `PAYROLL_TAX_FACTOR = 0.5`, `SALES_TAX_AMOUNT_KEY = 'salesTaxReviewAmount'`.

Decisions this task makes (report them to Alex with the plan): (1) rows in "Annual and one-time" carry `cadence: 'annual' | 'one-time'` so that group can split into the spec's separate `annual` and `oneTime` totals (Payroll setup is one-time, the rest annual); (2) the sales-tax block adds the review amount D when the selection's `includeReview` is true; (3) "Client call" is seeded as a formula row (`clientCallHours x 1 x controller`), which is exactly the spec's special case; (4) the per-count multipliers (`per-form`, `per-report`, `per-cleanup-month`) use the selection's typed `quantity` when there is one (her "__" blanks) and the input otherwise.

- [ ] **Step 1: Write the failing test** — create `lib/proposal-pricing.test.mjs`:

```js
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PROPOSAL_PRICING,
  defaultProposalPricing,
  formatProposalMoney,
  priceProposal,
} from './proposal-pricing.js'

/**
 * The proposal calculator against HER SHEET (docs/plans/proposals-2026-09.md
 * §4.1 and §4.3). Every seeded row is priced once with the same worked set of
 * counts, at the team's current bill rates as stand-in proposal rates
 * (B 75 / A 115 / C 125 — the real proposal rates are hers to set).
 */
const rates = { bookkeeper: 75, accountant: 115, controller: 125 }
const inputs = {
  transactions: 120,
  balanceSheetAccounts: 20,
  plAccounts: 40,
  totalAccounts: 80,
  invoicesPerWeekAR: 10,
  invoicesPerWeekAP: 12,
  employees: 10,
  salesTaxReviewAmount: 50,
  states: 2,
  cleanupMonths: 6,
  reportsNeeded: 3,
  forms: 4,
  accountsNeedingAttention: 5,
  chartAccountsToClean: 30,
  clientCallHours: 2,
}
const catalog = defaultProposalPricing()
const price = (selections, overrides = {}) =>
  priceProposal({ catalog, rates, inputs: { ...inputs, ...overrides }, selections })
const one = (selection, overrides) => price([selection], overrides).lines[0]

describe('the seed catalog', () => {
  it('reproduces her sheet: 41 rows, every one active, zero rates', () => {
    expect(DEFAULT_PROPOSAL_PRICING.services).toHaveLength(41)
    expect(DEFAULT_PROPOSAL_PRICING.services.every((row) => row.active)).toBe(true)
    expect(DEFAULT_PROPOSAL_PRICING.rates).toEqual({ bookkeeper: 0, accountant: 0, controller: 0 })
    expect(DEFAULT_PROPOSAL_PRICING.inputs.map((input) => input.key)).toEqual([
      'transactions',
      'balanceSheetAccounts',
      'plAccounts',
      'totalAccounts',
      'invoicesPerWeekAR',
      'invoicesPerWeekAP',
      'employees',
      'salesTaxReviewAmount',
      'states',
      'cleanupMonths',
      'reportsNeeded',
      'forms',
      'accountsNeedingAttention',
      'chartAccountsToClean',
      'clientCallHours',
    ])
  })

  it('hands out a fresh copy every time, so nobody can edit the seed', () => {
    const copy = defaultProposalPricing()
    copy.services[0].factor = 99
    expect(defaultProposalPricing().services[0].factor).toBe(0.07)
  })

  it('has unique service ids', () => {
    const ids = DEFAULT_PROPOSAL_PRICING.services.map((row) => row.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('every seeded row against the worked sheet', () => {
  // [serviceId, amount]. Flat rows are typed at $250.00.
  const worked = [
    ['monthly-weekly-transactions-basic', 630],
    ['monthly-weekly-transactions-classes', 900],
    ['monthly-weekly-transactions-advance', 1170],
    ['monthly-monthly-transactions-basic', 270],
    ['monthly-monthly-transactions-classes', 450],
    ['monthly-monthly-transactions-advance', 630],
    ['reconciliations', 375],
    ['ar-prepare-invoices', 149.5],
    ['ar-send-invoices', 22.5],
    ['ar-follow-up', 22.5],
    ['ar-collections', 7.5],
    ['ap-enter-invoices', 45],
    ['ap-pay-invoices', 45],
    ['ap-contact-vendors', 15],
    ['payroll', 115],
    ['sales-tax-monthly', 100],
    ['sales-tax-quarterly', 33.33],
    ['sales-tax-yearly', 8.33],
    ['reports-monthly-basic', 276],
    ['reports-monthly-advance', 460],
    ['reports-quarterly-basic', 92],
    ['reports-quarterly-advance', 153.33],
    ['reports-needed-basic', 828],
    ['reports-needed-advance', 1380],
    ['budget-vs-actual', 250],
    ['cash-flow-weekly', 2000],
    ['cash-flow-monthly', 500],
    ['kpi-reports', 700],
    ['client-call', 250],
    ['budget', 1000],
    ['forecast', 2000],
    ['payroll-setup', 250],
    ['business-return', 250],
    ['individual-return', 250],
    ['individual-return-multiple-forms', 1000],
    ['cleanup-transactions-basic', 1620],
    ['cleanup-transactions-classes', 2700],
    ['cleanup-transactions-advance', 3780],
    ['cleanup-reconciliations', 2250],
    ['cleanup-accounts-attention', 487.5],
    ['cleanup-chart-of-accounts', 241.5],
  ]

  it('covers the whole catalog', () => {
    expect(worked.map(([id]) => id).sort()).toEqual(
      DEFAULT_PROPOSAL_PRICING.services.map((row) => row.id).sort(),
    )
  })

  for (const [serviceId, amount] of worked) {
    it(`${serviceId} prices ${formatProposalMoney(amount)}`, () => {
      const line = one({ serviceId, flatAmount: 250 })
      expect(line.amount).toBe(amount)
      expect(line.computedAmount).toBe(amount)
      expect(line.flag).toBeNull()
    })
  }

  it('writes the formula she can read under the line', () => {
    expect(one({ serviceId: 'monthly-weekly-transactions-basic' }).formula).toBe(
      '120 transactions x 0.07 x $75/hr = $630.00',
    )
    expect(one({ serviceId: 'cash-flow-weekly' }).formula).toBe(
      '80 total accounts x 0.05 x $125/hr x 4 weeks = $2,000.00',
    )
    expect(one({ serviceId: 'cleanup-reconciliations' }).formula).toBe(
      '20 balance sheet accounts x 0.25 x $75/hr x 6 clean-up months = $2,250.00',
    )
  })
})

describe('the payroll block', () => {
  // A = $115, employees = 10: H = 115 x .05 x 10 = 57.50, T = 115 x .5 = 57.50,
  // bonus = 115 x .13 x 57.50 = 859.625.
  const cases = [
    ['weekly', false, 287.5],
    ['weekly', true, 1147.13],
    ['biweekly', false, 172.5],
    ['biweekly', true, 1032.13],
    ['monthly', false, 115],
    ['monthly', true, 974.63],
  ]
  for (const [payrollRun, includeBonus, amount] of cases) {
    it(`run ${payrollRun}${includeBonus ? ' with bonus' : ''} = ${formatProposalMoney(amount)}`, () => {
      expect(one({ serviceId: 'payroll', payrollRun, includeBonus }).amount).toBe(amount)
    })
  }

  it('defaults to a monthly run and names the run in the formula', () => {
    expect(one({ serviceId: 'payroll' }).amount).toBe(115)
    expect(one({ serviceId: 'payroll', payrollRun: 'biweekly' }).formula).toContain('run bi-weekly')
  })
})

describe('the sales-tax block', () => {
  it('files D x states, divided for quarterly and yearly', () => {
    expect(one({ serviceId: 'sales-tax-monthly' }).amount).toBe(100)
    expect(one({ serviceId: 'sales-tax-quarterly' }).amount).toBe(33.33)
    expect(one({ serviceId: 'sales-tax-yearly' }).amount).toBe(8.33)
  })

  it('adds the review amount D when the review is included', () => {
    const line = one({ serviceId: 'sales-tax-quarterly', includeReview: true })
    expect(line.amount).toBe(83.33)
    expect(line.formula).toBe('$50.00 x 2 states / 3 + review $50.00 = $83.33')
  })
})

describe('multipliers, quantities, flat rows and overrides', () => {
  it('a typed quantity beats the input for a per-count row (her "__" blanks)', () => {
    expect(one({ serviceId: 'budget', quantity: 2 }).amount).toBe(500)
    expect(one({ serviceId: 'budget' }).amount).toBe(1000)
  })

  it('a flat row is the typed amount, and $0.00 when nothing is typed', () => {
    expect(one({ serviceId: 'payroll-setup', flatAmount: 400 }).formula).toBe('Flat $400.00')
    expect(one({ serviceId: 'payroll-setup' }).amount).toBe(0)
    expect(one({ serviceId: 'individual-return-multiple-forms', flatAmount: 90 }).amount).toBe(360)
  })

  it('an override replaces the amount and keeps the computed one beside it', () => {
    const line = one({ serviceId: 'reports-monthly-basic', override: 200 })
    expect(line.amount).toBe(200)
    expect(line.computedAmount).toBe(276)
    expect(line.formula).toBe('80 total accounts x 0.03 x $115/hr = $276.00 (price set to $200.00)')
  })

  it('a missing count prices $0.00 rather than NaN', () => {
    expect(one({ serviceId: 'reconciliations' }, { balanceSheetAccounts: undefined }).amount).toBe(0)
  })
})

describe('rows that must never price', () => {
  it('an inactive row never prices', () => {
    const retired = defaultProposalPricing()
    retired.services.find((row) => row.id === 'reconciliations').active = false
    const result = priceProposal({
      catalog: retired,
      rates,
      inputs,
      selections: [{ serviceId: 'reconciliations' }],
    })
    expect(result.lines).toEqual([])
    expect(result.totals.monthly).toBe(0)
  })

  it('an unknown service id is skipped', () => {
    expect(price([{ serviceId: 'not-a-row' }]).lines).toEqual([])
  })

  it('an unknown inputKey prices $0.00 and flags the line', () => {
    const broken = defaultProposalPricing()
    broken.services.find((row) => row.id === 'kpi-reports').inputKey = 'widgets'
    const [line] = priceProposal({
      catalog: broken,
      rates,
      inputs,
      selections: [{ serviceId: 'kpi-reports' }],
    }).lines
    expect(line.amount).toBe(0)
    expect(line.flag).toBe('unknown-input')
  })
})

describe('the four totals', () => {
  it('sums monthly groups, splits annual from one-time, and keeps clean-up apart', () => {
    const { lines, totals } = price([
      { serviceId: 'cleanup-chart-of-accounts' },
      { serviceId: 'monthly-weekly-transactions-basic' },
      { serviceId: 'reconciliations' },
      { serviceId: 'payroll', payrollRun: 'biweekly' },
      { serviceId: 'reports-monthly-basic', override: 200 },
      { serviceId: 'budget' },
      { serviceId: 'payroll-setup', flatAmount: 400 },
      { serviceId: 'cleanup-transactions-basic' },
    ])
    expect(totals).toEqual({ monthly: 1377.5, annual: 1000, oneTime: 400, cleanup: 1861.5 })
    // Catalog order, not selection order.
    expect(lines[0].serviceId).toBe('monthly-weekly-transactions-basic')
    expect(lines.at(-1).serviceId).toBe('cleanup-chart-of-accounts')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run lib/proposal-pricing.test.mjs`
Expected: FAIL — the suite cannot load `./proposal-pricing.js` (file does not exist).

- [ ] **Step 3: Implement** — create `lib/proposal-pricing.js`:

```js
/**
 * PROPOSAL PRICING — the catalog math behind every proposal
 * (featreq-311473e2 / featreq-ef18a38e, docs/plans/proposals-2026-09.md §4).
 *
 * Pure: same inputs, same answer, no clock and no I/O. The AI never computes a
 * price — every dollar a proposal, its letter, or its PDF shows comes out of
 * `priceProposal`, which is why the intake chat and the letter validator are
 * handed its lines rather than asked to multiply anything.
 *
 * One formula shape for every catalog row:
 *   count x factor x role rate x multiplier
 * plus two explicit blocks that do not fit it (payroll, sales tax) and flat
 * rows whose amount is typed per proposal (her sheet's blanks).
 */

export const PROPOSAL_GROUPS = [
  'Monthly',
  'Reconciliations',
  'AR',
  'AP',
  'Payroll',
  'Sales tax',
  'Reports',
  'Additional reports',
  'Annual and one-time',
  'Clean-up',
]

/** The groups whose lines add up to the monthly fee. */
export const MONTHLY_GROUPS = PROPOSAL_GROUPS.slice(0, 8)
export const ANNUAL_GROUP = 'Annual and one-time'
export const CLEANUP_GROUP = 'Clean-up'

export const PROPOSAL_TIERS = ['Basic', 'Classes', 'Advance']
export const PROPOSAL_ROLES = ['bookkeeper', 'accountant', 'controller']
export const PROPOSAL_PRICING_KINDS = ['formula', 'flat', 'payroll', 'sales-tax']
export const PROPOSAL_MULTIPLIERS = [
  'none',
  'weekly-x4',
  'quarterly-div3',
  'yearly-div12',
  'per-cleanup-month',
  'per-report',
  'per-form',
]
/** Only rows in the Annual and one-time group carry one; it splits that group's total. */
export const PROPOSAL_CADENCES = ['annual', 'one-time']
export const PAYROLL_RUNS = ['weekly', 'biweekly', 'monthly']

/** Her payroll block: bonus = A x .13 x H, taxes T = A x .5. */
export const PAYROLL_BONUS_FACTOR = 0.13
export const PAYROLL_TAX_FACTOR = 0.5
/** The sales-tax block's D. Its `inputKey` is the state count (E). */
export const SALES_TAX_AMOUNT_KEY = 'salesTaxReviewAmount'

const DEFAULT_INPUTS = [
  { key: 'transactions', label: 'Transactions', help: 'X - transactions per month in their books' },
  { key: 'balanceSheetAccounts', label: 'Balance sheet accounts', help: 'Y' },
  { key: 'plAccounts', label: 'Profit and loss accounts', help: 'W' },
  { key: 'totalAccounts', label: 'Total accounts', help: 'Z' },
  { key: 'invoicesPerWeekAR', label: 'Customer invoices per week', help: 'F - accounts receivable' },
  { key: 'invoicesPerWeekAP', label: 'Vendor bills per week', help: 'G - accounts payable' },
  { key: 'employees', label: 'Employees', help: 'I - people on payroll' },
  { key: 'salesTaxReviewAmount', label: 'Sales tax review amount', help: 'D - dollars per sales tax review' },
  { key: 'states', label: 'Sales tax states', help: 'E - states they file in' },
  { key: 'cleanupMonths', label: 'Months of clean-up', help: 'How many months of books need clean-up' },
  { key: 'reportsNeeded', label: 'Reports needed', help: 'How many reports they want' },
  { key: 'forms', label: 'Forms', help: 'Forms on an individual return' },
  { key: 'accountsNeedingAttention', label: 'Accounts needing detailed attention', help: 'Clean-up' },
  { key: 'chartAccountsToClean', label: 'Chart of accounts entries to clean', help: 'Clean-up' },
  { key: 'clientCallHours', label: 'Client call hours', help: 'Hours of client calls per month' },
]

// [id, group, name, tier, pricing, inputKey, factor, role, multiplier, cadence]
const SEED_ROWS = [
  ['monthly-weekly-transactions-basic', 'Monthly', 'Weekly transactions', 'Basic', 'formula', 'transactions', 0.07, 'bookkeeper', 'none'],
  ['monthly-weekly-transactions-classes', 'Monthly', 'Weekly transactions', 'Classes', 'formula', 'transactions', 0.1, 'bookkeeper', 'none'],
  ['monthly-weekly-transactions-advance', 'Monthly', 'Weekly transactions', 'Advance', 'formula', 'transactions', 0.13, 'bookkeeper', 'none'],
  ['monthly-monthly-transactions-basic', 'Monthly', 'Monthly transactions', 'Basic', 'formula', 'transactions', 0.03, 'bookkeeper', 'none'],
  ['monthly-monthly-transactions-classes', 'Monthly', 'Monthly transactions', 'Classes', 'formula', 'transactions', 0.05, 'bookkeeper', 'none'],
  ['monthly-monthly-transactions-advance', 'Monthly', 'Monthly transactions', 'Advance', 'formula', 'transactions', 0.07, 'bookkeeper', 'none'],
  ['reconciliations', 'Reconciliations', 'Reconciliations', null, 'formula', 'balanceSheetAccounts', 0.25, 'bookkeeper', 'none'],
  ['ar-prepare-invoices', 'AR', 'Prepare invoices', null, 'formula', 'invoicesPerWeekAR', 0.13, 'accountant', 'none'],
  ['ar-send-invoices', 'AR', 'Send invoices', null, 'formula', 'invoicesPerWeekAR', 0.03, 'bookkeeper', 'none'],
  ['ar-follow-up', 'AR', 'Follow up with clients', null, 'formula', 'invoicesPerWeekAR', 0.03, 'bookkeeper', 'none'],
  ['ar-collections', 'AR', 'Support with collections', null, 'formula', 'invoicesPerWeekAR', 0.01, 'bookkeeper', 'none'],
  ['ap-enter-invoices', 'AP', 'Enter invoices', null, 'formula', 'invoicesPerWeekAP', 0.05, 'bookkeeper', 'none'],
  ['ap-pay-invoices', 'AP', 'Pay invoices', null, 'formula', 'invoicesPerWeekAP', 0.03, 'controller', 'none'],
  ['ap-contact-vendors', 'AP', 'Contact vendors', null, 'formula', 'invoicesPerWeekAP', 0.01, 'controller', 'none'],
  ['payroll', 'Payroll', 'Payroll', null, 'payroll', 'employees', 0.05, 'accountant', 'none'],
  ['sales-tax-monthly', 'Sales tax', 'File sales tax monthly', null, 'sales-tax', 'states', 0, null, 'none'],
  ['sales-tax-quarterly', 'Sales tax', 'File sales tax quarterly', null, 'sales-tax', 'states', 0, null, 'quarterly-div3'],
  ['sales-tax-yearly', 'Sales tax', 'File sales tax yearly', null, 'sales-tax', 'states', 0, null, 'yearly-div12'],
  ['reports-monthly-basic', 'Reports', 'Monthly reports', 'Basic', 'formula', 'totalAccounts', 0.03, 'accountant', 'none'],
  ['reports-monthly-advance', 'Reports', 'Monthly reports', 'Advance', 'formula', 'totalAccounts', 0.05, 'accountant', 'none'],
  ['reports-quarterly-basic', 'Reports', 'Quarterly reports', 'Basic', 'formula', 'totalAccounts', 0.03, 'accountant', 'quarterly-div3'],
  ['reports-quarterly-advance', 'Reports', 'Quarterly reports', 'Advance', 'formula', 'totalAccounts', 0.05, 'accountant', 'quarterly-div3'],
  ['reports-needed-basic', 'Reports', 'Reports needed', 'Basic', 'formula', 'totalAccounts', 0.03, 'accountant', 'per-report'],
  ['reports-needed-advance', 'Reports', 'Reports needed', 'Advance', 'formula', 'totalAccounts', 0.05, 'accountant', 'per-report'],
  ['budget-vs-actual', 'Additional reports', 'Budget vs actual', null, 'formula', 'plAccounts', 0.05, 'controller', 'none'],
  ['cash-flow-weekly', 'Additional reports', 'Cash flow weekly', null, 'formula', 'totalAccounts', 0.05, 'controller', 'weekly-x4'],
  ['cash-flow-monthly', 'Additional reports', 'Cash flow monthly', null, 'formula', 'totalAccounts', 0.05, 'controller', 'none'],
  ['kpi-reports', 'Additional reports', 'KPI reports', null, 'formula', 'totalAccounts', 0.07, 'controller', 'none'],
  ['client-call', 'Additional reports', 'Client call', null, 'formula', 'clientCallHours', 1, 'controller', 'none'],
  ['budget', 'Annual and one-time', 'Budget', null, 'formula', 'plAccounts', 0.05, 'controller', 'per-form', 'annual'],
  ['forecast', 'Annual and one-time', 'Forecast', null, 'formula', 'totalAccounts', 0.05, 'controller', 'per-form', 'annual'],
  ['payroll-setup', 'Annual and one-time', 'Payroll setup', null, 'flat', null, 0, null, 'none', 'one-time'],
  ['business-return', 'Annual and one-time', 'Business return', null, 'flat', null, 0, null, 'none', 'annual'],
  ['individual-return', 'Annual and one-time', 'Individual return', null, 'flat', null, 0, null, 'none', 'annual'],
  ['individual-return-multiple-forms', 'Annual and one-time', 'Individual return with multiple forms', null, 'flat', 'forms', 0, null, 'per-form', 'annual'],
  ['cleanup-transactions-basic', 'Clean-up', 'Monthly transactions', 'Basic', 'formula', 'transactions', 0.03, 'bookkeeper', 'per-cleanup-month'],
  ['cleanup-transactions-classes', 'Clean-up', 'Monthly transactions', 'Classes', 'formula', 'transactions', 0.05, 'bookkeeper', 'per-cleanup-month'],
  ['cleanup-transactions-advance', 'Clean-up', 'Monthly transactions', 'Advance', 'formula', 'transactions', 0.07, 'bookkeeper', 'per-cleanup-month'],
  ['cleanup-reconciliations', 'Clean-up', 'Reconciliations', null, 'formula', 'balanceSheetAccounts', 0.25, 'bookkeeper', 'per-cleanup-month'],
  ['cleanup-accounts-attention', 'Clean-up', 'Accounts needing detailed attention', null, 'formula', 'accountsNeedingAttention', 0.13, 'controller', 'per-cleanup-month'],
  ['cleanup-chart-of-accounts', 'Clean-up', 'Chart of accounts clean-up', null, 'formula', 'chartAccountsToClean', 0.07, 'accountant', 'none'],
]

/**
 * A fresh copy of the seed catalog: her sheet, row for row, with ZERO role
 * rates — the proposal rates are hers to set (spec §9: they are not the team's
 * bill rates). Always a new object, so no caller can mutate the seed.
 */
export function defaultProposalPricing() {
  return {
    rates: { bookkeeper: 0, accountant: 0, controller: 0 },
    inputs: DEFAULT_INPUTS.map((input) => ({ ...input })),
    services: SEED_ROWS.map(
      ([id, group, name, tier, pricing, inputKey, factor, role, multiplier, cadence], index) => ({
        id,
        group,
        name,
        tier,
        pricing,
        inputKey,
        factor,
        role,
        multiplier,
        cadence: group === ANNUAL_GROUP ? (cadence ?? 'annual') : null,
        active: true,
        sortOrder: index + 1,
      }),
    ),
  }
}

export const DEFAULT_PROPOSAL_PRICING = Object.freeze(defaultProposalPricing())

/** Round to cents at the line, so a total is always the sum of what is shown. */
export function roundCents(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100
}

/** "$1,234.50" — the one money format the formula strings and the letter use. */
export function formatProposalMoney(amount) {
  return `$${roundCents(amount).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

/** "$75/hr", or "$72.50/hr" when the rate has cents. */
function formatRate(rate) {
  return `${Number.isInteger(rate) ? `$${rate}` : formatProposalMoney(rate)}/hr`
}

/** A finite, non-negative number, or 0. */
function count(value) {
  const n = Number(value)
  return value !== null && value !== undefined && value !== '' && Number.isFinite(n) && n >= 0
    ? n
    : 0
}

/** A finite, non-negative number, or null when the field is absent or junk. */
function optionalAmount(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** The per-row count behind a per-* multiplier: the typed quantity wins, else the input. */
function perCount(selection, values, key) {
  const typed = optionalAmount(selection?.quantity)
  return typed ?? count(values[key])
}

function multiplierOf(service, selection, values) {
  switch (service.multiplier) {
    case 'weekly-x4':
      return { factor: 4, text: ' x 4 weeks' }
    case 'quarterly-div3':
      return { factor: 1 / 3, text: ' / 3' }
    case 'yearly-div12':
      return { factor: 1 / 12, text: ' / 12' }
    case 'per-cleanup-month': {
      const n = perCount(selection, values, 'cleanupMonths')
      return { factor: n, text: ` x ${n} clean-up months` }
    }
    case 'per-report': {
      const n = perCount(selection, values, 'reportsNeeded')
      return { factor: n, text: ` x ${n} reports` }
    }
    case 'per-form': {
      const n = perCount(selection, values, 'forms')
      return { factor: n, text: ` x ${n} forms` }
    }
    default:
      return { factor: 1, text: '' }
  }
}

function priceLine(service, selection, { rates, values, inputsByKey }) {
  if (service.inputKey && !inputsByKey.has(service.inputKey)) {
    return {
      amount: 0,
      formula: `No input named "${service.inputKey}" in the catalog - this line prices at $0.00`,
      flag: 'unknown-input',
    }
  }
  const rate = service.role ? count(rates[service.role]) : 0
  const multiplier = multiplierOf(service, selection, values)

  if (service.pricing === 'flat') {
    const typed = count(selection?.flatAmount)
    const amount = roundCents(typed * multiplier.factor)
    const formula = multiplier.text
      ? `${formatProposalMoney(typed)}${multiplier.text} = ${formatProposalMoney(amount)}`
      : `Flat ${formatProposalMoney(amount)}`
    return { amount, formula, flag: null }
  }

  if (service.pricing === 'payroll') {
    const employees = count(values[service.inputKey])
    const hours = rate * count(service.factor) * employees
    const taxes = rate * PAYROLL_TAX_FACTOR
    const run = PAYROLL_RUNS.includes(selection?.payrollRun) ? selection.payrollRun : 'monthly'
    const runs = run === 'weekly' ? 4 : run === 'biweekly' ? 2 : 1
    const bonus = selection?.includeBonus === true ? rate * PAYROLL_BONUS_FACTOR * hours : 0
    const amount = roundCents(hours * runs + taxes + bonus)
    const label = run === 'biweekly' ? 'bi-weekly' : run
    const formula =
      `${employees} employees, run ${label}: (${formatRate(rate)} x ${service.factor} x ${employees})` +
      `${runs === 1 ? '' : ` x ${runs}`} + taxes ${formatRate(rate)} x ${PAYROLL_TAX_FACTOR}` +
      `${bonus ? ` + bonus ${formatRate(rate)} x ${PAYROLL_BONUS_FACTOR} x ${formatProposalMoney(hours)}` : ''}` +
      ` = ${formatProposalMoney(amount)}`
    return { amount, formula, flag: null }
  }

  if (service.pricing === 'sales-tax') {
    const review = count(values[SALES_TAX_AMOUNT_KEY])
    const states = count(values[service.inputKey])
    const file = review * states * multiplier.factor
    const withReview = selection?.includeReview === true
    const amount = roundCents(file + (withReview ? review : 0))
    const formula =
      `${formatProposalMoney(review)} x ${states} states${multiplier.text}` +
      `${withReview ? ` + review ${formatProposalMoney(review)}` : ''} = ${formatProposalMoney(amount)}`
    return { amount, formula, flag: null }
  }

  const n = count(values[service.inputKey])
  const label = inputsByKey.get(service.inputKey)?.label ?? service.inputKey
  const amount = roundCents(n * count(service.factor) * rate * multiplier.factor)
  const formula =
    `${n} ${String(label).toLowerCase()} x ${service.factor} x ${formatRate(rate)}` +
    `${multiplier.text} = ${formatProposalMoney(amount)}`
  return { amount, formula, flag: null }
}

/**
 * Price a proposal.
 *
 * `selections` name catalog rows by id. A row that is missing or inactive
 * never prices. An `override` replaces the amount and keeps the computed one
 * beside it, so the estimate can show both.
 *
 * @returns {{ lines: object[], totals: { monthly: number, annual: number, oneTime: number, cleanup: number } }}
 */
export function priceProposal({ catalog, rates, inputs, selections } = {}) {
  const services = Array.isArray(catalog?.services) ? catalog.services : []
  const byId = new Map(services.map((service) => [service.id, service]))
  const inputsByKey = new Map(
    (Array.isArray(catalog?.inputs) ? catalog.inputs : []).map((input) => [input.key, input]),
  )
  const values = inputs && typeof inputs === 'object' ? inputs : {}
  const safeRates = rates && typeof rates === 'object' ? rates : {}

  const lines = []
  for (const selection of Array.isArray(selections) ? selections : []) {
    const service = byId.get(selection?.serviceId)
    if (!service || service.active !== true) continue
    const priced = priceLine(service, selection, { rates: safeRates, values, inputsByKey })
    const override = optionalAmount(selection.override)
    lines.push({
      serviceId: service.id,
      group: service.group,
      name: service.name,
      tier: service.tier ?? null,
      cadence: service.cadence ?? null,
      amount: override === null ? priced.amount : roundCents(override),
      computedAmount: priced.amount,
      formula:
        override === null
          ? priced.formula
          : `${priced.formula} (price set to ${formatProposalMoney(override)})`,
      flag: priced.flag,
      sortOrder: Number(service.sortOrder) || 0,
    })
  }
  lines.sort((a, b) => a.sortOrder - b.sortOrder)

  const sum = (keep) => roundCents(lines.filter(keep).reduce((total, line) => total + line.amount, 0))
  const totals = {
    monthly: sum((line) => MONTHLY_GROUPS.includes(line.group)),
    annual: sum((line) => line.group === ANNUAL_GROUP && line.cadence !== 'one-time'),
    oneTime: sum((line) => line.group === ANNUAL_GROUP && line.cadence === 'one-time'),
    cleanup: sum((line) => line.group === CLEANUP_GROUP),
  }
  return { lines: lines.map(({ sortOrder: _sortOrder, ...line }) => line), totals }
}
```

Then create `lib/proposal-pricing.d.ts`:

```ts
/**
 * Types for the plain-JS `lib/proposal-pricing.js`, so `src/` prices a
 * proposal through the very function the server snapshots with.
 *
 * Keep these in sync with the actual exports in lib/proposal-pricing.js.
 */

export type ProposalGroup =
  | 'Monthly'
  | 'Reconciliations'
  | 'AR'
  | 'AP'
  | 'Payroll'
  | 'Sales tax'
  | 'Reports'
  | 'Additional reports'
  | 'Annual and one-time'
  | 'Clean-up'
export type ProposalTier = 'Basic' | 'Classes' | 'Advance'
export type ProposalRole = 'bookkeeper' | 'accountant' | 'controller'
export type ProposalPricingKind = 'formula' | 'flat' | 'payroll' | 'sales-tax'
export type ProposalMultiplier =
  | 'none'
  | 'weekly-x4'
  | 'quarterly-div3'
  | 'yearly-div12'
  | 'per-cleanup-month'
  | 'per-report'
  | 'per-form'
export type ProposalCadence = 'annual' | 'one-time'
export type PayrollRun = 'weekly' | 'biweekly' | 'monthly'

export type ProposalRates = Record<ProposalRole, number>

export type ProposalInput = { key: string; label: string; help: string }

export type ProposalService = {
  id: string
  group: ProposalGroup
  name: string
  tier: ProposalTier | null
  pricing: ProposalPricingKind
  inputKey: string | null
  factor: number
  role: ProposalRole | null
  multiplier: ProposalMultiplier
  /** Only on 'Annual and one-time' rows; splits that group's total. */
  cadence: ProposalCadence | null
  active: boolean
  sortOrder: number
}

export type ProposalPricing = {
  rates: ProposalRates
  inputs: ProposalInput[]
  services: ProposalService[]
}

export type ProposalSelection = {
  serviceId: string
  quantity?: number
  flatAmount?: number
  override?: number
  payrollRun?: PayrollRun
  includeBonus?: boolean
  includeReview?: boolean
}

export type PricedLine = {
  serviceId: string
  group: ProposalGroup
  name: string
  tier: ProposalTier | null
  cadence: ProposalCadence | null
  amount: number
  computedAmount: number
  formula: string
  flag: 'unknown-input' | null
}

export type ProposalTotals = { monthly: number; annual: number; oneTime: number; cleanup: number }

export declare const PROPOSAL_GROUPS: readonly ProposalGroup[]
export declare const MONTHLY_GROUPS: readonly ProposalGroup[]
export declare const ANNUAL_GROUP: 'Annual and one-time'
export declare const CLEANUP_GROUP: 'Clean-up'
export declare const PROPOSAL_TIERS: readonly ProposalTier[]
export declare const PROPOSAL_ROLES: readonly ProposalRole[]
export declare const PROPOSAL_PRICING_KINDS: readonly ProposalPricingKind[]
export declare const PROPOSAL_MULTIPLIERS: readonly ProposalMultiplier[]
export declare const PROPOSAL_CADENCES: readonly ProposalCadence[]
export declare const PAYROLL_RUNS: readonly PayrollRun[]
export declare const PAYROLL_BONUS_FACTOR: number
export declare const PAYROLL_TAX_FACTOR: number
export declare const SALES_TAX_AMOUNT_KEY: string
export declare const DEFAULT_PROPOSAL_PRICING: Readonly<ProposalPricing>

export declare function defaultProposalPricing(): ProposalPricing
export declare function roundCents(value: number): number
export declare function formatProposalMoney(amount: number): string
export declare function priceProposal(args: {
  catalog: Pick<ProposalPricing, 'inputs' | 'services'> | null | undefined
  rates: Partial<ProposalRates> | null | undefined
  inputs: Record<string, number> | null | undefined
  selections: readonly ProposalSelection[] | null | undefined
}): { lines: PricedLine[]; totals: ProposalTotals }
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run lib/proposal-pricing.test.mjs`
Expected: PASS — 63 tests.

- [ ] **Step 5: Verify and commit**

Run: `npm run verify` — expected green (eslint does not lint `.js`; tsc sees only the `.d.ts`, which nothing in `src/` imports yet).

```bash
git add lib/proposal-pricing.js lib/proposal-pricing.d.ts lib/proposal-pricing.test.mjs
git commit -m "Proposal pricing: one pure calculator prices her sheet row for row, with the payroll and sales-tax blocks, overrides and a readable formula on every line" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The catalog lives in firm settings, sanitized on both backends and owner-only

**Files:**
- Modify: `lib/proposal-pricing.js` — append the sanitizer at the end of the file.
- Modify: `lib/proposal-pricing.d.ts` — append one declaration.
- Modify: `lib/proposal-pricing.test.mjs` — import line (`priceProposal,` in the top import) and a new describe at the end.
- Modify: `db/store.js`
  - import block, after line 20 `import { latestBillRate, latestCostRate, ratePeriodAsOf } from '../lib/rate-history.js'`
  - `function rowToFirmSettings(row)` (~:164-184)
  - `initialize()` — the `alter table firm_settings add column if not exists client_defaults jsonb` statement (~:3469-3473)
  - `async getFirmSettings()` (~:19444-19466)
  - `async updateFirmSettings(patch)` — after the `clientDefaults` merge (~:19495-19502) and the insert statement (~:19506-19546)
  - `async write(data, …)` file branch — the line `      await fsWriteFile(localDataPath, JSON.stringify(data, null, 2))` (~:8096)
- Modify: `server.js`
  - the comment above and the body of `const FIRM_SETTINGS_PATCH_FIELDS = [` (~:381-410)
  - `function scopeAppDataForSession(session, data)` — its `return {` (~:1189-1194)
- Modify: `src/lib/types.ts` — line 1 imports; `export type FirmSettings = {` (`clientDefaults?: ClientDefaults`, ~:1568-1569)
- Modify: `src/__tests__/audit-backlog-hardening.test.ts` — the drift test `accepts exactly the fields the store persists` (~:111-116)
- Modify: `db/store-staleness.test.mjs` — append at the end.

**Interfaces:**
- Consumes: `defaultProposalPricing`, `PROPOSAL_GROUPS`, `PROPOSAL_TIERS`, `PROPOSAL_ROLES`, `PROPOSAL_PRICING_KINDS`, `PROPOSAL_MULTIPLIERS`, `PROPOSAL_CADENCES`, `ANNUAL_GROUP` (Task 1).
- Produces: `sanitizeProposalPricing(raw: unknown): ProposalPricing` (anything that is not an object → the seed); `appDataStore.getFirmSettings()` always returns `proposalPricing`; `appDataStore.updateFirmSettings({ proposalPricing })` saves the whole catalog through the sanitizer (Postgres column `firm_settings.proposal_pricing jsonb`, file `data.firmSettings.proposalPricing`); `PUT /api/firm-settings` accepts `proposalPricing`; the non-owner `/api/app-data` never carries it; the file-backend bulk save keeps the STORED firm settings (Postgres parity).

Why the last two exist: `read()` puts the whole firm settings row on `/api/app-data`, which staff receive through `scopeAppDataForSession`'s `...data` spread, so the catalog would reach staff without the strip. And the file backend's `write()` persisted whatever `firmSettings` the bulk payload carried (or none), so an autosave could roll the catalog back; Postgres never touches `firm_settings` from the bulk save. The sanitizer lives in `lib/` (not beside `sanitizeClientDefaults` in the store) so the Settings UI test can run the exact function both backends use.

- [ ] **Step 1: Write the failing tests**

In `lib/proposal-pricing.test.mjs`, change the top import from
```js
  formatProposalMoney,
  priceProposal,
} from './proposal-pricing.js'
```
to
```js
  formatProposalMoney,
  priceProposal,
  sanitizeProposalPricing,
} from './proposal-pricing.js'
```
and append at the end of the file:

```js

describe('sanitizeProposalPricing', () => {
  it('is the seed for anything that is not an object', () => {
    expect(sanitizeProposalPricing(null)).toEqual(defaultProposalPricing())
    expect(sanitizeProposalPricing('junk')).toEqual(defaultProposalPricing())
  })

  it('passes the seed through unchanged', () => {
    expect(sanitizeProposalPricing(defaultProposalPricing())).toEqual(defaultProposalPricing())
  })

  it('clamps rates and factors, checks enums, caps strings, drops unknown keys', () => {
    const seed = defaultProposalPricing()
    const clean = sanitizeProposalPricing({
      rates: { bookkeeper: -5, accountant: 5e9, controller: '80', extra: 1 },
      inputs: seed.inputs,
      services: [
        { ...seed.services[0], factor: 500, junk: 1 },
        { ...seed.services[3], role: 'boss', multiplier: 'x9', tier: 'Gold', name: 'x'.repeat(300) },
      ],
      extra: true,
    })
    expect(clean.rates).toEqual({ bookkeeper: 0, accountant: 1e6, controller: 80 })
    expect(Object.keys(clean)).toEqual(['rates', 'inputs', 'services'])
    expect(clean.services[0].factor).toBe(100)
    expect(clean.services[0]).not.toHaveProperty('junk')
    expect(clean.services[1]).toMatchObject({ role: null, multiplier: 'none', tier: null })
    expect(clean.services[1].name).toHaveLength(120)
  })

  it('keeps the first of two rows with one id, and drops rows it cannot place', () => {
    const seed = defaultProposalPricing()
    const clean = sanitizeProposalPricing({
      ...seed,
      services: [
        seed.services[0],
        { ...seed.services[0], name: 'Duplicate' },
        { ...seed.services[1], group: 'Nope' },
        { ...seed.services[2], id: 'Bad Id' },
      ],
    })
    expect(clean.services.map((row) => row.id)).toEqual(['monthly-weekly-transactions-basic'])
  })

  it('retires a row whose input is not in the catalog instead of failing the save', () => {
    const seed = defaultProposalPricing()
    const clean = sanitizeProposalPricing({
      ...seed,
      services: [{ ...seed.services[0], inputKey: 'widgets' }],
    })
    expect(clean.services[0].active).toBe(false)
  })
})
```

In `src/__tests__/audit-backlog-hardening.test.ts`, replace

```ts
    // Plus `clientDefaults`, which the store merges separately rather than listing
    // beside the flat columns.
    expect(handlerList?.slice().sort()).toEqual([...(storeList ?? []), 'clientDefaults'].sort())
  })
})
```
with
```ts
    // Plus `clientDefaults` and `proposalPricing`, which the store merges
    // separately rather than listing beside the flat columns.
    expect(handlerList?.slice().sort()).toEqual(
      [...(storeList ?? []), 'clientDefaults', 'proposalPricing'].sort(),
    )
  })

  // The proposal rates and catalog are the firm's pricing. The public route is
  // read before sign-in, so it must never grow a field that carries them.
  it('never exposes the proposal catalog on the public settings route', () => {
    const publicBlock = routeBlock(
      /if \(normalizedPath === '\/api\/firm-settings\/public' && request\.method === 'GET'\)/,
      900,
    )
    expect(publicBlock).not.toContain('proposalPricing')
    expect(publicBlock).not.toContain('...settings')
  })

  // `read()` carries the whole firm settings row inside /api/app-data, so the
  // staff-scoped copy has to drop the catalog explicitly.
  it('strips the proposal catalog from the workspace a non-owner receives', () => {
    const scope = functionSource('function scopeAppDataForSession(', 6000)
    expect(scope).toContain(
      'const { proposalPricing: _proposalPricing, ...firmSettings } = data.firmSettings ?? {}',
    )
    expect(scope).toContain('...(data.firmSettings ? { firmSettings } : {}),')
  })
})
```

Append at the end of `db/store-staleness.test.mjs`:

```js

/**
 * The proposal pricing catalog in firm settings (featreq-311473e2, spec §4.1).
 * A missing catalog reads as the seed; a saved one always goes through
 * `sanitizeProposalPricing`, on both backends.
 */
describe('proposal pricing in firm settings (file backend)', () => {
  beforeEach(async () => {
    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    delete data.firmSettings
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
  })

  it('reads the seed catalog, with zero rates, before anything is saved', async () => {
    const settings = await store.getFirmSettings()
    expect(settings.proposalPricing.rates).toEqual({ bookkeeper: 0, accountant: 0, controller: 0 })
    expect(settings.proposalPricing.services).toHaveLength(41)
  })

  it('saves the catalog through the sanitizer and reads it back', async () => {
    const seed = (await store.getFirmSettings()).proposalPricing
    const edited = {
      ...seed,
      rates: { bookkeeper: 75, accountant: -4, controller: 5e9 },
      services: [
        { ...seed.services[0], factor: 0.08 },
        { ...seed.services[0], name: 'Duplicate id' },
        { ...seed.services[1], inputKey: 'widgets' },
      ],
    }
    await store.updateFirmSettings({ proposalPricing: edited })

    const reopened = new AppDataStore()
    await reopened.initialize()
    const pricing = (await reopened.getFirmSettings()).proposalPricing
    expect(pricing.rates).toEqual({ bookkeeper: 75, accountant: 0, controller: 1e6 })
    expect(pricing.services.map((row) => row.id)).toEqual([
      'monthly-weekly-transactions-basic',
      'monthly-weekly-transactions-classes',
    ])
    expect(pricing.services[0].factor).toBe(0.08)
    // An unknown input retires the row instead of failing the save.
    expect(pricing.services[1].active).toBe(false)
  })

  it('leaves the catalog alone when a settings save does not mention it', async () => {
    const seed = (await store.getFirmSettings()).proposalPricing
    await store.updateFirmSettings({ proposalPricing: { ...seed, rates: { bookkeeper: 80, accountant: 110, controller: 130 } } })
    await store.updateFirmSettings({ name: 'PB&J' })
    expect((await store.getFirmSettings()).proposalPricing.rates.bookkeeper).toBe(80)
  })
})

describe('proposal pricing in firm settings (postgres branch)', () => {
  function firmSettingsPool(row) {
    const statements = []
    return {
      statements,
      pool: {
        async query(text, params) {
          statements.push({ text: String(text).trim(), params })
          if (/from firm_settings where id = 'singleton'/i.test(text)) return { rows: row ? [row] : [] }
          return { rows: [], rowCount: 1 }
        },
      },
    }
  }

  it('selects the column and reads a NULL column as the seed', async () => {
    const fake = firmSettingsPool({ name: 'PB&J', proposal_pricing: null })
    const settings = await postgresStore(fake).getFirmSettings()
    expect(fake.statements[0].text).toMatch(/client_defaults, proposal_pricing/)
    expect(settings.proposalPricing.services).toHaveLength(41)
  })

  it('writes the sanitized catalog as $17 jsonb', async () => {
    const fake = firmSettingsPool({ name: 'PB&J', proposal_pricing: null })
    const seed = (await postgresStore(fake).getFirmSettings()).proposalPricing
    await postgresStore(fake).updateFirmSettings({
      proposalPricing: { ...seed, rates: { bookkeeper: 75, accountant: 115, controller: -1 } },
    })
    const insert = fake.statements.find((s) => /^insert into firm_settings/i.test(s.text))
    expect(insert.text).toMatch(/\$17::jsonb/)
    expect(insert.text).toMatch(/proposal_pricing = excluded\.proposal_pricing/)
    expect(JSON.parse(insert.params[16]).rates).toEqual({
      bookkeeper: 75,
      accountant: 115,
      controller: 0,
    })
  })
})

describe('firm settings survive a bulk save (file backend)', () => {
  // Postgres never touches `firm_settings` from the bulk save; the file
  // backend used to take whatever the payload carried — or drop the settings
  // entirely when the payload had none. Cardinal rule 1: same answer on both.
  it('keeps the stored catalog when an autosave carries none, or a stale one', async () => {
    const seed = (await store.getFirmSettings()).proposalPricing
    await store.updateFirmSettings({
      proposalPricing: { ...seed, rates: { bookkeeper: 75, accountant: 115, controller: 125 } },
    })
    await store.write(workspace())
    expect((await store.getFirmSettings()).proposalPricing.rates.bookkeeper).toBe(75)

    await store.write({ ...workspace(), firmSettings: { name: 'Stale tab', proposalPricing: seed } })
    const after = await store.getFirmSettings()
    expect(after.proposalPricing.rates.bookkeeper).toBe(75)
    expect(after.name).not.toBe('Stale tab')
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run lib/proposal-pricing.test.mjs src/__tests__/audit-backlog-hardening.test.ts db/store-staleness.test.mjs -t "sanitizeProposalPricing|proposal pricing|firm settings survive|accepts exactly|public settings|strips the proposal"`
Expected: FAIL — `sanitizeProposalPricing` is not exported, `proposalPricing` is undefined on the settings, the handler list lacks `proposalPricing`, and `scopeAppDataForSession` has no strip.

- [ ] **Step 3: Implement**

Append to the end of `lib/proposal-pricing.js`:

```js

const INPUT_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,40}$/
const SERVICE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

function clampNumber(value, min, max, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

function cleanText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

/**
 * Validate an owner-edited catalog (spec §4.1). Mirrors `sanitizeClientDefaults`
 * in db/store.js: only well-typed values survive and nothing throws. Rates clamp
 * to [0, 1e6], factors to [0, 100], enums are checked, strings are capped,
 * unknown keys are dropped, service ids are unique (the first wins), and a row
 * whose input is not in the catalog is saved INACTIVE rather than refusing the
 * whole save.
 *
 * Anything that is not an object (a first read, a null column) is the seed.
 */
export function sanitizeProposalPricing(raw) {
  const seed = defaultProposalPricing()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return seed

  const rates = {}
  for (const role of PROPOSAL_ROLES) {
    rates[role] = clampNumber(raw.rates?.[role], 0, 1e6, seed.rates[role])
  }

  const seenKeys = new Set()
  const cleanedInputs = (Array.isArray(raw.inputs) ? raw.inputs : [])
    .filter((input) => input && typeof input === 'object')
    .map((input) => ({
      key: typeof input.key === 'string' ? input.key.trim() : '',
      label: cleanText(input.label, 80),
      help: cleanText(input.help, 200),
    }))
    .filter((input) => {
      if (!INPUT_KEY_PATTERN.test(input.key) || seenKeys.has(input.key)) return false
      seenKeys.add(input.key)
      return true
    })
    .map((input) => ({ ...input, label: input.label || input.key }))
    .slice(0, 60)
  const inputs = cleanedInputs.length > 0 ? cleanedInputs : seed.inputs
  const inputKeys = new Set(inputs.map((input) => input.key))

  const seenIds = new Set()
  const cleanedServices = (Array.isArray(raw.services) ? raw.services : [])
    .filter((service) => service && typeof service === 'object')
    .map((service, index) => {
      const id = typeof service.id === 'string' ? service.id.trim() : ''
      const group = PROPOSAL_GROUPS.includes(service.group) ? service.group : null
      const name = cleanText(service.name, 120)
      if (!SERVICE_ID_PATTERN.test(id) || seenIds.has(id) || !group || !name) return null
      seenIds.add(id)
      const pricing = PROPOSAL_PRICING_KINDS.includes(service.pricing) ? service.pricing : 'formula'
      const inputKey =
        typeof service.inputKey === 'string' && service.inputKey.trim()
          ? service.inputKey.trim()
          : null
      // Every kind but a plain flat amount reads a count; a row that names no
      // input, or one the catalog does not have, cannot price and is retired.
      const inputOk = inputKey ? inputKeys.has(inputKey) : pricing === 'flat'
      return {
        id,
        group,
        name,
        tier: PROPOSAL_TIERS.includes(service.tier) ? service.tier : null,
        pricing,
        inputKey,
        factor: clampNumber(service.factor, 0, 100, 0),
        role: PROPOSAL_ROLES.includes(service.role) ? service.role : null,
        multiplier: PROPOSAL_MULTIPLIERS.includes(service.multiplier) ? service.multiplier : 'none',
        cadence:
          group === ANNUAL_GROUP
            ? PROPOSAL_CADENCES.includes(service.cadence)
              ? service.cadence
              : 'annual'
            : null,
        active: service.active !== false && inputOk,
        sortOrder: clampNumber(service.sortOrder, 0, 1e6, index + 1),
      }
    })
    .filter(Boolean)
    .slice(0, 300)
  const services = Array.isArray(raw.services) ? cleanedServices : seed.services

  return { rates, inputs, services }
}
```

Append to the end of `lib/proposal-pricing.d.ts`:

```ts

/** Owner-edited catalog in, a safe catalog out; anything not an object is the seed. */
export declare function sanitizeProposalPricing(raw: unknown): ProposalPricing
```

In `db/store.js`:

1. After line 20 (`import { latestBillRate, latestCostRate, ratePeriodAsOf } from '../lib/rate-history.js'`) add:
```js
import { sanitizeProposalPricing } from '../lib/proposal-pricing.js'
```

2. In `rowToFirmSettings`, replace
```js
function rowToFirmSettings(row) {
  if (!row) return { ...DEFAULT_FIRM_SETTINGS }
  const settings = { ...DEFAULT_FIRM_SETTINGS }
```
with
```js
function rowToFirmSettings(row) {
  if (!row) return { ...DEFAULT_FIRM_SETTINGS, proposalPricing: sanitizeProposalPricing(null) }
  const settings = { ...DEFAULT_FIRM_SETTINGS }
```
and replace its tail
```js
    settings.clientDefaults = {
      ...DEFAULT_FIRM_SETTINGS.clientDefaults,
      ...sanitizeClientDefaults(raw),
    }
  }
  return settings
}
```
with
```js
    settings.clientDefaults = {
      ...DEFAULT_FIRM_SETTINGS.clientDefaults,
      ...sanitizeClientDefaults(raw),
    }
  }
  // The proposal catalog (featreq-311473e2). A null column is the SEED — her
  // sheet with zero rates — so the Settings page always has a catalog to edit
  // and nothing has to be written to production to get one.
  const rawPricing =
    typeof row.proposal_pricing === 'string'
      ? safeJsonParse(row.proposal_pricing)
      : row.proposal_pricing
  settings.proposalPricing = sanitizeProposalPricing(rawPricing)
  return settings
}
```

3. In `initialize()`, replace
```js
      await this.pool.query(
        `alter table firm_settings add column if not exists client_defaults jsonb`,
      )
```
with
```js
      await this.pool.query(
        `alter table firm_settings add column if not exists client_defaults jsonb`,
      )
      // The proposal pricing catalog (featreq-311473e2): rates, the counts she
      // collects, and the service rows. NULL reads as the seed catalog, so the
      // column needs no backfill. Additive + idempotent.
      await this.pool.query(
        `alter table firm_settings add column if not exists proposal_pricing jsonb`,
      )
```

4. In `getFirmSettings()`, replace
```js
                city, state, postal_code, phone, email, website, ein,
                client_defaults
           from firm_settings where id = 'singleton'`,
```
with
```js
                city, state, postal_code, phone, email, website, ein,
                client_defaults, proposal_pricing
           from firm_settings where id = 'singleton'`,
```
and in its file branch replace
```js
      clientDefaults: {
        ...DEFAULT_FIRM_SETTINGS.clientDefaults,
        ...sanitizeClientDefaults(stored.clientDefaults),
      },
    }
  }
```
with
```js
      clientDefaults: {
        ...DEFAULT_FIRM_SETTINGS.clientDefaults,
        ...sanitizeClientDefaults(stored.clientDefaults),
      },
      proposalPricing: sanitizeProposalPricing(stored.proposalPricing),
    }
  }
```

5. In `updateFirmSettings(patch)`, replace
```js
        ...sanitizeClientDefaults(patch.clientDefaults),
      }
    }

    if (this.pool) {
```
with
```js
        ...sanitizeClientDefaults(patch.clientDefaults),
      }
    }

    // The proposal catalog is saved WHOLE — the Settings table sends the full
    // catalog back — and always through the sanitizer, so a crafted payload
    // can only ever store a catalog the calculator can price.
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'proposalPricing')) {
      next.proposalPricing = sanitizeProposalPricing(patch.proposalPricing)
    }

    if (this.pool) {
```
then in the same method's insert replace
```js
            phone, email, website, ein, client_defaults, updated_at)
         values ('singleton', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, now())
```
with
```js
            phone, email, website, ein, client_defaults, proposal_pricing, updated_at)
         values ('singleton', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17::jsonb, now())
```
replace
```js
            client_defaults = excluded.client_defaults,
            updated_at = now()`,
```
with
```js
            client_defaults = excluded.client_defaults,
            proposal_pricing = excluded.proposal_pricing,
            updated_at = now()`,
```
and replace
```js
          JSON.stringify(next.clientDefaults ?? DEFAULT_FIRM_SETTINGS.clientDefaults),
        ],
```
with
```js
          JSON.stringify(next.clientDefaults ?? DEFAULT_FIRM_SETTINGS.clientDefaults),
          JSON.stringify(sanitizeProposalPricing(next.proposalPricing)),
        ],
```

6. In `write()`'s file branch, replace (the only occurrence, ~:8096)
```js
      await fsWriteFile(localDataPath, JSON.stringify(data, null, 2))
```
with
```js
      // Firm settings are endpoint-managed (`PUT /api/firm-settings`), exactly
      // as on Postgres, where the bulk save never touches `firm_settings`. What
      // is stored wins over the payload's copy, so an autosave — or a stale
      // tab's — can never roll back the proposal catalog or any firm setting.
      if (previous?.firmSettings && typeof previous.firmSettings === 'object') {
        data.firmSettings = previous.firmSettings
      }

      await fsWriteFile(localDataPath, JSON.stringify(data, null, 2))
```

In `server.js`:

1. Replace
```js
// The fields `PUT /api/firm-settings` accepts (audit L2). The store whitelists
// too — `FIRM_SETTINGS_FIELDS` + `clientDefaults` in db/store.js — but the
```
with
```js
// The fields `PUT /api/firm-settings` accepts (audit L2). The store whitelists
// too — `FIRM_SETTINGS_FIELDS` + `clientDefaults` + `proposalPricing` in
// db/store.js — but the
```
and replace
```js
  'ein',
  'clientDefaults',
]
```
with
```js
  'ein',
  'clientDefaults',
  // The proposal pricing catalog (featreq-311473e2). Owner-only like the rest
  // of this route; `/api/firm-settings/public` never carries it.
  'proposalPricing',
]
```

2. In `scopeAppDataForSession`, replace
```js
  const recurringReimbursements = (data.recurringReimbursements ?? []).filter((recurring) =>
    allowedClientIds.has(recurring.clientId),
  )

  return {
    ...data,
    clients,
```
with
```js
  const recurringReimbursements = (data.recurringReimbursements ?? []).filter((recurring) =>
    allowedClientIds.has(recurring.clientId),
  )
  // The proposal pricing catalog is the firm's pricing, owner-only
  // (featreq-311473e2, spec §6). `read()` carries the whole firm settings row,
  // so it is stripped here rather than trusting every page not to show it.
  const { proposalPricing: _proposalPricing, ...firmSettings } = data.firmSettings ?? {}

  return {
    ...data,
    ...(data.firmSettings ? { firmSettings } : {}),
    clients,
```

In `src/lib/types.ts`, replace line 1
```ts
import type { RateHistoryEntry } from '../../lib/rate-history.js'
```
with
```ts
import type { RateHistoryEntry } from '../../lib/rate-history.js'
import type { ProposalPricing } from '../../lib/proposal-pricing.js'

/**
 * The proposal catalog and calculator shapes, re-exported from the calculator
 * that defines them (lib/proposal-pricing.js) — the same one-door rule as the
 * rate-history types below.
 */
export type {
  PayrollRun,
  PricedLine,
  ProposalCadence,
  ProposalGroup,
  ProposalInput,
  ProposalMultiplier,
  ProposalPricing,
  ProposalPricingKind,
  ProposalRates,
  ProposalRole,
  ProposalSelection,
  ProposalService,
  ProposalTier,
  ProposalTotals,
} from '../../lib/proposal-pricing.js'
```
and in `export type FirmSettings = {` replace
```ts
  /** Defaults pre-filled on the Add-client form. */
  clientDefaults?: ClientDefaults
```
with
```ts
  /** Defaults pre-filled on the Add-client form. */
  clientDefaults?: ClientDefaults
  /**
   * The proposal pricing catalog (owner-only; never on the public settings).
   * The server always answers with one — the seed when nothing is saved.
   */
  proposalPricing?: ProposalPricing
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run lib/proposal-pricing.test.mjs src/__tests__/audit-backlog-hardening.test.ts db/store-staleness.test.mjs`
Expected: PASS — every existing test in those files plus the 5 sanitizer, 3 audit and 6 store tests above.

- [ ] **Step 5: Verify and commit**

Run: `npm run verify` — expected green.

```bash
git add lib/proposal-pricing.js lib/proposal-pricing.d.ts lib/proposal-pricing.test.mjs db/store.js db/store-staleness.test.mjs server.js src/lib/types.ts src/__tests__/audit-backlog-hardening.test.ts
git commit -m "Firm settings carry the proposal pricing catalog: seeded from her sheet, sanitized on both backends, owner-only, and never rolled back by a bulk save" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Settings gets a "Proposal pricing" section

**Files:**
- Create: `src/lib/proposals.ts`
- Create: `src/__tests__/settings-proposal-pricing.test.tsx`
- Modify: `src/pages/SettingsPage.tsx`
  - imports from `'../lib/types'` (~:21-28)
  - `<ClientDefaultsSection settings={settings} onCommit={commit} />` in `SettingsPage` (~:116)
  - a new exported component inserted directly above `function BusinessSection({` (~:729)
- Modify: `src/App.css` — append at the end.

**Interfaces:**
- Consumes: `defaultProposalPricing`, `PROPOSAL_GROUPS`, `PROPOSAL_TIERS`, `PROPOSAL_ROLES`, `PROPOSAL_MULTIPLIERS`, `PROPOSAL_PRICING_KINDS`, `ANNUAL_GROUP` (Task 1); `sanitizeProposalPricing` (Task 2, in the test); `FirmSettings.proposalPricing` (Task 2); `SavingNumberInput`, `SavingTextInput`, `CollapsibleSection` from `src/components/SectionKit.tsx`; the page's existing `commit(patch: Partial<FirmSettings>)` → `updateFirmSettingsRequest` → `PUT /api/firm-settings`.
- Produces: `export function ProposalPricingSection({ settings, onCommit }: { settings: FirmSettings; onCommit: (patch: Partial<FirmSettings>) => void | Promise<void> })`; `PROPOSAL_ROLE_LABELS`, `PROPOSAL_MULTIPLIER_LABELS`, `PROPOSAL_PRICING_LABELS` in `src/lib/proposals.ts`.

- [ ] **Step 1: Write the failing test** — create `src/__tests__/settings-proposal-pricing.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { defaultProposalPricing, sanitizeProposalPricing } from '../../lib/proposal-pricing.js'
import { ProposalPricingSection } from '../pages/SettingsPage'
import { DEFAULT_FIRM_SETTINGS, type FirmSettings, type ProposalPricing } from '../lib/types'

/**
 * The Settings page's "Proposal pricing" section (featreq-311473e2, spec §4.1).
 * Every edit hands the WHOLE catalog to the save, and what it hands over has to
 * survive `sanitizeProposalPricing` — the function both store backends run.
 */

function renderSection(pricing: ProposalPricing = defaultProposalPricing()) {
  const onCommit = vi.fn()
  const settings: FirmSettings = { ...DEFAULT_FIRM_SETTINGS, proposalPricing: pricing }
  render(<ProposalPricingSection settings={settings} onCommit={onCommit} />)
  return onCommit
}

/** The catalog the last save sent, after the server's sanitizer. */
function lastSaved(onCommit: ReturnType<typeof vi.fn>): ProposalPricing {
  const patch = onCommit.mock.calls.at(-1)?.[0] as Partial<FirmSettings>
  return sanitizeProposalPricing(patch.proposalPricing)
}

describe('Proposal pricing in Settings', () => {
  it('says the rates are for proposals, not the team’s bill rates', () => {
    renderSection()
    expect(screen.getByText(/they are not your team’s bill rates/)).toBeTruthy()
  })

  it('saves a role rate', () => {
    const onCommit = renderSection()
    const input = screen.getByLabelText('Bookkeeper (B) rate')
    fireEvent.change(input, { target: { value: '75' } })
    fireEvent.blur(input)
    expect(lastSaved(onCommit).rates.bookkeeper).toBe(75)
  })

  it('edits a factor, and the edit round-trips through the sanitizer', () => {
    const onCommit = renderSection()
    const input = screen.getByLabelText('Factor for Weekly transactions Basic')
    fireEvent.change(input, { target: { value: '0.08' } })
    fireEvent.blur(input)
    const saved = lastSaved(onCommit)
    expect(saved.services.find((row) => row.id === 'monthly-weekly-transactions-basic')?.factor).toBe(0.08)
    expect(saved.services).toHaveLength(41)
  })

  it('retires a row without deleting it', () => {
    const onCommit = renderSection()
    fireEvent.click(screen.getByRole('button', { name: 'Retire Budget vs actual' }))
    const saved = lastSaved(onCommit)
    const row = saved.services.find((service) => service.id === 'budget-vs-actual')
    expect(row?.active).toBe(false)
  })

  it('restores a retired row', () => {
    const pricing = defaultProposalPricing()
    pricing.services.find((row) => row.id === 'kpi-reports')!.active = false
    const onCommit = renderSection(pricing)
    fireEvent.click(screen.getByRole('button', { name: 'Restore KPI reports' }))
    expect(lastSaved(onCommit).services.find((row) => row.id === 'kpi-reports')?.active).toBe(true)
  })

  it('adds a row to a group that the sanitizer keeps', () => {
    const onCommit = renderSection()
    fireEvent.click(screen.getByRole('button', { name: 'Add row to Payroll' }))
    const saved = lastSaved(onCommit)
    expect(saved.services).toHaveLength(42)
    const added = saved.services.at(-1)!
    expect(added).toMatchObject({ group: 'Payroll', name: 'New service', active: true })
    expect(added.id).toMatch(/^custom-/)
  })

  it('offers the Annual / One-time split only on the Annual and one-time rows', () => {
    const onCommit = renderSection()
    fireEvent.change(screen.getByLabelText('Billed for Business return'), {
      target: { value: 'one-time' },
    })
    expect(lastSaved(onCommit).services.find((row) => row.id === 'business-return')?.cadence).toBe(
      'one-time',
    )
    expect(screen.queryByLabelText('Billed for Reconciliations')).toBeNull()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/__tests__/settings-proposal-pricing.test.tsx`
Expected: FAIL — `ProposalPricingSection` is not exported from `../pages/SettingsPage`.

- [ ] **Step 3: Implement**

Create `src/lib/proposals.ts`:

```ts
import type {
  ProposalMultiplier,
  ProposalPricingKind,
  ProposalRole,
} from './types'

/**
 * Words for the proposal catalog's enums (featreq-311473e2). One place, so the
 * Settings table and the proposal editor can never name the same thing twice
 * two different ways.
 */
export const PROPOSAL_ROLE_LABELS: Record<ProposalRole, string> = {
  bookkeeper: 'Bookkeeper (B)',
  accountant: 'Accountant (A)',
  controller: 'Controller (C)',
}

export const PROPOSAL_MULTIPLIER_LABELS: Record<ProposalMultiplier, string> = {
  none: 'None',
  'weekly-x4': 'Weekly (x 4)',
  'quarterly-div3': 'Quarterly (/ 3)',
  'yearly-div12': 'Yearly (/ 12)',
  'per-cleanup-month': 'Per clean-up month',
  'per-report': 'Per report',
  'per-form': 'Per form',
}

export const PROPOSAL_PRICING_LABELS: Record<ProposalPricingKind, string> = {
  formula: 'Formula',
  flat: 'Flat amount',
  payroll: 'Payroll block',
  'sales-tax': 'Sales tax block',
}
```

In `src/pages/SettingsPage.tsx`, replace the types import
```tsx
import {
  ApiError,
  DEFAULT_FIRM_SETTINGS,
  type BillingMode,
  type FirmSettings,
  type TotpStatus,
} from '../lib/types'
import { isSafeImageSrc } from '../lib/utils'
```
with
```tsx
import {
  ApiError,
  DEFAULT_FIRM_SETTINGS,
  type BillingMode,
  type FirmSettings,
  type ProposalGroup,
  type ProposalMultiplier,
  type ProposalPricing,
  type ProposalPricingKind,
  type ProposalRole,
  type ProposalService,
  type ProposalTier,
  type TotpStatus,
} from '../lib/types'
import { isSafeImageSrc } from '../lib/utils'
import {
  ANNUAL_GROUP,
  PROPOSAL_GROUPS,
  PROPOSAL_MULTIPLIERS,
  PROPOSAL_PRICING_KINDS,
  PROPOSAL_ROLES,
  PROPOSAL_TIERS,
  defaultProposalPricing,
} from '../../lib/proposal-pricing.js'
import {
  PROPOSAL_MULTIPLIER_LABELS,
  PROPOSAL_PRICING_LABELS,
  PROPOSAL_ROLE_LABELS,
} from '../lib/proposals'
```
replace
```tsx
      <ClientDefaultsSection settings={settings} onCommit={commit} />
      <AuthenticationSection />
```
with
```tsx
      <ClientDefaultsSection settings={settings} onCommit={commit} />
      <ProposalPricingSection settings={settings} onCommit={commit} />
      <AuthenticationSection />
```
and insert directly above `function BusinessSection({`:

```tsx
/**
 * The proposal pricing catalog (featreq-311473e2, spec §4.1): the three role
 * rates, the labels of the counts she collects, and one row per service. Every
 * edit saves the WHOLE catalog through `PUT /api/firm-settings`, where
 * `sanitizeProposalPricing` has the last word — a row whose input is gone comes
 * back retired rather than refusing the save.
 */
export function ProposalPricingSection({
  settings,
  onCommit,
}: {
  settings: FirmSettings
  onCommit: (patch: Partial<FirmSettings>) => void | Promise<void>
}) {
  const pricing = settings.proposalPricing ?? defaultProposalPricing()
  const save = (next: ProposalPricing) => {
    void onCommit({ proposalPricing: next })
  }
  const setRate = (role: ProposalRole, value: number | null) =>
    save({ ...pricing, rates: { ...pricing.rates, [role]: value ?? 0 } })
  const setInputLabel = (key: string, label: string) =>
    save({
      ...pricing,
      inputs: pricing.inputs.map((input) => (input.key === key ? { ...input, label } : input)),
    })
  const setService = (id: string, patch: Partial<ProposalService>) =>
    save({
      ...pricing,
      services: pricing.services.map((service) =>
        service.id === id ? { ...service, ...patch } : service,
      ),
    })
  const addRow = (group: ProposalGroup) => {
    const sortOrder = Math.max(0, ...pricing.services.map((service) => service.sortOrder)) + 1
    save({
      ...pricing,
      services: [
        ...pricing.services,
        {
          id: `custom-${Date.now().toString(36)}`,
          group,
          name: 'New service',
          tier: null,
          pricing: 'formula',
          inputKey: pricing.inputs[0]?.key ?? null,
          factor: 0,
          role: 'bookkeeper',
          multiplier: 'none',
          cadence: group === ANNUAL_GROUP ? 'annual' : null,
          active: true,
          sortOrder,
        },
      ],
    })
  }
  const rowLabel = (service: ProposalService) =>
    service.tier ? `${service.name} ${service.tier}` : service.name

  return (
    <CollapsibleSection kicker="Proposals" title="Proposal pricing" lockable>
      <p className="muted-text" style={{ marginTop: 0 }}>
        Every proposal line is a count from their books × a factor × one of these rates × a
        multiplier. These rates are for proposals only — they are not your team’s bill rates.
        Changing the catalog never reprices a proposal you already wrote; open it and choose
        “Reprice at today’s catalog”.
      </p>
      <div className="form-grid two-col">
        {PROPOSAL_ROLES.map((role) => (
          <label className="field" key={role}>
            <span>{PROPOSAL_ROLE_LABELS[role]} rate ($/hr)</span>
            <SavingNumberInput
              ariaLabel={`${PROPOSAL_ROLE_LABELS[role]} rate`}
              canonical={pricing.rates[role]}
              min="0"
              step="0.01"
              onCommit={(value) => setRate(role, value)}
            />
          </label>
        ))}
      </div>

      <h3>What you collect</h3>
      <div className="form-grid two-col">
        {pricing.inputs.map((input) => (
          <label className="field" key={input.key}>
            <span>{input.help || input.key}</span>
            <SavingTextInput
              ariaLabel={`Label for ${input.key}`}
              canonical={input.label}
              onCommit={(value) => setInputLabel(input.key, value)}
            />
          </label>
        ))}
      </div>

      {PROPOSAL_GROUPS.map((group) => {
        const rows = pricing.services
          .filter((service) => service.group === group)
          .sort((a, b) => a.sortOrder - b.sortOrder)
        return (
          <div className="proposal-catalog-group" key={group}>
            <h3>{group}</h3>
            <div className="table-wrap">
              <table className="report-table proposal-catalog-table">
                <thead>
                  <tr>
                    <th>Service</th>
                    <th>Tier</th>
                    <th>Input</th>
                    <th>Factor</th>
                    <th>Role</th>
                    <th>Multiplier</th>
                    <th>Pricing</th>
                    {group === ANNUAL_GROUP ? <th>Billed</th> : null}
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((service) => {
                    const label = rowLabel(service)
                    return (
                      <tr key={service.id} className={service.active ? '' : 'is-retired'}>
                        <td>
                          <SavingTextInput
                            ariaLabel={`Name for ${label}`}
                            canonical={service.name}
                            onCommit={(value) => setService(service.id, { name: value })}
                          />
                        </td>
                        <td>
                          <select
                            className="input"
                            aria-label={`Tier for ${label}`}
                            value={service.tier ?? ''}
                            onChange={(event) =>
                              setService(service.id, {
                                tier: (event.target.value || null) as ProposalTier | null,
                              })
                            }
                          >
                            <option value="">None</option>
                            {PROPOSAL_TIERS.map((tier) => (
                              <option key={tier} value={tier}>
                                {tier}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <select
                            className="input"
                            aria-label={`Input for ${label}`}
                            value={service.inputKey ?? ''}
                            onChange={(event) =>
                              setService(service.id, { inputKey: event.target.value || null })
                            }
                          >
                            <option value="">None</option>
                            {pricing.inputs.map((input) => (
                              <option key={input.key} value={input.key}>
                                {input.label}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <SavingNumberInput
                            ariaLabel={`Factor for ${label}`}
                            canonical={service.factor}
                            min="0"
                            step="0.01"
                            onCommit={(value) => setService(service.id, { factor: value ?? 0 })}
                          />
                        </td>
                        <td>
                          <select
                            className="input"
                            aria-label={`Role for ${label}`}
                            value={service.role ?? ''}
                            onChange={(event) =>
                              setService(service.id, {
                                role: (event.target.value || null) as ProposalRole | null,
                              })
                            }
                          >
                            <option value="">None</option>
                            {PROPOSAL_ROLES.map((role) => (
                              <option key={role} value={role}>
                                {PROPOSAL_ROLE_LABELS[role]}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <select
                            className="input"
                            aria-label={`Multiplier for ${label}`}
                            value={service.multiplier}
                            onChange={(event) =>
                              setService(service.id, {
                                multiplier: event.target.value as ProposalMultiplier,
                              })
                            }
                          >
                            {PROPOSAL_MULTIPLIERS.map((multiplier) => (
                              <option key={multiplier} value={multiplier}>
                                {PROPOSAL_MULTIPLIER_LABELS[multiplier]}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <select
                            className="input"
                            aria-label={`Pricing for ${label}`}
                            value={service.pricing}
                            onChange={(event) =>
                              setService(service.id, {
                                pricing: event.target.value as ProposalPricingKind,
                              })
                            }
                          >
                            {PROPOSAL_PRICING_KINDS.map((kind) => (
                              <option key={kind} value={kind}>
                                {PROPOSAL_PRICING_LABELS[kind]}
                              </option>
                            ))}
                          </select>
                        </td>
                        {group === ANNUAL_GROUP ? (
                          <td>
                            <select
                              className="input"
                              aria-label={`Billed for ${label}`}
                              value={service.cadence ?? 'annual'}
                              onChange={(event) =>
                                setService(service.id, {
                                  cadence: event.target.value === 'one-time' ? 'one-time' : 'annual',
                                })
                              }
                            >
                              <option value="annual">Annual</option>
                              <option value="one-time">One-time</option>
                            </select>
                          </td>
                        ) : null}
                        <td>
                          <button
                            type="button"
                            className="ghost-action"
                            aria-label={`${service.active ? 'Retire' : 'Restore'} ${label}`}
                            onClick={() => setService(service.id, { active: !service.active })}
                          >
                            {service.active ? 'Retire' : 'Restore'}
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <button type="button" className="secondary-action" onClick={() => addRow(group)}>
              Add row to {group}
            </button>
          </div>
        )
      })}
    </CollapsibleSection>
  )
}

```

Append to the end of `src/App.css`:

```css

/* Proposal pricing catalog in Settings (featreq-311473e2). */
.proposal-catalog-group {
  margin-top: 18px;
}

.proposal-catalog-table .input {
  min-width: 90px;
}

.proposal-catalog-table tr.is-retired td {
  opacity: 0.55;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run src/__tests__/settings-proposal-pricing.test.tsx`
Expected: PASS — 7 tests.

- [ ] **Step 5: Verify and commit**

Run: `npm run verify` — expected green (the new section is a component export, which `react-refresh/only-export-components` allows).

```bash
git add src/lib/proposals.ts src/pages/SettingsPage.tsx src/App.css src/__tests__/settings-proposal-pricing.test.tsx
git commit -m "Settings shows Proposal pricing: the three proposal rates, the counts she collects and the service catalog, editable row by row with Add row and Retire" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Proposals are stored on both backends, priced on every write

**Files:**
- Modify: `lib/proposal-pricing.js` — append the three data cleaners at the end.
- Modify: `lib/proposal-pricing.d.ts` — append their types.
- Modify: `db/store.js`
  - the import added in Task 2 (`import { sanitizeProposalPricing } from '../lib/proposal-pricing.js'`)
  - directly after `export class PackageApplyError extends Error { … }` (~:1058-1063)
  - `initialize()` — directly after the `create table if not exists packages (` statement (~:4021-4031)
  - directly after `async deletePackage(id) { … }` (~:9785-9797), before the `Apply a package to a client` doc comment
- Modify: `db/store-staleness.test.mjs` — the `./store.js` import list (`PackageApplyError,` ~:17) and append at the end.

**Interfaces:**
- Consumes: `priceProposal`, `sanitizeProposalPricing` (Tasks 1-2), `getFirmSettings()` (Task 2).
- Produces:
  - `cleanProposalProspect(raw) -> { company, contactName, email, phone, notes }`, `cleanProposalInputs(raw, allowedKeys?) -> Record<string, number>`, `cleanProposalSelections(raw) -> ProposalSelection[]` (lib).
  - `export class ProposalStateError extends Error`, `export const PROPOSAL_STATUSES = ['draft', 'sent', 'accepted', 'declined']` (store).
  - `AppDataStore.mapProposal(row) -> Proposal` (API shape: `id, status, prospect, clientId, inputs, selections, pricingSnapshot, letter, letterAt, messages, emailLog, sentAt, acceptedAt, declinedAt, declineNote, copiedFromId, createdBy, createdAt, updatedAt`).
  - `listProposals() -> Proposal[]` (most recently updated first), `getProposal(id) -> Proposal | null`, `createProposal({ prospect, clientId, inputs, selections, createdBy, copiedFromId }) -> Proposal`, `updateProposal(id, patch: { prospect?, clientId?, inputs?, selections?, letterText? }) -> Proposal | null` (always re-prices at the current catalog; throws `ProposalStateError` for accepted/declined; `{}` = "Reprice at today's catalog"), `deleteProposal(id) -> boolean` (drafts only, else `ProposalStateError`), `copyProposal(id, { createdBy }) -> Proposal | null`, `setProposalStatus(id, status, { note, clientId }) -> Proposal | null` (`sent_at` stamped once), `appendProposalEmailEvent(id, { kind: 'send' | 'delivery', ok?, to, subject?, error?, event?, detail?, providerId, at? }) -> Proposal | null` (idempotent on kind + event + providerId; never touches status).

Reading of the spec: `updateProposal` re-prices at the CURRENT firm catalog, so nothing rewrites a proposal in the background — its snapshot moves only when she edits it or presses Reprice (spec §4.2 "A catalog change never rewrites an existing proposal").

- [ ] **Step 1: Write the failing tests**

In `db/store-staleness.test.mjs`, change the store import from
```js
  PackageApplyError,
  RateVersionError,
```
to
```js
  PackageApplyError,
  ProposalStateError,
  RateVersionError,
```
and append at the end of the file:

```js

/**
 * Proposals (featreq-311473e2, spec §4.2) — their own table on Postgres, the
 * auth-state file on the file backend, outside the bulk save and the workspace
 * fingerprint like packages and spitball sessions.
 */
async function clearProposals() {
  const authState = existsSync(localAuthPath)
    ? JSON.parse(await readFile(localAuthPath, 'utf8'))
    : {}
  authState.proposals = []
  await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
}

/** Firm rates for the proposal tests: B 75 / A 115 / C 125. */
async function setProposalRates(target) {
  const seed = (await target.getFirmSettings()).proposalPricing
  await target.updateFirmSettings({
    proposalPricing: { ...seed, rates: { bookkeeper: 75, accountant: 115, controller: 125 } },
  })
}

describe('proposals (file backend)', () => {
  beforeEach(async () => {
    await clearProposals()
    await setProposalRates(store)
  })

  it('creates a draft priced by the calculator', async () => {
    const created = await store.createProposal({
      prospect: { company: 'Acme Books', contactName: 'Pat', email: 'pat@acme.test' },
      inputs: { transactions: 120, notAnInput: 5 },
      selections: [{ serviceId: 'monthly-weekly-transactions-basic' }],
      createdBy: 'emp-patrice',
    })
    expect(created.id).toMatch(/^prop-/)
    expect(created.status).toBe('draft')
    expect(created.inputs).toEqual({ transactions: 120 })
    expect(created.pricingSnapshot.lines[0]).toMatchObject({ amount: 630 })
    expect(created.pricingSnapshot.totals.monthly).toBe(630)
    expect(created.pricingSnapshot.rates).toEqual({ bookkeeper: 75, accountant: 115, controller: 125 })
  })

  it('re-prices on every edit and survives a fresh store instance', async () => {
    const created = await store.createProposal({ inputs: { transactions: 120 } })
    await store.updateProposal(created.id, {
      selections: [{ serviceId: 'reconciliations' }],
      inputs: { balanceSheetAccounts: 20 },
    })
    const reopened = new AppDataStore()
    await reopened.initialize()
    const loaded = await reopened.getProposal(created.id)
    expect(loaded.inputs).toEqual({ balanceSheetAccounts: 20 })
    expect(loaded.pricingSnapshot.totals.monthly).toBe(375)
  })

  it('reprices at today’s catalog only when asked', async () => {
    const created = await store.createProposal({
      inputs: { transactions: 120 },
      selections: [{ serviceId: 'monthly-weekly-transactions-basic' }],
    })
    const seed = (await store.getFirmSettings()).proposalPricing
    await store.updateFirmSettings({
      proposalPricing: { ...seed, rates: { ...seed.rates, bookkeeper: 100 } },
    })
    // A catalog change rewrites nothing on its own…
    expect((await store.getProposal(created.id)).pricingSnapshot.totals.monthly).toBe(630)
    // …an empty patch is "Reprice at today's catalog".
    expect((await store.updateProposal(created.id, {})).pricingSnapshot.totals.monthly).toBe(840)
  })

  it('lists the most recently touched first', async () => {
    const first = await store.createProposal({ prospect: { company: 'First' } })
    const second = await store.createProposal({ prospect: { company: 'Second' } })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await store.updateProposal(first.id, { prospect: { company: 'First again' } })
    expect((await store.listProposals()).map((row) => row.id)).toEqual([first.id, second.id])
  })

  it('deletes a draft, and refuses anything else', async () => {
    const draft = await store.createProposal({})
    expect(await store.deleteProposal(draft.id)).toBe(true)
    expect(await store.getProposal(draft.id)).toBeNull()

    const sent = await store.createProposal({})
    await store.setProposalStatus(sent.id, 'sent')
    await expect(store.deleteProposal(sent.id)).rejects.toBeInstanceOf(ProposalStateError)
  })

  it('refuses to edit an accepted or declined proposal', async () => {
    const created = await store.createProposal({})
    await store.setProposalStatus(created.id, 'declined', { note: 'Went with a friend' })
    const declined = await store.getProposal(created.id)
    expect(declined.declineNote).toBe('Went with a friend')
    expect(declined.declinedAt).toBeTruthy()
    await expect(
      store.updateProposal(created.id, { inputs: { transactions: 1 } }),
    ).rejects.toBeInstanceOf(ProposalStateError)
  })

  it('copies into a new draft that points back at the original', async () => {
    const source = await store.createProposal({
      prospect: { company: 'Acme Books' },
      inputs: { transactions: 120 },
      selections: [{ serviceId: 'monthly-weekly-transactions-basic', override: 600 }],
    })
    await store.setProposalStatus(source.id, 'declined', { note: 'Not this year' })
    const copy = await store.copyProposal(source.id, { createdBy: 'emp-patrice' })
    expect(copy.id).not.toBe(source.id)
    expect(copy.status).toBe('draft')
    expect(copy.copiedFromId).toBe(source.id)
    expect(copy.prospect.company).toBe('Acme Books')
    expect(copy.pricingSnapshot.totals.monthly).toBe(600)
  })

  it('stamps sent_at once, on the first send', async () => {
    const created = await store.createProposal({})
    const first = await store.setProposalStatus(created.id, 'sent')
    await new Promise((resolve) => setTimeout(resolve, 5))
    const again = await store.setProposalStatus(created.id, 'sent')
    expect(again.sentAt).toBe(first.sentAt)
  })

  it('appends email events idempotently and never touches the status', async () => {
    const created = await store.createProposal({})
    await store.appendProposalEmailEvent(created.id, {
      kind: 'send',
      ok: true,
      to: 'pat@acme.test',
      providerId: 're_1',
      subject: 'Your proposal',
    })
    const bounced = { kind: 'delivery', event: 'bounced', providerId: 're_1', to: ['pat@acme.test'] }
    await store.appendProposalEmailEvent(created.id, bounced)
    const after = await store.appendProposalEmailEvent(created.id, bounced)
    expect(after.emailLog.map((entry) => `${entry.kind}:${entry.event ?? ''}`)).toEqual([
      'send:',
      'delivery:bounced',
    ])
    expect(after.status).toBe('draft')
  })

  it('survives a bulk save and is not part of the staleness fingerprint', async () => {
    const before = await store.computeWorkspaceVersion()
    const created = await store.createProposal({ prospect: { company: 'Acme Books' } })
    expect(await store.computeWorkspaceVersion()).toBe(before)
    await store.write(workspace())
    expect((await store.getProposal(created.id)).prospect.company).toBe('Acme Books')
    expect(BULK_SAVE_TABLES).not.toContain('proposals')
    expect(BULK_SAVE_SLICES).not.toContain('proposals')
    expect(workspaceVersionSql()).not.toMatch(/proposals/i)
  })
})

/** A recorder pool that answers the firm-settings read and echoes one proposal row. */
function fakeProposalPostgres(row = null) {
  const statements = []
  const pool = {
    async query(text, params) {
      const trimmed = String(text).trim()
      statements.push({ text: trimmed, params })
      if (/from firm_settings where id = 'singleton'/i.test(trimmed)) {
        return { rows: [{ name: 'PB&J', proposal_pricing: null }] }
      }
      if (/proposals/i.test(trimmed) && row) return { rows: [row], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    },
  }
  return { pool, statements, matching: (pattern) => statements.filter((s) => pattern.test(s.text)) }
}

const proposalRow = (overrides = {}) => ({
  id: 'prop-1',
  status: 'draft',
  prospect: { company: 'Acme Books' },
  client_id: null,
  inputs: { transactions: 120 },
  selections: [{ serviceId: 'monthly-weekly-transactions-basic' }],
  pricing_snapshot: { lines: [], totals: { monthly: 0, annual: 0, oneTime: 0, cleanup: 0 } },
  letter: null,
  letter_at: null,
  messages: [],
  email_log: [],
  sent_at: null,
  accepted_at: null,
  declined_at: null,
  decline_note: null,
  copied_from_id: null,
  created_by: 'emp-patrice',
  created_at: new Date('2026-09-23T12:00:00.000Z'),
  updated_at: new Date('2026-09-23T12:00:00.000Z'),
  ...overrides,
})

describe('proposals (postgres branch)', () => {
  it('maps a row to the API shape', () => {
    const mapped = AppDataStore.mapProposal(proposalRow())
    expect(mapped).toMatchObject({
      id: 'prop-1',
      status: 'draft',
      clientId: null,
      createdAt: '2026-09-23T12:00:00.000Z',
    })
    expect(mapped.prospect.company).toBe('Acme Books')
  })

  it('inserts a priced snapshot', async () => {
    const fake = fakeProposalPostgres(proposalRow())
    await postgresStore(fake).createProposal({
      inputs: { transactions: 120 },
      selections: [{ serviceId: 'monthly-weekly-transactions-basic' }],
    })
    const insert = fake.matching(/^insert into proposals/i)[0]
    const snapshot = JSON.parse(insert.params[5])
    expect(snapshot.lines).toHaveLength(1)
    expect(snapshot.totals).toHaveProperty('monthly')
  })

  it('updates with a fresh snapshot, and refuses a declined row', async () => {
    const fake = fakeProposalPostgres(proposalRow())
    await postgresStore(fake).updateProposal('prop-1', { inputs: { transactions: 10 } })
    const update = fake.matching(/^update proposals/i)[0]
    expect(update.text).toMatch(/pricing_snapshot = \$6::jsonb/)

    const declined = fakeProposalPostgres(proposalRow({ status: 'declined' }))
    await expect(postgresStore(declined).updateProposal('prop-1', {})).rejects.toBeInstanceOf(
      ProposalStateError,
    )
  })

  it('deletes drafts only, in the statement itself', async () => {
    const fake = fakeProposalPostgres(proposalRow())
    await postgresStore(fake).deleteProposal('prop-1')
    expect(fake.matching(/^delete from proposals/i)[0].text).toMatch(/status = 'draft'/)
  })

  it('appends email events in SQL and never writes status', async () => {
    const fake = fakeProposalPostgres(proposalRow())
    await postgresStore(fake).appendProposalEmailEvent('prop-1', {
      kind: 'delivery',
      event: 'delivered',
      providerId: 're_9',
    })
    const update = fake.matching(/^update proposals/i)[0]
    expect(update.text).toMatch(/email_log = coalesce\(email_log, '\[\]'::jsonb\) \|\| \$2::jsonb/)
    // The SET list, not the returning list: status is read back, never written.
    expect(update.text.split(/\bwhere\b/)[0]).not.toMatch(/status/)
  })

  it('stamps sent_at only when it is empty', async () => {
    const fake = fakeProposalPostgres(proposalRow())
    await postgresStore(fake).setProposalStatus('prop-1', 'sent')
    expect(fake.matching(/^update proposals/i)[0].text).toMatch(/coalesce\(sent_at, now\(\)\)/)
  })

  it('the bulk save never touches the table', async () => {
    const fake = fakePostgres()
    await postgresStore(fake).write(workspace())
    expect(fake.matching(/proposals/i)).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run db/store-staleness.test.mjs -t "proposals"`
Expected: FAIL — `ProposalStateError` is not exported by `./store.js` (the import itself fails, so the file does not load).

- [ ] **Step 3: Implement**

Append to the end of `lib/proposal-pricing.js`:

```js

/** The prospect block, every field a capped string. */
export function cleanProposalProspect(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  return {
    company: cleanText(src.company, 200),
    contactName: cleanText(src.contactName, 200),
    email: cleanText(src.email, 320),
    phone: cleanText(src.phone, 60),
    notes: cleanText(src.notes, 4000),
  }
}

/**
 * The counts she collected: finite, non-negative, capped at 1e9. With
 * `allowedKeys`, only the catalog's own inputs survive.
 */
export function cleanProposalInputs(raw, allowedKeys = null) {
  const allowed = allowedKeys ? new Set(allowedKeys) : null
  const out = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [key, value] of Object.entries(raw)) {
    if (!INPUT_KEY_PATTERN.test(key)) continue
    if (allowed && !allowed.has(key)) continue
    if (value === null || value === undefined || value === '') continue
    const n = Number(value)
    if (!Number.isFinite(n) || n < 0) continue
    out[key] = Math.min(n, 1e9)
  }
  return out
}

/**
 * The rows she picked. One entry per service (the last one wins), numbers
 * finite and non-negative, the payroll run an enum, the two flags real
 * booleans. A field that is absent stays absent.
 */
export function cleanProposalSelections(raw) {
  const byId = new Map()
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (!entry || typeof entry !== 'object') continue
    const serviceId = typeof entry.serviceId === 'string' ? entry.serviceId.trim() : ''
    if (!SERVICE_ID_PATTERN.test(serviceId)) continue
    const selection = { serviceId }
    for (const field of ['quantity', 'flatAmount', 'override']) {
      const n = optionalAmount(entry[field])
      if (n !== null) selection[field] = Math.min(n, 1e9)
    }
    if (PAYROLL_RUNS.includes(entry.payrollRun)) selection.payrollRun = entry.payrollRun
    if (typeof entry.includeBonus === 'boolean') selection.includeBonus = entry.includeBonus
    if (typeof entry.includeReview === 'boolean') selection.includeReview = entry.includeReview
    byId.delete(serviceId)
    byId.set(serviceId, selection)
  }
  return [...byId.values()].slice(0, 200)
}
```

Append to the end of `lib/proposal-pricing.d.ts`:

```ts

export type ProposalProspect = {
  company: string
  contactName: string
  email: string
  phone: string
  notes: string
}

/** The prospect block, every field a capped string. */
export declare function cleanProposalProspect(raw: unknown): ProposalProspect
/** Finite, non-negative counts; with `allowedKeys`, only the catalog's own inputs. */
export declare function cleanProposalInputs(
  raw: unknown,
  allowedKeys?: Iterable<string> | null,
): Record<string, number>
/** One entry per service (the last wins), numbers finite and non-negative. */
export declare function cleanProposalSelections(raw: unknown): ProposalSelection[]
```

In `db/store.js`:

1. Replace the Task 2 import
```js
import { sanitizeProposalPricing } from '../lib/proposal-pricing.js'
```
with
```js
import {
  cleanProposalInputs,
  cleanProposalProspect,
  cleanProposalSelections,
  priceProposal,
  sanitizeProposalPricing,
} from '../lib/proposal-pricing.js'
```

2. Replace
```js
export class PackageApplyError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PackageApplyError'
  }
}
```
with
```js
export class PackageApplyError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PackageApplyError'
  }
}

/**
 * A proposal write the proposal's own state refuses: editing an accepted or
 * declined proposal, deleting one that is not a draft, accepting twice. A
 * sentence, for the same reason `PackageApplyError` is one — the route answers
 * 409 with it and the page shows it as-is.
 */
export class ProposalStateError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ProposalStateError'
  }
}

export const PROPOSAL_STATUSES = ['draft', 'sent', 'accepted', 'declined']

/** Every `proposals` column, in the order `mapProposal` reads them. */
const PROPOSAL_COLUMNS = `id, status, prospect, client_id, inputs, selections, pricing_snapshot,
  letter, letter_at, messages, email_log, sent_at, accepted_at, declined_at, decline_note,
  copied_from_id, created_by, created_at, updated_at`

/**
 * The priced snapshot a proposal carries (spec §4.2). Always the CURRENT
 * catalog: the snapshot moves only when the proposal itself is edited or
 * repriced, never because the catalog changed underneath it.
 */
function proposalSnapshot(pricing, inputs, selections, at) {
  const { lines, totals } = priceProposal({
    catalog: pricing,
    rates: pricing.rates,
    inputs,
    selections,
  })
  return { rates: { ...pricing.rates }, lines, totals, catalogAt: at }
}
```

3. In `initialize()`, directly after the query that runs `create table if not exists packages (` — i.e. just above the comment `// Reusable contacts (shared across clients). Mirrors the plans/clients` — add:
```js

      // PROPOSALS (featreq-311473e2 / featreq-ef18a38e, spec §4.2): one row per
      // prospect estimate, with its letter, intake chat and email log. Outside
      // the bulk save and the workspace fingerprint exactly like `packages` and
      // `spitball_sessions` — endpoint-managed, so a stale tab can never rewrite
      // a proposal and editing one can never 409 another tab. `client_id` has NO
      // foreign key (the `plan_ids` idiom): a proposal outlives a deleted
      // client, and the clients wipe in `write()` must never cascade into it.
      await this.pool.query(`
        create table if not exists proposals (
          id text primary key,
          status text not null default 'draft',
          prospect jsonb not null default '{}'::jsonb,
          client_id text,
          inputs jsonb not null default '{}'::jsonb,
          selections jsonb not null default '[]'::jsonb,
          pricing_snapshot jsonb,
          letter jsonb,
          letter_at timestamptz,
          messages jsonb not null default '[]'::jsonb,
          email_log jsonb not null default '[]'::jsonb,
          sent_at timestamptz,
          accepted_at timestamptz,
          declined_at timestamptz,
          decline_note text,
          copied_from_id text,
          created_by text,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        )
      `)
```

4. Directly after the closing brace of `async deletePackage(id) {` — i.e. just above the doc comment whose first line is `   * Apply a package to a client: add its plans to the client's selected` — add:

```js

  // ---- Proposals (featreq-311473e2 / featreq-ef18a38e) ----
  //
  // docs/plans/proposals-2026-09.md §4.2. A proposal is a prospect's estimate,
  // letter, intake chat and outcome. Storage mirrors `packages`: a `proposals`
  // table on Postgres, the auth-state file (never app-data.json, which the bulk
  // save replaces wholesale) on the file backend.
  //
  // Every write that changes inputs or selections re-prices through
  // `priceProposal` with the firm's CURRENT catalog, so `pricing_snapshot` is
  // always the calculator's answer — the letter, the PDF and the list read it
  // and nothing else ever computes a price.

  /** Normalize a stored proposal (either backend's row shape) for the API. */
  static mapProposal(row) {
    if (!row) return null
    const json = (value) => (typeof value === 'string' ? safeJsonParse(value) : value)
    const iso = (value) => (value ? new Date(value).toISOString() : null)
    const list = (value) => {
      const parsed = json(value)
      return Array.isArray(parsed) ? parsed : []
    }
    return {
      id: row.id,
      status: PROPOSAL_STATUSES.includes(row.status) ? row.status : 'draft',
      prospect: cleanProposalProspect(json(row.prospect)),
      clientId: row.client_id ?? row.clientId ?? null,
      inputs: cleanProposalInputs(json(row.inputs)),
      selections: cleanProposalSelections(json(row.selections)),
      pricingSnapshot: json(row.pricing_snapshot ?? row.pricingSnapshot) ?? null,
      letter: json(row.letter) ?? null,
      letterAt: iso(row.letter_at ?? row.letterAt),
      messages: list(row.messages),
      emailLog: list(row.email_log ?? row.emailLog),
      sentAt: iso(row.sent_at ?? row.sentAt),
      acceptedAt: iso(row.accepted_at ?? row.acceptedAt),
      declinedAt: iso(row.declined_at ?? row.declinedAt),
      declineNote: row.decline_note ?? row.declineNote ?? null,
      copiedFromId: row.copied_from_id ?? row.copiedFromId ?? null,
      createdBy: row.created_by ?? row.createdBy ?? null,
      createdAt: iso(row.created_at ?? row.createdAt) ?? nowIso(),
      updatedAt: iso(row.updated_at ?? row.updatedAt),
    }
  }

  /** Every proposal, most recently touched first. Owner-only at the endpoint. */
  async listProposals() {
    if (this.pool) {
      const { rows } = await this.pool.query(
        `select ${PROPOSAL_COLUMNS} from proposals order by updated_at desc`,
      )
      return rows.map((row) => AppDataStore.mapProposal(row))
    }
    const authState = await readJson(localAuthPath)
    const list = Array.isArray(authState.proposals) ? authState.proposals : []
    return list
      .map((row) => AppDataStore.mapProposal(row))
      .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
  }

  /** One proposal, or null. */
  async getProposal(id) {
    if (!id) return null
    if (this.pool) {
      const { rows } = await this.pool.query(
        `select ${PROPOSAL_COLUMNS} from proposals where id = $1`,
        [id],
      )
      return rows[0] ? AppDataStore.mapProposal(rows[0]) : null
    }
    const authState = await readJson(localAuthPath)
    const found = (Array.isArray(authState.proposals) ? authState.proposals : []).find(
      (row) => row && row.id === id,
    )
    return found ? AppDataStore.mapProposal(found) : null
  }

  /**
   * Start a proposal. Everything is optional — "New proposal" opens an empty
   * draft — and the snapshot is priced from the firm's catalog at creation.
   */
  async createProposal({
    prospect = {},
    clientId = null,
    inputs = {},
    selections = [],
    createdBy = null,
    copiedFromId = null,
  } = {}) {
    const pricing = (await this.getFirmSettings()).proposalPricing
    const cleanInputs = cleanProposalInputs(
      inputs,
      pricing.inputs.map((input) => input.key),
    )
    const cleanSelections = cleanProposalSelections(selections)
    const now = nowIso()
    const record = {
      id: `prop-${randomUUID().slice(0, 8)}`,
      status: 'draft',
      prospect: cleanProposalProspect(prospect),
      clientId: typeof clientId === 'string' && clientId ? clientId : null,
      inputs: cleanInputs,
      selections: cleanSelections,
      pricingSnapshot: proposalSnapshot(pricing, cleanInputs, cleanSelections, now),
      letter: null,
      letterAt: null,
      messages: [],
      emailLog: [],
      sentAt: null,
      acceptedAt: null,
      declinedAt: null,
      declineNote: null,
      copiedFromId: typeof copiedFromId === 'string' && copiedFromId ? copiedFromId : null,
      createdBy: typeof createdBy === 'string' && createdBy ? createdBy : null,
      createdAt: now,
      updatedAt: now,
    }

    if (this.pool) {
      const { rows } = await this.pool.query(
        `insert into proposals (id, status, prospect, client_id, inputs, selections,
            pricing_snapshot, copied_from_id, created_by, created_at, updated_at)
         values ($1, 'draft', $2::jsonb, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9, $9)
         returning ${PROPOSAL_COLUMNS}`,
        [
          record.id,
          JSON.stringify(record.prospect),
          record.clientId,
          JSON.stringify(record.inputs),
          JSON.stringify(record.selections),
          JSON.stringify(record.pricingSnapshot),
          record.copiedFromId,
          record.createdBy,
          now,
        ],
      )
      return AppDataStore.mapProposal(rows[0] ?? record)
    }

    const authState = await readJson(localAuthPath)
    if (!Array.isArray(authState.proposals)) authState.proposals = []
    authState.proposals.push(record)
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return AppDataStore.mapProposal(record)
  }

  /**
   * Edit a proposal's prospect, client link, inputs, selections or letter
   * text, and RE-PRICE it at the current catalog. A patch that says nothing
   * about a field is not a statement about it; an empty patch is exactly
   * "Reprice at today's catalog".
   *
   * An accepted or declined proposal is a record of what happened and is
   * refused (copy it to change it). Returns null when there is no such proposal.
   */
  async updateProposal(id, patch = {}) {
    const current = await this.getProposal(id)
    if (!current) return null
    if (current.status === 'accepted' || current.status === 'declined') {
      throw new ProposalStateError(
        `This proposal is ${current.status} — copy it to a new proposal to change anything.`,
      )
    }
    const has = (key) => Object.prototype.hasOwnProperty.call(patch ?? {}, key)
    const pricing = (await this.getFirmSettings()).proposalPricing
    const next = {
      prospect: has('prospect') ? cleanProposalProspect(patch.prospect) : current.prospect,
      clientId: has('clientId')
        ? typeof patch.clientId === 'string' && patch.clientId
          ? patch.clientId
          : null
        : current.clientId,
      inputs: has('inputs')
        ? cleanProposalInputs(
            patch.inputs,
            pricing.inputs.map((input) => input.key),
          )
        : current.inputs,
      selections: has('selections') ? cleanProposalSelections(patch.selections) : current.selections,
      letter: has('letterText')
        ? {
            subject: current.letter?.subject ?? '',
            sections: current.letter?.sections ?? [],
            text: typeof patch.letterText === 'string' ? patch.letterText.slice(0, 20000) : '',
          }
        : current.letter,
    }
    const updatedAt = nowIso()
    const pricingSnapshot = proposalSnapshot(pricing, next.inputs, next.selections, updatedAt)

    if (this.pool) {
      const { rows } = await this.pool.query(
        `update proposals
            set prospect = $2::jsonb, client_id = $3, inputs = $4::jsonb,
                selections = $5::jsonb, pricing_snapshot = $6::jsonb, letter = $7::jsonb,
                updated_at = now()
          where id = $1
          returning ${PROPOSAL_COLUMNS}`,
        [
          id,
          JSON.stringify(next.prospect),
          next.clientId,
          JSON.stringify(next.inputs),
          JSON.stringify(next.selections),
          JSON.stringify(pricingSnapshot),
          next.letter ? JSON.stringify(next.letter) : null,
        ],
      )
      return rows[0] ? AppDataStore.mapProposal(rows[0]) : null
    }

    const authState = await readJson(localAuthPath)
    const target = (Array.isArray(authState.proposals) ? authState.proposals : []).find(
      (row) => row && row.id === id,
    )
    if (!target) return null
    Object.assign(target, next, { pricingSnapshot, updatedAt })
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return AppDataStore.mapProposal(target)
  }

  /**
   * Delete a DRAFT. A proposal that went out is part of the record — decline
   * it instead. Throws ProposalStateError for a non-draft; false when missing.
   */
  async deleteProposal(id) {
    const current = await this.getProposal(id)
    if (!current) return false
    if (current.status !== 'draft') {
      throw new ProposalStateError('Only a draft can be deleted — decline a sent proposal instead.')
    }
    if (this.pool) {
      const result = await this.pool.query(
        `delete from proposals where id = $1 and status = 'draft' returning id`,
        [id],
      )
      return (result.rowCount ?? 0) > 0
    }
    const authState = await readJson(localAuthPath)
    const list = Array.isArray(authState.proposals) ? authState.proposals : []
    authState.proposals = list.filter((row) => !row || row.id !== id)
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return true
  }

  /**
   * "Copy to new proposal" (spec §5.5): a new DRAFT with the same prospect,
   * client link, inputs and selections, priced at today's catalog, pointing
   * back at the one it came from. How a declined prospect is reopened.
   */
  async copyProposal(id, { createdBy = null } = {}) {
    const source = await this.getProposal(id)
    if (!source) return null
    return this.createProposal({
      prospect: source.prospect,
      clientId: source.clientId,
      inputs: source.inputs,
      selections: source.selections,
      createdBy,
      copiedFromId: source.id,
    })
  }

  /**
   * Move a proposal's status and stamp when: `sent_at` on the FIRST send only,
   * `accepted_at` / `declined_at` (+ the decline note) on those. `clientId`
   * links the client Accept created or used. Returns the proposal, or null.
   */
  async setProposalStatus(id, status, { note = null, clientId = null } = {}) {
    if (!id || !PROPOSAL_STATUSES.includes(status)) return null
    const cleanNote = typeof note === 'string' ? note.trim().slice(0, 2000) : null
    const linkClient = typeof clientId === 'string' && clientId ? clientId : null
    if (this.pool) {
      const { rows } = await this.pool.query(
        `update proposals
            set status = $2,
                sent_at = case when $2 = 'sent' then coalesce(sent_at, now()) else sent_at end,
                accepted_at = case when $2 = 'accepted' then now() else accepted_at end,
                declined_at = case when $2 = 'declined' then now() else declined_at end,
                decline_note = case when $2 = 'declined' then $3 else decline_note end,
                client_id = coalesce($4, client_id),
                updated_at = now()
          where id = $1
          returning ${PROPOSAL_COLUMNS}`,
        [id, status, cleanNote, linkClient],
      )
      return rows[0] ? AppDataStore.mapProposal(rows[0]) : null
    }
    const authState = await readJson(localAuthPath)
    const target = (Array.isArray(authState.proposals) ? authState.proposals : []).find(
      (row) => row && row.id === id,
    )
    if (!target) return null
    const now = nowIso()
    target.status = status
    if (status === 'sent') target.sentAt = target.sentAt ?? now
    if (status === 'accepted') target.acceptedAt = now
    if (status === 'declined') {
      target.declinedAt = now
      target.declineNote = cleanNote
    }
    if (linkClient) target.clientId = linkClient
    target.updatedAt = now
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return AppDataStore.mapProposal(target)
  }

  /**
   * Append one entry to a proposal's email log — a send (`kind: 'send'`) or a
   * provider delivery event (`kind: 'delivery'`), the same shapes as
   * `invoices.email_log`. NEVER touches status: a bounce does not un-send a
   * proposal. Idempotent on (kind, event, providerId), because Resend retries
   * until it gets a 200. Returns the proposal, or null when there is none.
   */
  async appendProposalEmailEvent(id, entry = {}) {
    const current = await this.getProposal(id)
    if (!current) return null
    const kind = entry.kind === 'delivery' ? 'delivery' : 'send'
    const event = kind === 'delivery' ? String(entry.event ?? '').trim().slice(0, 40) : null
    if (kind === 'delivery' && !event) return null
    const providerId = entry.providerId ? String(entry.providerId) : null
    const duplicate =
      providerId !== null &&
      current.emailLog.some(
        (logged) =>
          logged?.kind === kind &&
          (logged?.event ?? null) === event &&
          logged?.providerId === providerId,
      )
    if (duplicate) return current

    const at =
      entry.at && !Number.isNaN(new Date(entry.at).getTime())
        ? new Date(entry.at).toISOString()
        : nowIso()
    const clean = {
      kind,
      at,
      providerId,
      to: (Array.isArray(entry.to) ? entry.to : [entry.to])
        .filter(Boolean)
        .map((address) => String(address).slice(0, 320))
        .slice(0, 10),
      ...(kind === 'send'
        ? {
            ok: entry.ok === true,
            subject: String(entry.subject ?? '').slice(0, 200),
            error: entry.error ? String(entry.error).slice(0, 300) : null,
          }
        : { event, detail: String(entry.detail ?? '').slice(0, 300) }),
    }

    if (this.pool) {
      // Appended IN the row, like the invoice log: two events about one
      // proposal can land at once. `status` is deliberately absent.
      const { rows } = await this.pool.query(
        `update proposals
            set email_log = coalesce(email_log, '[]'::jsonb) || $2::jsonb,
                updated_at = now()
          where id = $1
          returning ${PROPOSAL_COLUMNS}`,
        [id, JSON.stringify([clean])],
      )
      return rows[0] ? AppDataStore.mapProposal(rows[0]) : null
    }
    const authState = await readJson(localAuthPath)
    const target = (Array.isArray(authState.proposals) ? authState.proposals : []).find(
      (row) => row && row.id === id,
    )
    if (!target) return null
    target.emailLog = [...(Array.isArray(target.emailLog) ? target.emailLog : []), clean]
    target.updatedAt = nowIso()
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return AppDataStore.mapProposal(target)
  }
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run db/store-staleness.test.mjs lib/proposal-pricing.test.mjs`
Expected: PASS — the 17 new proposal tests plus everything already there.

Before shipping this task's Postgres half, the rolled-back write check from HANDOFF §4 is the real proof (read-only credentials, `BEGIN` … `ROLLBACK`): run `create table if not exists proposals (…)` and one `insert into proposals … returning …` with the exact SQL above, then `ROLLBACK` and re-select to prove nothing stayed. Report the result; do not commit production writes.

- [ ] **Step 5: Verify and commit**

Run: `npm run verify` — expected green.

```bash
git add lib/proposal-pricing.js lib/proposal-pricing.d.ts db/store.js db/store-staleness.test.mjs
git commit -m "Proposals are stored on both backends outside the bulk save, and every edit re-prices them through the calculator" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The proposal CRUD routes, the client types and the API wrappers

**Files:**
- Create: `src/__tests__/proposal-routes.test.ts`
- Modify: `server.js`
  - the store import list (`  PackageApplyError,` ~:16)
  - insert the route block directly above `    if (normalizedPath === '/api/reimbursements' && request.method === 'POST') {` (~:7924, right after the `applyPackageMatch` route's `sendJson(response, 200, applied)`)
- Modify: `src/lib/types.ts` — the Task 2 import at the top, the Task 2 `export type { … } from '../../lib/proposal-pricing.js'` list, and directly after `export type Package = { … }` (ends `updatedAt: string | null\n}` ~:313)
- Modify: `src/lib/api.ts` — the `./types` import list (`  type Package,` ~:24) and directly after `export async function applyPackageRequest(` … `}` (~:854-872)

**Interfaces:**
- Consumes: the store methods of Task 4.
- Produces:
  - `GET /api/proposals` → `{ proposals: Proposal[] }`; `POST /api/proposals` `{ prospect?, clientId?, inputs?, selections? }` → 201 `Proposal`; `GET /api/proposals/:id` → `Proposal`; `PATCH /api/proposals/:id` `{ prospect?, clientId?, inputs?, selections?, letterText? }` → `Proposal` (409 `proposal_refused` for accepted/declined); `DELETE /api/proposals/:id` → `{ removedProposalId }` (409 for non-drafts); `POST /api/proposals/:id/copy` → 201 `Proposal`; `POST /api/proposals/:id/reprice` → `Proposal`.
  - Types: `ProposalStatus`, `ProposalSnapshot`, `ProposalLetter`, `ProposalChatPatch`, `ProposalMessage`, `ProposalEmailEvent`, `Proposal`, `ProposalPatch`, and the re-exported `ProposalProspect`.
  - `listProposalsRequest(): Promise<Proposal[]>`, `getProposalRequest(id): Promise<Proposal>`, `createProposalRequest(input?): Promise<Proposal>`, `updateProposalRequest(id, patch: ProposalPatch): Promise<Proposal>`, `deleteProposalRequest(id): Promise<void>`, `copyProposalRequest(id): Promise<Proposal>`, `repriceProposalRequest(id): Promise<Proposal>`.

- [ ] **Step 1: Write the failing test** — create `src/__tests__/proposal-routes.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The proposal endpoints' GLUE (featreq-311473e2 / featreq-ef18a38e).
 *
 * Same shape as package-routes.test.ts and for the same reason: `server.js`
 * calls `server.listen()` at module scope and exports nothing, so there is no
 * HTTP harness. The behavior lives in the store (db/store-staleness.test.mjs,
 * both backends) and in lib/; what is pinned here is the wiring — an owner gate
 * deleted, an origin guard dropped, a route below the `/api/` catch-all.
 *
 * Treat a failure here as "the routing moved, go look".
 */

const serverSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.js'),
  'utf8',
)

/** The body of a route block, from its opening guard onward. */
function routeBlock(startPattern: RegExp, length = 2200): string {
  const at = serverSource.search(startPattern)
  expect(at, `route not found: ${startPattern}`).toBeGreaterThan(-1)
  return serverSource.slice(at, at + length)
}

type Route = { name: string; pattern: RegExp; write: boolean }

/** Owner-only on every route; same-origin and a broadcast on every write. */
function pinOwnerRoutes(routes: Route[]) {
  for (const route of routes) {
    it(`${route.name} requires a session and refuses a non-owner`, () => {
      const block = routeBlock(route.pattern)
      expect(block).toContain('await requireSession(request, response)')
      expect(block).toMatch(/session\.user\.role !== 'owner'/)
      expect(block).toMatch(/sendJson\(response, 403,/)
    })

    if (route.write) {
      it(`${route.name} blocks a cross-site request`, () => {
        const block = routeBlock(route.pattern)
        expect(block).toContain('isCrossSiteOrigin(request)')
        expect(block).toContain("sendJson(response, 403, { error: 'Origin not allowed' })")
      })

      it(`${route.name} tells the other sessions`, () => {
        expect(routeBlock(route.pattern, 3000)).toContain('broadcastDataChanged()')
      })
    }
  }

  it('every route sits above the /api/ catch-all', () => {
    const guardAt = serverSource.indexOf("if (normalizedPath.startsWith('/api/')) {")
    expect(guardAt, 'the /api/ catch-all guard is gone').toBeGreaterThan(-1)
    for (const route of routes) {
      expect(serverSource.search(route.pattern), `${route.name} is unreachable`).toBeLessThan(guardAt)
    }
  })
}

describe('the proposal CRUD routes are owner-only and same-origin', () => {
  pinOwnerRoutes([
    {
      name: 'GET /api/proposals',
      pattern: /normalizedPath === '\/api\/proposals' && request\.method === 'GET'/,
      write: false,
    },
    {
      name: 'POST /api/proposals',
      pattern: /normalizedPath === '\/api\/proposals' && request\.method === 'POST'/,
      write: true,
    },
    { name: 'GET /api/proposals/:id', pattern: /proposalIdMatch && request\.method === 'GET'/, write: false },
    { name: 'PATCH /api/proposals/:id', pattern: /proposalIdMatch && request\.method === 'PATCH'/, write: true },
    { name: 'DELETE /api/proposals/:id', pattern: /proposalIdMatch && request\.method === 'DELETE'/, write: true },
    { name: 'POST /api/proposals/:id/copy', pattern: /proposalCopyMatch && request\.method === 'POST'/, write: true },
    {
      name: 'POST /api/proposals/:id/reprice',
      pattern: /proposalRepriceMatch && request\.method === 'POST'/,
      write: true,
    },
  ])

  it('the :id matcher cannot swallow the sub-routes', () => {
    const matcher = serverSource.match(/const proposalIdMatch = normalizedPath\.match\((.+)\)/)
    expect(matcher?.[1]).toBe('/^\\/api\\/proposals\\/([^/]+)$/')
  })

  it('the PATCH whitelists its fields and never hands the raw body to the store', () => {
    const block = routeBlock(/proposalIdMatch && request\.method === 'PATCH'/)
    expect(block).toContain("['prospect', 'clientId', 'inputs', 'selections', 'letterText']")
    expect(block).not.toContain('updateProposal(proposalIdMatch[1], payload)')
  })

  it('a refused edit or delete is a 409 with the sentence, not a 500', () => {
    for (const pattern of [
      /proposalIdMatch && request\.method === 'PATCH'/,
      /proposalIdMatch && request\.method === 'DELETE'/,
    ]) {
      const block = routeBlock(pattern)
      expect(block).toContain('error instanceof ProposalStateError')
      expect(block).toContain("sendJson(response, 409, { error: 'proposal_refused', message: error.message })")
    }
  })

  it('nothing here goes near the bulk save', () => {
    const start = serverSource.indexOf("normalizedPath === '/api/proposals' && request.method === 'GET'")
    const end = serverSource.indexOf("if (normalizedPath === '/api/reimbursements' && request.method === 'POST')")
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(serverSource.slice(start, end)).not.toContain('appDataStore.write(')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/__tests__/proposal-routes.test.ts`
Expected: FAIL — `route not found` for every proposal route.

- [ ] **Step 3: Implement**

In `server.js`, change the store import
```js
  PackageApplyError,
  RateVersionError,
```
to
```js
  PackageApplyError,
  ProposalStateError,
  RateVersionError,
```
and insert directly above `    if (normalizedPath === '/api/reimbursements' && request.method === 'POST') {`:

```js
    // ---- Proposals (featreq-311473e2 / featreq-ef18a38e) -------------------
    //
    // docs/plans/proposals-2026-09.md. Endpoint-managed like packages: never in
    // `PUT /api/app-data`, so outside the bulk save and the workspace
    // fingerprint. Owner-only, and same-origin on every write. Every price in a
    // response comes from the store's `priceProposal` snapshot.
    if (normalizedPath === '/api/proposals' && request.method === 'GET') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can see proposals' })
        return
      }
      sendJson(response, 200, { proposals: await appDataStore.listProposals() })
      return
    }

    if (normalizedPath === '/api/proposals' && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can create proposals' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }
      if (!isJsonContentType(request)) {
        sendJson(response, 415, { error: 'application/json required' })
        return
      }
      const payload = await readJsonBody(request)
      const created = await appDataStore.createProposal({
        prospect: payload?.prospect,
        clientId: typeof payload?.clientId === 'string' ? payload.clientId : null,
        inputs: payload?.inputs,
        selections: payload?.selections,
        createdBy: session.user.id,
      })
      await appDataStore.recordActivity(
        session.user.id,
        'proposal_created',
        created.prospect.company || created.id,
      )
      broadcastDataChanged()
      sendJson(response, 201, created)
      return
    }

    const proposalIdMatch = normalizedPath.match(/^\/api\/proposals\/([^/]+)$/)
    if (proposalIdMatch && request.method === 'GET') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can see proposals' })
        return
      }
      const proposal = await appDataStore.getProposal(proposalIdMatch[1])
      if (!proposal) {
        sendJson(response, 404, { error: 'Proposal not found' })
        return
      }
      sendJson(response, 200, proposal)
      return
    }

    if (proposalIdMatch && request.method === 'PATCH') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can edit proposals' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }
      if (!isJsonContentType(request)) {
        sendJson(response, 415, { error: 'application/json required' })
        return
      }
      const payload = (await readJsonBody(request)) ?? {}
      const patch = {}
      for (const field of ['prospect', 'clientId', 'inputs', 'selections', 'letterText']) {
        if (Object.prototype.hasOwnProperty.call(payload, field)) patch[field] = payload[field]
      }
      let updated
      try {
        updated = await appDataStore.updateProposal(proposalIdMatch[1], patch)
      } catch (error) {
        if (error instanceof ProposalStateError) {
          sendJson(response, 409, { error: 'proposal_refused', message: error.message })
          return
        }
        throw error
      }
      if (!updated) {
        sendJson(response, 404, { error: 'Proposal not found' })
        return
      }
      broadcastDataChanged()
      sendJson(response, 200, updated)
      return
    }

    if (proposalIdMatch && request.method === 'DELETE') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can delete proposals' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }
      let removed
      try {
        removed = await appDataStore.deleteProposal(proposalIdMatch[1])
      } catch (error) {
        if (error instanceof ProposalStateError) {
          sendJson(response, 409, { error: 'proposal_refused', message: error.message })
          return
        }
        throw error
      }
      if (!removed) {
        sendJson(response, 404, { error: 'Proposal not found' })
        return
      }
      await appDataStore.recordActivity(session.user.id, 'proposal_deleted', proposalIdMatch[1])
      broadcastDataChanged()
      sendJson(response, 200, { removedProposalId: proposalIdMatch[1] })
      return
    }

    // POST /api/proposals/:id/copy — a new draft from this one, priced at
    // today's catalog (spec §5.5). How a declined prospect is reopened.
    const proposalCopyMatch = normalizedPath.match(/^\/api\/proposals\/([^/]+)\/copy$/)
    if (proposalCopyMatch && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can copy proposals' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }
      const copy = await appDataStore.copyProposal(proposalCopyMatch[1], {
        createdBy: session.user.id,
      })
      if (!copy) {
        sendJson(response, 404, { error: 'Proposal not found' })
        return
      }
      await appDataStore.recordActivity(
        session.user.id,
        'proposal_copied',
        `${proposalCopyMatch[1]} -> ${copy.id}`,
      )
      broadcastDataChanged()
      sendJson(response, 201, copy)
      return
    }

    // POST /api/proposals/:id/reprice — "Reprice at today's catalog": an edit
    // that changes nothing but the snapshot.
    const proposalRepriceMatch = normalizedPath.match(/^\/api\/proposals\/([^/]+)\/reprice$/)
    if (proposalRepriceMatch && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can reprice proposals' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }
      let repriced
      try {
        repriced = await appDataStore.updateProposal(proposalRepriceMatch[1], {})
      } catch (error) {
        if (error instanceof ProposalStateError) {
          sendJson(response, 409, { error: 'proposal_refused', message: error.message })
          return
        }
        throw error
      }
      if (!repriced) {
        sendJson(response, 404, { error: 'Proposal not found' })
        return
      }
      broadcastDataChanged()
      sendJson(response, 200, repriced)
      return
    }

```

In `src/lib/types.ts`, replace the Task 2 import
```ts
import type { ProposalPricing } from '../../lib/proposal-pricing.js'
```
with
```ts
import type {
  PricedLine,
  ProposalPricing,
  ProposalProspect,
  ProposalRates,
  ProposalSelection,
  ProposalTotals,
} from '../../lib/proposal-pricing.js'
```
in the Task 2 re-export list replace
```ts
  ProposalPricingKind,
  ProposalRates,
```
with
```ts
  ProposalPricingKind,
  ProposalProspect,
  ProposalRates,
```
and directly after the closing `}` of `export type Package = {` insert:

```ts

/**
 * A PROPOSAL (featreq-311473e2 / featreq-ef18a38e) — a prospect's estimate,
 * letter, intake chat and outcome. Endpoint-managed: never in the bulk
 * workspace payload, fetched by the Proposals pages themselves.
 */
export type ProposalStatus = 'draft' | 'sent' | 'accepted' | 'declined'

/** What the calculator priced, frozen on the proposal (spec §4.2). */
export type ProposalSnapshot = {
  rates: ProposalRates
  lines: PricedLine[]
  totals: ProposalTotals
  catalogAt: string
}

export type ProposalLetter = {
  subject: string
  sections: Array<{ heading: string; body: string }>
  /** The rendered letter she edits; the PDF and the email read this. */
  text: string
}

/** What one intake-chat turn changed, after the server's validator. */
export type ProposalChatPatch = {
  prospect?: Partial<ProposalProspect>
  inputs?: Record<string, number>
  selections?: { add: ProposalSelection[]; remove: string[] }
}

export type ProposalMessage = {
  role: 'user' | 'assistant'
  text: string
  at: string
  patch?: ProposalChatPatch | null
}

/** One send or provider delivery event — the invoice email log's shape. */
export type ProposalEmailEvent = {
  kind: 'send' | 'delivery'
  at: string
  providerId: string | null
  to: string[]
  ok?: boolean
  subject?: string
  error?: string | null
  event?: string
  detail?: string
}

export type Proposal = {
  id: string
  status: ProposalStatus
  prospect: ProposalProspect
  /** The client it was written for, or the one Accept created. */
  clientId: string | null
  inputs: Record<string, number>
  selections: ProposalSelection[]
  pricingSnapshot: ProposalSnapshot | null
  letter: ProposalLetter | null
  letterAt: string | null
  messages: ProposalMessage[]
  emailLog: ProposalEmailEvent[]
  sentAt: string | null
  acceptedAt: string | null
  declinedAt: string | null
  declineNote: string | null
  copiedFromId: string | null
  createdBy: string | null
  createdAt: string
  updatedAt: string | null
}

/** What `PATCH /api/proposals/:id` accepts. A field left out is not a statement about it. */
export type ProposalPatch = Partial<{
  prospect: ProposalProspect
  clientId: string | null
  inputs: Record<string, number>
  selections: ProposalSelection[]
  letterText: string
}>
```

In `src/lib/api.ts`, change the `./types` import
```ts
  type Package,
  type PublicFirmSettings,
```
to
```ts
  type Package,
  type Proposal,
  type ProposalPatch,
  type ProposalProspect,
  type PublicFirmSettings,
```
and directly after the closing `}` of `export async function applyPackageRequest(` insert:

```ts

/* -------------------------------------------------------------------------- */
/* Proposals (featreq-311473e2 / featreq-ef18a38e)                            */
/* -------------------------------------------------------------------------- */
/*
 * Endpoint-managed like packages: never in the bulk workspace payload. Owner-
 * only on the server. Every proposal the server hands back carries a fresh
 * `pricingSnapshot` — the page never prices anything itself.
 */

/** One proposal call: same-origin, JSON in and out, the server's sentence on failure. */
async function proposalRequest<T>(path: string, init: RequestInit, failure: string): Promise<T> {
  const response = await apiFetch(path, { credentials: 'same-origin', ...init })
  if (!response.ok) {
    const message = await safeErrorMessage(response)
    throw new ApiError(response.status, message || `${failure} (${response.status})`)
  }
  return (await response.json()) as T
}

const proposalJson = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

const proposalPath = (id: string, action = '') =>
  `/api/proposals/${encodeURIComponent(id)}${action ? `/${action}` : ''}`

/** Owner-only: every proposal, most recently touched first. */
export async function listProposalsRequest(): Promise<Proposal[]> {
  const body = await proposalRequest<{ proposals?: Proposal[] }>(
    '/api/proposals',
    {},
    'Failed to load proposals',
  )
  return Array.isArray(body.proposals) ? body.proposals : []
}

/** Owner-only: one proposal. */
export function getProposalRequest(id: string): Promise<Proposal> {
  return proposalRequest<Proposal>(proposalPath(id), {}, 'Failed to load the proposal')
}

/** Owner-only: start a draft. Everything is optional. */
export function createProposalRequest(
  input: { prospect?: Partial<ProposalProspect>; clientId?: string | null } = {},
): Promise<Proposal> {
  return proposalRequest<Proposal>(
    '/api/proposals',
    proposalJson('POST', input),
    'Failed to create the proposal',
  )
}

/** Owner-only: edit a proposal; the answer is re-priced at the current catalog. */
export function updateProposalRequest(id: string, patch: ProposalPatch): Promise<Proposal> {
  return proposalRequest<Proposal>(
    proposalPath(id),
    proposalJson('PATCH', patch),
    'Failed to save the proposal',
  )
}

/** Owner-only: delete a DRAFT (409 with a sentence for anything else). */
export async function deleteProposalRequest(id: string): Promise<void> {
  await proposalRequest<{ removedProposalId: string }>(
    proposalPath(id),
    { method: 'DELETE' },
    'Failed to delete the proposal',
  )
}

/** Owner-only: "Copy to new proposal" — a new draft priced at today's catalog. */
export function copyProposalRequest(id: string): Promise<Proposal> {
  return proposalRequest<Proposal>(
    proposalPath(id, 'copy'),
    { method: 'POST' },
    'Failed to copy the proposal',
  )
}

/** Owner-only: "Reprice at today's catalog". */
export function repriceProposalRequest(id: string): Promise<Proposal> {
  return proposalRequest<Proposal>(
    proposalPath(id, 'reprice'),
    { method: 'POST' },
    'Failed to reprice the proposal',
  )
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run src/__tests__/proposal-routes.test.ts src/__tests__/package-routes.test.ts`
Expected: PASS — 22 proposal-route tests; the package suite is unchanged.

- [ ] **Step 5: Verify and commit**

Run: `node --check server.js` then `npm run verify` — expected green.

```bash
git add server.js src/lib/types.ts src/lib/api.ts src/__tests__/proposal-routes.test.ts
git commit -m "Owners can list, create, edit, copy, reprice and delete draft proposals through owner-only, same-origin endpoints" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The Proposals list replaces the Engagements placeholder

**Files:**
- Create: `src/pages/ProposalsPage.tsx`
- Create: `src/__tests__/proposals-page.test.tsx`
- Modify: `src/lib/proposals.ts` — replace the whole file (Task 3's labels stay, two helpers and a label map are added).
- Modify: `src/components/navItems.ts` — `const ENGAGEMENTS: NavItem = {` (~:57-62), the doc comment at ~:35, `ENGAGEMENTS,` in `navItems` (~:109), and the `{ items: [ENGAGEMENTS] }` section with its comment (~:136-139)
- Modify: `src/App.tsx` — `import { EngagementsPage } from './pages/EngagementsPage'` (~:171) and the `/engagements` route (~:4221-4228)
- Delete: `src/pages/EngagementsPage.tsx`

**Interfaces:**
- Consumes: `listProposalsRequest`, `createProposalRequest` (Task 5); `formatProposalMoney` (Task 1); `useAppContext().ownerMode`.
- Produces: `export function ProposalsPage()` at `/proposals` (owner-only); `PROPOSAL_STATUS_LABELS: Record<ProposalStatus, string>`, `proposalTitle(proposal): string`, `proposalDate(iso): string` in `src/lib/proposals.ts`; `/engagements` → `<Navigate to="/proposals" replace />`.

- [ ] **Step 1: Write the failing test** — create `src/__tests__/proposals-page.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AppContextValue } from '../AppContext'
import { ProposalsPage } from '../pages/ProposalsPage'
import type { Proposal } from '../lib/types'

/**
 * Proposals in the UI (featreq-311473e2 / featreq-ef18a38e). The server
 * prices everything; these pin what the pages ask it for and what they show.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))
vi.mock('../lib/api', () => ({
  listProposalsRequest: (...args: unknown[]) => api.listProposalsRequest(...args),
  createProposalRequest: (...args: unknown[]) => api.createProposalRequest(...args),
}))

const api: Record<string, Mock> = {}
let contextValue: AppContextValue

const PROPOSAL: Proposal = {
  id: 'prop-1',
  status: 'draft',
  prospect: {
    company: 'Acme Books',
    contactName: 'Pat Doe',
    email: 'pat@acme.test',
    phone: '',
    notes: '',
  },
  clientId: null,
  inputs: { transactions: 120 },
  selections: [{ serviceId: 'monthly-weekly-transactions-basic' }],
  pricingSnapshot: {
    rates: { bookkeeper: 75, accountant: 115, controller: 125 },
    lines: [
      {
        serviceId: 'monthly-weekly-transactions-basic',
        group: 'Monthly',
        name: 'Weekly transactions',
        tier: 'Basic',
        cadence: null,
        amount: 630,
        computedAmount: 630,
        formula: '120 transactions x 0.07 x $75/hr = $630.00',
        flag: null,
      },
    ],
    totals: { monthly: 630, annual: 0, oneTime: 0, cleanup: 0 },
    catalogAt: '2026-09-23T12:00:00.000Z',
  },
  letter: null,
  letterAt: null,
  messages: [],
  emailLog: [],
  sentAt: null,
  acceptedAt: null,
  declinedAt: null,
  declineNote: null,
  copiedFromId: null,
  createdBy: 'emp-patrice',
  createdAt: '2026-09-23T12:00:00.000Z',
  updatedAt: '2026-09-23T12:00:00.000Z',
}

const DECLINED: Proposal = {
  ...PROPOSAL,
  id: 'prop-2',
  status: 'declined',
  prospect: { ...PROPOSAL.prospect, company: 'Beta Farms', contactName: 'Lee' },
}

beforeEach(() => {
  contextValue = { ownerMode: true, data: { clients: [] } } as unknown as AppContextValue
  api.listProposalsRequest = vi.fn(async () => [PROPOSAL, DECLINED])
  api.createProposalRequest = vi.fn(async () => ({ ...PROPOSAL, id: 'prop-new' }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function renderList() {
  render(
    <MemoryRouter initialEntries={['/proposals']}>
      <Routes>
        <Route path="/proposals" element={<ProposalsPage />} />
        <Route path="/proposals/:proposalId" element={<p>Editor for the new draft</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('the Proposals list', () => {
  it('shows company, contact, status and the monthly total', async () => {
    renderList()
    expect(await screen.findByText('Acme Books')).toBeTruthy()
    expect(screen.getByText('Pat Doe')).toBeTruthy()
    expect(screen.getByText('Draft', { selector: '.status-pill' })).toBeTruthy()
    expect(screen.getAllByText('$630.00').length).toBeGreaterThan(0)
  })

  it('keeps declined proposals, and filters by status', async () => {
    renderList()
    expect(await screen.findByText('Beta Farms')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Status filter'), { target: { value: 'declined' } })
    expect(screen.queryByText('Acme Books')).toBeNull()
    expect(screen.getByText('Beta Farms')).toBeTruthy()
  })

  it('searches company, contact and email', async () => {
    renderList()
    await screen.findByText('Acme Books')
    fireEvent.change(screen.getByLabelText('Search proposals'), { target: { value: 'lee' } })
    expect(screen.queryByText('Acme Books')).toBeNull()
    expect(screen.getByText('Beta Farms')).toBeTruthy()
  })

  it('New proposal creates a draft and opens it', async () => {
    renderList()
    await screen.findByText('Acme Books')
    fireEvent.click(screen.getByRole('button', { name: 'New proposal' }))
    await waitFor(() => expect(api.createProposalRequest).toHaveBeenCalledWith({}))
    expect(await screen.findByText('Editor for the new draft')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/__tests__/proposals-page.test.tsx`
Expected: FAIL — cannot resolve `../pages/ProposalsPage`.

- [ ] **Step 3: Implement**

Replace the whole of `src/lib/proposals.ts` with:

```ts
import type {
  Proposal,
  ProposalMultiplier,
  ProposalPricingKind,
  ProposalRole,
  ProposalStatus,
} from './types'

/**
 * Words for the proposal catalog's enums (featreq-311473e2). One place, so the
 * Settings table and the proposal editor can never name the same thing twice
 * two different ways.
 */
export const PROPOSAL_ROLE_LABELS: Record<ProposalRole, string> = {
  bookkeeper: 'Bookkeeper (B)',
  accountant: 'Accountant (A)',
  controller: 'Controller (C)',
}

export const PROPOSAL_MULTIPLIER_LABELS: Record<ProposalMultiplier, string> = {
  none: 'None',
  'weekly-x4': 'Weekly (x 4)',
  'quarterly-div3': 'Quarterly (/ 3)',
  'yearly-div12': 'Yearly (/ 12)',
  'per-cleanup-month': 'Per clean-up month',
  'per-report': 'Per report',
  'per-form': 'Per form',
}

export const PROPOSAL_PRICING_LABELS: Record<ProposalPricingKind, string> = {
  formula: 'Formula',
  flat: 'Flat amount',
  payroll: 'Payroll block',
  'sales-tax': 'Sales tax block',
}

export const PROPOSAL_STATUS_LABELS: Record<ProposalStatus, string> = {
  draft: 'Draft',
  sent: 'Sent',
  accepted: 'Accepted',
  declined: 'Declined',
}

/** The name a proposal goes by in a list or a heading. */
export function proposalTitle(proposal: Pick<Proposal, 'prospect'>): string {
  return (
    proposal.prospect.company.trim() || proposal.prospect.contactName.trim() || 'Untitled prospect'
  )
}

/** "Sep 23, 2026" from an ISO timestamp; '' for anything else. */
export function proposalDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
```

Create `src/pages/ProposalsPage.tsx`:

```tsx
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAppContext } from '../AppContext'
import { formatProposalMoney } from '../../lib/proposal-pricing.js'
import { createProposalRequest, listProposalsRequest } from '../lib/api'
import { PROPOSAL_STATUS_LABELS, proposalDate, proposalTitle } from '../lib/proposals'
import { ApiError, type Proposal, type ProposalStatus } from '../lib/types'

const STATUSES = Object.keys(PROPOSAL_STATUS_LABELS) as ProposalStatus[]

/**
 * Proposals (featreq-311473e2) — the list. Replaces the Engagements
 * placeholder in the owner's sidebar. Every prospect's estimate is saved here,
 * declined ones included, so a prospect who comes back next year is reopened
 * as a copy rather than started from zero.
 */
export function ProposalsPage() {
  const { ownerMode } = useAppContext()
  const navigate = useNavigate()
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState<'all' | ProposalStatus>('all')
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    if (!ownerMode) return
    let cancelled = false
    void listProposalsRequest()
      .then((rows) => {
        if (cancelled) return
        setProposals(rows)
        setLoaded(true)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof ApiError ? err.message : 'Could not load proposals.')
        setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [ownerMode])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return proposals
      .filter((proposal) => status === 'all' || proposal.status === status)
      .filter(
        (proposal) =>
          !needle ||
          [proposal.prospect.company, proposal.prospect.contactName, proposal.prospect.email].some(
            (value) => value.toLowerCase().includes(needle),
          ),
      )
  }, [proposals, status, query])

  const startNew = async () => {
    setCreating(true)
    setError('')
    try {
      const created = await createProposalRequest({})
      navigate(`/proposals/${created.id}`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start a proposal.')
      setCreating(false)
    }
  }

  return (
    <section className="content-grid" id="proposals">
      <div className="panel">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Engagements</p>
            <h2>Proposals</h2>
            <p className="section-subtitle">
              Every prospect’s estimate, letter and outcome — saved, so you can reopen it later.
            </p>
          </div>
          <button
            className="primary-action"
            type="button"
            disabled={creating}
            onClick={() => void startNew()}
          >
            New proposal
          </button>
        </div>

        <div className="form-grid two-col">
          <label className="field">
            <span>Status</span>
            <select
              className="input"
              aria-label="Status filter"
              value={status}
              onChange={(event) => setStatus(event.target.value as 'all' | ProposalStatus)}
            >
              <option value="all">All</option>
              {STATUSES.map((value) => (
                <option key={value} value={value}>
                  {PROPOSAL_STATUS_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Search</span>
            <input
              className="input"
              type="search"
              aria-label="Search proposals"
              placeholder="Company, contact or email"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>

        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}

        {loaded && visible.length === 0 ? (
          <p className="muted-text">
            {proposals.length === 0
              ? 'No proposals yet — start one with New proposal.'
              : 'No proposals match.'}
          </p>
        ) : null}

        {visible.length > 0 ? (
          <div className="table-wrap">
            <table className="report-table">
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Contact</th>
                  <th>Status</th>
                  <th>Monthly</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((proposal) => (
                  <tr key={proposal.id}>
                    <td>
                      <Link to={`/proposals/${proposal.id}`}>{proposalTitle(proposal)}</Link>
                    </td>
                    <td>{proposal.prospect.contactName}</td>
                    <td>
                      <span className="status-pill">{PROPOSAL_STATUS_LABELS[proposal.status]}</span>
                    </td>
                    <td>{formatProposalMoney(proposal.pricingSnapshot?.totals.monthly ?? 0)}</td>
                    <td>{proposalDate(proposal.updatedAt ?? proposal.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </section>
  )
}
```

In `src/components/navItems.ts`, replace
```ts
const ENGAGEMENTS: NavItem = {
  to: '/engagements',
  label: 'Engagements',
  icon: Handshake,
  ownerOnly: true,
}
```
with
```ts
// Proposals took the Engagements placeholder's slot (featreq-311473e2); the old
// /engagements route redirects here.
const PROPOSALS: NavItem = {
  to: '/proposals',
  label: 'Proposals',
  icon: Handshake,
  ownerOnly: true,
}
```
replace ` * heading — that is how the standalone entries (Dashboard, Engagements, Team,` with ` * heading — that is how the standalone entries (Dashboard, Proposals, Team,`; in `navItems` replace
```ts
  DELAYED,
  ENGAGEMENTS,
  CLIENTS,
```
with
```ts
  DELAYED,
  PROPOSALS,
  CLIENTS,
```
and in `navSections` replace
```ts
  // Nothing lives here until the intake form and proposals ship (P2/P3); the
  // page itself explains that, so the section is visible rather than a
  // surprise appearing later.
  { items: [ENGAGEMENTS] },
```
with
```ts
  // The Engagements slot: winning new work, before a client is a client.
  { items: [PROPOSALS] },
```

In `src/App.tsx`, replace
```tsx
import { EngagementsPage } from './pages/EngagementsPage'
```
with
```tsx
import { ProposalsPage } from './pages/ProposalsPage'
```
and replace
```tsx
        <Route
          path="/engagements"
          element={
            <OwnerOnly ownerMode={ownerMode}>
              <EngagementsPage />
            </OwnerOnly>
          }
        />
```
with
```tsx
        {/* The Engagements placeholder became Proposals (featreq-311473e2);
            an old bookmark lands on the list. */}
        <Route path="/engagements" element={<Navigate to="/proposals" replace />} />
        <Route
          path="/proposals"
          element={
            <OwnerOnly ownerMode={ownerMode}>
              <ProposalsPage />
            </OwnerOnly>
          }
        />
```

Delete the placeholder: `git rm src/pages/EngagementsPage.tsx` (nothing else imports it; `grep -rn EngagementsPage src` must come back empty).

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run src/__tests__/proposals-page.test.tsx`
Expected: PASS — 4 tests.

- [ ] **Step 5: Verify and commit**

Run: `npm run verify` — expected green.

```bash
git add src/pages/ProposalsPage.tsx src/__tests__/proposals-page.test.tsx src/lib/proposals.ts src/components/navItems.ts src/App.tsx
git commit -m "Proposals takes the Engagements slot in the owner's sidebar: every prospect's proposal listed with status, monthly total, a filter and a search" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
(`git rm` already staged the deletion.)

---

### Task 7: The proposal editor — Estimate, Letter and Activity tabs

**Files:**
- Create: `src/pages/ProposalEditorPage.tsx`
- Create: `src/components/proposals/EstimateTab.tsx`
- Create: `src/components/proposals/LetterTab.tsx`
- Create: `src/components/proposals/ActivityTab.tsx`
- Modify: `src/lib/proposals.ts` — the type import at the top; append after `export function proposalDate(`.
- Modify: `src/App.tsx` — the Task 6 import `import { ProposalsPage } from './pages/ProposalsPage'` and the Task 6 `/proposals` route.
- Modify: `src/App.css` — append at the end.
- Modify: `src/__tests__/proposals-page.test.tsx` — replace the whole file.

**Interfaces:**
- Consumes: `getProposalRequest`, `updateProposalRequest`, `repriceProposalRequest`, `copyProposalRequest`, `deleteProposalRequest` (Task 5); `fetchFirmSettings` (existing, now carrying `proposalPricing`); `defaultProposalPricing`, `formatProposalMoney` (Task 1); `SavingTextInput`, `SavingTextarea`, `SavingNumberInput` (SectionKit); `useAppContext().data.clients`.
- Produces: `/proposals/:proposalId` → `ProposalEditorPage` (owner-only), tabs through `?tab=estimate|letter|activity` (the `task-area-tabs` pattern of `ClientDetailPage`); `EstimateTab({ proposal, pricing, clients, busy, onSave, onReprice })`; `LetterTab({ proposal })` (read-only for now); `ActivityTab({ proposal })`; in `src/lib/proposals.ts`: `ProposalTab`, `PROPOSAL_TABS`, `resolveProposalTab(param)`, `PROPOSAL_TOTAL_LABELS`, `PickerRow`, `pickerGroups(services)`, `selectService(selections, rowOptions, serviceId | null)`, `updateSelection(selections, serviceId, patch)`, `withInput(inputs, key, value | null)`, `proposalActivity(proposal) -> Array<{ at, text }>`.

- [ ] **Step 1: Write the failing tests** — replace the whole of `src/__tests__/proposals-page.test.tsx` with:

```tsx
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AppContextValue } from '../AppContext'
import { defaultProposalPricing } from '../../lib/proposal-pricing.js'
import { ProposalEditorPage } from '../pages/ProposalEditorPage'
import { ProposalsPage } from '../pages/ProposalsPage'
import type { Proposal } from '../lib/types'

/**
 * Proposals in the UI (featreq-311473e2 / featreq-ef18a38e). The server
 * prices everything; these pin what the pages ask it for and what they show.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))
vi.mock('../lib/api', () => ({
  listProposalsRequest: (...args: unknown[]) => api.listProposalsRequest(...args),
  createProposalRequest: (...args: unknown[]) => api.createProposalRequest(...args),
  getProposalRequest: (...args: unknown[]) => api.getProposalRequest(...args),
  fetchFirmSettings: (...args: unknown[]) => api.fetchFirmSettings(...args),
  updateProposalRequest: (...args: unknown[]) => api.updateProposalRequest(...args),
  repriceProposalRequest: (...args: unknown[]) => api.repriceProposalRequest(...args),
  copyProposalRequest: (...args: unknown[]) => api.copyProposalRequest(...args),
  deleteProposalRequest: (...args: unknown[]) => api.deleteProposalRequest(...args),
}))

const api: Record<string, Mock> = {}
let contextValue: AppContextValue

const PROPOSAL: Proposal = {
  id: 'prop-1',
  status: 'draft',
  prospect: {
    company: 'Acme Books',
    contactName: 'Pat Doe',
    email: 'pat@acme.test',
    phone: '',
    notes: '',
  },
  clientId: null,
  inputs: { transactions: 120 },
  selections: [{ serviceId: 'monthly-weekly-transactions-basic' }],
  pricingSnapshot: {
    rates: { bookkeeper: 75, accountant: 115, controller: 125 },
    lines: [
      {
        serviceId: 'monthly-weekly-transactions-basic',
        group: 'Monthly',
        name: 'Weekly transactions',
        tier: 'Basic',
        cadence: null,
        amount: 630,
        computedAmount: 630,
        formula: '120 transactions x 0.07 x $75/hr = $630.00',
        flag: null,
      },
    ],
    totals: { monthly: 630, annual: 0, oneTime: 0, cleanup: 0 },
    catalogAt: '2026-09-23T12:00:00.000Z',
  },
  letter: null,
  letterAt: null,
  messages: [],
  emailLog: [],
  sentAt: null,
  acceptedAt: null,
  declinedAt: null,
  declineNote: null,
  copiedFromId: null,
  createdBy: 'emp-patrice',
  createdAt: '2026-09-23T12:00:00.000Z',
  updatedAt: '2026-09-23T12:00:00.000Z',
}

const DECLINED: Proposal = {
  ...PROPOSAL,
  id: 'prop-2',
  status: 'declined',
  prospect: { ...PROPOSAL.prospect, company: 'Beta Farms', contactName: 'Lee' },
}

/** What the server answers once Reconciliations is picked: re-priced, not computed here. */
const WITH_RECONCILIATIONS: Proposal = {
  ...PROPOSAL,
  selections: [...PROPOSAL.selections, { serviceId: 'reconciliations' }],
  pricingSnapshot: {
    ...PROPOSAL.pricingSnapshot!,
    lines: [
      ...PROPOSAL.pricingSnapshot!.lines,
      {
        serviceId: 'reconciliations',
        group: 'Reconciliations',
        name: 'Reconciliations',
        tier: null,
        cadence: null,
        amount: 375,
        computedAmount: 375,
        formula: '20 balance sheet accounts x 0.25 x $75/hr = $375.00',
        flag: null,
      },
    ],
    totals: { monthly: 1005, annual: 0, oneTime: 0, cleanup: 0 },
  },
}

beforeEach(() => {
  contextValue = {
    ownerMode: true,
    data: { clients: [{ id: 'client-1', name: 'Existing Co' }] },
  } as unknown as AppContextValue
  api.listProposalsRequest = vi.fn(async () => [PROPOSAL, DECLINED])
  api.createProposalRequest = vi.fn(async () => ({ ...PROPOSAL, id: 'prop-new' }))
  api.getProposalRequest = vi.fn(async () => PROPOSAL)
  api.fetchFirmSettings = vi.fn(async () => ({
    name: 'PB&J',
    proposalPricing: {
      ...defaultProposalPricing(),
      rates: { bookkeeper: 75, accountant: 115, controller: 125 },
    },
  }))
  api.updateProposalRequest = vi.fn(async () => WITH_RECONCILIATIONS)
  api.repriceProposalRequest = vi.fn(async () => PROPOSAL)
  api.copyProposalRequest = vi.fn(async () => ({ ...PROPOSAL, id: 'prop-copy' }))
  api.deleteProposalRequest = vi.fn(async () => undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function renderList() {
  render(
    <MemoryRouter initialEntries={['/proposals']}>
      <Routes>
        <Route path="/proposals" element={<ProposalsPage />} />
        <Route path="/proposals/:proposalId" element={<p>Editor for the new draft</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

function renderEditor(entry = '/proposals/prop-1') {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/proposals" element={<p>The proposals list</p>} />
        <Route path="/proposals/:proposalId" element={<ProposalEditorPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('the Proposals list', () => {
  it('shows company, contact, status and the monthly total', async () => {
    renderList()
    expect(await screen.findByText('Acme Books')).toBeTruthy()
    expect(screen.getByText('Pat Doe')).toBeTruthy()
    expect(screen.getByText('Draft', { selector: '.status-pill' })).toBeTruthy()
    expect(screen.getAllByText('$630.00').length).toBeGreaterThan(0)
  })

  it('keeps declined proposals, and filters by status', async () => {
    renderList()
    expect(await screen.findByText('Beta Farms')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Status filter'), { target: { value: 'declined' } })
    expect(screen.queryByText('Acme Books')).toBeNull()
    expect(screen.getByText('Beta Farms')).toBeTruthy()
  })

  it('searches company, contact and email', async () => {
    renderList()
    await screen.findByText('Acme Books')
    fireEvent.change(screen.getByLabelText('Search proposals'), { target: { value: 'lee' } })
    expect(screen.queryByText('Acme Books')).toBeNull()
    expect(screen.getByText('Beta Farms')).toBeTruthy()
  })

  it('New proposal creates a draft and opens it', async () => {
    renderList()
    await screen.findByText('Acme Books')
    fireEvent.click(screen.getByRole('button', { name: 'New proposal' }))
    await waitFor(() => expect(api.createProposalRequest).toHaveBeenCalledWith({}))
    expect(await screen.findByText('Editor for the new draft')).toBeTruthy()
  })
})

describe('the proposal editor', () => {
  it('opens on the Estimate tab and moves between tabs through the URL', async () => {
    renderEditor()
    const estimate = await screen.findByRole('tab', { name: 'Estimate' })
    expect(estimate.getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('tab', { name: 'Letter' }))
    expect(screen.getByRole('tab', { name: 'Letter' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText(/No letter yet/)).toBeTruthy()
  })

  it('opens straight to a tab named in ?tab=', async () => {
    renderEditor('/proposals/prop-1?tab=activity')
    expect(await screen.findByText('What happened')).toBeTruthy()
    expect(screen.getByText('Created')).toBeTruthy()
  })

  it('shows each priced line with its formula, and the four totals', async () => {
    renderEditor()
    expect(await screen.findByText('120 transactions x 0.07 x $75/hr = $630.00')).toBeTruthy()
    for (const label of ['Monthly fee', 'Annual fees', 'One-time fees', 'Clean-up']) {
      expect(screen.getByText(label, { selector: 'dt' })).toBeTruthy()
    }
  })

  it('picking a service saves the selection and shows the line the server priced', async () => {
    renderEditor()
    fireEvent.click(await screen.findByLabelText('Reconciliations: Reconciliations'))
    await waitFor(() =>
      expect(api.updateProposalRequest).toHaveBeenCalledWith('prop-1', {
        selections: [
          { serviceId: 'monthly-weekly-transactions-basic' },
          { serviceId: 'reconciliations' },
        ],
      }),
    )
    expect(await screen.findByText('20 balance sheet accounts x 0.25 x $75/hr = $375.00')).toBeTruthy()
    expect(screen.getByText('$1,005.00')).toBeTruthy()
  })

  it('choosing another tier replaces the one that was picked', async () => {
    renderEditor()
    const row = await screen.findByRole('radiogroup', { name: 'Monthly: Weekly transactions' })
    fireEvent.click(within(row).getByLabelText('Advance'))
    await waitFor(() =>
      expect(api.updateProposalRequest).toHaveBeenCalledWith('prop-1', {
        selections: [{ serviceId: 'monthly-weekly-transactions-advance' }],
      }),
    )
  })

  it('an override saves beside the computed price', async () => {
    renderEditor()
    const override = await screen.findByLabelText('Override Monthly: Weekly transactions Basic')
    fireEvent.change(override, { target: { value: '600' } })
    fireEvent.blur(override)
    await waitFor(() =>
      expect(api.updateProposalRequest).toHaveBeenCalledWith('prop-1', {
        selections: [{ serviceId: 'monthly-weekly-transactions-basic', override: 600 }],
      }),
    )
  })

  it('a count saves as a number beside the others', async () => {
    renderEditor()
    const input = await screen.findByLabelText('Balance sheet accounts')
    fireEvent.change(input, { target: { value: '20' } })
    fireEvent.blur(input)
    await waitFor(() =>
      expect(api.updateProposalRequest).toHaveBeenCalledWith('prop-1', {
        inputs: { transactions: 120, balanceSheetAccounts: 20 },
      }),
    )
  })

  it('reprices a draft at today’s catalog', async () => {
    renderEditor()
    fireEvent.click(await screen.findByRole('button', { name: 'Reprice at today’s catalog' }))
    await waitFor(() => expect(api.repriceProposalRequest).toHaveBeenCalledWith('prop-1'))
  })

  it('copies to a new draft and opens it', async () => {
    renderEditor()
    fireEvent.click(await screen.findByRole('button', { name: 'Copy to new proposal' }))
    await waitFor(() => expect(api.copyProposalRequest).toHaveBeenCalledWith('prop-1'))
    await waitFor(() => expect(api.getProposalRequest).toHaveBeenCalledWith('prop-copy'))
  })

  it('deletes a draft only after a confirm', async () => {
    const confirm = vi.fn(() => false)
    vi.stubGlobal('confirm', confirm)
    renderEditor()
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    expect(confirm).toHaveBeenCalled()
    expect(api.deleteProposalRequest).not.toHaveBeenCalled()

    confirm.mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(await screen.findByText('The proposals list')).toBeTruthy()
    expect(api.deleteProposalRequest).toHaveBeenCalledWith('prop-1')
  })

  it('locks the estimate of a declined proposal and offers no Delete', async () => {
    api.getProposalRequest = vi.fn(async () => DECLINED)
    renderEditor('/proposals/prop-2')
    const company = await screen.findByLabelText('Company')
    expect(company.closest('fieldset')?.disabled).toBe(true)
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reprice at today’s catalog' })).toBeNull()
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/__tests__/proposals-page.test.tsx`
Expected: FAIL — cannot resolve `../pages/ProposalEditorPage`.

- [ ] **Step 3: Implement**

In `src/lib/proposals.ts`, replace the import
```ts
import type {
  Proposal,
  ProposalMultiplier,
  ProposalPricingKind,
  ProposalRole,
  ProposalStatus,
} from './types'
```
with
```ts
import type {
  Proposal,
  ProposalGroup,
  ProposalMultiplier,
  ProposalPricingKind,
  ProposalRole,
  ProposalSelection,
  ProposalService,
  ProposalStatus,
  ProposalTotals,
} from './types'
```
and append after `export function proposalDate(…) { … }`:

```ts

/* ---- The editor's tabs ------------------------------------------------- */

export type ProposalTab = 'estimate' | 'letter' | 'activity'

export const PROPOSAL_TABS: Array<{ key: ProposalTab; label: string }> = [
  { key: 'estimate', label: 'Estimate' },
  { key: 'letter', label: 'Letter' },
  { key: 'activity', label: 'Activity' },
]

/** `?tab=` wins when it names a tab; anything else is the Estimate. */
export function resolveProposalTab(param: string | null): ProposalTab {
  return PROPOSAL_TABS.some((tab) => tab.key === param) ? (param as ProposalTab) : 'estimate'
}

/** The four totals, in the order the estimate and the PDF show them. */
export const PROPOSAL_TOTAL_LABELS: Array<[keyof ProposalTotals, string]> = [
  ['monthly', 'Monthly fee'],
  ['annual', 'Annual fees'],
  ['oneTime', 'One-time fees'],
  ['cleanup', 'Clean-up'],
]

/* ---- The service picker ------------------------------------------------ */

/**
 * One line of the picker: a service NAME within a group, with every tier of it
 * as an option. "Weekly transactions" is one row with Basic / Classes /
 * Advance; "Reconciliations" is one row with a single option.
 */
export type PickerRow = {
  key: string
  group: ProposalGroup
  name: string
  options: ProposalService[]
}

/** The active catalog, grouped for the picker, in catalog order. */
export function pickerGroups(
  services: readonly ProposalService[],
): Array<{ group: ProposalGroup; rows: PickerRow[] }> {
  const groups: Array<{ group: ProposalGroup; rows: PickerRow[] }> = []
  const sorted = services
    .filter((service) => service.active)
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
  for (const service of sorted) {
    let bucket = groups.find((entry) => entry.group === service.group)
    if (!bucket) {
      bucket = { group: service.group, rows: [] }
      groups.push(bucket)
    }
    const key = `${service.group}::${service.name}`
    const row = bucket.rows.find((entry) => entry.key === key)
    if (row) row.options.push(service)
    else bucket.rows.push({ key, group: service.group, name: service.name, options: [service] })
  }
  return groups
}

/**
 * Pick one option of a picker row (or none): every option of the row is
 * removed, then the chosen one is added back — keeping its typed fields if it
 * was already selected. A client is on Basic OR Advance, never both.
 */
export function selectService(
  selections: readonly ProposalSelection[],
  rowOptions: readonly ProposalService[],
  serviceId: string | null,
): ProposalSelection[] {
  const optionIds = new Set(rowOptions.map((option) => option.id))
  const previous = serviceId ? selections.find((entry) => entry.serviceId === serviceId) : undefined
  const rest = selections.filter((entry) => !optionIds.has(entry.serviceId))
  return serviceId ? [...rest, previous ?? { serviceId }] : rest
}

/** Merge fields into one selection; a null or undefined value removes the field. */
export function updateSelection(
  selections: readonly ProposalSelection[],
  serviceId: string,
  patch: Partial<Record<Exclude<keyof ProposalSelection, 'serviceId'>, unknown>>,
): ProposalSelection[] {
  return selections.map((entry) => {
    if (entry.serviceId !== serviceId) return entry
    const next: Record<string, unknown> = { ...entry }
    for (const [field, value] of Object.entries(patch)) {
      if (value === null || value === undefined) delete next[field]
      else next[field] = value
    }
    return next as ProposalSelection
  })
}

/** A count typed into the inputs panel; blank removes it. */
export function withInput(
  inputs: Readonly<Record<string, number>>,
  key: string,
  value: number | null,
): Record<string, number> {
  const next = { ...inputs }
  if (value === null) delete next[key]
  else next[key] = value
  return next
}

/* ---- Activity ------------------------------------------------------------ */

const DELIVERY_WORDS: Record<string, string> = {
  sent: 'Accepted by the mail provider',
  delivered: 'Delivered',
  delayed: 'Delivery delayed',
  bounced: 'Bounced',
  complained: 'Marked as spam',
}

/** What happened to a proposal, oldest first: created, letter, sends, delivery, outcome. */
export function proposalActivity(proposal: Proposal): Array<{ at: string; text: string }> {
  const entries: Array<{ at: string; text: string }> = [
    {
      at: proposal.createdAt,
      text: proposal.copiedFromId ? `Created as a copy of ${proposal.copiedFromId}` : 'Created',
    },
  ]
  if (proposal.letterAt) entries.push({ at: proposal.letterAt, text: 'Letter drafted' })
  for (const entry of proposal.emailLog) {
    const to = entry.to.join(', ')
    if (entry.kind === 'send') {
      entries.push({
        at: entry.at,
        text: entry.ok ? `Sent to ${to}` : `Send to ${to} failed: ${entry.error ?? 'unknown error'}`,
      })
    } else {
      const word = DELIVERY_WORDS[entry.event ?? ''] ?? entry.event ?? 'Delivery event'
      entries.push({ at: entry.at, text: `${word}${to ? ` (${to})` : ''}` })
    }
  }
  if (proposal.acceptedAt) entries.push({ at: proposal.acceptedAt, text: 'Accepted' })
  if (proposal.declinedAt) {
    entries.push({
      at: proposal.declinedAt,
      text: `Declined${proposal.declineNote ? `: ${proposal.declineNote}` : ''}`,
    })
  }
  return entries.sort((a, b) => a.at.localeCompare(b.at))
}
```

Create `src/components/proposals/EstimateTab.tsx`:

```tsx
import { formatProposalMoney } from '../../../lib/proposal-pricing.js'
import { SavingNumberInput, SavingTextarea, SavingTextInput } from '../SectionKit'
import {
  PROPOSAL_TOTAL_LABELS,
  pickerGroups,
  selectService,
  updateSelection,
  withInput,
  type PickerRow,
} from '../../lib/proposals'
import type {
  PayrollRun,
  Proposal,
  ProposalPatch,
  ProposalPricing,
  ProposalProspect,
  ProposalSelection,
  ProposalService,
} from '../../lib/types'

const PROSPECT_FIELDS: Array<[Exclude<keyof ProposalProspect, 'notes'>, string]> = [
  ['company', 'Company'],
  ['contactName', 'Contact'],
  ['email', 'Email'],
  ['phone', 'Phone'],
]

const PER_COUNT_MULTIPLIERS = new Set(['per-form', 'per-report', 'per-cleanup-month'])

const serviceLabel = (service: Pick<ProposalService, 'name' | 'tier'>) =>
  service.tier ? `${service.name} ${service.tier}` : service.name

/**
 * The Estimate tab (spec §5.1): the prospect, the counts, the service picker,
 * and the lines the SERVER priced. Every change is a PATCH; the answer carries
 * the re-priced snapshot, so nothing on this page multiplies anything.
 */
export function EstimateTab({
  proposal,
  pricing,
  clients,
  busy,
  onSave,
  onReprice,
}: {
  proposal: Proposal
  pricing: ProposalPricing
  clients: ReadonlyArray<{ id: string; name: string }>
  busy: boolean
  onSave: (patch: ProposalPatch) => void
  onReprice: () => void
}) {
  const locked = proposal.status === 'accepted' || proposal.status === 'declined'
  const snapshot = proposal.pricingSnapshot
  const saveSelections = (selections: ProposalSelection[]) => onSave({ selections })

  return (
    <div className="proposal-estimate">
      <fieldset className="proposal-fieldset" disabled={locked}>
        <section className="panel">
          <h3>Prospect</h3>
          <div className="form-grid two-col">
            {PROSPECT_FIELDS.map(([field, label]) => (
              <label className="field" key={field}>
                <span>{label}</span>
                <SavingTextInput
                  ariaLabel={label}
                  canonical={proposal.prospect[field]}
                  onCommit={(value) => onSave({ prospect: { ...proposal.prospect, [field]: value } })}
                />
              </label>
            ))}
            <label className="field">
              <span>Existing client (optional)</span>
              <select
                className="input"
                aria-label="Existing client"
                value={proposal.clientId ?? ''}
                onChange={(event) => onSave({ clientId: event.target.value || null })}
              >
                <option value="">A new prospect</option>
                {clients.map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field full-row">
              <span>Notes</span>
              <SavingTextarea
                ariaLabel="Notes"
                canonical={proposal.prospect.notes}
                onCommit={(value) => onSave({ prospect: { ...proposal.prospect, notes: value } })}
              />
            </label>
          </div>
        </section>

        <section className="panel">
          <h3>What they told you</h3>
          <div className="form-grid two-col">
            {pricing.inputs.map((input) => (
              <label className="field" key={input.key}>
                <span>{input.label}</span>
                <SavingNumberInput
                  ariaLabel={input.label}
                  canonical={proposal.inputs[input.key] ?? null}
                  min="0"
                  step="1"
                  onCommit={(value) => onSave({ inputs: withInput(proposal.inputs, input.key, value) })}
                />
              </label>
            ))}
          </div>
        </section>

        <section className="panel">
          <h3>Services</h3>
          {pickerGroups(pricing.services).map(({ group, rows }) => (
            <fieldset className="proposal-picker-group" key={group}>
              <legend>{group}</legend>
              {rows.map((row) => (
                <PickerRowControl
                  key={row.key}
                  row={row}
                  selections={proposal.selections}
                  onChange={saveSelections}
                />
              ))}
            </fieldset>
          ))}
        </section>
      </fieldset>

      <section className="panel">
        <div className="section-heading">
          <h3>Estimate</h3>
          {proposal.status === 'draft' ? (
            <button type="button" className="secondary-action" disabled={busy} onClick={onReprice}>
              Reprice at today’s catalog
            </button>
          ) : null}
        </div>
        {snapshot && snapshot.lines.length > 0 ? (
          <div className="table-wrap">
            <table className="report-table proposal-lines">
              <tbody>
                {snapshot.lines.map((line) => {
                  const label = `${line.group}: ${serviceLabel(line)}`
                  const selection = proposal.selections.find(
                    (entry) => entry.serviceId === line.serviceId,
                  )
                  return (
                    <tr key={line.serviceId}>
                      <td>
                        <strong>{line.tier ? `${line.name} (${line.tier})` : line.name}</strong>
                        <div className="proposal-line-formula">{line.formula}</div>
                        {line.flag ? (
                          <div className="form-error">
                            This row names an input the catalog no longer has.
                          </div>
                        ) : null}
                      </td>
                      <td className="proposal-line-amount">{formatProposalMoney(line.amount)}</td>
                      <td>
                        <SavingNumberInput
                          ariaLabel={`Override ${label}`}
                          canonical={selection?.override ?? null}
                          placeholder="Override"
                          min="0"
                          step="0.01"
                          onCommit={(value) =>
                            saveSelections(
                              updateSelection(proposal.selections, line.serviceId, { override: value }),
                            )
                          }
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted-text">Pick services above and fill in the counts to price them.</p>
        )}
        <dl className="proposal-totals">
          {PROPOSAL_TOTAL_LABELS.map(([key, label]) => (
            <div key={key}>
              <dt>{label}</dt>
              <dd>{formatProposalMoney(snapshot?.totals[key] ?? 0)}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  )
}

function PickerRowControl({
  row,
  selections,
  onChange,
}: {
  row: PickerRow
  selections: readonly ProposalSelection[]
  onChange: (next: ProposalSelection[]) => void
}) {
  const chosen = row.options.find((option) =>
    selections.some((entry) => entry.serviceId === option.id),
  )
  const selection = chosen ? selections.find((entry) => entry.serviceId === chosen.id) : undefined
  const pick = (serviceId: string | null) => onChange(selectService(selections, row.options, serviceId))
  const rowLabel = `${row.group}: ${row.name}`
  const single = row.options.length === 1 && !row.options[0].tier

  return (
    <div className="proposal-picker-row">
      {single ? (
        <label className="toggle-label">
          <input
            type="checkbox"
            aria-label={rowLabel}
            checked={Boolean(chosen)}
            onChange={(event) => pick(event.target.checked ? row.options[0].id : null)}
          />
          {row.name}
        </label>
      ) : (
        <div role="radiogroup" aria-label={rowLabel} className="proposal-picker-tiers">
          <span className="proposal-picker-name">{row.name}</span>
          <label>
            <input type="radio" name={row.key} checked={!chosen} onChange={() => pick(null)} /> None
          </label>
          {row.options.map((option) => (
            <label key={option.id}>
              <input
                type="radio"
                name={row.key}
                checked={chosen?.id === option.id}
                onChange={() => pick(option.id)}
              />{' '}
              {option.tier ?? option.name}
            </label>
          ))}
        </div>
      )}
      {chosen && selection ? (
        <SelectionFields
          service={chosen}
          selection={selection}
          onChange={(patch) => onChange(updateSelection(selections, chosen.id, patch))}
        />
      ) : null}
    </div>
  )
}

/** The per-row extras a service needs: a count, a typed amount, the payroll run, the review. */
function SelectionFields({
  service,
  selection,
  onChange,
}: {
  service: ProposalService
  selection: ProposalSelection
  onChange: (patch: Partial<Record<Exclude<keyof ProposalSelection, 'serviceId'>, unknown>>) => void
}) {
  const label = `${service.group}: ${serviceLabel(service)}`
  return (
    <div className="proposal-picker-extras">
      {PER_COUNT_MULTIPLIERS.has(service.multiplier) ? (
        <label className="field">
          <span>Count (blank uses the input)</span>
          <SavingNumberInput
            ariaLabel={`Count for ${label}`}
            canonical={selection.quantity ?? null}
            min="0"
            step="1"
            onCommit={(value) => onChange({ quantity: value })}
          />
        </label>
      ) : null}
      {service.pricing === 'flat' ? (
        <label className="field">
          <span>Amount</span>
          <SavingNumberInput
            ariaLabel={`Amount for ${label}`}
            canonical={selection.flatAmount ?? null}
            min="0"
            step="0.01"
            onCommit={(value) => onChange({ flatAmount: value })}
          />
        </label>
      ) : null}
      {service.pricing === 'payroll' ? (
        <>
          <label className="field">
            <span>Payroll run</span>
            <select
              className="input"
              aria-label="Payroll run"
              value={selection.payrollRun ?? 'monthly'}
              onChange={(event) => onChange({ payrollRun: event.target.value as PayrollRun })}
            >
              <option value="weekly">Weekly</option>
              <option value="biweekly">Bi-weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </label>
          <label className="toggle-label">
            <input
              type="checkbox"
              checked={selection.includeBonus === true}
              onChange={(event) => onChange({ includeBonus: event.target.checked })}
            />
            Include bonus
          </label>
        </>
      ) : null}
      {service.pricing === 'sales-tax' ? (
        <label className="toggle-label">
          <input
            type="checkbox"
            aria-label={`Include the review for ${service.name}`}
            checked={selection.includeReview === true}
            onChange={(event) => onChange({ includeReview: event.target.checked })}
          />
          Include the review
        </label>
      ) : null}
    </div>
  )
}
```

Create `src/components/proposals/LetterTab.tsx`:

```tsx
import type { Proposal } from '../../lib/types'

/** The Letter tab: the saved letter text, read-only. */
export function LetterTab({ proposal }: { proposal: Proposal }) {
  return (
    <section className="panel">
      <h3>Letter</h3>
      {proposal.letter?.text ? (
        <pre className="proposal-letter-text">{proposal.letter.text}</pre>
      ) : (
        <p className="muted-text">No letter yet — it is drafted from this estimate.</p>
      )}
    </section>
  )
}
```

Create `src/components/proposals/ActivityTab.tsx`:

```tsx
import { proposalActivity, proposalDate } from '../../lib/proposals'
import type { Proposal } from '../../lib/types'

/** The Activity tab (spec §5.1): sends, delivery, status changes, and the intake chat. */
export function ActivityTab({ proposal }: { proposal: Proposal }) {
  return (
    <div className="proposal-activity">
      <section className="panel">
        <h3>What happened</h3>
        <ul className="proposal-activity-list">
          {proposalActivity(proposal).map((entry, index) => (
            <li key={`${entry.at}-${index}`}>
              <span className="muted-text">{proposalDate(entry.at)}</span> {entry.text}
            </li>
          ))}
        </ul>
      </section>
      <section className="panel">
        <h3>Intake conversation</h3>
        {proposal.messages.length === 0 ? (
          <p className="muted-text">No conversation yet.</p>
        ) : (
          <ol className="proposal-transcript">
            {proposal.messages.map((message, index) => (
              <li key={`${message.at}-${index}`} className={`proposal-turn is-${message.role}`}>
                <strong>{message.role === 'user' ? 'You' : 'Assistant'}:</strong> {message.text}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  )
}
```

Create `src/pages/ProposalEditorPage.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useAppContext } from '../AppContext'
import { ActivityTab } from '../components/proposals/ActivityTab'
import { EstimateTab } from '../components/proposals/EstimateTab'
import { LetterTab } from '../components/proposals/LetterTab'
import { defaultProposalPricing } from '../../lib/proposal-pricing.js'
import {
  copyProposalRequest,
  deleteProposalRequest,
  fetchFirmSettings,
  getProposalRequest,
  repriceProposalRequest,
  updateProposalRequest,
} from '../lib/api'
import {
  PROPOSAL_STATUS_LABELS,
  PROPOSAL_TABS,
  proposalTitle,
  resolveProposalTab,
  type ProposalTab,
} from '../lib/proposals'
import { ApiError, type Proposal, type ProposalPatch, type ProposalPricing } from '../lib/types'

/**
 * One proposal (spec §5.1): Estimate, Letter and Activity tabs, the tab in
 * `?tab=` like the client page, and the header actions. The proposal on screen
 * is always the server's latest answer — every save swaps it in whole.
 */
export function ProposalEditorPage() {
  const { proposalId = '' } = useParams()
  const { data } = useAppContext()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [pricing, setPricing] = useState<ProposalPricing | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void Promise.all([getProposalRequest(proposalId), fetchFirmSettings()])
      .then(([loaded, firm]) => {
        if (cancelled) return
        setProposal(loaded)
        setPricing(firm.proposalPricing ?? defaultProposalPricing())
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : 'Could not load this proposal.')
        }
      })
    return () => {
      cancelled = true
    }
  }, [proposalId])

  const run = async (action: () => Promise<Proposal>) => {
    setBusy(true)
    setError('')
    try {
      setProposal(await action())
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That did not save — try again.')
    } finally {
      setBusy(false)
    }
  }
  const save = (patch: ProposalPatch) => {
    void run(() => updateProposalRequest(proposalId, patch))
  }

  const tab = resolveProposalTab(searchParams.get('tab'))
  const setTab = (next: ProposalTab) => {
    const params = new URLSearchParams(searchParams)
    params.set('tab', next)
    setSearchParams(params, { replace: true })
  }

  const copy = async () => {
    setBusy(true)
    setError('')
    try {
      const created = await copyProposalRequest(proposalId)
      navigate(`/proposals/${created.id}`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not copy this proposal.')
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!window.confirm('Delete this draft? This cannot be undone.')) return
    setBusy(true)
    setError('')
    try {
      await deleteProposalRequest(proposalId)
      navigate('/proposals')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete this proposal.')
      setBusy(false)
    }
  }

  if (!proposal || !pricing) {
    return (
      <section className="panel">
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : (
          <p>Loading the proposal…</p>
        )}
      </section>
    )
  }

  return (
    <section className="content-grid proposal-editor">
      <header className="client-detail-header">
        <div>
          <p className="section-kicker">
            <Link to="/proposals">Proposals</Link>
          </p>
          <h1>{proposalTitle(proposal)}</h1>
          <span className="status-pill">{PROPOSAL_STATUS_LABELS[proposal.status]}</span>
        </div>
        <div className="button-row">
          <button type="button" className="secondary-action" disabled={busy} onClick={() => void copy()}>
            Copy to new proposal
          </button>
          {proposal.status === 'draft' ? (
            <button type="button" className="ghost-action" disabled={busy} onClick={() => void remove()}>
              Delete
            </button>
          ) : null}
        </div>
      </header>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="task-area-tabs" role="tablist" aria-label="Proposal sections">
        {PROPOSAL_TABS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={entry.key === tab}
            className={`task-area-tab${entry.key === tab ? ' is-active' : ''}`}
            onClick={() => setTab(entry.key)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tab === 'estimate' ? (
        <EstimateTab
          proposal={proposal}
          pricing={pricing}
          clients={data.clients}
          busy={busy}
          onSave={save}
          onReprice={() => void run(() => repriceProposalRequest(proposalId))}
        />
      ) : null}
      {tab === 'letter' ? <LetterTab proposal={proposal} /> : null}
      {tab === 'activity' ? <ActivityTab proposal={proposal} /> : null}
    </section>
  )
}
```

In `src/App.tsx`, replace
```tsx
import { ProposalsPage } from './pages/ProposalsPage'
```
with
```tsx
import { ProposalEditorPage } from './pages/ProposalEditorPage'
import { ProposalsPage } from './pages/ProposalsPage'
```
and replace
```tsx
            <OwnerOnly ownerMode={ownerMode}>
              <ProposalsPage />
            </OwnerOnly>
          }
        />
```
with
```tsx
            <OwnerOnly ownerMode={ownerMode}>
              <ProposalsPage />
            </OwnerOnly>
          }
        />
        <Route
          path="/proposals/:proposalId"
          element={
            <OwnerOnly ownerMode={ownerMode}>
              <ProposalEditorPage />
            </OwnerOnly>
          }
        />
```

Append to the end of `src/App.css`:

```css

/* The proposal editor (featreq-311473e2). */
.proposal-estimate,
.proposal-fieldset,
.proposal-activity {
  display: grid;
  gap: 16px;
  min-width: 0;
}

.proposal-fieldset {
  border: 0;
  margin: 0;
  padding: 0;
}

.proposal-picker-group {
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  margin: 0 0 12px;
  padding: 8px 12px;
}

.proposal-picker-row {
  padding: 6px 0;
}

.proposal-picker-tiers {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
}

.proposal-picker-name {
  font-weight: 700;
}

.proposal-picker-extras {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: flex-end;
  padding: 6px 0 0 24px;
}

.proposal-line-formula {
  color: var(--muted);
  font-size: 12px;
  margin-top: 2px;
}

.proposal-line-amount {
  font-weight: 700;
  text-align: right;
  white-space: nowrap;
}

.proposal-totals {
  display: grid;
  gap: 6px;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  margin: 12px 0 0;
}

.proposal-totals dt {
  color: var(--muted);
  font-size: 12px;
}

.proposal-totals dd {
  font-size: 18px;
  font-weight: 760;
  margin: 0;
}

.proposal-letter-text {
  font-family: inherit;
  white-space: pre-wrap;
}

.proposal-activity-list,
.proposal-transcript {
  display: grid;
  gap: 6px;
  margin: 0;
  padding-left: 18px;
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run src/__tests__/proposals-page.test.tsx`
Expected: PASS — 15 tests.

- [ ] **Step 5: Verify and commit**

Run: `npm run verify` — expected green.

```bash
git add src/pages/ProposalEditorPage.tsx src/components/proposals/EstimateTab.tsx src/components/proposals/LetterTab.tsx src/components/proposals/ActivityTab.tsx src/lib/proposals.ts src/App.tsx src/App.css src/__tests__/proposals-page.test.tsx
git commit -m "A proposal opens in an editor: prospect, counts and a tiered service picker on the Estimate tab, each line priced by the server with its formula, overrides and the four totals" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Opus 5.5 drafts the letter, and may only quote the estimate's figures

**Files:**
- Create: `lib/firm-lines.js`
- Create: `lib/firm-lines.test.mjs`
- Modify: `lib/assistant.js`
  - imports (`import { assignedTeamIds } from './data-scope.js'`, ~:27)
  - `runStructuredModel` — the `if (parsed) { const result = validate(parsed) … }` block and the `repairHint = labels.repairHint || REPAIR_HINT` line after it (~:1649-1656)
  - append at the end of the file (after `suggestPackageChecklists`, ~:2295)
- Modify: `lib/assistant.test.mjs` — the top import list (`  suggestPackageChecklists,` ~:17) and append at the end.

**Interfaces:**
- Consumes: `formatProposalMoney`, `PROPOSAL_GROUPS` (Task 1); the existing `runStructuredModel`, `jsonSchema`, `STRUCTURED_MAX_TOKENS`, `US_ENGLISH_RULE`, `getClient` in `lib/assistant.js`.
- Produces: `firmDetailLines(firmSettings) -> string[]` (address, city line, phone, email; blanks dropped; no tagline); `runStructuredModel` validators may return `{ ok: false, message, hint }` and the one retry's system prompt then carries `hint`; `PROPOSAL_LETTER_SECTIONS`; `PROPOSAL_LETTER_SCHEMA` (no bounds keywords); `dollarFiguresInCents(text) -> number[]`; `allowedLetterCents(snapshot) -> Set<number>`; `renderProposalLetterText(letter) -> string`; `validateProposalLetter(parsed, snapshot) -> { ok: true, value: { subject, sections, text } } | { ok: false, message?, hint? }`; `buildProposalLetterPrompt(proposal, firm) -> string`; `draftProposalLetter(proposal, firm, opts?) -> Promise<{ subject, sections, text }>` (claude-opus-5-5, `modelFallback: false`; 502 after a second failure, 503 at capacity).

`lib/firm-lines.js` is created here because the letter prompt needs the firm's contact lines; Task 10 moves the invoice PDF and email onto it.

- [ ] **Step 1: Write the failing tests**

Create `lib/firm-lines.test.mjs`:

```js
import { describe, expect, it } from 'vitest'
import { firmDetailLines } from './firm-lines.js'

describe('firmDetailLines', () => {
  it('is address, city line, phone, email — in that order, blanks dropped', () => {
    expect(
      firmDetailLines({
        tagline: 'Never printed',
        addressLine1: '12 Main St',
        addressLine2: '',
        city: 'Nashville',
        state: 'TN',
        postalCode: '37201',
        phone: '615-555-0100',
        email: 'hello@pbjsa.com',
      }),
    ).toEqual(['12 Main St', 'Nashville, TN, 37201', '615-555-0100', 'hello@pbjsa.com'])
  })

  it('is empty for an unconfigured firm', () => {
    expect(firmDetailLines(null)).toEqual([])
    expect(firmDetailLines({ name: 'PB&J' })).toEqual([])
  })
})
```

In `lib/assistant.test.mjs`, change the top import from
```js
  buildPackageChecklistPrompt,
  suggestPackageChecklists,
```
to
```js
  buildPackageChecklistPrompt,
  suggestPackageChecklists,
  PROPOSAL_LETTER_SCHEMA,
  buildProposalLetterPrompt,
  dollarFiguresInCents,
  draftProposalLetter,
  validateProposalLetter,
```
and append at the end of the file:

```js

/**
 * The proposal letter (featreq-311473e2, spec §5.3): the AI writes, it never
 * prices. A dollar figure the snapshot does not contain is a failed draft.
 */
describe('proposal letter drafting', () => {
  const snapshot = {
    rates: { bookkeeper: 75, accountant: 115, controller: 125 },
    lines: [
      { serviceId: 'monthly-weekly-transactions-basic', group: 'Monthly', name: 'Weekly transactions', tier: 'Basic', amount: 630 },
      { serviceId: 'payroll', group: 'Payroll', name: 'Payroll', tier: null, amount: 1147.13 },
    ],
    totals: { monthly: 1777.13, annual: 0, oneTime: 0, cleanup: 0 },
  }
  const proposal = {
    prospect: { company: 'Acme Books', contactName: 'Pat Doe', notes: 'Wants weekly books.' },
    pricingSnapshot: snapshot,
    messages: [
      { role: 'user', text: 'They run payroll weekly for 10 people.' },
      { role: 'assistant', text: 'Got it.' },
    ],
  }
  const firm = { name: 'PB&J Strategic Accounting', city: 'Nashville', state: 'TN', clientDefaults: { paymentTerms: 'Net 15' } }
  const letter = (pricing) => ({
    subject: 'Your bookkeeping proposal',
    sections: [
      { heading: 'Opening', body: 'Thank you for meeting with us last week about your books.' },
      { heading: 'Pricing', body: pricing },
    ],
  })

  it('reads every dollar figure as cents', () => {
    expect(dollarFiguresInCents('It is $630.00 a month, $1,147.13 for payroll, $5 and $ 12.5')).toEqual([
      63000, 114713, 500, 1250,
    ])
  })

  it('accepts a letter whose figures are all in the snapshot, and renders its text', () => {
    const result = validateProposalLetter(
      letter('Weekly transactions are $630.00 and payroll is $1,147.13, so $1,777.13 a month.'),
      snapshot,
    )
    expect(result.ok).toBe(true)
    expect(result.value.text).toBe(
      'Opening\n\nThank you for meeting with us last week about your books.\n\nPricing\n\n' +
        'Weekly transactions are $630.00 and payroll is $1,147.13, so $1,777.13 a month.',
    )
  })

  it('rejects a foreign dollar figure and names it for the retry', () => {
    const result = validateProposalLetter(letter('All in, about $1,800.00 a month.'), snapshot)
    expect(result.ok).toBe(false)
    expect(result.hint).toContain('$1,800.00')
  })

  it('rejects a letter without its Pricing section', () => {
    const result = validateProposalLetter(
      { subject: 'Your proposal', sections: [{ heading: 'Opening', body: 'Thanks for meeting with us.' }] },
      snapshot,
    )
    expect(result.ok).toBe(false)
  })

  it('hands the model the priced lines and the only figures it may quote', () => {
    const prompt = buildProposalLetterPrompt(proposal, firm)
    expect(prompt).toContain('- Weekly transactions (Basic): $630.00')
    expect(prompt).toContain('- Monthly fee: $1,777.13')
    expect(prompt).toContain('ALLOWED FIGURES (the only dollar amounts you may write): $630.00, $1,147.13, $1,777.13')
    expect(prompt).toContain('They run payroll weekly for 10 people.')
    expect(prompt).not.toContain('Got it.')
    expect(prompt).toContain('Payment terms: Net 15')
    expect(prompt).toContain('Firm contact: Nashville, TN')
  })

  it('retries once with the stray figure named, then returns the clean draft', async () => {
    const client = fakeClient([
      { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(letter('About $1,800.00 a month.')) }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(letter('It comes to $1,777.13 a month.')) }] },
    ])
    const drafted = await draftProposalLetter(proposal, firm, { client })
    expect(drafted.subject).toBe('Your bookkeeping proposal')
    expect(drafted.text).toContain('$1,777.13')
    expect(client.messages.create).toHaveBeenCalledTimes(2)
    const retry = client.messages.create.mock.calls[1][0]
    expect(retry.system).toContain('Your previous draft stated $1,800.00')
    expect(retry.model).toBe('claude-opus-5-5')
  })

  it('refuses after a second foreign figure rather than saving it', async () => {
    const bad = { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(letter('About $1,800.00 a month.')) }] }
    const client = fakeClient([bad, bad])
    await expect(draftProposalLetter(proposal, firm, { client })).rejects.toMatchObject({ statusCode: 502 })
  })

  it('the letter schema carries no bounds keywords', () => {
    const offenders = []
    const walk = (node, path) => {
      if (!node || typeof node !== 'object') return
      for (const [key, value] of Object.entries(node)) {
        if (['minimum', 'maximum', 'minItems', 'maxItems'].includes(key)) offenders.push(path + '.' + key)
        walk(value, path + '.' + key)
      }
    }
    walk(PROPOSAL_LETTER_SCHEMA, 'schema')
    expect(offenders).toEqual([])
  })
})
```

(`fakeClient` is the helper already defined at the top of `lib/assistant.test.mjs`.)

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run lib/firm-lines.test.mjs lib/assistant.test.mjs`
Expected: FAIL — `./firm-lines.js` does not exist, and `PROPOSAL_LETTER_SCHEMA` / `draftProposalLetter` are not exported by `./assistant.js`.

- [ ] **Step 3: Implement**

Create `lib/firm-lines.js`:

```js
/**
 * The firm's identity block under its name: address and contact, one line
 * each, blanks dropped. ONE copy, shared by the invoice PDF's letterhead, the
 * invoice email's footer, the proposal PDF and the proposal letter prompt — so
 * two documents about the same firm can never disagree about how to reach it.
 *
 * No tagline — she struck it off the letterhead on the marked-up sample
 * (featreq-97ae3214, §1d). `firmSettings.tagline` is still stored and still
 * shown in Settings; it just does not belong on a document a client files.
 *
 * @param {object|null|undefined} firmSettings
 * @returns {string[]}
 */
export function firmDetailLines(firmSettings) {
  const cityLine = [firmSettings?.city, firmSettings?.state, firmSettings?.postalCode]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .join(', ')
  return [
    firmSettings?.addressLine1,
    firmSettings?.addressLine2,
    cityLine,
    firmSettings?.phone,
    firmSettings?.email,
  ]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
}
```

In `lib/assistant.js`, replace
```js
import Anthropic from '@anthropic-ai/sdk'
import { assignedTeamIds } from './data-scope.js'
```
with
```js
import Anthropic from '@anthropic-ai/sdk'
import { assignedTeamIds } from './data-scope.js'
import { firmDetailLines } from './firm-lines.js'
import { PROPOSAL_GROUPS, formatProposalMoney } from './proposal-pricing.js'
```

In `runStructuredModel`, replace
```js
    if (parsed) {
      const result = validate(parsed)
      if (result.ok) return result.value
      lastMessage = result.message || labels.invalid
    }
    repairHint = labels.repairHint || REPAIR_HINT
  }
```
with
```js
    // A validator may name what was wrong (`hint`) — the proposal letter's
    // foreign dollar figure — so the one retry is told exactly what to fix.
    let validatorHint = null
    if (parsed) {
      const result = validate(parsed)
      if (result.ok) return result.value
      lastMessage = result.message || labels.invalid
      validatorHint = typeof result.hint === 'string' && result.hint ? result.hint : null
    }
    repairHint = validatorHint || labels.repairHint || REPAIR_HINT
  }
```

Append to the end of `lib/assistant.js`:

```js

// ---- Proposals: the letter (featreq-311473e2, spec §5.3) --------------------
//
// The AI WRITES; it never PRICES. Every dollar figure in the letter must be one
// the calculator already produced (a line amount or a total, to the cent), or
// the draft is retried once with the stray figure named, and then refused.

/** The sections, in the order the letter reads. */
export const PROPOSAL_LETTER_SECTIONS = [
  'Opening',
  'What you told us',
  'What we will do',
  'Pricing',
  'Terms',
  'Next step',
]

/**
 * The letter's structured output. No minimum / maximum / minItems / maxItems
 * anywhere (claude-opus-5-5's validator 400s on them); the caps live in
 * `validateProposalLetter`. `minLength` floors are accepted and keep a balking
 * model from answering with a bare ",".
 */
export const PROPOSAL_LETTER_SCHEMA = {
  type: 'object',
  properties: {
    subject: { type: 'string', minLength: 8 },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          heading: { type: 'string', enum: PROPOSAL_LETTER_SECTIONS },
          body: { type: 'string', minLength: 20 },
        },
        required: ['heading', 'body'],
        additionalProperties: false,
      },
    },
  },
  required: ['subject', 'sections'],
  additionalProperties: false,
}

/** Every "$1,234.56" in a piece of prose, as whole cents. */
export function dollarFiguresInCents(text) {
  const out = []
  for (const match of String(text ?? '').matchAll(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/g)) {
    const whole = Number(match[1].replace(/,/g, ''))
    const cents = match[2] ? Number(match[2].padEnd(2, '0')) : 0
    out.push(whole * 100 + cents)
  }
  return out
}

/** The figures a letter may quote: every line amount and every total, in cents. */
export function allowedLetterCents(snapshot) {
  const cents = new Set()
  for (const line of Array.isArray(snapshot?.lines) ? snapshot.lines : []) {
    cents.add(Math.round(Number(line?.amount) * 100))
  }
  for (const value of Object.values(snapshot?.totals ?? {})) {
    cents.add(Math.round(Number(value) * 100))
  }
  return cents
}

/** The letter as the text she edits: each heading, a blank line, its body. */
export function renderProposalLetterText(letter) {
  return (Array.isArray(letter?.sections) ? letter.sections : [])
    .map((section) => `${section.heading}\n\n${section.body}`)
    .join('\n\n')
}

/**
 * Hold a drafted letter to the rules: a subject, the Opening and Pricing
 * sections at least, strings capped, and NO dollar figure the snapshot does not
 * contain. A failure carries a `hint` naming the problem, which
 * `runStructuredModel` hands the one retry.
 */
export function validateProposalLetter(parsed, snapshot) {
  const subject = typeof parsed?.subject === 'string' ? parsed.subject.trim().slice(0, 200) : ''
  const sections = (Array.isArray(parsed?.sections) ? parsed.sections : [])
    .map((section) => ({
      heading: typeof section?.heading === 'string' ? section.heading.trim().slice(0, 120) : '',
      body: typeof section?.body === 'string' ? section.body.trim().slice(0, 4000) : '',
    }))
    .filter((section) => section.heading && section.body)
    .slice(0, 8)
  if (!subject || sections.length === 0) return { ok: false }

  const headings = new Set(sections.map((section) => section.heading.toLowerCase()))
  if (!headings.has('opening') || !headings.has('pricing')) {
    return {
      ok: false,
      message: 'The AI left out the Opening or the Pricing section. Please try again.',
      hint:
        'Your previous draft was missing the Opening or the Pricing section. ' +
        'Include every section, in the order given.',
    }
  }

  const allowed = allowedLetterCents(snapshot)
  const foreign = [subject, ...sections.flatMap((section) => [section.heading, section.body])]
    .flatMap(dollarFiguresInCents)
    .filter((cents) => !allowed.has(cents))
  if (foreign.length > 0) {
    const named = [...new Set(foreign)].map((cents) => formatProposalMoney(cents / 100)).join(', ')
    return {
      ok: false,
      message: `The AI quoted a price that is not in the estimate (${named}). Please try again.`,
      hint:
        `Your previous draft stated ${named}, which is not one of the estimate's figures. ` +
        'Quote only the dollar amounts listed under ALLOWED FIGURES, exactly as written.',
    }
  }

  const letter = { subject, sections }
  return { ok: true, value: { ...letter, text: renderProposalLetterText(letter) } }
}

/**
 * The user turn for {@link draftProposalLetter}. Pure, so the rule it carries —
 * the model is handed the priced lines and the ONLY figures it may quote — is
 * testable without a model.
 */
export function buildProposalLetterPrompt(proposal, firm) {
  const prospect = proposal?.prospect ?? {}
  const snapshot = proposal?.pricingSnapshot ?? { lines: [], totals: {} }
  const lines = Array.isArray(snapshot.lines) ? snapshot.lines : []
  const totals = snapshot.totals ?? {}
  const money = (value) => formatProposalMoney(Number(value) || 0)

  const grouped = PROPOSAL_GROUPS.flatMap((group) => {
    const rows = lines.filter((line) => line.group === group)
    if (rows.length === 0) return []
    return [
      group,
      ...rows.map((line) => `- ${line.name}${line.tier ? ` (${line.tier})` : ''}: ${money(line.amount)}`),
    ]
  })
  const totalLines = [
    ['Monthly fee', totals.monthly],
    ['Annual fees', totals.annual],
    ['One-time fees', totals.oneTime],
    ['Clean-up', totals.cleanup],
  ]
    .filter(([, value]) => Number(value) > 0)
    .map(([label, value]) => `- ${label}: ${money(value)}`)
  const allowed = [...allowedLetterCents(snapshot)]
    .filter((cents) => cents > 0)
    .sort((a, b) => a - b)
    .map((cents) => formatProposalMoney(cents / 100))
  const herWords = (Array.isArray(proposal?.messages) ? proposal.messages : [])
    .filter((message) => message?.role === 'user' && typeof message.text === 'string')
    .map((message) => message.text.trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 1500)
  const terms = String(firm?.clientDefaults?.paymentTerms ?? '').trim()

  return [
    `Firm: ${String(firm?.name ?? '').trim() || 'PB&J Strategic Accounting'}`,
    ...firmDetailLines(firm).map((line) => `Firm contact: ${line}`),
    '',
    `Prospect company: ${prospect.company || '(not given)'}`,
    `Prospect contact: ${prospect.contactName || '(not given)'}`,
    prospect.notes ? `Owner's notes: ${prospect.notes}` : '',
    herWords ? `What came up in the intake conversation (the owner's words):\n${herWords}` : '',
    '',
    'Priced services, by group:',
    ...(grouped.length > 0 ? grouped : ['- (none selected)']),
    '',
    'Totals:',
    ...(totalLines.length > 0 ? totalLines : ['- (nothing priced yet)']),
    terms ? `\nPayment terms: ${terms}` : '',
    '',
    `ALLOWED FIGURES (the only dollar amounts you may write): ${allowed.join(', ') || '(none)'}`,
  ]
    .filter((line) => line !== '')
    .join('\n')
}

/**
 * Draft the proposal letter (spec §5.3). Returns `{ subject, sections, text }`
 * and writes nothing — the route saves it.
 *
 * `modelFallback: false`, like the brainstorm and the package suggestions: the
 * letter goes to a prospect, so a quieter model's draft is worse than "try
 * again in a minute".
 */
export async function draftProposalLetter(proposal, firm, opts = {}) {
  const client = opts.client || getClient()
  const system =
    'You write the proposal letter a small US bookkeeping firm sends a prospective ' +
    'client, in the firm owner\'s warm, plain-spoken voice. Write these sections, in ' +
    `this order: ${PROPOSAL_LETTER_SECTIONS.join(', ')}. Each body is plain paragraphs — ` +
    'no markdown, no bullet symbols. "Pricing" walks through the priced services by group ' +
    'and the totals. NEVER compute, round, add up or estimate a number: quote dollar ' +
    'amounts ONLY from ALLOWED FIGURES, written exactly as given (for example $1,234.50), ' +
    'and never mention hourly rates, factors or formulas. Leave out any total that is not ' +
    'listed. "subject" is a short email subject line.' +
    US_ENGLISH_RULE

  return runStructuredModel(
    client,
    {
      model: process.env.ASSISTANT_MODEL || 'claude-opus-5-5',
      max_tokens: STRUCTURED_MAX_TOKENS,
      system,
      messages: [{ role: 'user', content: buildProposalLetterPrompt(proposal, firm) }],
      output_config: jsonSchema(PROPOSAL_LETTER_SCHEMA),
    },
    (parsed) => validateProposalLetter(parsed, proposal?.pricingSnapshot),
    {
      endpoint: 'draftProposalLetter',
      unavailable: 'The AI could not draft the letter right now. Please try again.',
      invalid: 'The AI returned an unexpected response. Please try again.',
    },
    { modelFallback: false },
  )
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run lib/firm-lines.test.mjs lib/assistant.test.mjs`
Expected: PASS — 2 firm-lines tests; the assistant suite with its 8 new letter tests, and the existing `structured-output schemas carry no bounds keywords` tripwire still green.

- [ ] **Step 5: Verify and commit**

Run: `npm run verify` — expected green.

```bash
git add lib/firm-lines.js lib/firm-lines.test.mjs lib/assistant.js lib/assistant.test.mjs
git commit -m "Opus 5.5 drafts a proposal letter around the priced estimate, and a draft quoting any figure the estimate lacks is retried once with it named, then refused" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The Letter tab drafts, regenerates, edits and copies the letter

**Files:**
- Modify: `db/store.js` — directly after `async appendProposalEmailEvent(id, entry = {}) { … }` (Task 4).
- Modify: `server.js` — the `./lib/assistant.js` import list (`  spitballChat,` ~:37) and directly after the Task 5 `proposalRepriceMatch` route (ends `sendJson(response, 200, repriced)\n      return\n    }`).
- Modify: `src/lib/api.ts` — directly after `export function repriceProposalRequest(` (Task 5).
- Modify: `src/components/proposals/LetterTab.tsx` — replace the whole file.
- Modify: `src/pages/ProposalEditorPage.tsx` — the api import list and the `{tab === 'letter' ? <LetterTab proposal={proposal} /> : null}` line.
- Modify: `db/store-staleness.test.mjs`, `src/__tests__/proposal-routes.test.ts`, `src/__tests__/proposals-page.test.tsx` — append; the page test's `vi.mock('../lib/api', …)` list and `beforeEach`.

**Interfaces:**
- Consumes: `draftProposalLetter` (Task 8), `getProposal`, `getFirmSettings`, `updateProposal({ letterText })` (Tasks 2/4), `SavingTextarea`.
- Produces: `appDataStore.setProposalLetter(id, { subject, sections, text }) -> Proposal | null` (stamps `letter_at`, both backends); `POST /api/proposals/:id/letter` → `Proposal` (409 for accepted/declined, 502/503 `proposal_letter_failed` with the sentence); `draftProposalLetterRequest(id): Promise<Proposal>`; `LetterTab({ proposal, busy, onDraft, onSaveText })`.

- [ ] **Step 1: Write the failing tests**

Append to the end of `db/store-staleness.test.mjs`:

```js

describe('proposal letters (both backends)', () => {
  beforeEach(async () => {
    await clearProposals()
  })

  const drafted = {
    subject: 'Your bookkeeping proposal',
    sections: [{ heading: 'Opening', body: 'Thank you for meeting with us.' }],
    text: 'Opening\n\nThank you for meeting with us.',
  }

  it('saves the drafted letter with its timestamp, and she can edit the text', async () => {
    const created = await store.createProposal({ prospect: { company: 'Acme Books' } })
    const saved = await store.setProposalLetter(created.id, drafted)
    expect(saved.letter).toEqual(drafted)
    expect(saved.letterAt).toBeTruthy()

    const edited = await store.updateProposal(created.id, { letterText: 'Opening\n\nThanks, Pat.' })
    expect(edited.letter).toEqual({ ...drafted, text: 'Opening\n\nThanks, Pat.' })
  })

  it('writes the letter and letter_at in one statement on Postgres', async () => {
    const fake = fakeProposalPostgres(proposalRow())
    await postgresStore(fake).setProposalLetter('prop-1', drafted)
    const update = fake.matching(/^update proposals/i)[0]
    expect(update.text).toMatch(/set letter = \$2::jsonb, letter_at = now\(\)/)
    expect(JSON.parse(update.params[1]).text).toBe(drafted.text)
  })
})
```

Append to the end of `src/__tests__/proposal-routes.test.ts`:

```ts

describe('drafting the letter', () => {
  pinOwnerRoutes([
    {
      name: 'POST /api/proposals/:id/letter',
      pattern: /proposalLetterMatch && request\.method === 'POST'/,
      write: true,
    },
  ])

  const block = () => routeBlock(/proposalLetterMatch && request\.method === 'POST'/, 2600)

  it('asks the model, then saves through the store', () => {
    const text = block()
    expect(text).toContain('draftProposalLetter(proposal, await appDataStore.getFirmSettings())')
    expect(text).toContain('appDataStore.setProposalLetter(proposal.id, letter)')
    expect(text.indexOf('draftProposalLetter(')).toBeLessThan(text.indexOf('setProposalLetter('))
  })

  it('turns a model failure into a sentence, never a crash', () => {
    const text = block()
    expect(text).toMatch(/status === 503 \? 503 : 502/)
    expect(text).toContain("error: 'proposal_letter_failed'")
  })
})
```

In `src/__tests__/proposals-page.test.tsx`, replace
```tsx
  deleteProposalRequest: (...args: unknown[]) => api.deleteProposalRequest(...args),
}))
```
with
```tsx
  deleteProposalRequest: (...args: unknown[]) => api.deleteProposalRequest(...args),
  draftProposalLetterRequest: (...args: unknown[]) => api.draftProposalLetterRequest(...args),
}))
```
replace
```tsx
  api.deleteProposalRequest = vi.fn(async () => undefined)
})
```
with
```tsx
  api.deleteProposalRequest = vi.fn(async () => undefined)
  api.draftProposalLetterRequest = vi.fn(async () => WITH_LETTER)
})
```
and append at the end of the file:

```tsx

const WITH_LETTER: Proposal = {
  ...PROPOSAL,
  letter: {
    subject: 'Your bookkeeping proposal',
    sections: [{ heading: 'Opening', body: 'Thank you for meeting with us.' }],
    text: 'Opening\n\nThank you for meeting with us.',
  },
  letterAt: '2026-09-23T13:00:00.000Z',
}

describe('the Letter tab', () => {
  it('drafts the letter and shows the text to edit', async () => {
    renderEditor('/proposals/prop-1?tab=letter')
    fireEvent.click(await screen.findByRole('button', { name: 'Draft the proposal' }))
    await waitFor(() => expect(api.draftProposalLetterRequest).toHaveBeenCalledWith('prop-1'))
    expect(((await screen.findByLabelText('Letter text')) as HTMLTextAreaElement).value).toBe(
      'Opening\n\nThank you for meeting with us.',
    )
    expect(screen.getByText('Subject: Your bookkeeping proposal')).toBeTruthy()
  })

  it('regenerates only after a confirm', async () => {
    api.getProposalRequest = vi.fn(async () => WITH_LETTER)
    const confirm = vi.fn(() => false)
    vi.stubGlobal('confirm', confirm)
    renderEditor('/proposals/prop-1?tab=letter')
    fireEvent.click(await screen.findByRole('button', { name: 'Regenerate' }))
    expect(confirm).toHaveBeenCalled()
    expect(api.draftProposalLetterRequest).not.toHaveBeenCalled()
  })

  it('saves an edit to the letter text', async () => {
    api.getProposalRequest = vi.fn(async () => WITH_LETTER)
    renderEditor('/proposals/prop-1?tab=letter')
    const text = await screen.findByLabelText('Letter text')
    fireEvent.change(text, { target: { value: 'Opening\n\nThanks, Pat.' } })
    fireEvent.blur(text)
    await waitFor(() =>
      expect(api.updateProposalRequest).toHaveBeenCalledWith('prop-1', {
        letterText: 'Opening\n\nThanks, Pat.',
      }),
    )
  })

  it('copies the text', async () => {
    api.getProposalRequest = vi.fn(async () => WITH_LETTER)
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    renderEditor('/proposals/prop-1?tab=letter')
    fireEvent.click(await screen.findByRole('button', { name: 'Copy text' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Opening\n\nThank you for meeting with us.'))
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run db/store-staleness.test.mjs src/__tests__/proposal-routes.test.ts src/__tests__/proposals-page.test.tsx -t "letter|Letter"`
Expected: FAIL — `setProposalLetter` is not a function, the letter route is not found, and there is no "Draft the proposal" button.

- [ ] **Step 3: Implement**

In `db/store.js`, directly after the closing `}` of `async appendProposalEmailEvent(id, entry = {}) {`, add:

```js

  /**
   * Save an AI-drafted letter (spec §5.3): subject, sections and the rendered
   * text she edits, stamped `letter_at`. Replaces whatever letter was there —
   * the page asks before regenerating over an edited one. Returns the
   * proposal, or null when there is none.
   */
  async setProposalLetter(id, letter) {
    const clean = {
      subject: String(letter?.subject ?? '').slice(0, 200),
      sections: (Array.isArray(letter?.sections) ? letter.sections : []).slice(0, 8).map((section) => ({
        heading: String(section?.heading ?? '').slice(0, 120),
        body: String(section?.body ?? '').slice(0, 4000),
      })),
      text: String(letter?.text ?? '').slice(0, 20000),
    }
    if (this.pool) {
      const { rows } = await this.pool.query(
        `update proposals
            set letter = $2::jsonb, letter_at = now(), updated_at = now()
          where id = $1
          returning ${PROPOSAL_COLUMNS}`,
        [id, JSON.stringify(clean)],
      )
      return rows[0] ? AppDataStore.mapProposal(rows[0]) : null
    }
    const authState = await readJson(localAuthPath)
    const target = (Array.isArray(authState.proposals) ? authState.proposals : []).find(
      (row) => row && row.id === id,
    )
    if (!target) return null
    const now = nowIso()
    target.letter = clean
    target.letterAt = now
    target.updatedAt = now
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return AppDataStore.mapProposal(target)
  }
```

In `server.js`, change the assistant import
```js
  spitballChat,
  suggestPackageChecklists,
```
to
```js
  spitballChat,
  draftProposalLetter,
  suggestPackageChecklists,
```
and directly after the `proposalRepriceMatch` route add:

```js

    // POST /api/proposals/:id/letter — Opus 5.5 drafts the letter from the
    // priced snapshot (spec §5.3). The AI writes; the validator in
    // `draftProposalLetter` refuses any dollar figure the snapshot lacks.
    const proposalLetterMatch = normalizedPath.match(/^\/api\/proposals\/([^/]+)\/letter$/)
    if (proposalLetterMatch && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can draft proposal letters' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }
      const proposal = await appDataStore.getProposal(proposalLetterMatch[1])
      if (!proposal) {
        sendJson(response, 404, { error: 'Proposal not found' })
        return
      }
      if (proposal.status === 'accepted' || proposal.status === 'declined') {
        sendJson(response, 409, {
          error: 'proposal_refused',
          message: `This proposal is ${proposal.status} — copy it to write a new letter.`,
        })
        return
      }
      let letter
      try {
        letter = await draftProposalLetter(proposal, await appDataStore.getFirmSettings())
      } catch (error) {
        const status = error?.statusCode ?? error?.status ?? 502
        console.error('[proposals] letter draft failed:', error?.message || error)
        sendJson(response, status === 503 ? 503 : 502, {
          error: 'proposal_letter_failed',
          message: error?.message || 'The AI could not draft the letter right now.',
        })
        return
      }
      const saved = await appDataStore.setProposalLetter(proposal.id, letter)
      await appDataStore.recordActivity(
        session.user.id,
        'proposal_letter_drafted',
        proposal.prospect.company || proposal.id,
      )
      broadcastDataChanged()
      sendJson(response, 200, saved)
      return
    }
```

In `src/lib/api.ts`, directly after the closing `}` of `export function repriceProposalRequest(` add:

```ts

/** Owner-only: the AI drafts (or redrafts) the letter from the priced estimate. */
export function draftProposalLetterRequest(id: string): Promise<Proposal> {
  return proposalRequest<Proposal>(
    proposalPath(id, 'letter'),
    { method: 'POST' },
    'The letter could not be drafted',
  )
}
```

Replace the whole of `src/components/proposals/LetterTab.tsx` with:

```tsx
import { useState } from 'react'
import { SavingTextarea } from '../SectionKit'
import type { Proposal } from '../../lib/types'

/**
 * The Letter tab (spec §5.1 / §5.3): "Draft the proposal" asks Opus 5.5 for a
 * letter written around the priced estimate; the text is hers to edit;
 * "Regenerate" replaces it only after a confirm. The AI never prices — the
 * server refuses a draft that quotes a figure the estimate does not have.
 */
export function LetterTab({
  proposal,
  busy,
  onDraft,
  onSaveText,
}: {
  proposal: Proposal
  busy: boolean
  onDraft: () => void
  onSaveText: (text: string) => void
}) {
  const [copied, setCopied] = useState(false)
  const locked = proposal.status === 'accepted' || proposal.status === 'declined'
  const text = proposal.letter?.text ?? ''

  const draft = () => {
    if (
      text &&
      !window.confirm('Replace this letter with a new draft? Your edits to this one will be lost.')
    ) {
      return
    }
    onDraft()
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <section className="panel">
      <div className="section-heading">
        <h3>Letter</h3>
        <div className="button-row">
          <button
            type="button"
            className="primary-action"
            disabled={busy || locked}
            onClick={draft}
          >
            {text ? 'Regenerate' : 'Draft the proposal'}
          </button>
          <button
            type="button"
            className="secondary-action"
            disabled={!text}
            onClick={() => void copy()}
          >
            {copied ? 'Copied' : 'Copy text'}
          </button>
        </div>
      </div>
      {proposal.letter?.subject ? (
        <p className="muted-text">Subject: {proposal.letter.subject}</p>
      ) : null}
      {text ? (
        <fieldset className="proposal-fieldset" disabled={locked}>
          <SavingTextarea
            ariaLabel="Letter text"
            rows={24}
            canonical={text}
            onCommit={onSaveText}
          />
        </fieldset>
      ) : (
        <p className="muted-text">
          No letter yet — “Draft the proposal” writes one from this estimate. Every price in it
          comes from the estimate, never from the AI.
        </p>
      )}
    </section>
  )
}
```

In `src/pages/ProposalEditorPage.tsx`, change the api import
```tsx
  copyProposalRequest,
  deleteProposalRequest,
  fetchFirmSettings,
```
to
```tsx
  copyProposalRequest,
  deleteProposalRequest,
  draftProposalLetterRequest,
  fetchFirmSettings,
```
and replace
```tsx
      {tab === 'letter' ? <LetterTab proposal={proposal} /> : null}
```
with
```tsx
      {tab === 'letter' ? (
        <LetterTab
          proposal={proposal}
          busy={busy}
          onDraft={() => void run(() => draftProposalLetterRequest(proposalId))}
          onSaveText={(text) => save({ letterText: text })}
        />
      ) : null}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run db/store-staleness.test.mjs src/__tests__/proposal-routes.test.ts src/__tests__/proposals-page.test.tsx`
Expected: PASS — 2 new store, 6 new route and 4 new page tests; the Task 7 "No letter yet" assertion still matches.

- [ ] **Step 5: Verify and commit**

Run: `node --check server.js` then `npm run verify` — expected green.

```bash
git add db/store.js db/store-staleness.test.mjs server.js src/lib/api.ts src/components/proposals/LetterTab.tsx src/pages/ProposalEditorPage.tsx src/__tests__/proposal-routes.test.ts src/__tests__/proposals-page.test.tsx
git commit -m "The Letter tab drafts the proposal letter with Opus 5.5, saves her edits, regenerates only after a confirm, and copies the text" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The proposal PDF, and one shared copy of the firm's letterhead lines

**Files:**
- Create: `lib/proposal-pdf.js`
- Create: `lib/proposal-pdf.test.mjs`
- Modify: `lib/invoice-pdf.js` — its import block (`import { customerNetDays, paymentTermsLabel } from './invoice-draft.js'`, :24) and the private `function firmDetailLines(firmSettings)` with its doc comment (:80-102). These are LF files.
- Modify: `lib/invoice-email.js` — its import block (`import { customerNetDays, DUE_ON_RECEIPT_LABEL } from './invoice-draft.js'`, :18), the comment in `brandShell` (~:128), the private `function firmContactLines(firmSettings)` with its doc comment (~:372-395), and `const contactLines = firmContactLines(firmSettings)` (~:526).
- Modify: `server.js` — the import `import { buildInvoicePdf, invoicePdfFilename } from './lib/invoice-pdf.js'` (~:70) and directly after the Task 9 `proposalLetterMatch` route.
- Modify: `src/components/proposals/LetterTab.tsx` — after the Copy text button.
- Modify: `src/__tests__/proposal-routes.test.ts`, `src/__tests__/proposals-page.test.tsx` — append.

**Interfaces:**
- Consumes: `firmDetailLines` (Task 8), `decodeSvgLogo` (exported by `lib/invoice-pdf.js`), `PROPOSAL_GROUPS`, `formatProposalMoney` (Task 1), the stored `pricingSnapshot` and `letter`.
- Produces: `buildProposalPdf({ proposal, firmSettings?, preparedOn?, compress? }) -> Promise<Buffer>`; `proposalPdfFilename(proposal) -> 'Proposal-<Company>.pdf'`; `GET /api/proposals/:id/pdf` (owner-only, `application/pdf`, `inline`, `no-store`); a "Preview PDF" link on the Letter tab. The invoice PDF and email now read `firmDetailLines` from `lib/firm-lines.js` — their output is unchanged, which their existing suites prove.

There is no print-sheet mode in the SPA for proposals (the PDF is server-rendered), so `scripts/check-print-pdf.mjs` is unaffected.

- [ ] **Step 1: Write the failing tests**

Create `lib/proposal-pdf.test.mjs`:

```js
import { describe, expect, it } from 'vitest'

import { buildProposalPdf, proposalPdfFilename } from './proposal-pdf.js'

/**
 * The proposal PDF (featreq-311473e2, spec §5.4). Asserts on the REAL bytes,
 * like lib/invoice-pdf.test.mjs: built uncompressed, each drawn line is a `TJ`
 * array of hex runs, reassembled here. ASCII substrings only.
 */
function pdfText(buffer) {
  const raw = buffer.toString('latin1')
  const runs = []
  for (const match of raw.matchAll(/\[([^\]]*)\]\s*TJ/g)) runs.push(match[1])
  for (const match of raw.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) runs.push(`<${match[1]}>`)
  return runs
    .map((run) =>
      [...run.matchAll(/<([0-9A-Fa-f]*)>/g)]
        .map((hex) => Buffer.from(hex[1], 'hex').toString('latin1'))
        .join(''),
    )
    .join('\n')
}

const proposal = {
  id: 'prop-1',
  prospect: { company: 'Acme Books', contactName: 'Pat Doe', email: 'pat@acme.test', phone: '' },
  letter: {
    subject: 'Your bookkeeping proposal',
    sections: [
      { heading: 'Opening', body: 'Thank you for meeting with us.' },
      { heading: 'Pricing', body: 'Weekly transactions come to $630.00 a month.' },
    ],
    text: 'Opening\n\nThank you for meeting with us.\n\nPricing\n\nWeekly transactions come to $630.00 a month.',
  },
  pricingSnapshot: {
    lines: [
      { serviceId: 'monthly-weekly-transactions-basic', group: 'Monthly', name: 'Weekly transactions', tier: 'Basic', amount: 630 },
      { serviceId: 'payroll-setup', group: 'Annual and one-time', name: 'Payroll setup', tier: null, amount: 400 },
    ],
    totals: { monthly: 630, annual: 0, oneTime: 400, cleanup: 0 },
  },
}

const firmSettings = {
  name: 'PB&J Strategic Accounting',
  city: 'Nashville',
  state: 'TN',
  email: 'hello@pbjsa.com',
}

describe('buildProposalPdf', () => {
  it('prints the firm, the prospect, the letter and the priced lines', async () => {
    const text = pdfText(
      await buildProposalPdf({
        proposal,
        firmSettings,
        preparedOn: new Date('2026-09-23T12:00:00Z'),
        compress: false,
      }),
    )
    expect(text).toContain('PB&J Strategic Accounting')
    expect(text).toContain('Nashville, TN')
    expect(text).toContain('Proposal')
    expect(text).toContain('September 23, 2026')
    expect(text).toContain('Acme Books')
    expect(text).toContain('Thank you for meeting with us.')
    expect(text).toContain('Weekly transactions (Basic)')
    expect(text).toContain('$630.00')
    expect(text).toContain('ANNUAL AND ONE-TIME')
  })

  it('prints only the totals that are not zero', async () => {
    const text = pdfText(await buildProposalPdf({ proposal, firmSettings, compress: false }))
    expect(text).toContain('Monthly fee')
    expect(text).toContain('One-time fees')
    expect(text).not.toContain('Annual fees')
    expect(text).not.toContain('Clean-up')
  })

  it('renders a proposal with no letter and no lines without throwing', async () => {
    const buffer = await buildProposalPdf({ proposal: { id: 'prop-2', prospect: {} } })
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })
})

describe('proposalPdfFilename', () => {
  it('names the file for the prospect, with nothing path-ish in it', () => {
    expect(proposalPdfFilename(proposal)).toBe('Proposal-Acme-Books.pdf')
    expect(proposalPdfFilename({ prospect: { company: '../../etc' } })).toBe('Proposal-etc.pdf')
    expect(proposalPdfFilename({ id: 'prop-9', prospect: {} })).toBe('Proposal-prop-9.pdf')
  })
})
```

Append to the end of `src/__tests__/proposal-routes.test.ts`:

```ts

describe('previewing the PDF', () => {
  pinOwnerRoutes([
    {
      name: 'GET /api/proposals/:id/pdf',
      pattern: /proposalPdfMatch && request\.method === 'GET'/,
      write: false,
    },
  ])

  it('renders the stored proposal as a PDF, never cached', () => {
    const block = routeBlock(/proposalPdfMatch && request\.method === 'GET'/, 1400)
    expect(block).toContain('buildProposalPdf({')
    expect(block).toContain("'Content-Type': 'application/pdf'")
    expect(block).toContain("'Cache-Control': 'no-store'")
  })
})
```

Append to the end of `src/__tests__/proposals-page.test.tsx`:

```tsx

describe('Preview PDF', () => {
  it('links to the server-rendered PDF in a new tab', async () => {
    renderEditor('/proposals/prop-1?tab=letter')
    const link = await screen.findByRole('link', { name: 'Preview PDF' })
    expect(link.getAttribute('href')).toBe('/api/proposals/prop-1/pdf')
    expect(link.getAttribute('target')).toBe('_blank')
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run lib/proposal-pdf.test.mjs src/__tests__/proposal-routes.test.ts src/__tests__/proposals-page.test.tsx -t "PDF|proposalPdfFilename|buildProposalPdf"`
Expected: FAIL — `./proposal-pdf.js` does not exist, the pdf route is not found, and there is no "Preview PDF" link.

- [ ] **Step 3: Implement**

In `lib/invoice-pdf.js`, replace
```js
import { customerNetDays, paymentTermsLabel } from './invoice-draft.js'
```
with
```js
import { customerNetDays, paymentTermsLabel } from './invoice-draft.js'
import { firmDetailLines } from './firm-lines.js'
```
and delete the whole private copy (doc comment included):
```js
/**
 * The firm's identity block under its name: address and contact.
 *
 * No tagline — she struck it off the letterhead on the marked-up sample
 * (featreq-97ae3214, §1d). `firmSettings.tagline` is still stored and still
 * shown in Settings; it just does not belong on the document a client files.
 */
function firmDetailLines(firmSettings) {
  const cityLine = [firmSettings?.city, firmSettings?.state, firmSettings?.postalCode]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .join(', ')
  return [
    firmSettings?.addressLine1,
    firmSettings?.addressLine2,
    cityLine,
    firmSettings?.phone,
    firmSettings?.email,
  ]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
}

```
(`const detailLines = firmDetailLines(firmSettings)` in `drawInvoice` now reads the import.)

In `lib/invoice-email.js`, replace
```js
import { customerNetDays, DUE_ON_RECEIPT_LABEL } from './invoice-draft.js'
```
with
```js
import { customerNetDays, DUE_ON_RECEIPT_LABEL } from './invoice-draft.js'
import { firmDetailLines } from './firm-lines.js'
```
replace ``  // the PDF's letterhead (lib/invoice-pdf.js `firmDetailLines`), so the email`` with ``  // the PDF's letterhead (lib/firm-lines.js `firmDetailLines`), so the email``, delete the whole private copy:
```js
/**
 * The firm's address and contact, for the email footer.
 *
 * Deliberately the same five fields in the same order as the PDF letterhead —
 * `firmDetailLines` in lib/invoice-pdf.js — because an invoice email and the
 * invoice attached to it disagreeing about how to reach the firm is exactly the
 * sort of small wrongness that makes a message look forged. No tagline, for the
 * same reason the document has none. Blanks drop out.
 */
function firmContactLines(firmSettings) {
  const cityLine = [firmSettings?.city, firmSettings?.state, firmSettings?.postalCode]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .join(', ')
  return [
    firmSettings?.addressLine1,
    firmSettings?.addressLine2,
    cityLine,
    firmSettings?.phone,
    firmSettings?.email,
  ]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
}

```
and replace
```js
  const contactLines = firmContactLines(firmSettings)
```
with
```js
  // The PDF letterhead's own lines (lib/firm-lines.js): an invoice email and
  // the invoice attached to it must never disagree about how to reach the firm.
  const contactLines = firmDetailLines(firmSettings)
```

Create `lib/proposal-pdf.js`:

```js
/**
 * The proposal as a PDF (featreq-311473e2, spec §5.4): the document a prospect
 * reads, forwards and signs off on.
 *
 * Server-side pdfkit like the invoice PDF (lib/invoice-pdf.js), so it runs on
 * Railway with no browser. Every figure on it comes from the proposal's stored
 * `pricingSnapshot` — the calculator's answer — and the letter text is the one
 * she edited. Nothing here prices anything.
 */

import PDFDocument from 'pdfkit'
import SVGtoPDF from 'svg-to-pdfkit'

import { firmDetailLines } from './firm-lines.js'
import { decodeSvgLogo } from './invoice-pdf.js'
import { PROPOSAL_GROUPS, formatProposalMoney } from './proposal-pricing.js'

const DEFAULT_FIRM_NAME = 'PB&J Strategic Accounting'
const REGULAR = 'Helvetica'
const BOLD = 'Helvetica-Bold'
// The invoice PDF's palette, so the two documents are recognizably one firm.
const INK = '#1f1d1a'
const MUTED = '#7d7269'
const RULE = '#ece8e1'
const MARGIN = 54
const LOGO_WIDTH = 150
const LOGO_HEIGHT = 46

const TOTAL_ROWS = [
  ['monthly', 'Monthly fee'],
  ['annual', 'Annual fees'],
  ['oneTime', 'One-time fees'],
  ['cleanup', 'Clean-up'],
]

/** "August 11, 2026" for a Date. */
function longDateOf(date) {
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

function rule(doc, y, left, right) {
  doc.save().lineWidth(0.75).strokeColor(RULE).moveTo(left, y).lineTo(right, y).stroke().restore()
}

/** Room for `needed` points, or a fresh page. */
function room(doc, y, needed) {
  const bottom = doc.page.height - doc.page.margins.bottom
  if (y + needed <= bottom) return y
  doc.addPage()
  return doc.page.margins.top
}

function drawProposal(doc, { proposal, firmSettings, preparedOn }) {
  const left = doc.page.margins.left
  const right = doc.page.width - doc.page.margins.right
  const width = right - left
  const top = doc.page.margins.top

  /* ---- firm header ---------------------------------------------------- */
  const firmName = String(firmSettings?.name ?? '').trim() || DEFAULT_FIRM_NAME
  const svg = decodeSvgLogo(firmSettings?.logoUrl)
  if (svg) {
    try {
      SVGtoPDF(doc, svg, right - LOGO_WIDTH, top, {
        width: LOGO_WIDTH,
        height: LOGO_HEIGHT,
        preserveAspectRatio: 'xMaxYMin meet',
      })
    } catch (error) {
      console.error('[proposal-pdf] could not draw the firm logo:', error?.message || error)
    }
  }
  const headerWidth = width - LOGO_WIDTH - 18
  doc.font(BOLD).fontSize(15).fillColor(INK).text(firmName, left, top, { width: headerWidth })
  const detailLines = firmDetailLines(firmSettings)
  if (detailLines.length > 0) {
    doc
      .font(REGULAR)
      .fontSize(9)
      .fillColor(MUTED)
      .text(detailLines.join('\n'), left, doc.y + 3, { width: headerWidth, lineGap: 1 })
  }
  let y = Math.max(doc.y, top + LOGO_HEIGHT) + 16
  rule(doc, y, left, right)
  y += 18

  /* ---- title and prospect ---------------------------------------------- */
  doc.font(BOLD).fontSize(20).fillColor(INK).text('Proposal', left, y, { width })
  doc
    .font(REGULAR)
    .fontSize(11)
    .fillColor(MUTED)
    .text(`Prepared ${longDateOf(preparedOn)}`, left, doc.y + 3, { width })
  y = doc.y + 16

  const prospect = proposal?.prospect ?? {}
  doc.font(BOLD).fontSize(8).fillColor(MUTED).text('PREPARED FOR', left, y, { width })
  doc
    .font(BOLD)
    .fontSize(12)
    .fillColor(INK)
    .text(String(prospect.company || prospect.contactName || ''), left, doc.y + 3, { width })
  const prospectLines = [prospect.company ? prospect.contactName : '', prospect.email, prospect.phone]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
  if (prospectLines.length > 0) {
    doc.font(REGULAR).fontSize(9.5).fillColor(MUTED).text(prospectLines.join('\n'), left, doc.y + 2, {
      width,
      lineGap: 1,
    })
  }
  y = doc.y + 20

  /* ---- the letter she edited ----------------------------------------- */
  const headings = new Set(
    (Array.isArray(proposal?.letter?.sections) ? proposal.letter.sections : []).map((section) =>
      String(section?.heading ?? '').trim(),
    ),
  )
  const paragraphs = String(proposal?.letter?.text ?? '')
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
  for (const paragraph of paragraphs) {
    const isHeading = headings.has(paragraph)
    doc.font(isHeading ? BOLD : REGULAR).fontSize(isHeading ? 12 : 10.5)
    y = room(doc, y, doc.heightOfString(paragraph, { width }) + 8)
    doc.fillColor(INK).text(paragraph, left, y, { width, lineGap: 2 })
    y = doc.y + (isHeading ? 4 : 10)
  }

  /* ---- the pricing table ---------------------------------------------- */
  const lines = Array.isArray(proposal?.pricingSnapshot?.lines) ? proposal.pricingSnapshot.lines : []
  const totals = proposal?.pricingSnapshot?.totals ?? {}
  y = room(doc, y + 8, 60)
  doc.font(BOLD).fontSize(14).fillColor(INK).text('Pricing', left, y, { width })
  y = doc.y + 6
  rule(doc, y, left, right)
  y += 8
  const amountWidth = 110
  for (const group of PROPOSAL_GROUPS) {
    const rows = lines.filter((line) => line.group === group)
    if (rows.length === 0) continue
    y = room(doc, y, 40)
    doc.font(BOLD).fontSize(8).fillColor(MUTED).text(group.toUpperCase(), left, y, {
      width,
      characterSpacing: 0.6,
    })
    y = doc.y + 4
    for (const line of rows) {
      y = room(doc, y, 18)
      const label = line.tier ? `${line.name} (${line.tier})` : line.name
      doc.font(REGULAR).fontSize(10).fillColor(INK).text(label, left, y, {
        width: width - amountWidth - 12,
      })
      doc.text(formatProposalMoney(Number(line.amount) || 0), right - amountWidth, y, {
        width: amountWidth,
        align: 'right',
      })
      y = doc.y + 4
    }
    y += 6
  }
  rule(doc, y, left, right)
  y += 8
  for (const [key, label] of TOTAL_ROWS) {
    const value = Number(totals[key]) || 0
    if (value <= 0) continue
    y = room(doc, y, 20)
    doc.font(BOLD).fontSize(11).fillColor(INK).text(label, left, y, {
      width: width - amountWidth - 12,
    })
    doc.text(formatProposalMoney(value), right - amountWidth, y, { width: amountWidth, align: 'right' })
    y = doc.y + 6
  }

  /* ---- footer --------------------------------------------------------- */
  const footer = [firmName, firmSettings?.email, firmSettings?.phone]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .join('  ·  ')
  y = room(doc, y + 18, 20)
  doc.font(REGULAR).fontSize(8.5).fillColor(MUTED).text(footer, left, y, { width, align: 'center' })
}

/**
 * Render one proposal to a PDF buffer.
 *
 * @param {object} args
 * @param {object} args.proposal      the stored proposal (prospect, letter, snapshot)
 * @param {object} [args.firmSettings] name, logo and address of the firm
 * @param {Date} [args.preparedOn]    the date printed under the title (tests pin it)
 * @param {boolean} [args.compress]   off makes the text readable out of the buffer
 * @returns {Promise<Buffer>}
 */
export function buildProposalPdf({
  proposal,
  firmSettings = null,
  preparedOn = new Date(),
  compress = true,
}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margin: MARGIN,
      compress,
      info: {
        Title: `Proposal for ${String(proposal?.prospect?.company || proposal?.prospect?.contactName || '').trim()}`.trim(),
        Author: String(firmSettings?.name ?? '').trim() || DEFAULT_FIRM_NAME,
      },
    })
    const chunks = []
    doc.on('data', (chunk) => chunks.push(chunk))
    doc.on('error', reject)
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    try {
      drawProposal(doc, { proposal, firmSettings, preparedOn })
      doc.end()
    } catch (error) {
      reject(error)
    }
  })
}

/** "Acme Books" -> "Proposal-Acme-Books.pdf", with anything path-ish stripped. */
export function proposalPdfFilename(proposal) {
  const name = String(proposal?.prospect?.company || proposal?.prospect?.contactName || proposal?.id || '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
  return `Proposal-${name || 'draft'}.pdf`
}
```

In `server.js`, replace
```js
import { buildInvoicePdf, invoicePdfFilename } from './lib/invoice-pdf.js'
```
with
```js
import { buildInvoicePdf, invoicePdfFilename } from './lib/invoice-pdf.js'
import { buildProposalPdf, proposalPdfFilename } from './lib/proposal-pdf.js'
```
and directly after the `proposalLetterMatch` route add:

```js

    // GET /api/proposals/:id/pdf — "Preview PDF": exactly the document Send
    // attaches, rendered from the stored snapshot and the edited letter.
    const proposalPdfMatch = normalizedPath.match(/^\/api\/proposals\/([^/]+)\/pdf$/)
    if (proposalPdfMatch && request.method === 'GET') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can see proposals' })
        return
      }
      const proposal = await appDataStore.getProposal(proposalPdfMatch[1])
      if (!proposal) {
        sendJson(response, 404, { error: 'Proposal not found' })
        return
      }
      const pdf = await buildProposalPdf({
        proposal,
        firmSettings: await appDataStore.getFirmSettings(),
      })
      response.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${proposalPdfFilename(proposal)}"`,
        'Cache-Control': 'no-store',
      })
      response.end(pdf)
      return
    }
```

In `src/components/proposals/LetterTab.tsx`, replace
```tsx
            {copied ? 'Copied' : 'Copy text'}
          </button>
        </div>
```
with
```tsx
            {copied ? 'Copied' : 'Copy text'}
          </button>
          <a
            className="secondary-action"
            href={`/api/proposals/${encodeURIComponent(proposal.id)}/pdf`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Preview PDF
          </a>
        </div>
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run lib/proposal-pdf.test.mjs lib/invoice-pdf.test.mjs lib/invoice-email.test.mjs lib/invoice-payment-email.test.mjs src/__tests__/proposal-routes.test.ts src/__tests__/proposals-page.test.tsx`
Expected: PASS — 4 new PDF tests, 3 new route tests, 1 new page test; the invoice PDF and email suites unchanged (the refactor moves code, not output).

- [ ] **Step 5: Verify and commit**

Run: `node --check server.js` then `npm run verify` — expected green.

```bash
git add lib/proposal-pdf.js lib/proposal-pdf.test.mjs lib/invoice-pdf.js lib/invoice-email.js server.js src/components/proposals/LetterTab.tsx src/__tests__/proposal-routes.test.ts src/__tests__/proposals-page.test.tsx
git commit -m "A proposal renders as a branded PDF — letterhead, letter, pricing by group and totals — previewable from the Letter tab; the invoice PDF and email share its letterhead lines" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Send the proposal PDF by email, and file delivery events on the proposal

**Files:**
- Create: `lib/proposal-email.js`
- Create: `lib/proposal-email.test.mjs`
- Modify: `lib/notify.js` — `function invoiceEmailTags({ invoiceId, kind })` (:491-503), the JSDoc `@param … [args.kind]` line (~:538), the `sendInvoiceEmail({ … invoiceId = null, kind = null, })` parameters (~:550-551), and `const tags = invoiceEmailTags({ invoiceId, kind })` (~:572).
- Modify: `server.js`
  - the Task 10 import `import { buildProposalPdf, proposalPdfFilename } from './lib/proposal-pdf.js'`
  - directly after `function broadcastDataChanged() { … }` (~:1433-1442)
  - the Resend webhook route, right after `const tagBag = … : (eventData.tags ?? {})` (~:4034-4036)
  - directly after the Task 10 `proposalPdfMatch` route
- Modify: `src/lib/api.ts` — after `draftProposalLetterRequest` (Task 9).
- Modify: `src/lib/proposals.ts` — after `export function proposalActivity(` (Task 7).
- Modify: `src/components/proposals/LetterTab.tsx` — imports, props, and after the Preview PDF link.
- Modify: `src/pages/ProposalEditorPage.tsx` — api import list and the `<LetterTab … />` props.
- Modify: `src/__tests__/proposal-routes.test.ts`, `src/__tests__/proposals-page.test.tsx` — append; the page test's mock list and `beforeEach`.

**Interfaces:**
- Consumes: `buildProposalPdf`, `proposalPdfFilename` (Task 10); `firmDetailLines` (Task 8); `appendProposalEmailEvent`, `setProposalStatus`, `getProposal` (Task 4); `sendInvoiceEmail`, `notify` (`lib/notify.js`); `getPublicAppUrl`, `getTeamMembers`.
- Produces: `sendInvoiceEmail({ …, proposalId })` tags `proposal_id` (and `kind`); `buildProposalEmail({ proposal, firmSettings }) -> { subject, html, text }`; `POST /api/proposals/:id/send` `{ to }` → `Proposal` (400 bad address, 409 no letter / accepted / declined, 502 `proposal_send_failed`); `recordProposalDelivery(request, proposalId, deliveryEvent, resendEvent) -> Promise<boolean>` (module function in `server.js`); the webhook files a `proposal_id`-tagged event on the proposal and never on an invoice, never writes status, and notifies owners once on a bounce or complaint; `sendProposalRequest(id, to): Promise<Proposal>`; `proposalDeliveryBadge(proposal) -> string | null`; `LetterTab` gains `onSend(to)`.

The bounce notice reuses the existing `invoice_email_bounced` event with its own subject ("Proposal email problem: …"), so the owners' existing "Invoice alerts" email switch governs it and the notification-prefs catalog (and its pinned tests) stays as it is.

- [ ] **Step 1: Write the failing tests**

Create `lib/proposal-email.test.mjs`:

```js
import { afterEach, describe, expect, it, vi } from 'vitest'

import { sendInvoiceEmail } from './notify.js'
import { buildProposalEmail } from './proposal-email.js'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('buildProposalEmail', () => {
  const proposal = {
    prospect: { company: 'Acme Books', contactName: 'Pat <Doe>' },
    letter: { subject: 'Your bookkeeping proposal', text: '...' },
  }

  it('uses the letter subject, greets the contact and escapes the HTML', () => {
    const email = buildProposalEmail({
      proposal,
      firmSettings: { name: 'PB&J Strategic Accounting', city: 'Nashville', state: 'TN' },
    })
    expect(email.subject).toBe('Your bookkeeping proposal')
    expect(email.text).toContain('Hi Pat <Doe>,')
    expect(email.text).toContain('Nashville, TN')
    expect(email.html).toContain('Hi Pat &lt;Doe&gt;,')
    expect(email.html).not.toContain('<Doe>')
  })

  it('falls back to a subject naming the firm', () => {
    expect(buildProposalEmail({ proposal: { prospect: {} } }).subject).toBe(
      'Your proposal from PB&J Strategic Accounting',
    )
  })
})

describe('sendInvoiceEmail for a proposal', () => {
  it('tags the proposal, not an invoice, so the webhook can find it', async () => {
    const calls = []
    vi.stubEnv('RESEND_API_KEY', 're_test_key')
    vi.stubEnv('INVOICE_EMAIL_FROM', 'billing@pbjsa.com')
    vi.stubGlobal('fetch', async (url, init) => {
      calls.push(JSON.parse(init.body))
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 're_1' }) }
    })
    const result = await sendInvoiceEmail({
      to: ['pat@acme.test'],
      subject: 's',
      html: '<p>hi</p>',
      proposalId: 'prop-1a2b3c4d',
      kind: 'proposal',
    })
    expect(result).toEqual({ ok: true, error: null, providerId: 're_1' })
    expect(calls[0].tags).toEqual([
      { name: 'proposal_id', value: 'prop-1a2b3c4d' },
      { name: 'kind', value: 'proposal' },
    ])
  })
})
```

Append to the end of `src/__tests__/proposal-routes.test.ts`:

```ts

describe('sending a proposal', () => {
  pinOwnerRoutes([
    {
      name: 'POST /api/proposals/:id/send',
      pattern: /proposalSendMatch && request\.method === 'POST'/,
      write: true,
    },
  ])

  const block = () => routeBlock(/proposalSendMatch && request\.method === 'POST'/, 4600)

  it('builds the PDF before anything is sent', () => {
    const text = block()
    expect(text).toContain('buildProposalPdf({ proposal, firmSettings })')
    expect(text.indexOf('buildProposalPdf(')).toBeLessThan(text.indexOf('sendInvoiceEmail('))
  })

  it('tags the email with the proposal so delivery events come back to it', () => {
    const text = block()
    expect(text).toContain('proposalId: proposal.id')
    expect(text).toContain("kind: 'proposal'")
  })

  it('logs every attempt and moves a draft to sent only after a successful send', () => {
    const text = block()
    expect(text).toContain('appDataStore.appendProposalEmailEvent(proposal.id, {')
    const failAt = text.indexOf('if (!sendResult.ok) {')
    expect(failAt).toBeGreaterThan(-1)
    expect(text.indexOf("setProposalStatus(proposal.id, 'sent')")).toBeGreaterThan(failAt)
    expect(text).toContain("proposal.status === 'draft'")
  })

  it('refuses without a letter and without a real address', () => {
    const text = block()
    expect(text).toContain('Draft the letter before sending the proposal.')
    expect(text).toContain("sendJson(response, 400, { error: 'A valid email address is required.' })")
  })
})

describe('the Resend webhook proposal branch', () => {
  const webhook = () =>
    routeBlock(/if \(normalizedPath === '\/api\/resend\/webhook' && request\.method === 'POST'\)/, 6000)

  it('files a proposal-tagged event on the proposal, before any invoice lookup', () => {
    const text = webhook()
    expect(text).toContain("typeof tagBag.proposal_id === 'string'")
    expect(text.indexOf('recordProposalDelivery(')).toBeLessThan(text.indexOf('const taggedInvoiceId'))
  })

  it('appends a delivery event, notifies once, and never writes a status', () => {
    const at = serverSource.indexOf('async function recordProposalDelivery(')
    expect(at).toBeGreaterThan(-1)
    const rest = serverSource.slice(at)
    const helper = rest.slice(0, rest.search(/\r?\n\}\r?\n/))
    expect(helper).toContain('appDataStore.appendProposalEmailEvent(proposal.id, {')
    expect(helper).toContain('const alreadyLogged =')
    expect(helper).not.toContain('setProposalStatus')
    expect(helper).not.toContain('updateProposal')
    expect(helper).not.toMatch(/status:\s*'/)
  })
})
```

In `src/__tests__/proposals-page.test.tsx`, replace
```tsx
  draftProposalLetterRequest: (...args: unknown[]) => api.draftProposalLetterRequest(...args),
}))
```
with
```tsx
  draftProposalLetterRequest: (...args: unknown[]) => api.draftProposalLetterRequest(...args),
  sendProposalRequest: (...args: unknown[]) => api.sendProposalRequest(...args),
}))
```
replace
```tsx
  api.draftProposalLetterRequest = vi.fn(async () => WITH_LETTER)
})
```
with
```tsx
  api.draftProposalLetterRequest = vi.fn(async () => WITH_LETTER)
  api.sendProposalRequest = vi.fn(async () => ({ ...WITH_LETTER, status: 'sent' }))
})
```
and append at the end of the file:

```tsx

describe('Send to prospect', () => {
  it('asks for the address, prefilled from the prospect, and sends to what she confirms', async () => {
    api.getProposalRequest = vi.fn(async () => WITH_LETTER)
    const prompt = vi.fn(() => 'pat@acme.test')
    vi.stubGlobal('prompt', prompt)
    renderEditor('/proposals/prop-1?tab=letter')
    fireEvent.click(await screen.findByRole('button', { name: 'Send to prospect' }))
    expect(prompt).toHaveBeenCalledWith('Send the proposal to which email address?', 'pat@acme.test')
    await waitFor(() => expect(api.sendProposalRequest).toHaveBeenCalledWith('prop-1', 'pat@acme.test'))
  })

  it('sends nothing when she cancels the address prompt', async () => {
    api.getProposalRequest = vi.fn(async () => WITH_LETTER)
    vi.stubGlobal('prompt', vi.fn(() => null))
    renderEditor('/proposals/prop-1?tab=letter')
    fireEvent.click(await screen.findByRole('button', { name: 'Send to prospect' }))
    expect(api.sendProposalRequest).not.toHaveBeenCalled()
  })

  it('cannot send before there is a letter', async () => {
    renderEditor('/proposals/prop-1?tab=letter')
    const send = (await screen.findByRole('button', { name: 'Send to prospect' })) as HTMLButtonElement
    expect(send.disabled).toBe(true)
  })

  it('shows what the mail provider said about the last send', async () => {
    api.getProposalRequest = vi.fn(async () => ({
      ...WITH_LETTER,
      status: 'sent' as const,
      emailLog: [
        { kind: 'send' as const, at: '2026-09-23T14:00:00.000Z', providerId: 're_1', to: ['pat@acme.test'], ok: true },
        { kind: 'delivery' as const, at: '2026-09-23T14:01:00.000Z', providerId: 're_1', to: ['pat@acme.test'], event: 'delivered' },
      ],
    }))
    renderEditor('/proposals/prop-1?tab=letter')
    expect(await screen.findByText('Delivered', { selector: '.status-pill' })).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run lib/proposal-email.test.mjs src/__tests__/proposal-routes.test.ts src/__tests__/proposals-page.test.tsx -t "proposal|Send to prospect|Resend|sending"`
Expected: FAIL — `./proposal-email.js` does not exist, the tag list has no `proposal_id`, the send route and webhook branch are not found, and there is no "Send to prospect" button.

- [ ] **Step 3: Implement**

In `lib/notify.js`, replace
```js
function invoiceEmailTags({ invoiceId, kind }) {
```
with
```js
function invoiceEmailTags({ invoiceId, kind, proposalId = null }) {
```
replace
```js
  if (id) tags.push({ name: 'invoice_id', value: id })
  const label = clean(kind)
```
with
```js
  if (id) tags.push({ name: 'invoice_id', value: id })
  // A proposal email (featreq-311473e2) names its proposal instead, so the
  // delivery webhook files the event on the proposal and never on an invoice.
  const proposal = clean(proposalId)
  if (proposal) tags.push({ name: 'proposal_id', value: proposal })
  const label = clean(kind)
```
replace
```js
 * @param {'invoice'|'payment_ack'|'receipt'} [args.kind] tagged the same way
```
with
```js
 * @param {string} [args.proposalId] tagged instead of invoiceId for a proposal email
 * @param {'invoice'|'payment_ack'|'receipt'|'proposal'} [args.kind] tagged the same way
```
replace (in `sendInvoiceEmail`'s parameters)
```js
  invoiceId = null,
  kind = null,
```
with
```js
  invoiceId = null,
  proposalId = null,
  kind = null,
```
and replace
```js
  const tags = invoiceEmailTags({ invoiceId, kind })
```
with
```js
  const tags = invoiceEmailTags({ invoiceId, kind, proposalId })
```

Create `lib/proposal-email.js`:

```js
/**
 * The email that carries a proposal PDF to a prospect (featreq-311473e2,
 * spec §5.4). Short on purpose: the proposal is the attachment. The subject is
 * the letter's own subject line when there is one.
 */

import { firmDetailLines } from './firm-lines.js'

const DEFAULT_FIRM_NAME = 'PB&J Strategic Accounting'

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char])

/**
 * @param {{ proposal: object, firmSettings?: object|null }} args
 * @returns {{ subject: string, html: string, text: string }}
 */
export function buildProposalEmail({ proposal, firmSettings = null }) {
  const firmName = String(firmSettings?.name ?? '').trim() || DEFAULT_FIRM_NAME
  const subject =
    String(proposal?.letter?.subject ?? '').trim().slice(0, 200) || `Your proposal from ${firmName}`
  const contactName = String(proposal?.prospect?.contactName ?? '').trim()
  const lines = [
    contactName ? `Hi ${contactName},` : 'Hello,',
    '',
    `Thank you for the chance to work with you. Your proposal from ${firmName} is attached as a PDF.`,
    'Reply to this email with any questions — we are glad to walk through it with you.',
    '',
    firmName,
    ...firmDetailLines(firmSettings),
  ]
  const text = lines.join('\n')
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#1f1d1a;">${lines
    .map((line) => (line ? `<p style="margin:0 0 4px;">${esc(line)}</p>` : '<br>'))
    .join('')}</div>`
  return { subject, html, text }
}
```

In `server.js`:

1. Replace
```js
import { buildProposalPdf, proposalPdfFilename } from './lib/proposal-pdf.js'
```
with
```js
import { buildProposalPdf, proposalPdfFilename } from './lib/proposal-pdf.js'
import { buildProposalEmail } from './lib/proposal-email.js'
```

2. Directly after the closing `}` of `function broadcastDataChanged() {` add:

```js

/**
 * A Resend delivery event about a PROPOSAL email (featreq-311473e2, spec §5.4):
 * appended to that proposal's email log — idempotently, in the store — and, on
 * a bounce or a spam complaint, told to every owner once. It NEVER touches the
 * proposal's status: a bounce does not un-send a proposal.
 *
 * Reuses the `invoice_email_bounced` event on purpose, so the owners' existing
 * "Invoice alerts" email switch governs it; the subject says it is a proposal.
 *
 * @returns {Promise<boolean>} whether the proposal was found
 */
async function recordProposalDelivery(request, proposalId, deliveryEvent, resendEvent) {
  const eventData = resendEvent?.data ?? {}
  const providerId = typeof eventData.email_id === 'string' ? eventData.email_id : null
  const proposal = await appDataStore.getProposal(proposalId)
  if (!proposal) {
    console.warn('[resend] event for an unknown proposal', resendEvent?.type, proposalId, providerId)
    return false
  }
  const detail =
    deliveryEvent === 'bounced' || deliveryEvent === 'complained'
      ? String(eventData.bounce?.message ?? eventData.bounce?.type ?? '')
      : ''
  const alreadyLogged = proposal.emailLog.some(
    (entry) =>
      entry?.kind === 'delivery' &&
      entry?.event === deliveryEvent &&
      (entry?.providerId ?? null) === providerId,
  )
  await appDataStore.appendProposalEmailEvent(proposal.id, {
    kind: 'delivery',
    event: deliveryEvent,
    at: resendEvent?.created_at ?? null,
    providerId,
    to: Array.isArray(eventData.to) ? eventData.to : [eventData.to].filter(Boolean),
    detail,
  })
  if (!alreadyLogged && (deliveryEvent === 'bounced' || deliveryEvent === 'complained')) {
    const what = deliveryEvent === 'bounced' ? 'bounced' : 'was marked as spam'
    const who = proposal.prospect.company || proposal.prospect.contactName || 'a prospect'
    const members = await appDataStore.getTeamMembers()
    for (const owner of members.filter((member) => member.role === 'owner')) {
      await notify(appDataStore, owner.id, 'invoice_email_bounced', {
        message: `The proposal to ${who} ${what}${detail ? `: ${detail}` : ''}`,
        subject: `Proposal email problem: ${who}`,
        link: `/proposals/${proposal.id}?tab=activity`,
        appPublicUrl: getPublicAppUrl(request),
      })
    }
  }
  return true
}
```

3. In the Resend webhook route, replace
```js
          : (eventData.tags ?? {})
        const taggedInvoiceId =
```
with
```js
          : (eventData.tags ?? {})
        // A proposal email carries a proposal_id tag: its events go on the
        // proposal's own log (never its status), and nowhere near an invoice.
        if (typeof tagBag.proposal_id === 'string' && tagBag.proposal_id) {
          const matched = await recordProposalDelivery(
            request,
            tagBag.proposal_id,
            deliveryEvent,
            resendEvent,
          )
          sendJson(response, 200, { received: true, matched })
          return
        }
        const taggedInvoiceId =
```
(Keep it this short: `src/__tests__/resend-webhook-routes.test.ts` reads the first 6000 characters of the route, and its invoice assertions must still fall inside them.)

4. Directly after the `proposalPdfMatch` route add:

```js

    // POST /api/proposals/:id/send — { to } (spec §5.4). The owner confirms the
    // address on every send; the prospect's email only pre-fills that prompt.
    // Sent through the invoice Resend path, tagged with the proposal so the
    // delivery webhook files its events here. Draft -> sent on the first
    // successful send; every attempt, failed ones included, is logged.
    const proposalSendMatch = normalizedPath.match(/^\/api\/proposals\/([^/]+)\/send$/)
    if (proposalSendMatch && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can send proposals' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }
      if (!isJsonContentType(request)) {
        sendJson(response, 415, { error: 'application/json required' })
        return
      }
      const payload = await readJsonBody(request)
      const to = typeof payload?.to === 'string' ? payload.to.trim() : ''
      if (!to || to.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
        sendJson(response, 400, { error: 'A valid email address is required.' })
        return
      }
      const proposal = await appDataStore.getProposal(proposalSendMatch[1])
      if (!proposal) {
        sendJson(response, 404, { error: 'Proposal not found' })
        return
      }
      if (proposal.status === 'accepted' || proposal.status === 'declined') {
        sendJson(response, 409, {
          error: 'proposal_refused',
          message: `This proposal is ${proposal.status} — copy it to send a new one.`,
        })
        return
      }
      if (!String(proposal.letter?.text ?? '').trim()) {
        sendJson(response, 409, {
          error: 'proposal_refused',
          message: 'Draft the letter before sending the proposal.',
        })
        return
      }
      const firmSettings = await appDataStore.getFirmSettings()
      // The PDF IS the proposal, so it is built before anything is sent: a
      // render failure sends nothing rather than an email with no proposal.
      const pdf = await buildProposalPdf({ proposal, firmSettings })
      const email = buildProposalEmail({ proposal, firmSettings })
      const sendResult = await sendInvoiceEmail({
        to: [to],
        subject: email.subject,
        html: email.html,
        text: email.text,
        attachments: [{ filename: proposalPdfFilename(proposal), content: pdf }],
        fromName: firmSettings?.name || undefined,
        proposalId: proposal.id,
        kind: 'proposal',
      })
      await appDataStore.appendProposalEmailEvent(proposal.id, {
        kind: 'send',
        ok: sendResult.ok,
        to: [to],
        subject: email.subject,
        providerId: sendResult.providerId ?? null,
        error: sendResult.error ?? null,
      })
      if (!sendResult.ok) {
        broadcastDataChanged()
        sendJson(response, 502, { error: 'proposal_send_failed', message: sendResult.error })
        return
      }
      // Past this point the email HAS gone out, so no bookkeeping failure may
      // make the answer say otherwise.
      let sent = proposal
      try {
        sent =
          (proposal.status === 'draft'
            ? await appDataStore.setProposalStatus(proposal.id, 'sent')
            : await appDataStore.getProposal(proposal.id)) ?? proposal
        await appDataStore.recordActivity(
          session.user.id,
          'proposal_sent',
          `${proposal.prospect.company || proposal.id} -> ${to}`,
        )
      } catch (error) {
        console.error('[proposals] send bookkeeping failed after delivery:', error)
      }
      broadcastDataChanged()
      sendJson(response, 200, sent)
      return
    }
```

In `src/lib/api.ts`, directly after the closing `}` of `export function draftProposalLetterRequest(` add:

```ts

/** Owner-only: email the proposal PDF to the address she confirmed. */
export function sendProposalRequest(id: string, to: string): Promise<Proposal> {
  return proposalRequest<Proposal>(
    proposalPath(id, 'send'),
    proposalJson('POST', { to }),
    'The proposal could not be sent',
  )
}
```

In `src/lib/proposals.ts`, append after the closing `}` of `export function proposalActivity(`:

```ts

/**
 * The delivery badge beside "Send to prospect": what the mail provider last
 * said about the most recent successful send, or "Sent <date>" before it has
 * said anything. Null when nothing has gone out.
 */
export function proposalDeliveryBadge(proposal: Proposal): string | null {
  const lastSend = proposal.emailLog.filter((entry) => entry.kind === 'send' && entry.ok).at(-1)
  if (!lastSend) return null
  const latest = proposal.emailLog
    .filter(
      (entry) =>
        entry.kind === 'delivery' &&
        entry.providerId !== null &&
        entry.providerId === lastSend.providerId,
    )
    .at(-1)
  if (latest) return DELIVERY_WORDS[latest.event ?? ''] ?? latest.event ?? 'Sent'
  return `Sent ${proposalDate(lastSend.at)}`
}
```

In `src/components/proposals/LetterTab.tsx`, replace
```tsx
import { SavingTextarea } from '../SectionKit'
import type { Proposal } from '../../lib/types'
```
with
```tsx
import { SavingTextarea } from '../SectionKit'
import { proposalDeliveryBadge } from '../../lib/proposals'
import type { Proposal } from '../../lib/types'
```
replace
```tsx
  onDraft,
  onSaveText,
}: {
  proposal: Proposal
  busy: boolean
  onDraft: () => void
  onSaveText: (text: string) => void
}) {
  const [copied, setCopied] = useState(false)
  const locked = proposal.status === 'accepted' || proposal.status === 'declined'
  const text = proposal.letter?.text ?? ''
```
with
```tsx
  onDraft,
  onSaveText,
  onSend,
}: {
  proposal: Proposal
  busy: boolean
  onDraft: () => void
  onSaveText: (text: string) => void
  onSend: (to: string) => void
}) {
  const [copied, setCopied] = useState(false)
  const locked = proposal.status === 'accepted' || proposal.status === 'declined'
  const text = proposal.letter?.text ?? ''
  const badge = proposalDeliveryBadge(proposal)

  // The address is confirmed on EVERY send; the prospect's email only fills it in.
  const send = () => {
    const to = window.prompt('Send the proposal to which email address?', proposal.prospect.email)
    if (to === null || !to.trim()) return
    onSend(to.trim())
  }
```
and replace
```tsx
            Preview PDF
          </a>
        </div>
```
with
```tsx
            Preview PDF
          </a>
          <button
            type="button"
            className="primary-action"
            disabled={busy || locked || !text}
            onClick={send}
          >
            Send to prospect
          </button>
          {badge ? <span className="status-pill">{badge}</span> : null}
        </div>
```

In `src/pages/ProposalEditorPage.tsx`, change
```tsx
  repriceProposalRequest,
  updateProposalRequest,
} from '../lib/api'
```
to
```tsx
  repriceProposalRequest,
  sendProposalRequest,
  updateProposalRequest,
} from '../lib/api'
```
and replace
```tsx
          onSaveText={(text) => save({ letterText: text })}
        />
```
with
```tsx
          onSaveText={(text) => save({ letterText: text })}
          onSend={(to) => void run(() => sendProposalRequest(proposalId, to))}
        />
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run lib/proposal-email.test.mjs lib/invoice-payment-email.test.mjs src/__tests__/proposal-routes.test.ts src/__tests__/resend-webhook-routes.test.ts src/__tests__/proposals-page.test.tsx`
Expected: PASS — 3 email tests, 10 new route tests, 4 new page tests; the existing Resend webhook suite and the invoice tag tests unchanged.

- [ ] **Step 5: Verify and commit**

Run: `node --check server.js` then `npm run verify` — expected green.

```bash
git add lib/notify.js lib/proposal-email.js lib/proposal-email.test.mjs server.js src/lib/api.ts src/lib/proposals.ts src/components/proposals/LetterTab.tsx src/pages/ProposalEditorPage.tsx src/__tests__/proposal-routes.test.ts src/__tests__/proposals-page.test.tsx
git commit -m "Send to prospect emails the proposal PDF to the address she confirms, logs every attempt, and files delivery events on the proposal without ever changing its status" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Accept turns a prospect into a client in Onboarding; Decline keeps a note

**Files:**
- Modify: `db/store.js` — directly after `async setProposalLetter(id, letter) { … }` (Task 9).
- Modify: `server.js` — directly after the Task 11 `proposalSendMatch` route (ends `sendJson(response, 200, sent)\n      return\n    }`).
- Modify: `src/lib/api.ts` — after `sendProposalRequest` (Task 11).
- Modify: `src/pages/ProposalEditorPage.tsx` — imports, state, a packages effect, two handlers, the header's `<div className="button-row">`.
- Modify: `db/store-staleness.test.mjs`, `src/__tests__/proposal-routes.test.ts`, `src/__tests__/proposals-page.test.tsx` — append; the page test's mock list and `beforeEach`.

**Interfaces:**
- Consumes: `createClient`, `_setClientPlanIds`, `applyPackageToClient`, `read`, `recordActivity`, `getFirmSettings` (existing store); `setProposalStatus`, `getProposal` (Task 4); `listPackagesRequest` (existing api).
- Produces:
  - `appDataStore.setClientMonthlyRate(clientId, monthlyRate) -> boolean` (targeted `update clients set monthly_rate`, both backends).
  - `appDataStore.acceptProposal(id, { actorUserId, packageId, planIds, updateMonthlyRate }) -> { proposal, clientId, createdClient, packageApplied } | null` — `client_id` null: `createClient({ name: company || contactName, contact, contactName, email, phone, lifecycleStage: 'onboarding', billingMode: 'subscription', monthlyRate: totals.monthly, paymentTerms: firm.clientDefaults.paymentTerms, newPrimaryContact })`, linked to the proposal at once; `client_id` set: the monthly rate moves only with `updateMonthlyRate === true`; chosen plans unioned (known plans only) through `_setClientPlanIds`; a chosen package through `applyPackageToClient`; activity `proposal_accepted` names the proposal id; throws `ProposalStateError` when already accepted/declined or nameless.
  - `POST /api/proposals/:id/accept` `{ packageId?, planIds?, updateMonthlyRate? }` → the result (409 `proposal_refused` for `ProposalStateError` / `PackageApplyError`); `POST /api/proposals/:id/decline` `{ note }` → `Proposal`.
  - `AcceptProposalResult`, `acceptProposalRequest(id, input)`, `declineProposalRequest(id, note)`.
  - Header: a "Package to apply on accept" select, **Accept** (confirm; an upsell asks a second, separate question before changing the monthly fee), **Decline** (prompt for a note), **Open the client** once accepted.

Reading of the spec: §4.2 has no column for a chosen package or plans, so Accept takes them in its request (the header's package picker) rather than storing them on the proposal.

- [ ] **Step 1: Write the failing tests**

Append to the end of `db/store-staleness.test.mjs`:

```js

describe('accepting a proposal (file backend)', () => {
  beforeEach(async () => {
    await clearProposals()
    await setProposalRates(store)
    await store.write(
      workspace({
        plans: [{ id: 'plan-books', name: 'Bookkeeping', notes: '', templateIds: [] }],
      }),
    )
  })

  const prospectProposal = () =>
    store.createProposal({
      prospect: {
        company: 'Acme Books',
        contactName: 'Pat Doe',
        email: 'pat@acme.test',
        phone: '615-555-0101',
      },
      inputs: { transactions: 120 },
      selections: [{ serviceId: 'monthly-weekly-transactions-basic' }],
    })

  it('creates the client in Onboarding, billed monthly at the proposal total', async () => {
    const proposal = await prospectProposal()
    const result = await store.acceptProposal(proposal.id, {
      actorUserId: 'emp-patrice',
      planIds: ['plan-books', 'plan-gone'],
    })
    expect(result.createdClient).toBe(true)
    expect(result.proposal.status).toBe('accepted')
    expect(result.proposal.clientId).toBe(result.clientId)
    expect(result.proposal.acceptedAt).toBeTruthy()

    const client = (await store.read()).clients.find((row) => row.id === result.clientId)
    expect(client).toMatchObject({
      name: 'Acme Books',
      contactName: 'Pat Doe',
      email: 'pat@acme.test',
      lifecycleStage: 'onboarding',
      billingMode: 'subscription',
      monthlyRate: 630,
      planIds: ['plan-books'],
    })
  })

  it('never accepts twice', async () => {
    const proposal = await prospectProposal()
    await store.acceptProposal(proposal.id, {})
    await expect(store.acceptProposal(proposal.id, {})).rejects.toBeInstanceOf(ProposalStateError)
    expect((await store.read()).clients.filter((row) => row.name === 'Acme Books')).toHaveLength(1)
  })

  it('an upsell leaves the client’s monthly rate alone unless she confirmed it', async () => {
    const upsell = await store.createProposal({
      clientId: 'c1',
      inputs: { transactions: 120 },
      selections: [{ serviceId: 'monthly-weekly-transactions-basic' }],
    })
    const kept = await store.acceptProposal(upsell.id, { updateMonthlyRate: false })
    expect(kept.createdClient).toBe(false)
    expect((await store.read()).clients.find((row) => row.id === 'c1').monthlyRate ?? 0).not.toBe(630)

    const again = await store.createProposal({
      clientId: 'c1',
      inputs: { transactions: 120 },
      selections: [{ serviceId: 'monthly-weekly-transactions-basic' }],
    })
    await store.acceptProposal(again.id, { updateMonthlyRate: true })
    expect((await store.read()).clients.find((row) => row.id === 'c1').monthlyRate).toBe(630)
  })

  it('refuses a prospect with no name to put on the client', async () => {
    const nameless = await store.createProposal({})
    await expect(store.acceptProposal(nameless.id, {})).rejects.toBeInstanceOf(ProposalStateError)
  })
})

describe('accepting a proposal (postgres branch)', () => {
  it('changes an upsell client’s rate with one targeted statement', async () => {
    const fake = fakeProposalPostgres(proposalRow())
    await postgresStore(fake).setClientMonthlyRate('c1', 630)
    const update = fake.matching(/^update clients/i)[0]
    expect(update.text).toMatch(/set monthly_rate = \$2/)
    expect(update.params).toEqual(['c1', 630])
  })

  it('refuses an accepted proposal before writing anything', async () => {
    const fake = fakeProposalPostgres(proposalRow({ status: 'accepted' }))
    await expect(postgresStore(fake).acceptProposal('prop-1', {})).rejects.toBeInstanceOf(
      ProposalStateError,
    )
    expect(fake.matching(/^(insert|update)/i)).toHaveLength(0)
  })
})
```

Append to the end of `src/__tests__/proposal-routes.test.ts`:

```ts

describe('accepting and declining', () => {
  pinOwnerRoutes([
    {
      name: 'POST /api/proposals/:id/accept',
      pattern: /proposalAcceptMatch && request\.method === 'POST'/,
      write: true,
    },
    {
      name: 'POST /api/proposals/:id/decline',
      pattern: /proposalDeclineMatch && request\.method === 'POST'/,
      write: true,
    },
  ])

  const accept = () => routeBlock(/proposalAcceptMatch && request\.method === 'POST'/, 2400)

  it('Accept goes through the store, which alone decides whether a client is created', () => {
    const text = accept()
    expect(text).toContain('appDataStore.acceptProposal(proposalAcceptMatch[1], {')
    expect(text).not.toContain('appDataStore.createClient(')
    expect(text).toContain('updateMonthlyRate: payload.updateMonthlyRate === true')
  })

  it('a refusal is a 409 with the sentence', () => {
    const text = accept()
    expect(text).toContain('error instanceof ProposalStateError || error instanceof PackageApplyError')
    expect(text).toContain("sendJson(response, 409, { error: 'proposal_refused', message: error.message })")
  })

  it('Decline records the note through the status write', () => {
    const text = routeBlock(/proposalDeclineMatch && request\.method === 'POST'/, 2400)
    expect(text).toContain("appDataStore.setProposalStatus(current.id, 'declined', {")
  })
})
```

In `src/__tests__/proposals-page.test.tsx`, replace
```tsx
  sendProposalRequest: (...args: unknown[]) => api.sendProposalRequest(...args),
}))
```
with
```tsx
  sendProposalRequest: (...args: unknown[]) => api.sendProposalRequest(...args),
  listPackagesRequest: (...args: unknown[]) => api.listPackagesRequest(...args),
  acceptProposalRequest: (...args: unknown[]) => api.acceptProposalRequest(...args),
  declineProposalRequest: (...args: unknown[]) => api.declineProposalRequest(...args),
}))
```
replace
```tsx
  api.sendProposalRequest = vi.fn(async () => ({ ...WITH_LETTER, status: 'sent' }))
})
```
with
```tsx
  api.sendProposalRequest = vi.fn(async () => ({ ...WITH_LETTER, status: 'sent' }))
  api.listPackagesRequest = vi.fn(async () => [
    { id: 'pkg-1', name: 'Full service', description: '', planIds: [], templateIds: [], createdAt: '', updatedAt: null },
  ])
  api.acceptProposalRequest = vi.fn(async () => ({
    proposal: { ...PROPOSAL, status: 'accepted', clientId: 'client-new' },
    clientId: 'client-new',
    createdClient: true,
    packageApplied: false,
  }))
  api.declineProposalRequest = vi.fn(async () => ({ ...PROPOSAL, status: 'declined' }))
})
```
and append at the end of the file:

```tsx

describe('Accept and Decline', () => {
  it('Accept on a prospect says what it will create, then accepts', async () => {
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    renderEditor()
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }))
    expect(confirm).toHaveBeenCalledWith(
      'Accept this proposal? This adds Acme Books as a client in Onboarding, billed monthly at $630.00. Nothing about any invoice changes.',
    )
    await waitFor(() =>
      expect(api.acceptProposalRequest).toHaveBeenCalledWith('prop-1', { packageId: null }),
    )
    expect(await screen.findByText('Accepted', { selector: '.status-pill' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open the client' }).getAttribute('href')).toBe(
      '/clients/client-new',
    )
  })

  it('does nothing when the Accept confirm is canceled', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false))
    renderEditor()
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }))
    expect(api.acceptProposalRequest).not.toHaveBeenCalled()
  })

  it('sends the chosen package with the accept', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    renderEditor()
    await waitFor(() => expect(api.listPackagesRequest).toHaveBeenCalled())
    fireEvent.change(await screen.findByLabelText('Package to apply on accept'), {
      target: { value: 'pkg-1' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    await waitFor(() =>
      expect(api.acceptProposalRequest).toHaveBeenCalledWith('prop-1', { packageId: 'pkg-1' }),
    )
  })

  it('an upsell asks separately before it changes the client’s monthly fee', async () => {
    api.getProposalRequest = vi.fn(async () => ({ ...PROPOSAL, clientId: 'client-1' }))
    const confirm = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false)
    vi.stubGlobal('confirm', confirm)
    renderEditor()
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }))
    expect(confirm).toHaveBeenNthCalledWith(1, 'Accept this proposal for Existing Co?')
    expect(confirm).toHaveBeenNthCalledWith(
      2,
      'Also change Existing Co’s monthly fee to $630.00? Cancel keeps their current fee.',
    )
    await waitFor(() =>
      expect(api.acceptProposalRequest).toHaveBeenCalledWith('prop-1', {
        packageId: null,
        updateMonthlyRate: false,
      }),
    )
  })

  it('Decline asks for a note and saves it', async () => {
    vi.stubGlobal('prompt', vi.fn(() => 'Went with a friend'))
    renderEditor()
    fireEvent.click(await screen.findByRole('button', { name: 'Decline' }))
    await waitFor(() =>
      expect(api.declineProposalRequest).toHaveBeenCalledWith('prop-1', 'Went with a friend'),
    )
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run db/store-staleness.test.mjs src/__tests__/proposal-routes.test.ts src/__tests__/proposals-page.test.tsx -t "accept|Accept|Decline|declining"`
Expected: FAIL — `acceptProposal` / `setClientMonthlyRate` are not functions, the routes are not found, and there is no Accept button.

- [ ] **Step 3: Implement**

In `db/store.js`, directly after the closing `}` of `async setProposalLetter(id, letter) {` add:

```js

  /**
   * Targeted write of one client's monthly rate — Accept's upsell path, and
   * only after the owner confirmed it in the page. Never the bulk save
   * (cardinal rule 4). Returns true when a client row changed.
   */
  async setClientMonthlyRate(clientId, monthlyRate) {
    if (!clientId) return false
    const rate = clampMoney(monthlyRate ?? 0)
    if (this.pool) {
      const result = await this.pool.query(
        `update clients set monthly_rate = $2, updated_at = now() where id = $1 returning id`,
        [clientId, rate],
      )
      return (result.rowCount ?? 0) > 0
    }
    const data = await readJson(localDataPath)
    let found = false
    data.clients = (data.clients ?? []).map((client) => {
      if (client.id !== clientId) return client
      found = true
      return { ...client, monthlyRate: rate }
    })
    if (!found) return false
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return true
  }

  /**
   * Accept a proposal (spec §5.5).
   *
   * A PROSPECT (no `client_id`) becomes a client: company, contact fields,
   * Onboarding, Monthly billing at the proposal's monthly total, the firm's
   * default payment terms. The new client is linked to the proposal at once, so
   * a second press after a later failure can never create it twice.
   *
   * An UPSELL (`client_id` set) changes that client's monthly rate only when
   * `updateMonthlyRate` is true — the page asks first.
   *
   * Chosen plans are unioned in through the targeted plan write and a chosen
   * package through `applyPackageToClient`, the same paths the client page
   * uses. Nothing about any existing invoice changes.
   *
   * @returns {{ proposal, clientId, createdClient, packageApplied } | null}
   */
  async acceptProposal(
    id,
    { actorUserId = null, packageId = null, planIds = [], updateMonthlyRate = false } = {},
  ) {
    const proposal = await this.getProposal(id)
    if (!proposal) return null
    if (proposal.status === 'accepted' || proposal.status === 'declined') {
      throw new ProposalStateError(`This proposal is already ${proposal.status}.`)
    }
    const monthlyRate = Number(proposal.pricingSnapshot?.totals?.monthly) || 0
    let clientId = proposal.clientId
    let createdClient = false

    if (!clientId) {
      const { company, contactName, email, phone } = proposal.prospect
      const name = company || contactName
      if (!name) {
        throw new ProposalStateError('Give the prospect a company or contact name before accepting.')
      }
      const firm = await this.getFirmSettings()
      const client = await this.createClient({
        name,
        contact: contactName,
        contactName,
        email,
        phone,
        lifecycleStage: 'onboarding',
        billingMode: 'subscription',
        monthlyRate,
        paymentTerms: firm.clientDefaults?.paymentTerms ?? '',
        ...(contactName ? { newPrimaryContact: { name: contactName, email, phone } } : {}),
      })
      if (!client) throw new ProposalStateError('The client could not be created.')
      clientId = client.id
      createdClient = true
      await this.setProposalStatus(id, proposal.status, { clientId })
    } else if (updateMonthlyRate === true) {
      await this.setClientMonthlyRate(clientId, monthlyRate)
    }

    const wantedPlans = [
      ...new Set(
        (Array.isArray(planIds) ? planIds : []).filter((planId) => typeof planId === 'string' && planId),
      ),
    ]
    if (wantedPlans.length > 0) {
      const data = await this.read()
      const client = (data.clients ?? []).find((row) => row.id === clientId)
      const known = new Set((data.plans ?? []).map((plan) => plan.id))
      const existing = Array.isArray(client?.planIds) ? client.planIds : []
      const added = wantedPlans.filter((planId) => known.has(planId) && !existing.includes(planId))
      if (client && added.length > 0) await this._setClientPlanIds(clientId, [...existing, ...added])
    }
    const packageResult =
      typeof packageId === 'string' && packageId
        ? await this.applyPackageToClient(clientId, packageId, { actorUserId })
        : null

    const accepted = await this.setProposalStatus(id, 'accepted', { clientId })
    if (actorUserId) {
      await this.recordActivity(
        actorUserId,
        'proposal_accepted',
        `${proposal.prospect.company || proposal.prospect.contactName || 'Proposal'} · ${proposal.id}`,
      )
    }
    return { proposal: accepted, clientId, createdClient, packageApplied: Boolean(packageResult) }
  }
```

In `server.js`, directly after the `proposalSendMatch` route add:

```js

    // POST /api/proposals/:id/accept — { packageId?, planIds?, updateMonthlyRate? }
    // (spec §5.5). The store decides: a prospect becomes a client in Onboarding;
    // an existing client's monthly rate moves only when the page confirmed it.
    const proposalAcceptMatch = normalizedPath.match(/^\/api\/proposals\/([^/]+)\/accept$/)
    if (proposalAcceptMatch && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can accept proposals' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }
      if (!isJsonContentType(request)) {
        sendJson(response, 415, { error: 'application/json required' })
        return
      }
      const payload = (await readJsonBody(request)) ?? {}
      let result
      try {
        result = await appDataStore.acceptProposal(proposalAcceptMatch[1], {
          actorUserId: session.user.id,
          packageId: typeof payload.packageId === 'string' ? payload.packageId : null,
          planIds: Array.isArray(payload.planIds) ? payload.planIds : [],
          updateMonthlyRate: payload.updateMonthlyRate === true,
        })
      } catch (error) {
        if (error instanceof ProposalStateError || error instanceof PackageApplyError) {
          sendJson(response, 409, { error: 'proposal_refused', message: error.message })
          return
        }
        throw error
      }
      if (!result) {
        sendJson(response, 404, { error: 'Proposal not found' })
        return
      }
      broadcastDataChanged()
      sendJson(response, 200, result)
      return
    }

    // POST /api/proposals/:id/decline — { note } (spec §5.5). A declined
    // proposal stays on the list and is reopened as a copy.
    const proposalDeclineMatch = normalizedPath.match(/^\/api\/proposals\/([^/]+)\/decline$/)
    if (proposalDeclineMatch && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can decline proposals' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }
      if (!isJsonContentType(request)) {
        sendJson(response, 415, { error: 'application/json required' })
        return
      }
      const payload = await readJsonBody(request)
      const current = await appDataStore.getProposal(proposalDeclineMatch[1])
      if (!current) {
        sendJson(response, 404, { error: 'Proposal not found' })
        return
      }
      if (current.status === 'accepted' || current.status === 'declined') {
        sendJson(response, 409, {
          error: 'proposal_refused',
          message: `This proposal is already ${current.status}.`,
        })
        return
      }
      const declined = await appDataStore.setProposalStatus(current.id, 'declined', {
        note: typeof payload?.note === 'string' ? payload.note : '',
      })
      await appDataStore.recordActivity(
        session.user.id,
        'proposal_declined',
        current.prospect.company || current.id,
      )
      broadcastDataChanged()
      sendJson(response, 200, declined)
      return
    }
```

In `src/lib/api.ts`, directly after the closing `}` of `export function sendProposalRequest(` add:

```ts

/** What Accept did: the proposal, the client it created or used, and whether a package went on. */
export type AcceptProposalResult = {
  proposal: Proposal
  clientId: string
  createdClient: boolean
  packageApplied: boolean
}

/**
 * Owner-only: accept. A prospect becomes a client in Onboarding; an existing
 * client's monthly fee moves only with `updateMonthlyRate: true`.
 */
export function acceptProposalRequest(
  id: string,
  input: { packageId?: string | null; planIds?: string[]; updateMonthlyRate?: boolean } = {},
): Promise<AcceptProposalResult> {
  return proposalRequest<AcceptProposalResult>(
    proposalPath(id, 'accept'),
    proposalJson('POST', input),
    'The proposal could not be accepted',
  )
}

/** Owner-only: decline, with her note. The proposal stays on the list. */
export function declineProposalRequest(id: string, note: string): Promise<Proposal> {
  return proposalRequest<Proposal>(
    proposalPath(id, 'decline'),
    proposalJson('POST', { note }),
    'The proposal could not be declined',
  )
}
```

In `src/pages/ProposalEditorPage.tsx`:

1. Replace
```tsx
import { defaultProposalPricing } from '../../lib/proposal-pricing.js'
import {
  copyProposalRequest,
  deleteProposalRequest,
  draftProposalLetterRequest,
  fetchFirmSettings,
  getProposalRequest,
  repriceProposalRequest,
  sendProposalRequest,
  updateProposalRequest,
} from '../lib/api'
```
with
```tsx
import { defaultProposalPricing, formatProposalMoney } from '../../lib/proposal-pricing.js'
import {
  acceptProposalRequest,
  copyProposalRequest,
  declineProposalRequest,
  deleteProposalRequest,
  draftProposalLetterRequest,
  fetchFirmSettings,
  getProposalRequest,
  listPackagesRequest,
  repriceProposalRequest,
  sendProposalRequest,
  updateProposalRequest,
} from '../lib/api'
```
and replace
```tsx
import { ApiError, type Proposal, type ProposalPatch, type ProposalPricing } from '../lib/types'
```
with
```tsx
import {
  ApiError,
  type Package,
  type Proposal,
  type ProposalPatch,
  type ProposalPricing,
} from '../lib/types'
```

2. Replace
```tsx
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void Promise.all([getProposalRequest(proposalId), fetchFirmSettings()])
```
with
```tsx
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [packages, setPackages] = useState<Package[]>([])
  const [packageId, setPackageId] = useState('')

  // Packages are endpoint-managed; Accept can apply one. A failed list just
  // means Accept offers none.
  useEffect(() => {
    let cancelled = false
    void listPackagesRequest()
      .then((rows) => {
        if (!cancelled) setPackages(rows)
      })
      .catch(() => {
        if (!cancelled) setPackages([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void Promise.all([getProposalRequest(proposalId), fetchFirmSettings()])
```

3. Replace
```tsx
  if (!proposal || !pricing) {
    return (
```
with
```tsx
  // Accept says what it will do before it does it (spec §5.5). A prospect
  // becomes a client; an existing client's fee moves only on a second yes.
  const accept = () => {
    if (!proposal) return
    const monthly = formatProposalMoney(proposal.pricingSnapshot?.totals.monthly ?? 0)
    const chosenPackage = packageId || null
    if (!proposal.clientId) {
      const ok = window.confirm(
        `Accept this proposal? This adds ${proposalTitle(proposal)} as a client in Onboarding, ` +
          `billed monthly at ${monthly}. Nothing about any invoice changes.`,
      )
      if (!ok) return
      void run(async () => (await acceptProposalRequest(proposalId, { packageId: chosenPackage })).proposal)
      return
    }
    const clientName =
      data.clients.find((client) => client.id === proposal.clientId)?.name ?? 'this client'
    if (!window.confirm(`Accept this proposal for ${clientName}?`)) return
    const updateMonthlyRate = window.confirm(
      `Also change ${clientName}’s monthly fee to ${monthly}? Cancel keeps their current fee.`,
    )
    void run(
      async () =>
        (await acceptProposalRequest(proposalId, { packageId: chosenPackage, updateMonthlyRate }))
          .proposal,
    )
  }

  const decline = () => {
    const note = window.prompt('Why did they decline? (optional — saved on the proposal)', '')
    if (note === null) return
    void run(() => declineProposalRequest(proposalId, note))
  }

  if (!proposal || !pricing) {
    return (
```

4. Replace
```tsx
        <div className="button-row">
          <button type="button" className="secondary-action" disabled={busy} onClick={() => void copy()}>
```
with
```tsx
        <div className="button-row">
          {proposal.status === 'draft' || proposal.status === 'sent' ? (
            <>
              <select
                className="input"
                aria-label="Package to apply on accept"
                value={packageId}
                onChange={(event) => setPackageId(event.target.value)}
              >
                <option value="">No package</option>
                {packages.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>
              <button type="button" className="primary-action" disabled={busy} onClick={accept}>
                Accept
              </button>
              <button type="button" className="ghost-action" disabled={busy} onClick={decline}>
                Decline
              </button>
            </>
          ) : null}
          {proposal.status === 'accepted' && proposal.clientId ? (
            <Link className="secondary-action" to={`/clients/${proposal.clientId}`}>
              Open the client
            </Link>
          ) : null}
          <button type="button" className="secondary-action" disabled={busy} onClick={() => void copy()}>
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run db/store-staleness.test.mjs src/__tests__/proposal-routes.test.ts src/__tests__/proposals-page.test.tsx`
Expected: PASS — 6 new store tests, 10 new route tests, 5 new page tests.

Before shipping, the HANDOFF §4 rolled-back write check for Accept's Postgres half: in one `BEGIN` … `ROLLBACK`, run `createClient`'s insert with an Onboarding / subscription client, the `update proposals set status = 'accepted', client_id = …` statement and `update clients set monthly_rate = $2 …`, then `ROLLBACK` and re-select to prove nothing stayed.

- [ ] **Step 5: Verify and commit**

Run: `node --check server.js` then `npm run verify` — expected green.

```bash
git add db/store.js db/store-staleness.test.mjs server.js src/lib/api.ts src/pages/ProposalEditorPage.tsx src/__tests__/proposal-routes.test.ts src/__tests__/proposals-page.test.tsx
git commit -m "Accept makes the prospect a client in Onboarding at the proposal's monthly fee (an existing client's fee moves only on a second yes), and Decline keeps her note" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: The intake chat's brain — schema, patch validator and `proposalChat`

**Files:**
- Modify: `lib/proposal-pricing.js`, `lib/proposal-pricing.d.ts` — append `applyProposalPatch`.
- Modify: `lib/proposal-pricing.test.mjs` — the top import and append.
- Modify: `lib/assistant.js` — append at the end (after `draftProposalLetter`, Task 8).
- Modify: `lib/assistant.test.mjs` — the top import (the Task 8 additions) and append.

**Interfaces:**
- Consumes: `cleanProposalProspect`, `cleanProposalInputs`, `cleanProposalSelections` (Task 4); `formatProposalMoney` (Task 1); `runStructuredModel`, `jsonSchema`, `STRUCTURED_MAX_TOKENS`, `US_ENGLISH_RULE`, `meaningfulCharCount`, `MIN_MEANINGFUL_REPLY_CHARS`, `FALLBACK_STATUSES`, `isTransientInvalidRequest`, `getClient` (existing in `lib/assistant.js`).
- Produces:
  - `applyProposalPatch(current, patch, services) -> { prospect, inputs, selections }` (pure; adding a tier replaces that row's other tiers).
  - `PROPOSAL_CHAT_TURN_CHARS = 8000`, `PROPOSAL_CHAT_MAX_ADDS = 20`, `PROPOSAL_CHAT_SCHEMA` (every property required-and-nullable; `inputs` as `[{ key, value }]`; no bounds keywords).
  - `validateProposalPatch(patch, catalog) -> { prospect?, inputs?: Record<string, number>, selections?: { add, remove } } | null` (drops unknown input keys and service ids and retired rows; finite non-negative numbers; strings capped; ≤ 20 adds; `tier` resolves to that tier of the same row).
  - `buildProposalChatContext(proposal, catalog) -> string` (catalog, inputs with current values, prospect, the calculator's lines and totals).
  - `proposalChat(proposal, userText, ctx = { catalog }, opts?) -> Promise<{ reply, patch }>` — claude-opus-5-5, `modelFallback: false`, `runModel`'s transient-fault retry, and one more try on a provider fault with only the last six turns (the `spitballChat` answer); 400 on an empty turn.

Reading of the spec: structured outputs cannot express a free-form `{ [inputKey]: number }` map, so the schema carries `inputs` as a `{ key, value }` list and `validateProposalPatch` turns it into the spec's map before anything is applied.

- [ ] **Step 1: Write the failing tests**

In `lib/proposal-pricing.test.mjs`, change the top import from
```js
import {
  DEFAULT_PROPOSAL_PRICING,
  defaultProposalPricing,
```
to
```js
import {
  DEFAULT_PROPOSAL_PRICING,
  applyProposalPatch,
  defaultProposalPricing,
```
and append at the end of the file:

```js

describe('applyProposalPatch', () => {
  const services = defaultProposalPricing().services
  const current = {
    prospect: { company: 'Acme Books', contactName: '', email: '', phone: '', notes: '' },
    inputs: { transactions: 10 },
    selections: [
      { serviceId: 'monthly-weekly-transactions-basic', override: 5 },
      { serviceId: 'reconciliations' },
    ],
  }

  it('merges the prospect and inputs, and adds and removes services', () => {
    const next = applyProposalPatch(
      current,
      {
        prospect: { contactName: 'Pat Doe' },
        inputs: { transactions: 120, employees: 10 },
        selections: { add: [{ serviceId: 'payroll' }], remove: ['reconciliations'] },
      },
      services,
    )
    expect(next.prospect).toMatchObject({ company: 'Acme Books', contactName: 'Pat Doe' })
    expect(next.inputs).toEqual({ transactions: 120, employees: 10 })
    expect(next.selections.map((row) => row.serviceId)).toEqual([
      'monthly-weekly-transactions-basic',
      'payroll',
    ])
  })

  it('adding another tier of a row replaces the tier that was there', () => {
    const next = applyProposalPatch(
      current,
      { selections: { add: [{ serviceId: 'monthly-weekly-transactions-advance' }], remove: [] } },
      services,
    )
    expect(next.selections.map((row) => row.serviceId)).toEqual([
      'reconciliations',
      'monthly-weekly-transactions-advance',
    ])
  })

  it('a null patch changes nothing', () => {
    const next = applyProposalPatch(current, null, services)
    expect(next.inputs).toEqual(current.inputs)
    expect(next.selections).toEqual(current.selections)
  })
})
```

In `lib/assistant.test.mjs`, change the Task 8 import lines
```js
  PROPOSAL_LETTER_SCHEMA,
  buildProposalLetterPrompt,
```
to
```js
  PROPOSAL_CHAT_SCHEMA,
  PROPOSAL_LETTER_SCHEMA,
  buildProposalChatContext,
  buildProposalLetterPrompt,
  proposalChat,
  validateProposalPatch,
```
and append at the end of the file:

```js

/**
 * The proposal intake chat (featreq-311473e2, spec §5.2): the model collects
 * counts and picks services through a PATCH the server validates; it never
 * prices anything.
 */
describe('proposal intake chat', () => {
  const catalog = {
    inputs: [
      { key: 'transactions', label: 'Transactions', help: 'X' },
      { key: 'employees', label: 'Employees', help: 'I' },
    ],
    services: [
      { id: 'monthly-weekly-transactions-basic', group: 'Monthly', name: 'Weekly transactions', tier: 'Basic', pricing: 'formula', inputKey: 'transactions', active: true },
      { id: 'monthly-weekly-transactions-advance', group: 'Monthly', name: 'Weekly transactions', tier: 'Advance', pricing: 'formula', inputKey: 'transactions', active: true },
      { id: 'payroll', group: 'Payroll', name: 'Payroll', tier: null, pricing: 'payroll', inputKey: 'employees', active: true },
      { id: 'kpi-reports', group: 'Additional reports', name: 'KPI reports', tier: null, pricing: 'formula', inputKey: 'totalAccounts', active: false },
    ],
  }
  const proposal = {
    prospect: { company: 'Acme Books', contactName: '', email: '', phone: '', notes: '' },
    inputs: { transactions: 120 },
    selections: [{ serviceId: 'monthly-weekly-transactions-basic' }],
    pricingSnapshot: {
      lines: [{ serviceId: 'monthly-weekly-transactions-basic', name: 'Weekly transactions', tier: 'Basic', amount: 630 }],
      totals: { monthly: 630, annual: 0, oneTime: 0, cleanup: 0 },
    },
    messages: [
      { role: 'user', text: 'New prospect, Acme Books.' },
      { role: 'assistant', text: 'Great — how many transactions a month?' },
    ],
  }

  it('drops unknown inputs and services, retired rows and bad numbers, and caps adds', () => {
    const patch = validateProposalPatch(
      {
        prospect: { company: null, contactName: '  Pat Doe  ', email: null, phone: null, notes: null },
        inputs: [
          { key: 'employees', value: 10 },
          { key: 'widgets', value: 3 },
          { key: 'transactions', value: -5 },
        ],
        selections: {
          add: [
            { serviceId: 'payroll', tier: null, quantity: null, flatAmount: null },
            { serviceId: 'not-a-service', tier: null, quantity: null, flatAmount: null },
            { serviceId: 'kpi-reports', tier: null, quantity: null, flatAmount: null },
            ...Array.from({ length: 30 }, () => ({ serviceId: 'payroll', tier: null, quantity: 2, flatAmount: null })),
          ],
          remove: ['monthly-weekly-transactions-basic', 'nope'],
        },
      },
      catalog,
    )
    expect(patch.prospect).toEqual({ contactName: 'Pat Doe' })
    expect(patch.inputs).toEqual({ employees: 10 })
    expect(patch.selections.add).toHaveLength(20)
    expect(patch.selections.add[0]).toEqual({ serviceId: 'payroll' })
    expect(patch.selections.remove).toEqual(['monthly-weekly-transactions-basic'])
  })

  it('resolves a tier to that tier of the same row', () => {
    const patch = validateProposalPatch(
      {
        prospect: null,
        inputs: null,
        selections: {
          add: [{ serviceId: 'monthly-weekly-transactions-basic', tier: 'Advance', quantity: null, flatAmount: null }],
          remove: [],
        },
      },
      catalog,
    )
    expect(patch.selections.add).toEqual([{ serviceId: 'monthly-weekly-transactions-advance' }])
  })

  it('a patch with nothing usable is null', () => {
    expect(validateProposalPatch(null, catalog)).toBeNull()
    expect(validateProposalPatch({ prospect: null, inputs: [{ key: 'widgets', value: 1 }], selections: null }, catalog)).toBeNull()
  })

  it('tells the model the catalog, the inputs and ONLY the calculator’s prices', () => {
    const context = buildProposalChatContext(proposal, catalog)
    expect(context).toContain('- monthly-weekly-transactions-basic | Monthly | Weekly transactions | Basic | transactions | formula | SELECTED')
    expect(context).not.toContain('kpi-reports')
    expect(context).toContain('- transactions: Transactions = 120')
    expect(context).toContain('- employees: Employees = not collected yet')
    expect(context).toContain('- Weekly transactions (Basic): $630.00')
    expect(context).toContain('TOTALS: monthly $630.00')
  })

  it('answers with a reply and a validated patch, on Opus 5.5 with no fallback', async () => {
    const client = fakeClient([
      {
        stop_reason: 'end_turn',
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              reply: 'Ten on payroll — I added weekly payroll to the estimate.',
              patch: {
                prospect: null,
                inputs: [{ key: 'employees', value: 10 }, { key: 'widgets', value: 2 }],
                selections: { add: [{ serviceId: 'payroll', tier: null, quantity: null, flatAmount: null }], remove: [] },
              },
            }),
          },
        ],
      },
    ])
    const result = await proposalChat(proposal, 'They have 10 employees, paid weekly.', { catalog }, { client })
    expect(result.reply).toContain('Ten on payroll')
    expect(result.patch).toEqual({
      inputs: { employees: 10 },
      selections: { add: [{ serviceId: 'payroll' }], remove: [] },
    })
    const params = client.messages.create.mock.calls[0][0]
    expect(params.model).toBe('claude-opus-5-5')
    expect(params.messages.at(-1)).toEqual({ role: 'user', content: 'They have 10 employees, paid weekly.' })
    expect(params.messages).toHaveLength(3)
    expect(params.system).toContain('NEVER state a price')
  })

  it('refuses an empty turn without calling the model', async () => {
    const client = fakeClient([])
    await expect(proposalChat(proposal, '   ', { catalog }, { client })).rejects.toMatchObject({ statusCode: 400 })
    expect(client.messages.create).not.toHaveBeenCalled()
  })

  it('the chat schema carries no bounds keywords', () => {
    const offenders = []
    const walk = (node, path) => {
      if (!node || typeof node !== 'object') return
      for (const [key, value] of Object.entries(node)) {
        if (['minimum', 'maximum', 'minItems', 'maxItems'].includes(key)) offenders.push(path + '.' + key)
        walk(value, path + '.' + key)
      }
    }
    walk(PROPOSAL_CHAT_SCHEMA, 'schema')
    expect(offenders).toEqual([])
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run lib/proposal-pricing.test.mjs lib/assistant.test.mjs`
Expected: FAIL — `applyProposalPatch`, `PROPOSAL_CHAT_SCHEMA`, `validateProposalPatch`, `buildProposalChatContext` and `proposalChat` are not exported.

- [ ] **Step 3: Implement**

Append to the end of `lib/proposal-pricing.js`:

```js

/**
 * Apply a VALIDATED chat patch (see `validateProposalPatch` in
 * lib/assistant.js) to a proposal's editable fields. Pure: returns the next
 * prospect / inputs / selections and never touches status, letter or email.
 *
 * Adding one tier of a tiered row replaces its siblings (same group + name):
 * a client is on Basic OR Advance weekly transactions, never both.
 */
export function applyProposalPatch(current, patch, services) {
  const catalog = Array.isArray(services) ? services : []
  const byId = new Map(catalog.map((service) => [service.id, service]))
  const prospect = { ...cleanProposalProspect(current?.prospect) }
  for (const [field, value] of Object.entries(patch?.prospect ?? {})) {
    if (typeof value === 'string' && field in prospect) prospect[field] = value
  }
  const inputs = { ...(current?.inputs ?? {}), ...(patch?.inputs ?? {}) }

  let selections = Array.isArray(current?.selections) ? [...current.selections] : []
  const remove = new Set(patch?.selections?.remove ?? [])
  selections = selections.filter((selection) => !remove.has(selection.serviceId))
  for (const add of patch?.selections?.add ?? []) {
    const service = byId.get(add.serviceId)
    if (!service) continue
    const siblingIds = new Set(
      catalog
        .filter((row) => row.group === service.group && row.name === service.name)
        .map((row) => row.id),
    )
    const previous = selections.find((selection) => selection.serviceId === add.serviceId)
    selections = selections.filter((selection) => !siblingIds.has(selection.serviceId))
    selections.push({ ...(previous ?? {}), ...add })
  }
  return {
    prospect: cleanProposalProspect(prospect),
    inputs: cleanProposalInputs(inputs),
    selections: cleanProposalSelections(selections),
  }
}
```

Append to the end of `lib/proposal-pricing.d.ts`:

```ts

/** A chat patch AFTER `validateProposalPatch` (lib/assistant.js). */
export type ValidatedProposalPatch = {
  prospect?: Partial<ProposalProspect>
  inputs?: Record<string, number>
  selections?: { add: ProposalSelection[]; remove: string[] }
}

/** Apply a validated chat patch; adding one tier of a row replaces its siblings. */
export declare function applyProposalPatch(
  current: {
    prospect?: Partial<ProposalProspect> | null
    inputs?: Record<string, number> | null
    selections?: readonly ProposalSelection[] | null
  },
  patch: ValidatedProposalPatch | null | undefined,
  services: readonly ProposalService[],
): { prospect: ProposalProspect; inputs: Record<string, number>; selections: ProposalSelection[] }
```

Append to the end of `lib/assistant.js`:

```js

// ---- Proposals: the intake chat (featreq-311473e2, spec §5.2) ---------------
//
// Opus 5.5 walks her through sizing a prospect. It collects counts and picks
// services by returning a PATCH; the calculator prices whatever results. It
// never states a price the calculator has not produced, never sends email and
// never changes a proposal's status — the route applies only the validated
// patch, through the same store write the form uses.

/** One turn's text cap, both ways. */
export const PROPOSAL_CHAT_TURN_CHARS = 8000
/** At most this many services added in one turn. */
export const PROPOSAL_CHAT_MAX_ADDS = 20

const nullable = (schema) => ({ anyOf: [{ type: 'null' }, schema] })

/**
 * The chat's structured output. Every property is required and nullable
 * rather than optional, and `inputs` is a list of {key, value} rather than a
 * map (structured outputs cannot express free-form keys);
 * `validateProposalPatch` turns it into the spec's map. No minimum / maximum /
 * minItems / maxItems anywhere — claude-opus-5-5's validator 400s on them.
 */
export const PROPOSAL_CHAT_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string', minLength: 20 },
    patch: nullable({
      type: 'object',
      properties: {
        prospect: nullable({
          type: 'object',
          properties: {
            company: nullable({ type: 'string' }),
            contactName: nullable({ type: 'string' }),
            email: nullable({ type: 'string' }),
            phone: nullable({ type: 'string' }),
            notes: nullable({ type: 'string' }),
          },
          required: ['company', 'contactName', 'email', 'phone', 'notes'],
          additionalProperties: false,
        }),
        inputs: nullable({
          type: 'array',
          items: {
            type: 'object',
            properties: { key: { type: 'string' }, value: { type: 'number' } },
            required: ['key', 'value'],
            additionalProperties: false,
          },
        }),
        selections: nullable({
          type: 'object',
          properties: {
            add: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  serviceId: { type: 'string' },
                  tier: nullable({ type: 'string' }),
                  quantity: nullable({ type: 'number' }),
                  flatAmount: nullable({ type: 'number' }),
                },
                required: ['serviceId', 'tier', 'quantity', 'flatAmount'],
                additionalProperties: false,
              },
            },
            remove: { type: 'array', items: { type: 'string' } },
          },
          required: ['add', 'remove'],
          additionalProperties: false,
        }),
      },
      required: ['prospect', 'inputs', 'selections'],
      additionalProperties: false,
    }),
  },
  required: ['reply', 'patch'],
  additionalProperties: false,
}

const PROSPECT_CAPS = { company: 200, contactName: 200, email: 320, phone: 60, notes: 4000 }

/**
 * Hold a model's patch to the catalog (spec §5.2): unknown input keys and
 * service ids are dropped, numbers must be finite and non-negative, strings
 * are capped, at most {@link PROPOSAL_CHAT_MAX_ADDS} services are added, and a
 * `tier` resolves to that tier of the same row. Returns the spec-shaped patch,
 * or null when nothing usable is left.
 */
export function validateProposalPatch(patch, catalog) {
  if (!patch || typeof patch !== 'object') return null
  const inputKeys = new Set((catalog?.inputs ?? []).map((input) => input.key))
  const services = Array.isArray(catalog?.services) ? catalog.services : []
  const active = services.filter((service) => service.active === true)
  const activeById = new Map(active.map((service) => [service.id, service]))
  const knownIds = new Set(services.map((service) => service.id))
  const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0
  const out = {}

  if (patch.prospect && typeof patch.prospect === 'object') {
    const prospect = {}
    for (const [field, cap] of Object.entries(PROSPECT_CAPS)) {
      const value = patch.prospect[field]
      if (typeof value === 'string' && value.trim()) prospect[field] = value.trim().slice(0, cap)
    }
    if (Object.keys(prospect).length > 0) out.prospect = prospect
  }

  const rawInputs = Array.isArray(patch.inputs)
    ? patch.inputs
    : Object.entries(patch.inputs && typeof patch.inputs === 'object' ? patch.inputs : {}).map(
        ([key, value]) => ({ key, value }),
      )
  const inputs = {}
  for (const entry of rawInputs) {
    if (!entry || !inputKeys.has(entry.key) || !finite(entry.value)) continue
    inputs[entry.key] = Math.min(entry.value, 1e9)
  }
  if (Object.keys(inputs).length > 0) out.inputs = inputs

  const selections = patch.selections && typeof patch.selections === 'object' ? patch.selections : {}
  const add = []
  for (const entry of Array.isArray(selections.add) ? selections.add : []) {
    if (add.length >= PROPOSAL_CHAT_MAX_ADDS) break
    let service = activeById.get(entry?.serviceId)
    if (service && typeof entry.tier === 'string' && entry.tier !== service.tier) {
      service = active.find(
        (row) => row.group === service.group && row.name === service.name && row.tier === entry.tier,
      )
    }
    if (!service) continue
    const item = { serviceId: service.id }
    if (finite(entry.quantity)) item.quantity = Math.min(entry.quantity, 1e9)
    if (finite(entry.flatAmount)) item.flatAmount = Math.min(entry.flatAmount, 1e9)
    add.push(item)
  }
  const remove = [
    ...new Set(
      (Array.isArray(selections.remove) ? selections.remove : []).filter(
        (id) => typeof id === 'string' && knownIds.has(id),
      ),
    ),
  ].slice(0, 50)
  if (add.length > 0 || remove.length > 0) out.selections = { add, remove }

  return Object.keys(out).length > 0 ? out : null
}

/**
 * The CURRENT state, for the chat's system prompt: the catalog it may pick
 * from, the inputs, the prospect, and the calculator's own lines and totals —
 * the only prices that exist. Pure, so what the model is told is testable.
 */
export function buildProposalChatContext(proposal, catalog) {
  const money = (value) => formatProposalMoney(Number(value) || 0)
  const inputs = Array.isArray(catalog?.inputs) ? catalog.inputs : []
  const services = (Array.isArray(catalog?.services) ? catalog.services : []).filter(
    (service) => service.active === true,
  )
  const values = proposal?.inputs ?? {}
  const snapshot = proposal?.pricingSnapshot ?? { lines: [], totals: {} }
  const prospect = proposal?.prospect ?? {}
  const selected = new Set((proposal?.selections ?? []).map((selection) => selection.serviceId))

  return [
    'CATALOG (serviceId | group | name | tier | input it uses | kind):',
    ...services.map(
      (service) =>
        `- ${service.id} | ${service.group} | ${service.name} | ${service.tier ?? '-'} | ` +
        `${service.inputKey ?? '-'} | ${service.pricing}${selected.has(service.id) ? ' | SELECTED' : ''}`,
    ),
    '',
    'INPUTS (key: label = current value):',
    ...inputs.map(
      (input) =>
        `- ${input.key}: ${input.label} = ${
          Object.prototype.hasOwnProperty.call(values, input.key) ? values[input.key] : 'not collected yet'
        }`,
    ),
    '',
    `PROSPECT: company=${prospect.company || '-'}; contact=${prospect.contactName || '-'}; ` +
      `email=${prospect.email || '-'}; phone=${prospect.phone || '-'}`,
    '',
    'CURRENT PRICED LINES (from the calculator — the only prices that exist):',
    ...((snapshot.lines ?? []).length > 0
      ? snapshot.lines.map(
          (line) => `- ${line.name}${line.tier ? ` (${line.tier})` : ''}: ${money(line.amount)}`,
        )
      : ['- (nothing priced yet)']),
    `TOTALS: monthly ${money(snapshot.totals?.monthly)}, annual ${money(snapshot.totals?.annual)}, ` +
      `one-time ${money(snapshot.totals?.oneTime)}, clean-up ${money(snapshot.totals?.cleanup)}`,
  ].join('\n')
}

const PROPOSAL_CHAT_PERSONA =
  'You help Brittany, who owns a small US bookkeeping firm, size and shape a bookkeeping ' +
  'proposal for a prospect. Ask for the counts one topic at a time (transactions, accounts, ' +
  'invoices, payroll, sales tax, reports, clean-up), in plain words, and suggest services by ' +
  'their catalog name. When she gives you a count or agrees to a service, put it in `patch`: ' +
  'inputs as {key, value} using only keys from INPUTS, services by serviceId from CATALOG ' +
  '(tier optional), prospect details she mentions. Use null for anything that did not change, ' +
  'and a null patch when nothing did. NEVER state a price, total or hourly rate that is not in ' +
  'CURRENT PRICED LINES or TOTALS below — the calculator prices everything after your reply, ' +
  'so for anything you add this turn say it is on the estimate rather than quoting it. You ' +
  'cannot send email or change a proposal\'s status; if she asks, tell her to use the buttons ' +
  'on the page.'

/**
 * One intake-chat turn (spec §5.2). Returns `{ reply, patch }` with the patch
 * already validated against `ctx.catalog` (null when nothing usable changed).
 * Writes nothing — the route applies the patch and saves both turns.
 *
 * Built on the brainstorm's plumbing: claude-opus-5-5, `modelFallback: false`
 * (a degraded model's turn is persisted and poisons later ones), the
 * transient-fault retry inside `runModel`, and one more try on a provider
 * fault with only the last six turns — the same "drop the oldest context"
 * answer `spitballChat` gives.
 */
export async function proposalChat(proposal, userText, ctx = {}, opts = {}) {
  const client = opts.client || getClient()
  const text = String(userText ?? '').trim().slice(0, PROPOSAL_CHAT_TURN_CHARS)
  if (!text) {
    throw Object.assign(new Error('Say something about the prospect first.'), { statusCode: 400 })
  }
  const history = (Array.isArray(proposal?.messages) ? proposal.messages : [])
    .filter(
      (message) =>
        message &&
        (message.role === 'user' || message.role === 'assistant') &&
        typeof message.text === 'string' &&
        message.text.trim(),
    )
    .map((message) => ({
      role: message.role,
      content: message.text.slice(0, PROPOSAL_CHAT_TURN_CHARS),
    }))
  const system =
    PROPOSAL_CHAT_PERSONA +
    '\n\n' +
    buildProposalChatContext(proposal, ctx.catalog) +
    '\n\n' +
    US_ENGLISH_RULE.trim()

  const runWith = (turns) =>
    runStructuredModel(
      client,
      {
        model: process.env.ASSISTANT_MODEL || 'claude-opus-5-5',
        max_tokens: STRUCTURED_MAX_TOKENS,
        system,
        messages: [...turns, { role: 'user', content: text }],
        output_config: jsonSchema(PROPOSAL_CHAT_SCHEMA),
      },
      (parsed) => {
        const reply = typeof parsed?.reply === 'string' ? parsed.reply.trim() : ''
        if (meaningfulCharCount(reply) < MIN_MEANINGFUL_REPLY_CHARS) {
          return { ok: false, message: 'The AI returned an empty reply. Please try again.' }
        }
        return {
          ok: true,
          value: {
            reply: reply.slice(0, PROPOSAL_CHAT_TURN_CHARS),
            patch: validateProposalPatch(parsed?.patch, ctx.catalog),
          },
        }
      },
      {
        endpoint: 'proposalChat',
        unavailable: 'The AI is unavailable right now — you can still fill in the estimate yourself.',
        invalid: 'The AI returned an unexpected response. Please try again.',
      },
      { modelFallback: false },
    )

  try {
    return await runWith(history.slice(-40))
  } catch (error) {
    const provider = error?.cause
    const status = provider?.status ?? provider?.statusCode
    const providerFault = FALLBACK_STATUSES.has(status) || isTransientInvalidRequest(provider)
    if (!providerFault || history.length <= 6) throw error
    console.warn(
      `[assistant] proposalChat: provider fault (${status}); retrying once with the last six turns`,
    )
    return runWith(history.slice(-6))
  }
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run lib/proposal-pricing.test.mjs lib/assistant.test.mjs`
Expected: PASS — 3 new patch tests and 7 new chat tests; the whole-file `structured-output schemas carry no bounds keywords` tripwire still green.

- [ ] **Step 5: Verify and commit**

Run: `npm run verify` — expected green.

```bash
git add lib/proposal-pricing.js lib/proposal-pricing.d.ts lib/proposal-pricing.test.mjs lib/assistant.js lib/assistant.test.mjs
git commit -m "The proposal intake chat asks for counts one topic at a time and answers with a patch the catalog validates, never with a price" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: The intake chat beside the estimate

**Files:**
- Create: `src/components/proposals/ChatPanel.tsx`
- Modify: `db/store.js` — directly after `async acceptProposal(` (Task 12).
- Modify: `server.js` — the `./lib/assistant.js` import list (the Task 9 `  draftProposalLetter,` line), the Task 11 import `import { buildProposalEmail } from './lib/proposal-email.js'`, and directly after the Task 12 `proposalDeclineMatch` route (ends `sendJson(response, 200, declined)\n      return\n    }`).
- Modify: `src/lib/api.ts` — the `./types` import list and above `/** Owner-only: decline, with her note.` (Task 12).
- Modify: `src/lib/proposals.ts` — the type import and above the `proposalDeliveryBadge` doc comment (Task 11).
- Modify: `src/components/proposals/EstimateTab.tsx` — constants, props, three class names, `PickerRowControl`.
- Modify: `src/pages/ProposalEditorPage.tsx` — imports, a `highlight` state, `save`, and the Estimate tab render.
- Modify: `src/App.css` — append.
- Modify: `db/store-staleness.test.mjs`, `src/__tests__/proposal-routes.test.ts`, `src/__tests__/proposals-page.test.tsx` — append; the page test's mock list and its `../lib/types` import.

**Interfaces:**
- Consumes: `proposalChat` (Task 13), `applyProposalPatch` (Task 13), `updateProposal`, `getProposal`, `getFirmSettings` (Tasks 2/4).
- Produces: `appDataStore.appendProposalMessages(id, turns: Array<{ role: 'user' | 'assistant', text, patch? }>) -> Proposal | null` (append IN the row on Postgres); `POST /api/proposals/:id/chat` `{ text }` → `{ reply, applied, snapshot, proposal }` (400 empty, 409 accepted/declined, 502/503 `proposal_chat_failed`); `ProposalChatResult`, `proposalChatRequest(id, text)`; `changedKeys(patch) -> Set<'prospect:…' | 'input:…' | 'service:…'>`; `ChatPanel({ proposal, onReply })`; `EstimateTab` gains `highlight?: ReadonlySet<string>`; the Estimate tab renders chat (left) and estimate (right) in `.proposal-estimate-layout`.

- [ ] **Step 1: Write the failing tests**

Append to the end of `db/store-staleness.test.mjs`:

```js

describe('proposal chat turns (both backends)', () => {
  beforeEach(async () => {
    await clearProposals()
  })

  it('appends both turns on the proposal, the reply carrying its patch', async () => {
    const created = await store.createProposal({ prospect: { company: 'Acme Books' } })
    await store.appendProposalMessages(created.id, [
      { role: 'user', text: 'They have 10 employees.' },
      { role: 'assistant', text: 'Noted.', patch: { inputs: { employees: 10 } } },
      { role: 'system', text: 'ignored' },
    ])
    const loaded = await store.getProposal(created.id)
    expect(loaded.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(loaded.messages[1].patch).toEqual({ inputs: { employees: 10 } })
    expect(loaded.messages[0].at).toBeTruthy()
  })

  it('appends IN the row on Postgres', async () => {
    const fake = fakeProposalPostgres(proposalRow())
    await postgresStore(fake).appendProposalMessages('prop-1', [{ role: 'user', text: 'hello' }])
    const update = fake.matching(/^update proposals/i)[0]
    expect(update.text).toMatch(/set messages = coalesce\(messages, '\[\]'::jsonb\) \|\| \$2::jsonb/)
  })
})
```

Append to the end of `src/__tests__/proposal-routes.test.ts`:

```ts

describe('the intake chat route', () => {
  pinOwnerRoutes([
    {
      name: 'POST /api/proposals/:id/chat',
      pattern: /proposalChatMatch && request\.method === 'POST'/,
      write: true,
    },
  ])

  const block = () => routeBlock(/proposalChatMatch && request\.method === 'POST'/, 3600)

  it('applies only the validated patch, through the same re-pricing write the form uses', () => {
    const text = block()
    expect(text).toContain('proposalChat(proposal, text, { catalog: pricing })')
    expect(text).toContain('applyProposalPatch(proposal, turn.patch, pricing.services)')
    expect(text).toContain('appDataStore.updateProposal(')
    expect(text).toContain('appDataStore.appendProposalMessages(proposal.id, [')
  })

  it('never sends email and never changes a status', () => {
    const text = block()
    expect(text).not.toContain('sendInvoiceEmail')
    expect(text).not.toContain('setProposalStatus')
    expect(text).not.toContain('acceptProposal')
  })

  it('turns a model failure into a sentence, never a crash', () => {
    const text = block()
    expect(text).toContain("error: 'proposal_chat_failed'")
  })
})
```

In `src/__tests__/proposals-page.test.tsx`, replace
```tsx
import type { Proposal } from '../lib/types'
```
with
```tsx
import { ApiError, type Proposal } from '../lib/types'
```
replace
```tsx
  declineProposalRequest: (...args: unknown[]) => api.declineProposalRequest(...args),
}))
```
with
```tsx
  declineProposalRequest: (...args: unknown[]) => api.declineProposalRequest(...args),
  proposalChatRequest: (...args: unknown[]) => api.proposalChatRequest(...args),
}))
```
and append at the end of the file:

```tsx

describe('the intake chat', () => {
  const AFTER_CHAT: Proposal = {
    ...PROPOSAL,
    inputs: { transactions: 120, employees: 10 },
    messages: [
      { role: 'user', text: 'They have 10 employees.', at: '2026-09-23T15:00:00.000Z' },
      {
        role: 'assistant',
        text: 'Ten on payroll — noted. How often do they run it?',
        at: '2026-09-23T15:00:01.000Z',
        patch: { inputs: { employees: 10 } },
      },
    ],
  }

  it('sends her message, shows the reply, and marks what the chat changed', async () => {
    api.proposalChatRequest = vi.fn(async () => ({
      reply: 'Ten on payroll — noted. How often do they run it?',
      applied: { inputs: { employees: 10 } },
      snapshot: AFTER_CHAT.pricingSnapshot,
      proposal: AFTER_CHAT,
    }))
    renderEditor()
    const box = await screen.findByLabelText('Message to the intake assistant')
    fireEvent.change(box, { target: { value: 'They have 10 employees.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(api.proposalChatRequest).toHaveBeenCalledWith('prop-1', 'They have 10 employees.'),
    )
    expect(await screen.findByText('Ten on payroll — noted. How often do they run it?')).toBeTruthy()
    expect(screen.getByLabelText('Employees').closest('label')?.className).toContain('proposal-changed')
    expect(screen.getByLabelText('Transactions').closest('label')?.className).not.toContain(
      'proposal-changed',
    )
  })

  it('shows the error sentence when the AI cannot answer', async () => {
    api.proposalChatRequest = vi.fn(async () => {
      throw new ApiError(503, 'The AI is at capacity right now — give it a minute and try again.')
    })
    renderEditor()
    fireEvent.change(await screen.findByLabelText('Message to the intake assistant'), {
      target: { value: 'Hello' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByText(/at capacity/)).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run db/store-staleness.test.mjs src/__tests__/proposal-routes.test.ts src/__tests__/proposals-page.test.tsx -t "chat"`
Expected: FAIL — `appendProposalMessages` is not a function, the chat route is not found, and there is no chat box.

- [ ] **Step 3: Implement**

In `db/store.js`, directly after the closing `}` of `async acceptProposal(` add:

```js

  /**
   * Append intake-chat turns (spec §5.2) — the owner's message and the AI's
   * reply, the reply carrying the validated patch it applied. Persisted on the
   * proposal itself (not one active session per user, unlike the brainstorm).
   * Postgres appends IN the row, like the email log. Returns the proposal.
   */
  async appendProposalMessages(id, turns) {
    const clean = (Array.isArray(turns) ? turns : [])
      .filter(
        (turn) =>
          turn &&
          (turn.role === 'user' || turn.role === 'assistant') &&
          typeof turn.text === 'string' &&
          turn.text.trim(),
      )
      .map((turn) => ({
        role: turn.role,
        text: turn.text.trim().slice(0, 8000),
        at: turn.at ?? nowIso(),
        ...(turn.role === 'assistant' ? { patch: turn.patch ?? null } : {}),
      }))
    if (clean.length === 0) return this.getProposal(id)
    if (this.pool) {
      const { rows } = await this.pool.query(
        `update proposals
            set messages = coalesce(messages, '[]'::jsonb) || $2::jsonb, updated_at = now()
          where id = $1
          returning ${PROPOSAL_COLUMNS}`,
        [id, JSON.stringify(clean)],
      )
      return rows[0] ? AppDataStore.mapProposal(rows[0]) : null
    }
    const authState = await readJson(localAuthPath)
    const target = (Array.isArray(authState.proposals) ? authState.proposals : []).find(
      (row) => row && row.id === id,
    )
    if (!target) return null
    target.messages = [...(Array.isArray(target.messages) ? target.messages : []), ...clean]
    target.updatedAt = nowIso()
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return AppDataStore.mapProposal(target)
  }
```

In `server.js`, change
```js
  spitballChat,
  draftProposalLetter,
  suggestPackageChecklists,
```
to
```js
  spitballChat,
  draftProposalLetter,
  proposalChat,
  suggestPackageChecklists,
```
replace
```js
import { buildProposalEmail } from './lib/proposal-email.js'
```
with
```js
import { buildProposalEmail } from './lib/proposal-email.js'
import { applyProposalPatch } from './lib/proposal-pricing.js'
```
and directly after the `proposalDeclineMatch` route add:

```js

    // POST /api/proposals/:id/chat — { text } (spec §5.2). One intake turn:
    // Opus 5.5 answers and proposes a patch; ONLY the validated patch reaches
    // the store, through the same re-pricing write the form uses. The chat
    // never sends email and never changes a status.
    const proposalChatMatch = normalizedPath.match(/^\/api\/proposals\/([^/]+)\/chat$/)
    if (proposalChatMatch && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can use the proposal assistant' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }
      if (!isJsonContentType(request)) {
        sendJson(response, 415, { error: 'application/json required' })
        return
      }
      const payload = await readJsonBody(request)
      const text = typeof payload?.text === 'string' ? payload.text.trim().slice(0, 8000) : ''
      if (!text) {
        sendJson(response, 400, { error: 'Say something about the prospect first.' })
        return
      }
      const proposal = await appDataStore.getProposal(proposalChatMatch[1])
      if (!proposal) {
        sendJson(response, 404, { error: 'Proposal not found' })
        return
      }
      if (proposal.status === 'accepted' || proposal.status === 'declined') {
        sendJson(response, 409, {
          error: 'proposal_refused',
          message: `This proposal is ${proposal.status} — copy it to keep working on it.`,
        })
        return
      }
      const pricing = (await appDataStore.getFirmSettings()).proposalPricing
      let turn
      try {
        turn = await proposalChat(proposal, text, { catalog: pricing })
      } catch (error) {
        const status = error?.statusCode ?? error?.status ?? 502
        console.error('[proposals] chat failed:', error?.message || error)
        sendJson(response, status === 503 ? 503 : status === 400 ? 400 : 502, {
          error: 'proposal_chat_failed',
          message: error?.message || 'The AI could not answer right now.',
        })
        return
      }
      try {
        if (turn.patch) {
          await appDataStore.updateProposal(
            proposal.id,
            applyProposalPatch(proposal, turn.patch, pricing.services),
          )
        }
      } catch (error) {
        if (error instanceof ProposalStateError) {
          sendJson(response, 409, { error: 'proposal_refused', message: error.message })
          return
        }
        throw error
      }
      const saved = await appDataStore.appendProposalMessages(proposal.id, [
        { role: 'user', text },
        { role: 'assistant', text: turn.reply, patch: turn.patch },
      ])
      broadcastDataChanged()
      sendJson(response, 200, {
        reply: turn.reply,
        applied: turn.patch,
        snapshot: saved?.pricingSnapshot ?? null,
        proposal: saved,
      })
      return
    }
```

In `src/lib/api.ts`, change
```ts
  type Proposal,
  type ProposalPatch,
  type ProposalProspect,
```
to
```ts
  type Proposal,
  type ProposalChatPatch,
  type ProposalPatch,
  type ProposalProspect,
  type ProposalSnapshot,
```
and directly above `/** Owner-only: decline, with her note. The proposal stays on the list. */` insert:

```ts
/** One intake-chat turn: the reply, the validated patch the server applied, and the result. */
export type ProposalChatResult = {
  reply: string
  applied: ProposalChatPatch | null
  snapshot: ProposalSnapshot | null
  proposal: Proposal
}

/** Owner-only: one turn of the intake chat. The server applies and prices the patch. */
export function proposalChatRequest(id: string, text: string): Promise<ProposalChatResult> {
  return proposalRequest<ProposalChatResult>(
    proposalPath(id, 'chat'),
    proposalJson('POST', { text }),
    'The AI could not answer right now',
  )
}

```

In `src/lib/proposals.ts`, change
```ts
import type {
  Proposal,
  ProposalGroup,
```
to
```ts
import type {
  Proposal,
  ProposalChatPatch,
  ProposalGroup,
```
and directly above the doc comment that begins `/**\n * The delivery badge beside "Send to prospect":` insert:

```ts
/**
 * What one chat turn changed, as the keys the Estimate tab highlights:
 * `prospect:<field>`, `input:<key>`, `service:<id>`.
 */
export function changedKeys(patch: ProposalChatPatch | null | undefined): Set<string> {
  const keys = new Set<string>()
  for (const field of Object.keys(patch?.prospect ?? {})) keys.add(`prospect:${field}`)
  for (const key of Object.keys(patch?.inputs ?? {})) keys.add(`input:${key}`)
  for (const entry of patch?.selections?.add ?? []) keys.add(`service:${entry.serviceId}`)
  return keys
}

```

Create `src/components/proposals/ChatPanel.tsx`:

```tsx
import { useState, type FormEvent } from 'react'
import { proposalChatRequest, type ProposalChatResult } from '../../lib/api'
import { ApiError, type Proposal } from '../../lib/types'

/**
 * The intake chat (spec §5.2), beside the estimate. Each turn goes to the
 * server, which applies only the validated patch and re-prices — the page
 * swaps in the proposal it answers with. Prices come from the estimate, never
 * from the AI.
 */
export function ChatPanel({
  proposal,
  onReply,
}: {
  proposal: Proposal
  onReply: (result: ProposalChatResult) => void
}) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const locked = proposal.status === 'accepted' || proposal.status === 'declined'

  const send = async (event: FormEvent) => {
    event.preventDefault()
    const message = text.trim()
    if (!message) return
    setSending(true)
    setError('')
    try {
      const result = await proposalChatRequest(proposal.id, message)
      setText('')
      onReply(result)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The AI could not answer right now.')
    } finally {
      setSending(false)
    }
  }

  return (
    <section className="panel proposal-chat">
      <h3>Intake chat</h3>
      <p className="muted-text">
        Tell it about the prospect; it asks for the counts and fills in the estimate as you go.
        Prices come from the estimate, never from the AI.
      </p>
      <ol className="proposal-transcript">
        {proposal.messages.map((message, index) => (
          <li key={`${message.at}-${index}`} className={`proposal-turn is-${message.role}`}>
            <strong>{message.role === 'user' ? 'You' : 'Assistant'}:</strong> {message.text}
          </li>
        ))}
      </ol>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <form className="proposal-chat-form" onSubmit={(event) => void send(event)}>
        <textarea
          className="input"
          aria-label="Message to the intake assistant"
          rows={3}
          value={text}
          disabled={locked || sending}
          onChange={(event) => setText(event.target.value)}
        />
        <button
          type="submit"
          className="primary-action"
          disabled={locked || sending || !text.trim()}
        >
          {sending ? 'Thinking…' : 'Send'}
        </button>
      </form>
    </section>
  )
}
```

In `src/components/proposals/EstimateTab.tsx`:

1. Replace
```tsx
const PER_COUNT_MULTIPLIERS = new Set(['per-form', 'per-report', 'per-cleanup-month'])
```
with
```tsx
const PER_COUNT_MULTIPLIERS = new Set(['per-form', 'per-report', 'per-cleanup-month'])
const NOTHING_CHANGED: ReadonlySet<string> = new Set()

/** The field's class, marked when the last chat turn changed it. */
const fieldClass = (base: string, changed: boolean) => (changed ? `${base} proposal-changed` : base)
```

2. Replace
```tsx
  onSave,
  onReprice,
}: {
  proposal: Proposal
  pricing: ProposalPricing
  clients: ReadonlyArray<{ id: string; name: string }>
  busy: boolean
  onSave: (patch: ProposalPatch) => void
  onReprice: () => void
}) {
```
with
```tsx
  onSave,
  onReprice,
  highlight = NOTHING_CHANGED,
}: {
  proposal: Proposal
  pricing: ProposalPricing
  clients: ReadonlyArray<{ id: string; name: string }>
  busy: boolean
  onSave: (patch: ProposalPatch) => void
  onReprice: () => void
  /** What the last chat turn changed (`changedKeys`), marked for her to see. */
  highlight?: ReadonlySet<string>
}) {
```

3. Replace `              <label className="field" key={field}>` with
```tsx
              <label className={fieldClass('field', highlight.has(`prospect:${field}`))} key={field}>
```
and `              <label className="field" key={input.key}>` with
```tsx
              <label className={fieldClass('field', highlight.has(`input:${input.key}`))} key={input.key}>
```

4. Replace
```tsx
                <PickerRowControl
                  key={row.key}
                  row={row}
                  selections={proposal.selections}
                  onChange={saveSelections}
                />
```
with
```tsx
                <PickerRowControl
                  key={row.key}
                  row={row}
                  selections={proposal.selections}
                  onChange={saveSelections}
                  changed={row.options.some((option) => highlight.has(`service:${option.id}`))}
                />
```

5. Replace
```tsx
function PickerRowControl({
  row,
  selections,
  onChange,
}: {
  row: PickerRow
  selections: readonly ProposalSelection[]
  onChange: (next: ProposalSelection[]) => void
}) {
```
with
```tsx
function PickerRowControl({
  row,
  selections,
  onChange,
  changed,
}: {
  row: PickerRow
  selections: readonly ProposalSelection[]
  onChange: (next: ProposalSelection[]) => void
  changed: boolean
}) {
```
and `    <div className="proposal-picker-row">` with
```tsx
    <div className={fieldClass('proposal-picker-row', changed)}>
```

In `src/pages/ProposalEditorPage.tsx`:

1. Replace
```tsx
import { ActivityTab } from '../components/proposals/ActivityTab'
```
with
```tsx
import { ActivityTab } from '../components/proposals/ActivityTab'
import { ChatPanel } from '../components/proposals/ChatPanel'
```
and replace
```tsx
import {
  PROPOSAL_STATUS_LABELS,
  PROPOSAL_TABS,
  proposalTitle,
```
with
```tsx
import {
  PROPOSAL_STATUS_LABELS,
  PROPOSAL_TABS,
  changedKeys,
  proposalTitle,
```

2. Replace
```tsx
  const [packages, setPackages] = useState<Package[]>([])
  const [packageId, setPackageId] = useState('')
```
with
```tsx
  const [packages, setPackages] = useState<Package[]>([])
  const [packageId, setPackageId] = useState('')
  const [highlight, setHighlight] = useState<ReadonlySet<string>>(new Set())
```

3. Replace
```tsx
  const save = (patch: ProposalPatch) => {
    void run(() => updateProposalRequest(proposalId, patch))
  }
```
with
```tsx
  const save = (patch: ProposalPatch) => {
    // Her own edit ends the "what the chat just changed" marking.
    setHighlight(new Set())
    void run(() => updateProposalRequest(proposalId, patch))
  }
```

4. Replace
```tsx
      {tab === 'estimate' ? (
        <EstimateTab
          proposal={proposal}
          pricing={pricing}
          clients={data.clients}
          busy={busy}
          onSave={save}
          onReprice={() => void run(() => repriceProposalRequest(proposalId))}
        />
      ) : null}
```
with
```tsx
      {tab === 'estimate' ? (
        <div className="proposal-estimate-layout">
          <ChatPanel
            proposal={proposal}
            onReply={(result) => {
              setProposal(result.proposal)
              setHighlight(changedKeys(result.applied))
            }}
          />
          <EstimateTab
            proposal={proposal}
            pricing={pricing}
            clients={data.clients}
            busy={busy}
            highlight={highlight}
            onSave={save}
            onReprice={() => void run(() => repriceProposalRequest(proposalId))}
          />
        </div>
      ) : null}
```

Append to the end of `src/App.css`:

```css

/* The intake chat beside the estimate (featreq-311473e2). */
.proposal-estimate-layout {
  display: grid;
  gap: 16px;
  min-width: 0;
}

@media (min-width: 1100px) {
  .proposal-estimate-layout {
    align-items: start;
    grid-template-columns: minmax(280px, 1fr) 2fr;
  }
}

.proposal-chat-form {
  display: grid;
  gap: 8px;
  margin-top: 12px;
}

.proposal-changed {
  border-radius: var(--radius-sm);
  outline: 2px solid var(--gold);
  outline-offset: 2px;
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run db/store-staleness.test.mjs src/__tests__/proposal-routes.test.ts src/__tests__/proposals-page.test.tsx`
Expected: PASS — 2 new store, 7 new route and 2 new page tests; every earlier page test (which now renders the chat beside the estimate) still green.

- [ ] **Step 5: Verify and commit**

Run: `node --check server.js` then `npm run verify` — expected green.

```bash
git add src/components/proposals/ChatPanel.tsx src/components/proposals/EstimateTab.tsx src/pages/ProposalEditorPage.tsx src/lib/proposals.ts src/lib/api.ts src/App.css db/store.js db/store-staleness.test.mjs server.js src/__tests__/proposal-routes.test.ts src/__tests__/proposals-page.test.tsx
git commit -m "The intake chat sits beside the estimate: each turn is saved on the proposal, its validated changes are applied and re-priced, and what it changed is outlined" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: The capability manifest learns Proposals

**Files:**
- Modify: `docs/capability-manifest.md` (CRLF)
  - `## Navigation map` — the lines `Sidebar pages: Dashboard, Engagements, Time, …` (:34), `many to scan). In order: Dashboard, Engagements, …` (:41), `Dashboard, Engagements, Team and Updates stand alone …` (:45), and the `**Engagements is a placeholder.**` paragraph (:54-57)
  - a new `## Proposals (owner only)` section directly above `## Clients (owner manages; staff see assigned)` (:1101)
  - `## Settings (owner only)` — between `- Mailing address, contact details, EIN — used on invoices.` and `- Sections can be locked to prevent accidental edits.` (:2737-2738)
- Modify: `src/__tests__/assistant.test.tsx` — the `capability manifest` describe (:63-95).

**Interfaces:**
- Consumes: nothing in code; the manifest is the assistant's (and the voice agent's) knowledge base.
- Produces: `## Proposals (owner only)` containing the sentence "Prices come from the catalog math, never from the AI."; a Settings bullet for **Proposal pricing**; the Engagements placeholder note gone; a size tripwire under the voice knowledge-base cap.

- [ ] **Step 1: Write the failing test**

In `src/__tests__/assistant.test.tsx`, replace
```tsx
      '## Dashboard',
      '## Time tracking',
```
with
```tsx
      '## Dashboard',
      '## Proposals (owner only)',
      '## Time tracking',
```
and replace
```tsx
  it('has the not-supported list the assistant relies on', () => {
    expect(manifest).toContain('## NOT supported (yet)')
    expect(manifest).toContain('feature request')
  })
})
```
with
```tsx
  it('has the not-supported list the assistant relies on', () => {
    expect(manifest).toContain('## NOT supported (yet)')
    expect(manifest).toContain('feature request')
  })

  // Proposals (featreq-311473e2): the one sentence the assistant must be able
  // to say, and the placeholder note it must no longer repeat.
  it('says proposal prices come from the catalog, never from the AI', () => {
    expect(manifest).toContain('Prices come from the catalog math, never from the AI.')
    expect(manifest).toContain('**Proposal pricing**')
    expect(manifest).not.toContain('**Engagements is a placeholder.**')
  })

  // The voice agent's knowledge-base upload caps at ~216 KB (HANDOFF §0).
  it('stays under the voice knowledge-base cap', () => {
    expect(Buffer.byteLength(manifest, 'utf8')).toBeLessThan(216_000)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/__tests__/assistant.test.tsx -t "capability manifest"`
Expected: FAIL — no `## Proposals (owner only)`, no catalog sentence, and the placeholder note is still there.

- [ ] **Step 3: Implement** — edit `docs/capability-manifest.md` (Edit tool; the file is CRLF):

Replace `Sidebar pages: Dashboard, Engagements, Time, Timesheet, Time Approvals,` with `Sidebar pages: Dashboard, Proposals, Time, Timesheet, Time Approvals,`.

Replace `many to scan). In order: Dashboard, Engagements, **Clients** (Clients, Contacts,` with `many to scan). In order: Dashboard, Proposals, **Clients** (Clients, Contacts,`.

Replace `Dashboard, Engagements, Team and Updates stand alone — a heading over a single` with `Dashboard, Proposals, Team and Updates stand alone — a heading over a single`.

Replace
```md
**Engagements is a placeholder.** The section is visible before it has content
so it does not appear out of nowhere later; opening it explains that the intake
form and proposals are on the way and that clients are still added on the
Clients page meanwhile. Owner-only.
```
with
```md
**Proposals took the Engagements placeholder's place** (owner-only; an old
/engagements link opens it). See "Proposals (owner only)" below.
```

Insert directly above `## Clients (owner manages; staff see assigned)`:

```md
## Proposals (owner only)

Sidebar: **Proposals**. Every prospect's estimate, letter, intake conversation
and outcome is saved — declined ones too — so a prospect who comes back next
year is reopened with **Copy to new proposal**, not started from zero. The list
shows company, contact, status (Draft, Sent, Accepted, Declined), the monthly
total and when it last changed, with a status filter and a search. **New
proposal** opens an empty draft. Three tabs:

- **Estimate** — the prospect (company, contact, email, phone, notes, or an
  existing client for an upsell), the counts from their books (transactions,
  balance sheet accounts, employees, sales tax states, months of clean-up...),
  and the service picker grouped like her pricing sheet (Monthly,
  Reconciliations, AR, AP, Payroll, Sales tax, Reports, Additional reports,
  Annual and one-time, Clean-up) with Basic / Classes / Advance tiers. Each
  priced line shows its formula ("120 transactions x 0.07 x $75/hr =
  $630.00"); any line can take a typed price (an override). Four totals:
  Monthly fee, Annual fees, One-time fees, Clean-up. A catalog change never
  reprices a proposal by itself — **Reprice at today's catalog** (drafts) does.
  Beside it, the **intake chat** (Opus 5.5) asks for the counts one topic at a
  time and fills the estimate in as she answers; what it changed is outlined.
- **Letter** — **Draft the proposal** has the AI write the letter (Opening,
  What you told us, What we will do, Pricing, Terms, Next step) around the
  priced estimate; she edits the text; **Regenerate** replaces it after a
  confirm; **Copy text**; **Preview PDF**; **Send to prospect** asks for the To
  address (filled in from the prospect) and emails the branded PDF. A badge
  shows what the mail provider said (Delivered, Bounced, Marked as spam); a
  bounce or spam report notifies the owners.
- **Activity** — created, letter drafted, sends and delivery, accepted or
  declined (with her note), and the chat transcript.

Header actions: **Accept** — a new prospect becomes a client in Onboarding,
billed monthly at the proposal's monthly total with the firm's default payment
terms, plus an optional package; for an existing client it asks separately
before changing their monthly fee; no invoice changes. **Decline** (asks for a
note), **Copy to new proposal**, **Delete** (drafts only).

**Prices come from the catalog math, never from the AI.** The chat only
collects counts and picks services; the letter may quote only figures the
estimate already has, and a draft that invents one is refused. The chat cannot
send email or change a status. The catalog is **Settings → Proposal pricing**.

```

In `## Settings (owner only)`, replace
```md
- Mailing address, contact details, EIN — used on invoices.
- Sections can be locked to prevent accidental edits.
```
with
```md
- Mailing address, contact details, EIN — used on invoices.
- **Proposal pricing** — the three proposal rates (Bookkeeper B, Accountant A,
  Controller C; separate from the team's bill rates), the labels of the counts
  collected, and the service catalog behind every proposal: each row is count x
  factor x role rate x multiplier, a flat amount typed per proposal, or the
  payroll / sales tax block. Rows can be edited, added or retired (Retire /
  Restore). Editing it never reprices a proposal already written.
- Sections can be locked to prevent accidental edits.
```

Check the size: `wc -c docs/capability-manifest.md` — about 213,950 bytes (it was 210,894). If a later edit pushes it past 216,000, condense this section rather than raising the tripwire.

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run src/__tests__/assistant.test.tsx`
Expected: PASS — the two new manifest tests and every existing one.

- [ ] **Step 5: Verify and commit**

Run: `npm run verify` — expected green (the full suite: 209 files, about 3,890 tests in the dry run of this plan).

```bash
git add docs/capability-manifest.md src/__tests__/assistant.test.tsx
git commit -m "The assistant knows Proposals: the list, the editor, the catalog in Settings, sending, Accept, and that prices come from the catalog, never the AI" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

After the orchestrator pushes and `/health` reports the new commit, the voice agent is re-provisioned because the manifest changed: `node scripts/provision-voice-agent.mjs` (Railway variables per HANDOFF §3). The HANDOFF entry is the orchestrator's, not part of this plan.

---

## Spec coverage

| Spec | Where |
|---|---|
| §4.1 catalog, seed, inputs, sanitizer, `FIRM_SETTINGS_PATCH_FIELDS`, drift test, Settings section | Tasks 1, 2, 3 |
| §4.2 `proposals` table / `authState.proposals`, outside bulk save and fingerprint, snapshot on every edit, Reprice | Tasks 4, 5 |
| §4.3 calculator, payroll and sales-tax blocks, multipliers, flat rows, overrides, formula strings, tests | Task 1 |
| §5.1 list, editor tabs, prospect + client link, picker, lines, overrides, totals, Reprice, header actions | Tasks 6, 7, 12 |
| §5.2 intake chat (Opus 5.5, no fallback, 8000-char turns, persisted, schema without bounds, validator, `{ reply, applied, snapshot }`, highlight, no email/status) | Tasks 13, 14 |
| §5.3 letter (sections, figure validator with named retry, caps, regenerate confirm) | Tasks 8, 9 |
| §5.4 PDF, shared `firmDetailLines`, send with tags, webhook proposal branch, owners notified on bounce, draft → sent | Tasks 8, 10, 11 |
| §5.5 accept (client in Onboarding, monthly rate, terms, package/plans, activity entry, upsell confirm), decline, copy | Tasks 4, 5, 12 |
| §5.6 manifest; voice re-provision after deploy | Task 15 |
| §6 owner-only + origin on writes, prospect email only as confirmed To, catalog never public, schema tripwires, no invoice/rate/team/checklist change outside Accept | Tasks 2, 5, 9-14 |
| §7 test files | every task |

Decisions this plan takes where the spec is silent (for Alex): the `cadence` field on "Annual and one-time" rows (to split `annual` from `oneTime`); `includeReview` for the sales-tax review amount D; per-count rows use a typed `quantity` before the input; Client call seeded as a formula row; Accept takes the package/plans in its request (no column in §4.2); the chat schema carries `inputs` as a `{ key, value }` list; the proposal bounce notice reuses `invoice_email_bounced` with its own subject; two fixes beyond the spec, both needed to keep the catalog owner-only and intact — the staff copy of `/api/app-data` strips `proposalPricing`, and the file backend's bulk save keeps the stored firm settings (Postgres parity).

