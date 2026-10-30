# Feedback attachments

This feature is prepared locally. Alex must approve provisioning and deployment after reviewing the local app.

## Runtime configuration

The Node API authorizes every operation against an owner session and a live Updates request. Staff and all preview sessions are denied, including downloads. Files never enter the workspace JSON or AI prompts. Only validated raster images can render inline; all other formats download. Validation is not a malware scan.

Production uses a dedicated private R2 bucket, proposed name `pbj-feedback-attachments`. Disable its public r2.dev endpoint and public custom domains. Scope its S3 credentials only to this bucket. Do not reuse Finance or database-backup buckets or credentials.

Configure these names through the existing Cloudflare secret uploader and Container restart procedure:

| Name | Value |
| --- | --- |
| `FEEDBACK_STORAGE` | `r2` |
| `FEEDBACK_R2_ENDPOINT` | The account's HTTPS R2 S3 endpoint |
| `FEEDBACK_R2_BUCKET` | Dedicated private attachment bucket |
| `FEEDBACK_R2_ACCESS_KEY_ID` | Bucket-scoped S3 credential |
| `FEEDBACK_R2_SECRET_ACCESS_KEY` | Matching secret |
| `FEEDBACK_ATTACHMENTS_PAUSED` | `1` pauses uploads, removals and cleanup |

Missing storage settings fail closed. There is no production filesystem fallback. Local review explicitly uses `NODE_ENV=development`, `FEEDBACK_STORAGE=local`, and an absolute `FEEDBACK_LOCAL_DIRECTORY` under the ignored checkout `tmp` directory. Local-only paths are deliberately excluded from Container forwarding. Never load production environment files for local review.

## Persistence and cleanup

Idempotent startup adds `feature_request_attachments` and `feature_request_attachment_deletions`, without foreign keys to bulk-saved tables. A unique parent/upload ID and a transactional advisory lock protect quota and idempotency. Pending intent is committed before PUT. Each attempt has its own random key and a two-minute lease; storage operations time out within 25 seconds. A lost finalization acknowledgment preserves a ready attachment.

The JSON backend stores tracker records in `tmp/feature-requests.json`, migrated once on first access from the old auth-state field. Tracker CRUD and attachment operations share a reentrant process lock. `tmp/feedback-attachments.json` stores metadata, pending intents, cleanup jobs and authoritative deleted-parent tombstones. Auth and whole-workspace writes cannot overwrite either file. JSON mode is a single-process development backend; do not run competing API servers or tests in the same checkout.

Removal commits metadata removal and a deletion intent together. `feedbackAttachmentCleanup` runs through the existing authenticated 15-minute tick. Each pass expires up to 25 pending intents and attempts at most five object deletions, with a time budget and durable exponential backoff. It checks the exact attachment namespace and live references while holding the lifecycle lock through deletion. Missing objects count as removed. Never manually empty the bucket to clear a queue.

## Backup, restore and rollback

Nightly PostgreSQL dumps include attachment metadata and cleanup records. Bytes live separately in R2. Version one has no independent backup of those bytes and promises no recovery after removal and physical cleanup. An old database snapshot may reference a file that no longer exists; the API reports that file as unavailable.

For a full database restore:

1. Set maintenance and attachment pause in both source and target runtimes. Drain or stop active HTTP uploads and cleanup before restoring anything. The pause prevents new writes; a process already inside an operation must finish or be stopped. Do not rely on a database advisory lock across two databases.
2. Preserve the pre-restore metadata, pending intents, deletion queue and object inventory. Keep the bucket intact.
3. Restore into the isolated target. Compare restored ready references with object existence. Record missing objects explicitly. Review pending intents and old deletion jobs before resuming cleanup.
4. Under the attachment lifecycle lock, reconcile obsolete deletion intents against restored references. The cleanup job rechecks references as a further guard; it is not a substitute for inventory review.
5. Verify downloads and parent counts, then resume only the intended runtime. Keep the old runtime paused.

Rollback retains tables and objects. Pause attachment operations and cleanup first. An older build does not understand attachment-bearing parent deletion; keep `MAINTENANCE_MODE=1` on such a rollback until a compatibility guard is installed. Never drop additive tables or delete bucket objects as rollback steps.

## Local verification

- `npm run verify`: lint, TypeScript/Vite build, all Vitest tests and Cloudflare script tests.
- `node scripts/feedback-json-test.mjs`: fictional tracker CRUD, auth-write races, bulk save, reload and deletion guards. Run with no API/Vitest process in that checkout.
- `node scripts/feedback-postgres-test.mjs`: requires `PBJ_FEEDBACK_TEST_DATABASE_URL` pointing only to a loopback database named `feedback_test`. Uses a new isolated schema and retains it for inspection. Covers concurrent quota, duplicate IDs, parent deletion, expired intents, maintenance and restored references.
- Browser: `/updates`, create with multiple files, force one upload failure, retry without duplicate parent creation, preview, byte-correct download, confirmation/removal, reload, add later, keyboard, logout/preview cancellation, and 360/768/1280 widths.

Production release separately requires private-bucket checks, scoped credentials, exact CI commit and health, startup inspection, manifest voice synchronization, and approved synthetic end-to-end storage checks. Local adapter tests do not prove R2 provisioning.
