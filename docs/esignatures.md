# E-signature through eSignatures.io (featreq-56d39567, task 18)

eSignatures.io (esignatures.com; $0.49 per contract, no subscription, free test mode) is the
default e-signature provider whenever its token is set. SignWell (docs/signwell.md) stays
selectable and keeps working exactly as before. The letter's page, **Send for signature**, the
badge, **Send reminder**, **Download signed PDF** and **Mark as signed** are the same for both; only
the provider behind them changes.

Everything eSignatures.io-specific lives in two files: `lib/esignatures.js` (the only file that knows
its URLs and shapes) and `lib/esignatures-webhook.js` (the webhook, "Check eSignatures.io" / "Finish
e-signature", and the expiry sweep). `lib/esign-provider.js` picks the provider;
`lib/letter-markdown.js` writes the letter as Markdown; `lib/engagement-esign.js` holds the send and
remind rules for both providers; `server.js` only wires them.

## Environment variables (Worker secrets via scripts/cf/secrets-upload.mjs)

| Variable | Meaning |
|---|---|
| `ESIGNATURES_SECRET_TOKEN` | The account's secret API token (HTTP Basic username, empty password). It also keys the webhook signature, so **it is a secret**: Worker secret only, never in chat, a ticket or a commit. Without it eSignatures.io is not the provider, and its webhook answers 503. Never logged. |
| `ESIGNATURES_TEST_MODE` | **Missing means TEST.** Only the literal `false` (any case) means live; anything else is test (`"test": "yes"` on every contract: a demo, no fee, not binding). The code can only force test on, never live. A test-mode signature never marks a real client's letter signed: only the existing client named exactly `Test` (as for SignWell). |
| `ESIGN_PROVIDER` | Optional. `signwell` sends through SignWell even with the eSignatures.io token set (if SignWell has no key, e-signature is "not set up"; it never falls back to the other one). Anything else, or unset: eSignatures.io when its token is set, else SignWell when `SIGNWELL_API_KEY` is set. |

A request remembers the provider it went to (`signature_requests.provider`), so its webhook, its
reminder and its **Check** button keep using that provider whatever these variables say later.
`GET /api/esign/status` answers `{ configured, provider, testMode }` for the page;
`GET /api/signwell/status` still answers SignWell's own `{ configured, testMode }`.

## The webhook URL (set it in eSignatures.io's dashboard - there is no API for it)

```
https://app.pbjsatime.com/api/esignatures/webhook
```

Set it in the eSignatures.io API dashboard (Settings -> API / Webhooks) of the account whose token is
in `ESIGNATURES_SECRET_TOKEN`. One URL receives every event.

## What the app does

- **Who signs** (Alex, 2026-10-27; `lib/esign-signer.js`, the page's `SignerPicker.tsx`): pressing **Send for
  signature** first opens a confirm naming ONE signer, name and email. It lists the letter's addresses on
  file (`GET /api/engagements/:id/recipients`, the same list as Send's recipient picker: the party's address,
  then the linked client's contacts and record, never a team member's) with the party's address chosen, plus
  "Another address for this send only". An address on file that is not one plain address is listed but can't
  be chosen; nor can the firm's reply-to mailbox unless it is the party's own address (a short note says so;
  typed, it is refused on the page). The button reads **Send for signature to <email>**. The body is
  `{ templateHash, signer: { email, name?, oneTime? } }`. The server takes exactly one plain address (also
  plausible, no control or invisible characters) that is on file for the letter (case-insensitive; its stored
  spelling is used) or marked `oneTime`; a team/app-user mailbox is refused (`team_address`). The firm's
  reply-to mailbox signs ONLY as the engagement party's own stored address (deliberate and visible on the
  engagement - the Test client's party is that mailbox, as for every engagement send); as a picked contact,
  the client record's address or a typed one-time address it is refused (`team_address`,
  `isReplyToSigner`). Two addresses or a named one
  `invalid_recipient`, an address no longer on file and not one-time `recipients_changed` (with the list as it
  is now; the page reopens the choice on it), an unreadable `signer` 400 `signer_invalid`. No `signer` (an older
  tab) = the party's address, as before. **The name goes on a binding document, so it is never borrowed:** the
  party's own address signs under the party's contact name (else its company), a named contact under that
  name (a posted name is ignored for both); the client record's address, an unnamed contact, a one-time
  address and a party with no name need a name typed at the confirm (else 409 `signer_name_required`). The
  page and the server use the same helpers (`esignSignerName`, `isSignerEmail`), so the confirm's "Signer:"
  line is exactly what the provider gets. The chosen address is what goes to the provider, what
  `signature_requests.recipients` and the letter's `esign` log entry carry, what the badge shows ("Sent to
  ..."), what a delivery failure names ("could not deliver the signing email to <address>") and what Send
  reminder and the webhook use (they read the stored request). The letter itself is still addressed to the
  party, and the party record is never changed by a one-time address. No new column.
  The same confirm (`EsignSendConfirm`) is on the client's Billing tab (Engagements card): a draft or sent letter
  with no request out has **Send for signature** once e-signature is set up (never in preview); the card reads
  the stored letter first and sends with its hash, then badges the row with the request it got back.
- **Send for signature** (`POST /api/engagements/:id/esign`): the same refusals as SignWell (not set
  up, stale page, signed/void/superseded letter, master or retired client, a request already out, an
  unfilled placeholder, no single plain party address when no signer is chosen, a team address). Then:
  1. the FILLED letter (Send's own builder, the closing reworded "please sign electronically where
     indicated") is written as Markdown: the firm name as a heading, the date, the addressee, the
     paragraphs with bold as `**bold**`. `{{initial:...}}` tags become a mandatory checkbox line
     "Initials: I have read and agree to the section above"; `{{text:...}}` a text input;
     `{{check:...}}` a checkbox; `{{signature:...}}` and `{{date:...}}` tags, and the letter's own
     "Signature:" / "Date:" / blank-to-fill lines, are dropped (eSignatures.io adds ONE signature
     section at the end, with name, date and IP). Letter text is Markdown-escaped;
  2. `POST /api/templates` {title "<party> - Engagement letter <date>", markdown};
  3. `POST /api/contracts` with this body (from `lib/esignatures.js` `createContract`):

     ```json
     {
       "template_id": "<from step 2>",
       "title": "<party> - Engagement letter <date>",
       "signers": [{ "name": "<the signer's name>", "email": "<the address confirmed at Send for signature>" }],
       "test": "yes",
       "expires_in_hours": 720,
       "metadata": "{\"engagement_id\":\"eng-...\",\"client_id\":\"client-...\",\"app\":\"pbjbillingapp\",\"esign_hash\":\"<sha256>\"}",
       "emails": {
         "signature_request_subject": "Please sign your engagement letter - <firm>",
         "signature_request_text": "Please review and sign your engagement letter electronically where indicated.",
         "final_contract_subject": "Your signed engagement letter",
         "final_contract_text": "Thank you for signing your engagement letter with <firm>.",
         "reply_to": "<INVOICE_REPLY_TO, the invoice emails' reply-to>"
       },
       "custom_branding": { "company_name": "<firm>" }
     }
     ```

     (`client_id` only when the letter has a client; `reply_to` only when it is one plain address.)
  4. a `signature_requests` row: provider `esignatures`, the contract id (in `signwell_document_id`,
     read neutrally as `providerDocumentId`), `provider_template_id`, `provider_signer_id`
     (`signers[0].id` of the answer), test mode, the signed-details hash; the letter moves to Sent
     with an `esign` line in its log. eSignatures.io emails the signer itself.
- **Send reminder** (once per firm day, as for SignWell): `POST
  /api/contracts/<contract id>/signers/<signer id>/send_contract` (confirmed in the API docs
  2026-10-23). eSignatures.io also reminds the signer on its own (days 2, 4, 8, 16, ...); a manual
  resend skips its next automatic one. A 4xx answer is "can't send this contract again right now"
  (409 `esign_cannot_remind`).
- **Expiry**: eSignatures.io sends no expiry event, so an hourly job (`esignatures-upkeep`, also once a
  minute after boot) marks a request still `sent` or `viewed` 30 days after it went out `expired` (badge
  "E-sign: expired"). The same job retries signed PDFs that could not be kept (below).
- **Check eSignatures.io / Finish e-signature** re-reads `GET /api/contracts/<id>` (never polled on a
  timer: their rate limits are "adaptive") and, when it reads `signed`, downloads the PDF from that
  FRESH link and runs the same completion as the webhook. A check that reads the contract as not signed
  clears an older "reported it signed but the contract reads ..." note. A request withdrawn meanwhile
  (below) is refused as ended; its completion never runs.
- **Withdrawal** (featreq-60118b28; `withdrawSignatureRequest` in lib/engagement-esign.js): **Void**, **Mark
  as signed** and the superseding flip (the predecessor and the replaced amendments, by hand or by an
  e-signed superseding letter) withdraw every request of that letter that has not finished - AFTER the
  route has answered (the requests side by side, each provider call capped at 8 s per attempt - a 429
  retry can stretch one request to about 52 s; the other sessions are told when one changed). eSignatures.io: `POST /api/contracts/<id>/withdraw`, then the contract is
  re-read (8 s) WHATEVER the withdraw answered (a 2xx could be a no-op on a signed contract): one that
  reads signed, or cannot be read, is LEFT OPEN with a note in `last_error` ("press Check
  eSignatures.io"; shown even on a signed letter), so the webhook or Finish completes it (a letter signed
  by hand keeps the PDF; a void or superseded one is never signed, its PDF is kept, the owners are told
  "Signed after the letter was voided; the signed PDF is kept, nothing was changed here" and Finish is
  not offered). Check eSignatures.io on a request still out whose letter no longer stands withdraws it
  again; Send reminder is refused (409 `engagement_closed`) and hidden for a signed, void or superseded
  letter. Only a contract that reads withdrawn, or still out, ends the request `withdrawn` (badge "E-sign:
  withdrawn"; a finished status), and only then is the `es:<id>:contract-withdrawn` ledger row written
  (so its own withdrawn event that follows is a duplicate). SignWell: the app has no cancel call, so a
  voided or superseded letter's request is withdrawn in the app only (its note says to cancel it at
  SignWell); Mark as signed leaves a SignWell request as it is. Nothing here ever undoes the void or the
  signing. A contract signed after it was withdrawn signs nothing; the owners are told the signed copy is
  in eSignatures.io and nothing was changed (never "mark it signed by hand").

## How the webhook is made safe

`POST /api/esignatures/webhook` (outside session auth and the origin check):

1. 503 without `ESIGNATURES_SECRET_TOKEN`; 413 over 1 MB;
2. **401** unless `X-Signature-SHA256` is the HMAC-SHA256 of the **exact raw body bytes** keyed with
   the token. The docs do not say hex or base64, so both are accepted (hex any case; base64 standard
   or URL-safe; an optional `sha256=` prefix), compared in constant time - before the body is parsed;
3. 400 for a body that is not JSON or has no `status`;
4. 200 `ignored` (nothing written) for an event the app does not act on, a contract whose `metadata`
   (a JSON string) does not carry `app: pbjbillingapp` and an engagement id, or one no eSignatures.io
   request holds (the lookup is held to provider `esignatures`);
5. ledgered once in `signwell_events` (no new table) with keys prefixed `es:` -
   `es:<contract id>:<event>` for one-time events, plus the body's hash for `contract-reminder-sent-to-signer`
   and `error`, which can repeat. A replay is 200 `duplicate`. Any failure from here on releases the key
   and answers 500, so eSignatures.io's hourly retry (up to 6) is processed;
6. events: `contract-sent-to-signer` -> sent; `signer-viewed-the-contract` -> viewed;
   `contract-reminder-sent-to-signer` -> logged only; `contract-withdrawn` (also a signer's decline) ->
   declined; `error` with `email-delivery-failed`/`sms-delivery-failed` -> bounced ("could not deliver
   the signing email to <the request's signer>"), other errors -> error. The store keeps a finished request finished and
   in-progress statuses moving forward only;
7. `contract-signed`: the contract is **re-read** (`GET /api/contracts/<id>`, at most 8 s - eSignatures.io
   gives up on us at 15 s). It must read `signed` and its metadata must name this request's engagement
   and signed-details hash (else 200 ignored). Not yet signed: recorded ("reported it signed but the
   contract reads ..."), owners told once, key released, 500 for a retry. Signed, but the app had already
   ended the request (its own 30-day expiry ran first): nothing is signed, an `[esign]` log line, and the
   owners are told once to check and mark it signed by hand. Signed: the request is completed and the
   answer sent; **then** the PDF is downloaded from the re-read `contract_pdf_url`, else from the link in
   the verified event (it lives 3 days; sent with no credentials; https only, redirects followed by hand
   and only to https, at most 3; PDF content type or a storage host's octet-stream, `%PDF` bytes, 25 MB
   cap), kept in `signature_documents`, and the SAME completion SignWell uses runs (`completeRequest` in
   lib/signwell-webhook.js): the letter is signed only if its text and signing details are unchanged,
   only for the `Test` client in test mode, as the owner who sent it ("Signed electronically through
   eSignatures.io", activity "via eSignatures.io"); owners are told by name only.
8. A PDF that could not be kept leaves the request completed (and the letter signed) with
   `documentPending` and "The signed PDF could not be saved - press Finish e-signature to retry". The
   hourly job retries it for 3 days after signing (a fresh re-read link each time, then the event's link
   if this process heard it - kept in memory only, never stored), clearing that sentence on success; after
   3 days it says "could not be fetched for 3 days - download it from eSignatures.io" and tells the owners
   once.

## Database

Three nullable columns on `signature_requests`, added by a look-first `alter table ... add column if not
exists` in `initialize()` (and in the create statement for a fresh database; mirrored in
`db/schema.sql`): `provider` (null = SignWell), `provider_template_id`, `provider_signer_id`. No new
table, no backfill. Both store backends carry them.

## Manual test plan (Alex)

1. Create the eSignatures.io account (a separate test account is what their docs recommend) and copy the
   secret token.
2. Set `ESIGNATURES_SECRET_TOKEN` as a Worker secret (scripts/cf/secrets-upload.mjs). Leave
   `ESIGNATURES_TEST_MODE` unset (test). Deploy. The columns are added at the first boot.
3. In the eSignatures.io dashboard set the webhook URL above.
4. In the eSignatures.io account settings, check who receives the signed contract by email: it must be
   the signer only - never your own mailbox (client tax documents never go to Alex).
5. Open a draft letter for the `Test` client (its party with an address you can read). **Send for
   signature**: the confirm asks who signs (keep the party's address, or pick a contact or a one-time
   address to test that path) and names eSignatures.io, its automatic reminders and test mode. Badge "E-sign:
   sent", the letter Sent, an `esign` line in Activity.
6. Note: does the test contract email the signer; does the email carry the fixed subject/sentence and the
   reply-to; how the Markdown looks (heading, bold, addressee, the initials checkbox); does the badge move
   to "viewed" (the webhook works). **Check the escapes:** put a services list in the test letter (lines
   starting "- ", "1. ", a "Fees:" bold run, an asterisk and an underscore). On the sign page AND in the
   signed PDF they must read as typed ("- item", "1. item"), with NO backslash showing (the app sends
   `\- item`, `1\. item`, `\*`, `\_`). If a backslash shows, the escaping in lib/letter-markdown.js must
   change before going live.
7. Press **Send reminder** (once a day): the signer gets the request again.
8. Sign it. Expect "E-sign: signed", the letter Signed, **Download signed PDF** working, an owner notice.
9. A forged POST to `/api/esignatures/webhook` answers 401; a replay answers duplicate.
10. Only when all of that worked: `ESIGNATURES_TEST_MODE=false` and one real letter.

## What the docs did not confirm (record each on the first run)

- Whether `X-Signature-SHA256` is hex or base64 (both accepted).
- The exact JSON around `GET /api/contracts/<id>` (`data.contract` per the docs; `data` and the top level
  are read too) and whether `expires_in_hours` wants a number (sent as one).
- Whether a test contract emails the signer (assumed yes).
- Whether the event payloads carry a timestamp (none documented: the app stamps the time it heard).
- The signed PDF link's host and content type (any https host; `application/pdf` or octet-stream with
  `%PDF` bytes).
- How the extended-markdown checkbox, line breaks (two trailing spaces) and backslash escapes render.
- Whether account settings email the final contract to the account owner as well as the signer.
- Templates pile up in the account (one per letter sent); nothing deletes them.
