# 2026-08-04 — Historical Jan–May 2026 time import (re-run)

Approved by Alex 2026-08-04 (tracker `featreq-deef43f1`). Re-run of the June 23
import that was wiped by a stale-tab bulk save on June 24; the bulk-save
staleness guard (merge `b7ce60e`) now derives the workspace version from the
data itself, so this import immediately invalidates every open tab — the wipe
vector is closed.

## What was written (one transaction, committed 2026-08-04 ~16:30Z)

- **1,368 `time_entries` rows**, ids `seed-00001` … `seed-01368`, entry dates
  2026-01-05 → 2026-05-29, **961.77 hours** total, `approval_status='approved'`,
  `entry_method='timer'`, no sessions (minutes-only historical records).
  By month: 2026-01 = 187.12h · 02 = 180.37h · 03 = 214.97h · 04 = 217.90h ·
  05 = 161.42h. Users: emp-patrice (Brittany), emp-a41095f0 (Lisa),
  emp-41def8a0 (Allison).
- **6 placeholder clients** created for unmatched names, ids `client-seed-*`:
  17-signiture, clean-up-split-project, craig-s-design,
  new-gen-construction-llc, sophie-sorensen, susannah-dobbs — all named
  "[Review] …" for Brittany to reconcile (rename/merge into real clients).

Pre-state: 830 time_entries, 42 clients. Post-state: 2,198 time_entries,
48 clients.

## Undo

```sql
BEGIN;
DELETE FROM time_entries WHERE id LIKE 'seed-%';        -- 1,368 rows
DELETE FROM clients      WHERE id LIKE 'client-seed-%'; -- 6 rows, created this run
COMMIT;
```

All six `client-seed-%` clients were created BY this run (verified absent in
pre-flight), so deleting them is safe unless Brittany has since attached new
data to them — check `time_entries.client_id` / checklists referencing them
first if undoing later.

Full pre-import table backups (machine-local, `D:\PBJ Accounting\Old Time\`):
`backup-time_entries-2026-08-04T16-30-02-522Z.json` (830 rows) and
`backup-clients-2026-08-04T16-30-02-522Z.json` (42 rows).
