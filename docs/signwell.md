# E-signature through SignWell (featreq-56d39567)

SignWell is now the second provider: eSignatures.io is used whenever `ESIGNATURES_SECRET_TOKEN` is set
(unless `ESIGN_PROVIDER=signwell`) - see docs/esignatures.md. Everything below still holds for SignWell.

An engagement letter can be sent for electronic signature from the letter's own page. SignWell
emails the signer a link; when they sign, the app marks the letter signed itself (the same thing
**Mark as signed** does), keeps the signed PDF, and tells the owners by name only. **Mark as signed**
stays as the manual path.

Everything SignWell-specific lives in two files: `lib/signwell.js` (the only file that knows
SignWell's URLs and shapes) and `lib/signwell-webhook.js` (the webhook handler). The send and remind
rules are in `lib/engagement-esign.js`; `server.js` only wires them.

## Environment variables (Worker secrets via scripts/cf/secrets-upload.mjs)

| Variable | Meaning |
|---|---|
| `SIGNWELL_API_KEY` | The SignWell API key. Without it the **Send for signature** button is hidden and the send route answers 409 `signwell_not_configured`. Never logged. |
| `SIGNWELL_TEST_MODE` | **Missing means TEST mode.** Only the literal `false` (any case) means live; anything else (`true`, empty, `0`, `no`, a typo) is test. Every document the app creates passes `test_mode` from this variable, and the code can only ever force test mode on, never live. Keep it unset or `true` until the end-to-end test below has passed. A test-mode document is not binding, so **a test-mode signature never marks a real client's letter signed**: only a letter of the existing client named exactly `Test` is signed (a prospect whose party is named Test is not: signing would create a second Test client); any other gets "Test mode - not marked signed; use Mark as signed if this was a real signature". |
| `SIGNWELL_WEBHOOK_ID` | The id of the registered webhook (printed by the registration script). SignWell signs each event with it, so **it is a secret** (anyone who knows it can forge events): set it as a Worker secret only, never in chat, a ticket or a commit. The handler answers 503 until it is set. |
| `APP_PUBLIC_URL` | Already set for the app. The webhook callback is `${APP_PUBLIC_URL}/api/signwell/webhook` and a signer lands on `${APP_PUBLIC_URL}/signed-thank-you` when they finish. |

There is no `.env.example` in this repo: this table is the documentation.

## Registering the webhook

After the deploy, from the repo root:

```bash
node scripts/prod/signwell-webhook-register.mjs            # lists hooks, creates ours only if absent
node scripts/prod/signwell-webhook-register.mjs --delete <id>   # removes one hook
```

It reads `SIGNWELL_API_KEY` and `APP_PUBLIC_URL` from the environment, or, for whichever is missing,
from PBJ_PROD_ENV_FILE via scripts/prod/env.mjs (the way `scripts/prod/voice-provision.mjs` does). It never prints
the key or the address; it prints the webhook id with "set SIGNWELL_WEBHOOK_ID to this on the Railway
service". One URL receives every event type. Because the id is a secret, the script prints only OUR
hook's id (never another hook's on the account); put it in the external rotation file and upload the Worker secret.
The quoted Railway wording is historical script output; the destination after cutover is the Worker.

## What the app does

- **Send for signature** (`POST /api/engagements/:id/esign`, owner only) builds the same letter Send
  would email, with SignWell's `{{signature:1:y}}` and `{{date:1:y}}` text tags written **in white**
  (under the letter's own ink, on one page) at the letter's own "Signature:" and "Date:" lines (a
  letter with no such line gets one added). The closing "please sign below and return a copy to us by
  replying..." reads "please sign electronically where indicated" on this PDF only; Send's own wording
  is unchanged. SignWell's email carries a fixed message ("Please review and sign your engagement
  letter electronically where indicated."), not the letter's email text. One SignWell document is
  created for the party (one signer, no countersignature; expires in 30 days; `metadata` carries
  `engagement_id`, `client_id` and `app: pbjbillingapp`), and the request row keeps a hash of the
  letter AND its signing details (`esign_hash`: the text, retainer and party, plus package, plans,
  fee choice and figures). The letter is held "in flight" from the quick refusals - before the
  "is one already out?" question - until the row is written, so a double click makes one document. The
  send confirm, in test mode, says the document is not binding and will not mark the letter signed unless
  this is the Test client. It refuses, before SignWell
  is asked, when e-signature is not set up, the page is stale, the letter is signed, void or
  superseded, the client is a billing master or retired (what signing would refuse), a request is
  already out, a placeholder is unfilled, or the party has no single plain email address; never to a
  team address. It records a `signature_requests` row, moves a draft to Sent, and logs an `esign` entry
  on the engagement's email log (carrying the letter's hash, so "changed since sent" still works).
