# Proposals - design (2026-09-23)

Tracker: `featreq-311473e2` (Proposals - 1) and `featreq-ef18a38e` (Proposals - 2), Brittany, 2026-09-22.
Parent: `featreq-79b6d974` engagement-to-billing (parked in_progress); the Engagements
placeholder page already names this as P2 (intake feeding a Proposals inbox), P3 (a
proposal builder) and P4 (an accepted proposal becomes a client and plan). This spec is
that planning session. Decisions taken with Alex on 2026-09-23 are marked **Decided**.

## 1. What Brittany does today

She meets a prospect, works out which services they need, looks at their QuickBooks to
size the work, and prices it from a sheet: every line is a count from the books times a
factor times one of three role rates (Bookkeeper B, Accountant A, Controller C), grouped
into monthly fees, annual or one-time fees, and clean-up priced per month of clean-up.
Several lines are blank in her sheet ("__", client call, payroll setup as a flat amount,
tax returns at a standard rate). She writes the proposal up by hand. Nothing is saved, so a
prospect who declines and comes back next year starts from zero.

## 2. Goals

1. A Proposals section where each prospect's estimate, letter, conversation and outcome
   are saved and can be reopened later.
2. The pricing math lives in the app as an editable catalog: she changes factors, rates,
   adds or retires lines, without a developer.
3. Opus 5.5 walks her through intake and drafts the letter. It never computes a price.
4. The finished proposal goes to the prospect as a branded PDF by email from the app.
5. Accepting a proposal creates the client in Onboarding with what was proposed.

Non-goals: e-signature; a formula editor; pricing tied to team bill rates; any effect on
invoices or money for existing clients; a prospect-facing portal.

## 3. Decisions (Alex, 2026-09-23)

- **Decided: own section, convert later.** Proposals are their own records. A prospect is
  not a client until Accept. An existing client can also receive a proposal (upsell).
- **Decided: editable service catalog.** One formula shape for every line
  (`count x factor x role rate x multiplier`), stored as data in firm settings; she edits
  numbers, adds rows, marks a row as a flat amount. No free formula editor.
- **Decided: the AI guides intake and writes the letter.** Numbers come from the
  calculator only. She can skip the chat and fill the form directly.
- **Decided: email the PDF from the app; Accept creates the client.** Statuses draft,
  sent, accepted, declined; declined stays on the list and can be reopened as a copy.

## 4. Data

### 4.1 Firm settings: `proposalPricing` (jsonb column on `firm_settings`; `data.firmSettings` on the file backend)

```
proposalPricing: {
  rates: { bookkeeper: number, accountant: number, controller: number },   // $/hr, owner-set, NOT the team's bill rates
  inputs: [ { key, label, help } ],            // the counts she collects; seeded, editable labels
  services: [ {
    id,                                        // stable slug, e.g. 'monthly-transactions-basic'
    group,                                     // 'Monthly' | 'Reconciliations' | 'AR' | 'AP' | 'Payroll' | 'Sales tax' | 'Reports' | 'Additional reports' | 'Annual and one-time' | 'Clean-up'
    name, tier,                                // tier: null | 'Basic' | 'Classes' | 'Advance'
    pricing: 'formula' | 'flat' | 'payroll' | 'sales-tax',   // flat = an amount typed per proposal (her blanks); payroll and sales-tax are the two explicit blocks in 4.3
    inputKey, factor, role,                    // role: 'bookkeeper' | 'accountant' | 'controller'
    multiplier: 'none' | 'weekly-x4' | 'quarterly-div3' | 'yearly-div12' | 'per-cleanup-month' | 'per-report' | 'per-form',
    active: boolean, sortOrder: number
  } ]
}
```

Seed (the migration and the file backend default) reproduces her sheet exactly:

| group | name / tier | input | factor | role | multiplier |
|---|---|---|---|---|---|
| Monthly | Weekly transactions Basic / Classes / Advance | transactions | .07 / .10 / .13 | B | none |
| Monthly | Monthly transactions Basic / Classes / Advance | transactions | .03 / .05 / .07 | B | none |
| Reconciliations | Reconciliations | balanceSheetAccounts | .25 | B | none |
| AR | Prepare invoices | invoicesPerWeekAR | .13 | A | none |
| AR | Send invoices / Follow up with clients / Support with collections | invoicesPerWeekAR | .03 / .03 / .01 | B | none |
| AP | Enter invoices | invoicesPerWeekAP | .05 | B | none |
| AP | Pay invoices / Contact vendors | invoicesPerWeekAP | .03 / .01 | C | none |
| Payroll | Payroll | employees | .05 | A | explicit block (4.3): run weekly / bi-weekly / monthly |
| Sales tax | File sales tax monthly / quarterly / yearly | states x salesTaxReviewAmount | - | - | explicit block (4.3): none / quarterly-div3 / yearly-div12 |
| Reports | Monthly reports Basic / Advance | totalAccounts | .03 / .05 | A | none |
| Reports | Quarterly reports Basic / Advance | totalAccounts | .03 / .05 | A | quarterly-div3 |
| Additional reports | Budget vs actual | plAccounts | .05 | C | none |
| Additional reports | Cash flow weekly / monthly | totalAccounts | .05 | C | weekly-x4 / none |
| Additional reports | KPI reports | totalAccounts | .07 | C | none |
| Additional reports | Client call | - | - | C | flat (hours typed per proposal x C) |
| Annual and one-time | Budget / Forecast | plAccounts / totalAccounts | .05 | C | per-form ("__" count typed per proposal) |
| Annual and one-time | Payroll setup / Business return / Individual return | - | - | - | flat |
| Annual and one-time | Individual return with multiple forms | forms | (standard rate typed) | - | per-form |
| Clean-up | Monthly transactions Basic / Classes / Advance | transactions | .03 / .05 / .07 | B | per-cleanup-month |
| Clean-up | Reconciliations | balanceSheetAccounts | .25 | B | per-cleanup-month |
| Clean-up | Accounts needing detailed attention | accountsNeedingAttention | .13 | C | per-cleanup-month |
| Clean-up | Chart of accounts clean-up | chartAccountsToClean | .07 | A | none (Proposals - 2: not per month) |
| Reports (Proposals - 2) | Reports needed Basic / Advance | totalAccounts | .03 / .05 | A | per-report |

Inputs seeded: transactions (X), balanceSheetAccounts (Y), plAccounts (W), totalAccounts (Z),
invoicesPerWeekAR (F), invoicesPerWeekAP (G), employees (I), salesTaxReviewAmount (D),
states (E), cleanupMonths, reportsNeeded, forms, accountsNeedingAttention,
chartAccountsToClean, clientCallHours.

Sanitizer (`sanitizeProposalPricing`, both backends, mirrors `sanitizeClientDefaults`):
rates clamp to [0, 1e6]; factors to [0, 100]; enums checked; strings length-capped;
unknown keys dropped; `services[].id` unique; an unknown `inputKey` makes the row
inactive rather than failing the save. Owner-only via `PUT /api/firm-settings`
(`FIRM_SETTINGS_PATCH_FIELDS` gains `proposalPricing`; the drift test in
`src/__tests__/audit-backlog-hardening.test.ts` is updated). Settings page gains a
"Proposal pricing" section: the three rates, then the catalog as an editable table
grouped by group, with Add row and Retire.

### 4.2 The `proposals` table (Postgres) / `authState.proposals` (file backend)

Outside the bulk save and the workspace fingerprint, like `packages` and `spitball_sessions`.

```
id                text pk ('prop-xxxxxxxx')
status            text: 'draft' | 'sent' | 'accepted' | 'declined'
prospect          jsonb { company, contactName, email, phone, notes }
client_id         text null      -- the client it was written for, or the one Accept created (no FK, like plan_ids)
inputs            jsonb { [inputKey]: number }
selections        jsonb [ { serviceId, quantity?, flatAmount?, override? } ]   -- override = a typed price that replaces the computed one
pricing_snapshot  jsonb { rates, lines: [ { serviceId, group, name, tier, amount, computedAmount, formula } ], totals: { monthly, annual, oneTime, cleanup } , catalogAt }
letter            jsonb { subject, sections: [ { heading, body } ], text }  -- text = the rendered letter she edits
letter_at         timestamptz null
messages          jsonb [ { role, text, at, patch? } ]     -- the intake chat
email_log         jsonb [ ]                                -- send + delivery events, same shape as invoices.email_log
sent_at, accepted_at, declined_at   timestamptz null
decline_note      text null
copied_from_id    text null
created_by        text, created_at, updated_at
```

`pricing_snapshot` is written every time inputs, selections or overrides change, and is
what the letter, the PDF and the list read. A catalog change never rewrites an existing
proposal; "Reprice at today's catalog" is an explicit button on a draft.

### 4.3 The calculator: `lib/proposal-pricing.js` (+ `.d.ts`)

Pure. `priceProposal({ catalog, rates, inputs, selections }) -> { lines, totals }`.

