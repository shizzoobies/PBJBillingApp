# Invoice confidence ratings + the learning loop — plan of record

Written 2026-08-22. Decided with Alex (structured questions, all four answered):
**advisory only** (never blocks review) · questions surface **at approve, skippable** ·
**auto-rate after generate + per-invoice re-rate** · **ships live to Brittany**.

## Why this exists

The invoicing plans gate bulk-send / auto-send on "trust earned" in three places
(`invoicing-handoff.md:110-111`, `invoicing-in-app-2026-08.md:39-42`, `:139`) with
no mechanism to measure trust. This feature builds that mechanism: Opus rates each
draft's accuracy, Brittany's actual corrections are recorded, and over months the
confidence-vs-corrections record becomes the case for (or against) automation
tiers. Nothing here automates anything today.

Two jobs:
1. **Rate** — after Generate, `claude-opus-5` reviews each monthly draft and
   stores a confidence verdict: band, score, summary, per-line concerns, and up
   to 3 questions it would ask Brittany.
2. **Learn** — the corpus that doesn't exist yet starts being recorded: the
   generated draft is snapshotted, her edits are diffed, and her answers to the
   AI's questions persist and feed future rating prompts.

## Hard rules (from recon — violating any of these is a known bug class)

- The rating is a **read-only annotation**. It never feeds `lib/invoice-lines.js`
  (the one money calculator), never changes a status, never blocks anything.
- **Both store backends** for every persisted change (Postgres + JSON file).
- New tables carry **no FK to `invoices`** — the bulk save wipes-and-reinserts
  that table; a restricting child FK wedges every owner save. Plain text
  `invoice_id`, matching `client_notes` / `item_deletion_requests`.
- New tables stay **out of the bulk-save payload and staleness fingerprint**
  (the standing rule for `invoices` itself).
- A new column on `invoices` touches **six** places: DDL in `initialize()`,
  additive `alter table`, `INVOICE_SELECT_COLUMNS`, `mapInvoiceRow`, the
  bulk-save snapshot + restore insert, and `_insertInvoice`. Missing the
  snapshot/restore pair is the exact shape of three past data-loss bugs.
- Store tests append to `db/store-staleness.test.mjs` — never a parallel store
  test file (parallel vitest workers clobber the shared tmp workspace).
- The month run **never re-sorts** (locked decision: invoice-number order).
- Blunt-flag doctrine (`lib/invoice-draft.js:75`): few, specific concerns.
  Schema caps: ≤4 concerns, ≤3 questions.

## Data model

### `invoices.original_line_items` (new jsonb column, nullable)
Set once at insert (`_insertInvoice` callers: generate + retainer), never
updated. Null on pre-feature rows. The before-side of every future diff.

### `invoice_review_events` (new table, both backends)
Append-only record of what a human did to an invoice.

```
id text pk · invoice_id text (no FK) · client_id text · period text ·
actor_user_id text · event text ('edited'|'reviewed'|'unreviewed'|'voided') ·
changes jsonb · created_at timestamptz default now()
```

Captured inside `updateInvoice` where `current` and `next` both exist.
`changes` is a compact diff — only fields that changed:
`{ lineItems?: {before, after}, blurb?: {before, after}, dueDate?: {before, after}, status?: {before, after} }`.
Recorded only when something actually changed. Index on `invoice_id`.

### `invoice_ai_reviews` (new table, both backends)
One row per rating; history kept.

```
id text pk · invoice_id text (no FK) · client_id text · period text ·
model text · confidence text ('high'|'medium'|'low') · score int ·
summary text · concerns jsonb · questions jsonb ·
lines_fingerprint text · superseded boolean default false ·
created_at timestamptz default now()
```

- `concerns`: `[{ line: string, issue: string, severity: 'info'|'warn' }]`
- `questions`: `[{ id: string, question: string, answer: string|null, skipped: boolean, answeredAt: string|null }]`
- `lines_fingerprint`: sha256 of the canonical `line_items` JSON at rating time.
  UI compares against current lines → "stale" indicator → re-rate button.
- A new rating marks the invoice's prior rows `superseded = true`.

## The rating call — `lib/invoice-confidence.js`

Reuses `lib/assistant.js` plumbing: export `getClient`, `runStructuredModel`,
and the `jsonSchema` helper from assistant.js (additive exports only). Tests
inject `opts.client` exactly like `assistant.test.mjs` does.

