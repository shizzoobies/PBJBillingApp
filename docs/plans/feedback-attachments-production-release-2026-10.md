# Feedback attachment production release

October 30, 2026. Alex approved production storage and deployment after local review.

Feature commit: `9afb5aadb3df93077fc6e19180b8234c673035d6`.
Previous production commit: `a54b26c11e0e3aa925a2086abe3a4e96aeb285bd`.
Deployment run: https://github.com/shizzoobies/PBJBillingApp/actions/runs/41106528871

## Storage

- Dedicated private R2 bucket: `pbj-feedback-attachments`.
- Verified public r2.dev access disabled and no custom domains.
- Account service credential: Object Read & Write, restricted to this bucket.
- S3 HeadBucket succeeded for the attachment bucket; the same credential received 403 for the database backup bucket.
- Credentials are outside Git in `D:/PBJ Accounting Work/secrets/feedback-attachments-production.env` and uploaded as Worker secrets. Only six feedback settings and ENV_REVISION were uploaded.
- Uploaded environment revision: `2026-10-30T18:19:31.142Z`.

## Current status

Feature commit `9afb5aa` is deployed. GitHub run `41106528871` completed successfully after its status display lagged during the GitHub Actions incident. Live health returned HTTP 200, `ok=true`, `db=ok`, `maintenance=false`, exact commit `9afb5aa`, and environment revision `2026-10-30T18:19:31.142Z`. Both attachment tables exist.

Alex chose to test an attachment manually after the browser extension blocked automated file selection. One ready attachment and one R2 object were subsequently verified on the synthetic request `featreq-bae5f652`; its contents were not inspected and the user's upload is preserved. Anonymous attachment listing and download both returned 401. An unsigned S3 request returned 400 InvalidArgument; bucket privacy is established by disabled public access, no custom domains, and scoped-credential checks, not by treating that 400 as a specific permission result.

Pending: Alex's preview/download/removal checks and physical cleanup confirmation; historical Container stdout startup evidence; voice knowledge-base synchronization. Automatic approval review rejected the voice provisioner because it considered updating the agent and replacing its prior manifest outside storage/deployment approval. An explicit voice-sync question is pending; do not run it without that answer.

## Release gates

- Primary checkout `npm ci --no-audit --no-fund`: passed.
- Primary checkout `npm run verify`: exit 0; lint/build, 470 test files / 10,825 tests and 40 Cloudflare script tests passed.
- Guarded `scripts/prod/ship.sh`: quiet check passed, no invoices sent in 15 minutes or non-bulk invoice edits in five minutes.
- GitHub authentication was scoped to the existing shizzoobies login for this process; the other active account was preserved.
- Live commit, health, environment revision, schema and an actual ready R2 upload: verified. Remaining checks are itemized above.
- The Cloudflare dashboard showed Container image `sha256:7354e5c4ab04393b71b4db0f30ce4a7b1cd244402d69a70f7c722408b7ed8f16`, updated at 18:38:01 UTC. Its filtered stdout query returned no startup event; the read-only API credential also lacks Container/telemetry read access. Do not present Worker tail or health as historical stdout evidence.

## Remaining checks

1. Preserve the upload on synthetic request `featreq-bae5f652` while Alex tests it. Do not create another request or delete his uploaded file. Manual preview, download, removal and physical cleanup are not yet confirmed.
2. If Alex wants agent-driven transfer verification resumed, use only fictional files and an authorized owner session. The Chrome extension needs file-URL access for its automated chooser; Alex chose manual testing instead. Local automated create/retry/download/removal and both persistence-backend tests already passed.
3. Capture historical Container startup stdout if available. Dashboard version 39 is Running in Chicago on image `sha256:7354e5c4ab04393b71b4db0f30ce4a7b1cd244402d69a70f7c722408b7ed8f16`; this and healthy responses are operational evidence, not stdout.
4. Obtain the answer to the explicit voice-sync approval question. If approved, run `node scripts/prod/voice-provision.mjs` at the released commit with current credentials, then verify the manifest/tools. Do not rerun a rejected command before that answer.
5. After the remaining verification, file the feature as Shipped and update this record/HANDOFF. Brittany's acceptance remains separate. No financial records, client files, invoices, or notification emails were used for the agent's QA.

## Data and rollback

The additive tables store metadata and deletion intents. PostgreSQL backups include those tables; the files in R2 have no independent byte backup. Files removed and physically cleaned cannot be recovered from a database dump alone.

Rollback retains the bucket, objects, and tables. Set attachment pause and maintenance before returning to an older build, because older parent deletion does not understand attachments. Use the restoration reconciliation procedure in `docs/runbooks/feedback-attachments.md` before resuming cleanup after a database restore.
