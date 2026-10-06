# Bulk save: batch the inserts (follow-up B2 on featreq-c8e5f169)

Written 2026-10-06 night, for Alex's approval. Nothing here is built.

## Why now

The whole-workspace save (`AppDataStore.write()`, db/store.js ~7908-9027) takes its 14 tables
EXCLUSIVE, deletes every row and re-inserts it one `INSERT` at a time. Production on 2026-10-06:

- `[bulk-save] write committed in` 9,898-12,944 ms per save, one at 20,548 ms.
- Two `could not lock the workspace tables after 3 attempts (55P03); refusing as busy`
  (a second save arrived while one was running); the tab's retry won both times.
- Saves whose before/after fingerprint was identical still rewrote everything.
- While a save runs, every single-row write to those tables (a checklist tick, a time entry,
  a Stripe payment apply) waits behind the lock. Reads do not.

Rows rewritten per save today: 8,865 (time_entries 3,178, checklist_items 2,557, checklists
1,313, checklist_template_items 800, template stages 475, templates 175, the rest small).
Invoices (138) are snapshotted and restored, not sent by the tab.

## Where the time goes

One statement per row: roughly 9,000 inserts plus ~37 fixed statements (lock, fingerprint,
~17 snapshot selects, 14 deletes, fingerprint again, commit). At ~1 ms per Railway app ->
Postgres round trip that is the whole 10 s. The server-side work for 9k rows is well under
1.5 s. Two extra costs found on the way: `hashPassword` (scrypt, ~50 ms, synchronous) runs for
EVERY user on every save even though `ON CONFLICT` discards it (db/store.js ~8340); and the
`write committed` line also fires for materializer write-backs and template saves, so not every
line is a tab save (the route's own `emp-patrice saved ...` line is).

## Options

| | Per save | Risk | Backends |
|---|---|---|---|
| (a) multi-row `VALUES` inserts, chunks of 500, same transaction + lock | 1.5-3 s | low if every value keeps today's parameter conversion and casts | Postgres only; file untouched |
| (b) skip when fingerprints match | - | cannot work as worded: a save that passes the guard always matches. Workable form: after inserting, if the produced version equals the stored one, `rollback` instead of `commit` (saves no lock time, but stops re-stamping `updated_at` on 9k rows and the dead tuples/WAL that invite autovacuum into the lock tiers) | Postgres only |
| (c) diff-based save (only changed rows) | <1 s | high - a per-column "changed?" rule on top of every preserve rule; the exact shape of the three past data-loss bugs; changes the duplicate-checklist outcome | - |
| (d) COPY | ~(a) | new dependency + Linux lockfile refresh, no ON CONFLICT/RETURNING, hand-escaped arrays/jsonb | - |

Recommendation: (a), then the narrow (b).

## Ship order (each stage deploys alone)

0. **No behaviour change, measure first.** Hash passwords only for users not already in the
   table. Extend the `write committed` log line with a phase breakdown (lock / check /
   snapshots / deletes / inserts per table / version / commit) and row counts.
1. **Helper + time_entries.** One `insertRowsBatched(client, { table, columns, casts, rows,
   chunk, onConflict, returning })` helper; use it for time_entries only. VALUES lists, not
   `unnest` (ragged `text[]` columns such as `group_client_ids` break it) and not
   `jsonb_populate_recordset` (a stringified jsonb becomes a jsonb string). Chunk 500 keeps
   every statement far under the 65,535-parameter limit.
2. **Checklists + items, then templates/stages/items.** Checklists use `on conflict do nothing
   returning id`, chunks in payload order, first returned occurrence wins; build the item list
   only from inserted checklists and keep the "skipped duplicate checklist" warning.
3. **Clients + invoice restore + the small tables.** Merge the three separate `clients`
   snapshot selects into one.
4. **No-op rollback.** When `returnVersion` is set and the produced version equals the
   current one, `rollback` and return it; log `[bulk-save] no-op save rolled back`.

## Invariants (every stage)

- `begin` -> `set local lock_timeout` -> `BULK_SAVE_LOCK_SQL` stay the first statements; the
  tiers and the retry loop are untouched. Never revert 0cc2afb.
- The fingerprint is checked under the lock; the version is taken on the same connection just
  before commit and returned to the tab.
- Every preserved column still comes from its snapshot, never the payload: stripe_customer_id,
  invoice_note, rate pins, coverage_*, category fallback, push stamps, waits, completion stamps,
  created_at. The invoice restore stays verbatim (recorded_outside_app, pay_token included).
- The empty-clients guard and the missing-version 409 in the route are untouched.
- The file backend is untouched.

## Proof before each deploy (rolled back, set-based, on production)

In one transaction: `set local lock_timeout='1500ms'; set local statement_timeout='30s'`;
`create temp table te_new (like time_entries including all)`; map the real rows through the
store's own mapper and run the NEW helper into the temp table (time each statement with
`explain (analyze)`); run the OLD per-row SQL on 100 rows into `te_old`; assert
`except all` between `to_jsonb(x) - 'updated_at'` of te_new vs time_entries, and te_old vs
te_new on the sample, both return zero rows; `rollback`. No real table is written or locked.
Repeat for checklists/items at stage 2. Optional end-to-end: restore last night's dump into a
throwaway Postgres (db-restore-drill.sh) and compare old vs new `write()`.

## Tests

- First, a no-behaviour-change commit: a `insertedRows(statements, table)` decoder in
  db/store-staleness.test.mjs that reads per-row AND multi-row statements (about 120
  assertions match per-row inserts today); teach the fake pool's uniqueness simulation
  multi-row inserts.
- A golden parity fixture: decoded rows per table for a rich payload captured on current main;
  every stage must reproduce it exactly (values, JSON strings, arrays, Dates).
- Chunk boundaries 0 / 500 / 501 / 1,001 rows; no statement over 65,535 parameters.
- Duplicate checklists: same id twice and same (template, cycle, stage) -> first wins, the
  loser's items skipped, one warning each.
- Stage 4: identical payload -> rollback and the same version; changed payload -> commit.
- All existing lock-order and preserve tests stay green.

## Watch after deploy

`write committed` under 3,000 ms with the breakdown; `refusing as busy` near zero; no
`write() failed`; unchanged `skipped duplicate checklist` rate; from stage 4, every
`(X -> X)` save line has a matching `no-op save rolled back` line; stale-save 409 rate
unchanged; `/health` 200; row counts of the 14 tables unchanged across a save; `n_dead_tup`
on time_entries falls.

## Not in this plan

A tab-side skip (do not send a save when the snapshot equals the last confirmed save) would
remove the request entirely but is client logic and a separate decision.
