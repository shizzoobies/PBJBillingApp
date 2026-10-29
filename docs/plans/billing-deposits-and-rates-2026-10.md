# Deposits, credit statements and client rate agreements

**Historical initial plan.** See [the implemented local review guide](billing-local-review-2026-10.md) for Brittany's answers, actual storage/presentation design, editable workflows and validation limits. The separate-invoice-kind proposal and unanswered-rate list below were superseded; actual advances use a separate request/receipt ledger and an optional invoice attachment.

Authorized by Alex on 2026-10-28 for an isolated LOCAL build. No production writes, push, merge or deployment. Client rates and deposit amounts remain unset while Brittany answers.

## Contracts

- A deposit request is a separate invoice kind, never a custom service line or retainer. Requesting money creates no credit. Settled money creates reusable credit once; pending/failed/short payments cannot be silently marked fully paid. Normal plan prepayment stays intact.
- Credit is reserved by draft invoices but is not described to customers as a completed payment. Customer statements distinguish opening credit, credit used on this invoice, closing credit and amounts reserved elsewhere. Sent documents retain their recorded statement; live balances must not rewrite history.
- Client hourly agreements are effective by BILLING month, independent of the historical team-rate pin. Per-person overrides take precedence over a client default; absent/null scopes inherit. Zero is a valid agreed rate. Changing a setting never reprices stored invoice lines or time logs. Unsent invoices require explicit editing/regeneration.
- Rate agreements and deposit/receipt records use targeted endpoints, owner authorization, append-only audit, idempotent operations and both storage backends. Bulk workspace saves cannot forge or remove them.
- No production schema changes run here. Additive initialization changes are reviewable source artifacts only.

## Pending answers

Exact rates for Flourish and Lilac and Lemons; which people/roles they cover; first billing month; general deposit versus earmarked months; replenishment cadence and customer statement wording. No client-specific values are seeded.

## Validation

Synthetic fixtures only; no production environment variables or external notifications. Exercise full/partial/repeated payment events, pending and failed settlement, void and reversal protections, draft credit reservations, partial drawdown, zero-due invoice sending, unchanged plan/retainer behavior, effective-month inheritance, authorization and saved invoice stability. Run lint, typecheck/build, focused tests, full verify, and local rendered UI checks. Two independent review passes for financial/save-path changes.
