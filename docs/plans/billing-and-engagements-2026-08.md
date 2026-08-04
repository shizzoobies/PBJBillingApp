# Billing & Engagements plan — locked 2026-08-04

Decided in a planning session with Alex (structured questions, all answered
2026-08-04). Covers tracker items `featreq-79b6d974` (engagement-to-billing
workflow), `featreq-2cd78b22` (Brittany's monthly invoicing braindump), and
`featreq-5c225d33` (client-page consolidation). **This is the plan of record —
do not re-open these decisions without Alex.**

## Decisions

1. **Roadmap P1–P4 adopted** (as proposed 2026-07-23).
2. **Invoicing end-state = monthly prep packet**, not in-app invoices and not
   QBO API integration. The app generates a per-client packet; Brittany
   transfers to QBO in minutes.
3. **Out-of-scope detection ships in the first packet cut** ("the girls won't
   know"): compare the month's logged tasks/hours against the client's plan
   inclusions + estimated hours; unusual work surfaces as "review these" lines.
4. **P1 builds the week of Aug 6** (mid-month window).
5. **The billing track runs SEPARATELY from the engagement track**, starting
   right after P1 — the packet does not depend on intake/proposals.
6. **Intake-form fields**: draft derived from existing client + contacts
   records, filed for Brittany's review in the tracker BEFORE building.
7. **Monthly per-client profit joins the packet phase**: Client Recap gains
   billed vs labor cost vs plan estimate (cost rates exist as of `244e24a`).
8. **Client-page tab consolidation waits until P1 settles**; staff Time /
   Checklists tabs must NOT be removed (protects b24ad79/64ee907/85003a6).

## Tracks

### Track A — navigation (P1, week of Aug 6)
Regroup the sidebar into Brittany's sections: Engagements / Clients / Billing /
Operations / Team / Reports / Settings. Pure navigation; every page keeps
working; staff routes unchanged underneath.

### Track B — billing (right after P1)
Monthly **prep packet** per client: hours (by member), labor cost, billable $,
reimbursements (one-time + recurring), prior-month +/- carry, suggested line
descriptions, a sendable blurb. Plus **scope flags** (decision 3) and the
**Recap profit line** (decision 7). Surfaces under Billing; the safe
`invoice_drafts` table (fixed `32976f4`) is available if drafts materialize.

### Track C — engagements (P2 → P3 → P4)
- **P2** tokenized public intake form (magic-link idiom) → Proposals inbox.
  Field draft per decision 6 gates the build.
- **P3** proposal builder; accepting auto-fills Client + Contacts.
- **P4** accepted proposal → Plan → feeds the Track B packet (not QBO).

### Later / guarded
- Client-page tab consolidation — revisit with Brittany after P1.
- QBO API integration — explicitly rejected for now; revisit only if the
  packet proves insufficient.
