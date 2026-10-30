# Feedback attachment local review

October 30, 2026. Branch `codex/feedback-attachments`, based on `a54b26c11e0e3aa925a2086abe3a4e96aeb285bd`. Checkout: `D:/PBJ Accounting Work/AP-feedback-attachments`. Alex approved local implementation and wants to review before deployment.

## Try it

The dedicated Chrome review window is signed into the isolated local app at `http://127.0.0.1:4179/updates`. Choose the New tab. The fictional request **LOCAL REVIEW: attach a screenshot and notes** has an image and two text files.

1. Add files to a new update or the existing example.
2. Preview the image, download a file, and remove one after confirming.
3. Reload to check persistence. Up to 10 files per request, 10 MB each.

The local API binds to loopback and uses ignored `tmp/feedback-objects` storage. External service credentials are cleared by the local launcher. This preview does not send mail, charge cards, invoke AI or access production storage. The ignored launcher is `tmp/start-feedback-preview.mjs`; current startup and error logs are `tmp/feedback-preview.stdout.log` and `tmp/feedback-preview.stderr.log`.

## Verified

| Check | Result |
| --- | --- |
| `npm run verify` | Exit 0: ESLint, TypeScript/Vite, 470 test files / 10,825 tests, 40 Cloudflare script tests |
| `npm run test:scripts` | Exit 0: 58 script tests |
| `node scripts/feedback-json-test.mjs` | Passed concurrent create/delete, stale auth write, whole-workspace save, reload and deleted-parent guards |
| `node scripts/feedback-postgres-test.mjs` | Passed against isolated local PostgreSQL 18: concurrent quota, duplicate upload exclusion, retry idempotency, atomic parent deletion, expired intent cleanup, maintenance and restored-reference reconciliation |
| Linux dependency check | Node 22.23.2 production-only install, Sharp native decode, Busboy/Yauzl imports and S3 client configuration passed |
| Independent review | Backend and frontend reviewed; identified parser, commit acknowledgment, JSON concurrency, queue removal, refresh and logout races fixed; final source cleared for local review |
| Manifest | 204,858 normalized UTF-8 bytes, below the 205,000-byte limit |

The lockfile was generated locally in Linux with npm 11.6.2. No existing dependency version changed. Production dependency audit found no advisory for the four additions. It still reports the pre-existing Zod 4.5.4 advisory, unchanged from the base lockfile; this feature does not use Zod for uploads.

## Browser evidence

Actual route: `http://127.0.0.1:4179/updates`, authenticated as the synthetic local owner.

- Created one request with three files. Injected one HTTP 503 for the third upload; the first two remained, retry uploaded only the failed file, and exactly one matching request existed afterward.
- Image preview, download, removal confirmation, cancel removal, actual removal, reload and adding files to an existing request passed.
- Downloaded TXT matched the source SHA-256: `214ad6eaa60e9a23f2dbd71b65de27634c3c2455e9f7bb8f1312a75d09f9c52c`.
- Delayed creation response plus delayed logout response produced zero attachment uploads after logout initiation and no saved form continuation.
- Real local API returned anonymous 401, staff 403, boolean-preview 403, identity-preview 403, owner 200.
- Cleanup removed the test deletion objects; the review example retained three ready files and the durable deletion queue was empty.
- Screenshots inspected at 360x800, 768x1024 and 1280x900. No horizontal overflow. Mobile drawer settled offscreen; reduced-motion mode, visible keyboard focus and preview focus return checked. The fresh final browser session reported zero console errors or warnings. Earlier logs contain the deliberate upload 503 and connection refusals while the API was stopped for tests.

Local screenshots: `tmp/updates-360-final.png`, `tmp/updates-768-final.png`, `tmp/updates-1280-final.png`. Failure/preview evidence: `tmp/updates-1280-retry.png`, `tmp/updates-1280-preview.png`. Test logs: `tmp-feedback-verify-release.log`, `tmp-feedback-script-tests-final.log`.

## Held for Alex

No commit has been pushed and nothing has been deployed. R2 bucket creation, scoped credentials, production schema application, real R2 transfer checks and voice-manifest provisioning remain for an approved release. Local tests prove the application flow and both persistence implementations, not production R2 configuration. See `docs/runbooks/feedback-attachments.md` for configuration, cleanup, backup limitations, restore pause and rollback boundaries.