- Model: `process.env.INVOICE_AI_MODEL || 'claude-opus-5'`. No fallback-model
  degradation (`modelFallback: false`) — a wrong-but-confident rating from a
  weaker model is worse than no rating; on overload the invoice just stays
  "Not rated" and can be re-rated.
- Output via `output_config: jsonSchema(...)`, `additionalProperties: false`,
  `required` everywhere, `minLength` floors on strings (house idiom).
- Prompt input (all passed in; the lib does no store reads):
  - the draft: lines with per-line provenance (`kind`, adhoc mode, coverage
    fields), totals, due date, blurb, scope flags
  - client context: name, plan type, monthly/annual rate, estimated hours,
    payment terms
  - the month's billable-hours summary per employee (what the hourly lines
    were derived from)
  - prior-month invoice lines for the same client (already loaded at generate)
  - learning context: recent answered questions + recent correction diffs for
    this client, plus a few firm-wide ones (capped, newest first)
- System prompt frames the task: "you are checking a bookkeeping firm's draft
  invoice for accuracy before the owner reviews it" — what to check (rate ×
  hours arithmetic against the summary, plan-vs-hourly consistency, coverage
  windows, adhoc dispositions, month named in descriptions, anomalies vs prior
  month), and that questions must be ones only Brittany can answer, phrased to
  her, US English (`US_ENGLISH_RULE`).
- Score bands: high ≥ 85, medium 60–84, low < 60 — but the model returns both
  band and score directly; the lib validates consistency.

## Server surface (`server.js`, all owner-only + CSRF + content-type)

| Endpoint | Behavior |
|---|---|
| `POST /api/invoices/:id/ai-review` | Rate (or re-rate) one invoice now, synchronously. Returns the stored review. 503 if no `ANTHROPIC_API_KEY`. |
| `GET /api/invoices/ai-reviews?period=YYYY-MM` | Latest non-superseded review per invoice for the period. |
| `POST /api/invoices/:id/ai-review/answer` | Body `{ questionId, answer? , skipped? }` — stores the answer or skip on the current review. |
| (hook) after `POST /api/invoices/generate` and `/regenerate` | Fire-and-forget async loop: rate each newly created **monthly** invoice (retainers skipped — one manual line, nothing to check), persist, `broadcastDataChanged()` as each lands. Per-invoice try/catch; a failed rating logs and moves on. If no API key, skip silently. |

Answering a question also appends to the learning context; the review row is
the storage.

Activity log: rating events are NOT logged to `activity_log` (200-row trim;
high volume). `invoice_review_events` is the audit surface.

## UI (`src/components/InvoiceMonthRun.tsx`, `src/lib/api.ts`, `src/lib/types.ts`)

- **Row badge** beside the existing scope-flag chips: `High confidence` /
  `Check 2 things` (medium) / `Low confidence` / `Rating…` / nothing (unrated,
  pre-feature). Colors follow the existing pill vocabulary. Never re-sorts,
  never disables anything.
- **Expanded editor — AI review card**: summary sentence, concerns list
  (line + issue), questions with inline answer boxes (answer / skip per
  question), re-rate button, and a stale note when `lines_fingerprint` no
  longer matches ("Rated before your latest edits — re-rate?").
- **At approve**: clicking Mark reviewed when the current review has
  unanswered, unskipped questions swaps the button area for a compact panel:
  the questions with answer boxes, [Answer & approve] and [Skip & approve].
  Both proceed to `{status:'reviewed'}`. Approval is never blocked — this is
  capture, not a gate.
- Reviews fetched once per period alongside invoices; refreshed on the
  existing SSE `data-changed` ping (badges fill in as background ratings land).

## Docs + ship

- `docs/capability-manifest.md`: new blockquote material in the Invoices
  section (what the badge means, that it's advisory, the questions flow, that
  the AI never changes an invoice), **plus fix two stale claims while in
  there**: L1579-1582 (says Stripe is test mode — it's live) and L2293-2296
  (says no online payment collection). Manifest changed ⇒ re-provision the
  voice agent after deploy.
- Prod DDL validated with `BEGIN … ROLLBACK` against production before push.
- Tracker: file a shipped `feature_requests` record (standing approval).
- Ship ritual: verify → push → poll Railway to the exact hash → `/health` →
  voice re-provision.

## Explicitly out of scope (recorded so nobody re-litigates)

- Any automation tier (auto-approve, auto-send) — that is the *output* of
  months of calibration data, not part of this build.
- Rating retainer invoices.
- A confidence-based sort or filter of the month run.
- Rate limiting the re-rate button (owner-only; bounded by patience).
- Backfilling ratings for pre-feature invoices.