- **Send reminder** (`POST /api/engagements/:id/esign/remind`): once per firm day, only while a
  request is out.
- **Check SignWell / Finish e-signature** (`POST /api/engagements/:id/esign/:requestId/finish`): for
  ANY request that has not ended, re-reads its document and applies what it says (the event type is not
  involved); when the document reads Completed it runs, idempotently, the work after completion (keep the
  signed PDF once, mark the letter signed). The button reads "Finish e-signature" for a completed request
  that is not finished (the server died part-way, `finishing_at` stays set, or the PDF could not be
  fetched) and "Check SignWell" for one still out, bounced or in error. Two presses at once run it once.
  At boot the log lists (by id) every request still marked finishing - nothing is finishing in a fresh
  process - and an hourly check does the same for requests finishing for more than 10 minutes. If a
  completion lands while Check SignWell is reading the document, Check SignWell finishes it.
- **Edits while a request is out** (or bounced or errored, which can recover to out): Send, Send again,
  Save of an edit (text or signing details) and Save address warn that the client will sign the earlier
  version (they do not block).
- **Download signed PDF** (`GET /api/engagements/:id/esign/:requestId/pdf`): completed requests of
  that engagement only. The signed PDF is stored in Postgres (`bytea`) and is **never emailed** to
  anyone; it is downloaded in the app.
- `GET /api/engagements/:id/esign` lists an engagement's requests; `GET /api/signwell/status` tells
  the page whether SignWell is set up and whether it is in test mode.
- If `ESIGN_FIELD_MODE` in `lib/engagement-esign.js` is changed from `'text_tags'` to `'coordinates'`,
  the send places fixed signature and date fields instead of relying on the tags. The coordinate units
  are **not documented by SignWell**, so that path is a best guess until it has been tried.

## Status mapping

Our statuses: `draft`, `sent`, `viewed`, `signed_partial`, `completed`, `declined`, `expired`,
`canceled`, `bounced`, `error`. The status is mapped ONLY from the re-fetched document's `status`;
the event type merely tells "viewed" from "sent" while the document is not finished, and never sets
a status the document does not show.

| Get Document `status` | Our status |
|---|---|
| `Created`, `Sending`, `Sent` | `sent` (`viewed` when the event is `document_viewed`) |
| `Viewed` | `viewed` |
| `Pending` | `signed_partial` |
| `Completed` | `completed` |
| `Manually completed` | `completed`, but NOT signed for the client (see below) |
| `Declined`, `Expired`, `Canceled` | `declined`, `expired`, `canceled` |
| `Bounced` | `bounced` |
| `Blocked`, `Error` | `error` |
| `Draft`, anything unknown | no change; only `last_event_at` moves |

Movement: a finished request (completed, declined, expired, canceled) never changes; the in-progress
statuses (draft, sent, viewed, signed_partial) only move forward; `bounced` and `error` are
recoverable (a re-fetched in-progress status replaces them) and an in-progress request can bounce or
error; an event older than the newest one applied never changes the status.

## How the webhook is made safe

