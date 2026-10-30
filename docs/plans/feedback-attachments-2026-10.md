# Private attachments for Updates feedback

Prepared October 30, 2026. Approved by Alex for local implementation and review. Deployment remains held.

## Scope and current base

Add optional pictures and documents to the existing Updates tracker, during creation and on existing requests. Use the Finance handoff as a behavior reference, not as deployment or provider authorization. Preserve statuses, clarification, approvals, notifications, and AI behavior. Attachment contents are never sent to AI.

Base: `a54b26c11e0e3aa925a2086abe3a4e96aeb285bd`, verified on local main, GitHub main, successful Cloudflare deployment, and live health. Billing work is already included. Isolated branch `codex/feedback-attachments`, checkout `D:/PBJ Accounting Work/AP-feedback-attachments`. No production changes have been made for attachments.

## User experience

- Add a labeled file picker to the existing request form and an Attachments area to each expanded request, including requests awaiting clarification or review.
- Up to 10 files per request, 10 MiB each, labeled 10 MB in the UI. Support JPEG, PNG, GIF, WebP, PDF, DOCX, XLSX, PPTX, UTF-8 TXT and CSV.
- Save a new request once, retain its returned ID, then upload selected files. Show successful files and individual failures. Retry only failed files with their original upload IDs. Never create another request on attachment retry.
- Show filename, size, progress/busy status, recoverable errors, image preview, Download and Remove. Removing a file needs a clear confirmation. Attachments remain optional.
- Match existing Updates styling and keyboard behavior. Abort queued/in-flight requests on session or preview identity change, logout and unmount. Ignore late results and revoke preview/download object URLs.
- Existing owner-only access applies to all attachment operations. Staff and all preview sessions are denied, including reads and inline previews. Both owners can manage attachments, matching existing request management.

## Storage recommendation

Use a dedicated private R2 bucket, proposed name `pbj-feedback-attachments`, accessed by the existing authenticated Node server with the official S3 client. This keeps request authorization and storage operations in one backend. A Worker binding would require an additional authenticated bridge from the Container to the Worker; the current app has no such storage bridge.

Use credentials scoped only to the attachment bucket, forwarded through `cloudflare/env-names.js` and the existing secret uploader. Inspect existing administrative access before asking Alex to create anything. Do not use Finance storage or PBJ backup credentials/buckets. Disable r2.dev and custom public domains. Fail closed if storage is unconfigured or unavailable. Production never falls back to local disk.

Dependencies proposed for specific work: `@aws-sdk/client-s3` for storage/signing and bounded requests; `busboy` for streaming multipart limits; `sharp` for real image decoding with a pixel limit; `yauzl` for bounded Office ZIP inspection. Confirm compatible versions and advisories before installation. Generate the lockfile through the repository's established Linux process. Do not hand-roll multipart parsing, ZIP extraction, or S3 signing.

Development/tests use an explicitly selected local object adapter in an ignored directory, separate from the JSON workspace, and fake storage for fault injection. The local adapter is forbidden in production.

## API and validation

Add list/upload under `/api/feature-requests/:id/attachments`, and download/preview/delete under that path plus `:attachmentId`. Resolve the authorized parent first. Register these before generic matchers. Keep existing preview denial and origin protection; accept multipart only on this upload endpoint. Use safe errors and never expose object keys or credentials.

The parser accepts exactly one file and one UUID `upload_id`; cap file bytes, aggregate request bytes including overhead, field counts, field lengths, runtime and concurrent validation work. Reject extra parts, empty/truncated uploads, malformed IDs, aborted connections, unsupported formats and filename controls/overlong names. Generate object keys independently of filenames.

Validate content against extension, not browser MIME: actually decode raster images under 25 million pixels with bounded animation/frame work; inspect Office ZIPs lazily with 500-entry and 50 MiB expanded limits, reject unsafe paths, macros, embedded files, encryption and incorrect document structure; validate PDF signature/structure within bounded work; require strict UTF-8 TXT/CSV and reject NUL and active HTML/script/SVG. Do not describe validation as a malware scan.

Serve bytes only through authorized endpoints, with safe Content-Disposition, `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`, and `Content-Security-Policy: default-src 'none'; sandbox`. Inline delivery is restricted to validated raster formats. Every preview/download uses the central preview-aware client API rather than an untagged direct URL.

## Persistence and lifecycle

Add two endpoint-managed tables through idempotent initialization, outside the bulk workspace save and without foreign keys to bulk-saved data:

1. `feature_request_attachments`: IDs, parent/uploader, sanitized filename, validated type/size, private key, upload ID, content digest, lifecycle state, lease/attempt information, creation time. Pending rows are durable upload intents; only ready rows appear in public lists.
2. `feature_request_attachment_deletions`: private object key, earliest retry time, attempts and cleanup status. No file bytes.

Reserve a pending upload durably before writing an object. Serialize per parent so ready plus active reservations cannot exceed ten. Uniqueness on parent/upload ID makes successful retries return the same metadata (201 first success, 200 existing); conflicting content with the same ID is refused. An in-flight duplicate must not start another upload. Use unique attempt keys and lease ownership so stale completion cannot publish an expired attempt.

Finalize ready metadata after upload succeeds. Failed or expired attempts remain discoverable after crashes and are queued for cleanup. Cover crashes before PUT, after PUT, and before finalization. A queued deletion cannot race an active upload or publish after physical deletion.

Delete attachment metadata and enqueue cleanup in one transaction. Parent request deletion does the same for every attached/pending object. Handle existing file-backend parent CRUD under the same serialization boundary as attachment operations so a whole auth-state write cannot undo a deletion or lose the queue. Store only metadata in JSON, never bytes.

Register a bounded cleanup job on the existing 15-minute internal tick; an optional immediate post-commit dispatch is only an optimization. Retry provider failures durably with timeouts/backoff. Validate the exact attachment-key namespace. Recheck live references and hold the same lifecycle lock through object deletion; upload finalization and restoration must honor that lock. Missing objects are successful cleanup. Limit each pass by object count and elapsed time so invoice/reminder jobs are not starved.

## Backup, restore and rollback boundary

Nightly PostgreSQL dumps include attachment metadata, pending intents and cleanup records. File bytes persist separately in private R2; the existing database backup is not an independent backup of those bytes. Version one does not promise recovery of a file after the user removes it and cleanup deletes it. Old monthly database snapshots can reference files that no longer exist; report unavailable attachments honestly.

Before any database restore, stop attachment uploads and cleanup, preserve the pre-restore inventory, reconcile restored references with R2, and clear/adjust obsolete cleanup intents under the lifecycle lock before resuming. A database advisory lock alone cannot protect a restore into a different database: the operational pause must cover both runtimes. Test restoration racing cleanup within the supported runtime and test the maintenance pause during a full restore drill. Never run production writes as a restore test.

Rollback preserves the additive tables and objects and disables attachment operations/cleanup. Do not run an older parent-delete implementation against attachment-bearing requests without a compatibility guard or disabling tracker deletes. Do not drop the tables or delete the bucket as a rollback.

## Verification and release

- Real HTTP handler tests for multipart parsing, session/owner/preview/origin protection, cross-parent IDs, file headers and byte-correct delivery.
- Both persistence backends: reload, workspace saves, unrelated billing edits, parent deletion, crash recovery, idempotency and cleanup. Real isolated PostgreSQL concurrent quota and duplicate-upload tests, beyond recording adapters.
- Validation fixtures for every permitted format and malformed/oversized/truncated/hostile files. Storage failure and delayed completion injection. Cleanup/reference/restore races.
- Render the real Updates UI at 360, 768 and 1280 pixels: create with files, add later, partial failure/retry, preview/download/remove/reload, logout/preview transitions, keyboard and focus. Inspect screenshots and console.
- Independent permissions/persistence/cleanup review, then `npm run verify` and relevant script/integration tests. One Vitest process per checkout.
- Update the capability manifest within 205,000 normalized bytes and the handoff. Do not claim the Finance release proves PBJ behavior.
- Production bucket/credentials, schema application, release, and live synthetic QA require Alex's authorization. Use the established deployment pipeline, verify exact commit/health/startup, and synchronize the voice manifest. Live QA creates only a clearly labeled synthetic request/file; verify anonymous denial, byte-correct downloads and asynchronous cleanup, then remove only test data. No real client files are used.

## Approval record

Alex approved this PBJ implementation plan, including the dedicated private R2/S3 adapter, two additive tables, four justified dependencies and the stated deleted-file recovery limitation. This approval covers local implementation and testing. Provisioning and deployment remain separate until Alex authorizes the reviewed release.

## References

- User-provided handoff: `D:/AEC/AEC-Finance/docs/PBJ-FEEDBACK-ATTACHMENTS-HANDOFF.md`.
- Current PBJ `AGENTS.md`, `docs/HANDOFF.md`, Updates routes/UI, store and periodic-job registry.
- Cloudflare S3 client example: https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/
- Multipart parser: https://github.com/mscdex/busboy
- Image decoder limits: https://sharp.pixelplumbing.com/api-constructor/
- ZIP reader and validation: https://github.com/thejoshwolfe/yauzl