- `formula` row: `amount = input[inputKey] x factor x rates[role] x multiplierFactor`, where
  multiplierFactor is 1, 4, 2, 1/3, 1/12, `inputs.cleanupMonths`, `inputs.reportsNeeded`,
  or `inputs.forms`. Rounded to cents at the line.
- `flat` row: `amount = selection.flatAmount` (0 when absent); "Client call" is
  `inputs.clientCallHours x rates.controller`.
- Payroll (her derived block): `H = A x .05 x employees`; bonus `= A x .13 x H`;
  taxes `T = A x .5`; run weekly `= H x 4 + T`, bi-weekly `= H x 2 + T`, monthly
  `= H + T`. Modeled as one service with a `payrollRun` choice ('weekly' | 'biweekly' |
  'monthly') and an `includeBonus` flag on the selection; the calculator implements the
  block explicitly rather than forcing it into the generic shape.
- Sales tax: `review reports = D`, `file = D x states` with the quarterly / yearly divisors.
- Totals: monthly = sum of Monthly, Reconciliations, AR, AP, Payroll, Sales tax, Reports,
  Additional reports lines; annual and one-time = that group; cleanup = the Clean-up
  group (already multiplied by months). An `override` replaces `amount` and keeps
  `computedAmount` beside it.
- Every line carries a human-readable `formula` string ("120 transactions x 0.07 x $75/hr
  = $630.00") for the estimate panel and the letter's pricing table.

Tests: every seeded row against a worked example from her sheet; payroll for all three
run choices; multipliers; override and flat; an inactive row never prices; unknown
inputKey prices 0 and flags the line.

## 5. Surfaces

### 5.1 Proposals page (owner-only; replaces the Engagements placeholder in the sidebar slot)

List: company, contact, status pill, monthly total, updated, with status filter and
search; "New proposal". Row opens the editor.

Editor (one page, three tabs: Estimate, Letter, Activity):

- **Estimate**: prospect block (company, contact, email, phone, notes, optional link to an
  existing client); the intake chat panel (left) and the estimate (right): inputs with
  their labels, the service picker grouped by catalog group with tier radios and
  quantity or flat-amount fields where the row needs them, the priced lines with the
  formula string under each, per-line override, and the four totals. "Reprice at
  today's catalog" on drafts.
- **Letter**: "Draft the proposal" (AI), the editable letter text, "Regenerate",
  "Preview PDF", "Send to prospect" (asks for the To address, prefilled from the
  prospect), "Copy text". Delivery badge after send, from the email log.
- **Activity**: sends, delivery events, status changes, the chat transcript.

Header actions: Accept, Decline (asks for a note), Copy to new proposal, Delete (drafts
only).

### 5.2 Intake chat (Opus 5.5)

`proposalChat(proposal, userText)` in `lib/assistant.js`, built on the spitball plumbing:
`claude-opus-5-5`, `modelFallback: false`, the transient-fault retry, turns capped at
8000 characters, messages persisted on the proposal (not one-active-session-per-user).

System prompt: the persona ("you help Brittany size and shape a bookkeeping proposal"),
the catalog (group, name, tier, which input it uses, whether it is flat), the input
labels, and the CURRENT state: inputs, selections, and the calculator's lines and
totals. Rule stated to the model: never state a price the state does not contain; ask for
counts one topic at a time; suggest services by name.

Structured output `PROPOSAL_CHAT_SCHEMA`:

```
{ reply: string,
  patch: null | {
    prospect?: { company?, contactName?, email?, phone?, notes? },
    inputs?: { [inputKey]: number },
    selections?: { add?: [ { serviceId, tier?, quantity?, flatAmount? } ], remove?: [serviceId] }
  } }
```

No `minimum` / `maximum` / `minItems` / `maxItems` in any schema (the 5.5 validator rule);
caps in the validator: unknown inputKeys and serviceIds dropped, numbers finite and
non-negative, at most 20 adds per turn, strings length-capped. The server applies the
validated patch, reprices, saves, and returns `{ reply, applied: patch, snapshot }`; the
estimate panel highlights changed fields for one render. The chat never sends email or
changes status.

### 5.3 Letter drafting

`draftProposalLetter(proposal, firm)`: input = prospect, firm details (name, address,
contact from firm settings), the priced lines grouped, totals, her notes and the chat
summary. Output `PROPOSAL_LETTER_SCHEMA`: `{ subject, sections: [ { heading, body } ] }`
with a fixed section order the prompt names (Opening, What you told us, What we will do,
Pricing, Terms, Next step). Validator: every `$` figure in the prose must equal one of
the snapshot's line amounts or totals (cents-exact) or the call is retried once with the
mismatch named; strings length-capped; at least Opening and Pricing present. The
rendered `text` is what she edits; regenerate replaces it after a confirm.

### 5.4 PDF and email

- `lib/proposal-pdf.js` (pdfkit, like the invoice PDF): firm header with logo, prospect
  block, the letter sections, the pricing table by group with totals, footer. The firm
  detail lines move into one exported helper (`lib/firm-lines.js`) that the invoice PDF,
  the invoice email and the proposal PDF all use (today two private copies exist).
- `POST /api/proposals/:id/send` (owner-only): builds the PDF, sends through
  `sendInvoiceEmail`'s Resend path with tags `proposal_id` and `kind: 'proposal'`; the
  Resend webhook gains a proposal branch that appends delivery events to
  `proposals.email_log` (both backends) and never touches status; owners are notified
  on bounce. Status draft -> sent on the first successful send; later sends are logged.
- No print-sheet mode in the SPA (the PDF is server-rendered), so `check-print-pdf.mjs`
  is unaffected.

### 5.5 Accept and decline

- `POST /api/proposals/:id/accept`: if `client_id` is null, creates the client
  (`createClient`) with company, contact fields, `lifecycleStage: 'onboarding'`,
  `billingMode: 'subscription'`, `monthlyRate = totals.monthly`, `paymentTerms` from the
  firm default, and records the proposal id in an activity entry; if a package or plans
  were chosen on the proposal, applies them through the existing package / plan paths.
  If `client_id` is set (upsell), updates that client's monthly rate only after a confirm
  in the UI. Sets `accepted_at`, status accepted. Nothing about existing invoices changes.
- `POST /api/proposals/:id/decline` with a note.
- `POST /api/proposals/:id/copy`: a new draft with the same prospect, inputs and
  selections, repriced at today's catalog, `copied_from_id` set.

### 5.6 Assistant and manifest

`docs/capability-manifest.md` gains `## Proposals (owner only)` describing the list,
editor, catalog settings, the chat's rules, the letter, sending, acceptance, and the
sentence "prices come from the catalog math, never from the AI". The Engagements
placeholder note is replaced. Voice agent re-provisioned after deploy.

## 6. Security and invariants

- Every route owner-only with `isCrossSiteOrigin` on writes; proposals excluded from
  `BULK_SAVE_SLICES` and the fingerprint; both backends for every persisted change.
- The prospect email is only ever used as a send-to address the owner confirms per send.
- Rates and catalog stay in owner-only firm settings; `/api/firm-settings/public` does
  not expose them.
- The AI schemas carry no bounds keywords; the existing tripwire tests
  (`lib/assistant.test.mjs` "structured-output schemas carry no bounds keywords") are
  extended to the two new schemas.
- A proposal never changes an invoice, a rate version, a team, or a checklist except
  through Accept's explicit client creation and package application.

## 7. Testing

- `lib/proposal-pricing.test.mjs`: the worked sheet, payroll, multipliers, overrides,
  flat rows, inactive rows, unknown inputs.
- `db/store-staleness.test.mjs`: proposals CRUD both backends; `proposalPricing`
  sanitizer both backends; excluded from bulk save; email_log append idempotent.
- `src/__tests__/proposal-routes.test.ts` (source-reading): owner gate and origin check
  on every write; send builds the PDF before sending; accept creates the client only
  when `client_id` is null; the webhook's proposal branch never writes status.
- `src/__tests__/proposals-page.test.tsx`: list, editor tabs, service picker prices a
  line, override, totals, Send asks for the address, Accept confirm.
- `lib/assistant.test.mjs`: chat patch validator drops unknown keys and caps adds; letter
  validator rejects a foreign dollar figure; schema bounds tripwires.
- `src/__tests__/settings-proposal-pricing.test.tsx`: catalog table edit round-trips
  through the sanitizer.

## 8. Build order (one plan)

1. Catalog in firm settings (types, sanitizer, migration seed, Settings section) + the
   calculator with tests.
2. Proposals table both backends, routes, list and editor with the form and pricing.
3. Letter drafting (AI) + Letter tab.
4. PDF, send, webhook branch, delivery badge.
5. Accept, decline, copy; client creation.
6. Intake chat.
7. Manifest, handoff, deploy, voice.

## 9. Open questions for Brittany (do not block the build)

- The three role rates to seed (the team's current bill rates 75 / 115 / 125 are the
  obvious starting numbers, but she said proposal rates are separate).
- The blanks: client call hours, budget and forecast counts, payroll setup amount, tax
  return standard rates - all typed per proposal until she settles defaults.
- Whether "Accept" should also send her a reminder to set the client's team and
  checklists (the Setup Checklist already lights up; probably enough).