SignWell's hash covers only the event type and time: `HMAC-SHA256(key = the webhook id, data =
type + '@' + time)`, hex. So the handler (`POST /api/signwell/webhook`, outside session auth and the
origin check):

1. answers 503 without `SIGNWELL_WEBHOOK_ID`, 400 for a body that is not JSON, 401 for a bad hash;
2. ignores (200) a document that is not one of ours;
3. ledgers the event once, keyed on sha256(type | time | hash | document id) - the hash trimmed and
   lower-cased, and refused with 401 unless it is 64 hex characters - so a replay (in any spelling of the
   hash) is a 200 "duplicate" with no second write (`signwell_events`; no address is stored). A second
   ledger row keyed on the signed triple sha256(type | time | hash) notices the same signed event
   arriving for ANOTHER of our documents: that delivery is processed as a plain **re-sync** (the event type
   is ignored; the re-fetched document alone decides), so a captured event replayed against another
   document can do nothing that document's own state does not, while a genuine event for a second
   document in the same second still lands. The keys a delivery took are released on a failure (the
   triple only if it was the one to take it);
4. **re-reads the document** (`Get Document`) before acting; its metadata must name this request's
   engagement and its `status` alone sets ours. A `document_completed` event the document does not
   bear out records "SignWell reported it signed but the document reads <status> - press Check SignWell
   to retry", tells the owners once (by name), does not stamp the event's time and releases the ledger
   key so a retry can succeed. Any failure from here on releases the key and answers 500, so SignWell's
   retry is processed (not answered "duplicate"). A finished status read from the document applies even
   if a later event already stamped the clock;
5. moves the status and answers 200 **first** (the request is marked `finishing_at`); for a completed
   document it then fetches the signed PDF (retrying while SignWell makes it: 2, 5 and 10 seconds),
   stores it (one per request), marks the engagement signed as the owner who sent the request (or,
   if they are no longer an active owner, the first active owner; the new client's onboarding
   checklist goes to that owner; activity says "via SignWell"; signed on the firm day of the event,
   never later than today; note "Signed electronically through SignWell"), and tells the owners.

It signs ONLY what the client was sent: if the engagement's `esign_hash` no longer equals the request's
(the letter or its signing details changed after it went to SignWell, or the row has no hash), it is a
superseding letter with open amendments (draft, sent or signed) to decide on, or the request is in test
mode and not the Test client's, nothing is signed. The request is still `completed` and the PDF still
kept, `last_error` says why ("The letter or its signing details changed after it went to SignWell - the
client signed the earlier version; finish by hand" / "Choose which amendments to keep - finish by hand" /
"Test mode - not marked signed; use Mark as signed if this was a real signature") and the owners are
told. A `Manually completed` document is marked completed with "Marked complete in SignWell, not signed
by the client - mark it signed by hand if that is right" and nothing is signed. A problem a retry can
fix (the PDF could not be saved, an unexpected error, the amendments or the engagement could not be
read) says "press Finish e-signature to retry"; one it cannot (a master or retired client, ...) says
"finish it by hand". The owners are told again only when the problem is not the one already on the
request. Every owner notice names the client, never the document, an attachment or a link to it. Logs
carry ids and event types only.

Also: events older than 45 days are refused (400, nothing recorded); the webhook body is limited to
1 MB (413); the webhook id is trimmed before it is used; a 2xx answer from SignWell that is not JSON
is not an error.

## Database

Three endpoint-managed tables created at boot beside the engagements tables (no foreign keys,
outside the bulk save's lock list): `signature_requests`, `signature_documents` and `signwell_events`.
The DDL is in `db/store.js` (`initialize()`) and mirrored in `db/schema.sql`.

## Manual test plan (Alex)

0. The three tables are created at the first boot after this deploys (Alex's yes to the schema is on
   record, 2026-10-21); nothing to run by hand.
1. Create the SignWell account and an API key.
2. Set SIGNWELL_API_KEY as a Worker secret with scripts/cf/secrets-upload.mjs. Leave `SIGNWELL_TEST_MODE` unset
   (that is test mode). Deploy.
3. Run `node scripts/prod/signwell-webhook-register.mjs` and set `SIGNWELL_WEBHOOK_ID` to the id it
   prints. Redeploy (or restart) so the variable is read.
4. Open a draft engagement letter for the `Test` client (give its party an address you can read).
   **Send for signature**: the confirm names the address and says test mode. Check the badge reads
   "E-sign: sent" with the Test mode tag, and the engagement is Sent with an `esign` line in Activity.
5. Note what SignWell does in test mode (see "What we could not confirm"): does the signer get an
   email, can the test document be signed, did the webhook fire (the badge moving to "viewed" is the
   sign of it).
6. Sign it. Expect: badge "E-sign: signed", the engagement Signed (client created or used, fees on
   billing, onboarding opened), **Download signed PDF** working, and an owner notice naming the client.
7. Try **Send reminder** while a second test request is out (once per day), and **Send for signature**
   again while one is out (it should refuse and point at the reminder).
8. Replay is safe: re-sending a captured event (or SignWell retrying), even with the hash in another
   letter case, answers duplicate and changes nothing; a forged request to `/api/signwell/webhook`
   answers 401.
9. When all of that has worked, and only then, set `SIGNWELL_TEST_MODE=false` and send one real letter.

## What we could not confirm from the docs

Record each of these on the first run:

- Whether a **test-mode** document emails the signer, fires webhooks, and can be signed.
- The per-recipient `status` strings (undocumented: the app stores whatever SignWell sends and never
  interprets it).
- How long the completed-PDF URL lives (the app never asks for a URL; it downloads the bytes).
- Whether the text tags are read from white text in the PDF reliably (if not, switch
  `ESIGN_FIELD_MODE`, and learn the coordinate units).
- Whether `time` in an event is epoch seconds or milliseconds, or can be a float (both whole forms
  are read; it must be passed to the hash exactly as received).
- Whether a decline carries a reason (the badge says "declined"; no reason is stored).
- SignWell's webhook retry policy (none is documented, so every event is treated as retryable and
  the handler is idempotent).
