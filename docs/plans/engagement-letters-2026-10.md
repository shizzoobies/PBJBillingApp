# Letters under Engagements - the 1099 engagement letter (featreq-5e195707)

Written 2026-10-08 from a read-only design pass at main 3922637. Scope approved by Alex the same day.
Nothing is built at the time of writing.

## The ask (Brittany, via the tracker; Alex's scope)

Brittany wants to tell chosen clients that PB&J can prepare their 1099s for the coming year and get a
signed engagement letter back from each. Her words: she writes the email; the app changes the client's
name (and the figures) per client; she edits it each year because prices change; it lives under
Engagements. Alex's scope for this stage: a "Letters" item under Engagements - one email + one letter
written once with placeholders, a client picker with checkboxes, a per-client preview, Send with the
letter as a PDF attachment, reply-to Brittany's mailbox, a template saved and edited each year, sends
logged per client. NOT in this stage: pulling sections from an accepted proposal, e-signature, tracking
returned letters in the app (they come back by email).

## Rules that bind (Alex, 2026-10-08)

- **Nothing from these letters ever goes to Alex's mailbox** - no copy, no BCC, no owner summary
  carrying the document. The in-app send log is the record. (Ordinary owner notifications are fine.)
- **Reply-to is Brittany's mailbox.** Today every client-facing email already goes out From
  `PB&J Strategic Accounting <billing@pbjsa.com>` with `reply_to = INVOICE_REPLY_TO` (her address), so
  sending through `sendInvoiceEmail` gives this for free; no new env.
- Owner-only, like Proposals. Staff never see the page.

## Shape in one paragraph

A new owner-only page `/letters` ("Letters") joins Proposals under an **Engagements** sidebar heading.
One template (subject, email body, letter body) with `{{placeholder}}` tokens is saved in a new
endpoint-managed table (`engagement_letters`, singleton row `default`); sends are logged per client in
`engagement_letter_sends`, which is also the double-send guard (a claim row per client + template hash +
firm day + attempt, taken BEFORE the provider call). The letter body is rendered to a PDF by a new
`lib/letter-pdf.js` lifted from `lib/proposal-pdf.js`'s letterhead-plus-paragraphs renderer; the email
is built the way `lib/proposal-email.js` builds its short body; both go out through the existing
`sendInvoiceEmail` in `lib/notify.js`. The addressee rule is the invoice rule (`invoiceEmailAddressee` +
`resolveInvoiceRecipients`). Preview routes mirror `/api/invoices/:id/preview` and `.preview.pdf`; the
page's preview dialog is a copy of `InvoicePreviewModal` (sandboxed frame + `<base target="_blank">`).
Five deployable commits; the manifest must be trimmed before the Letters section is added.

## 1. Where it lives

- `src/components/navItems.ts`: the "Engagements slot" is today a label-less single-item section
  `{ items: [PROPOSALS] }` (~136). Add `LETTERS = { to: '/letters', label: 'Letters', icon: FileSignature,
  ownerOnly: true }`; the section becomes `{ label: 'Engagements', items: [PROPOSALS, LETTERS] }`; insert
  `LETTERS` after `PROPOSALS` in the flat `navItems` list (page titles come from it).
- `src/App.tsx`: route `<Route path="/letters" element={<OwnerOnly ...><LettersPage /></OwnerOnly>} />`
  next to `/proposals` (~4463); add `/letters` (and, in passing, the missing `/proposals`) to the
  owner-only bounce list (~4365).
- Page conventions: `src/pages/ProposalsPage.tsx` (fetch on mount guarded by `ownerMode`, `cancelled`
  flag, `ApiError` messages); classes `panel`, `section-heading`, `field`, `input`, `button-row`,
  `primary-action`, `ghost-action`, `form-error`, `report-table`, `status-pill`, `muted-text`;
  `SaveBadge` (`src/components/SectionKit.tsx`); `ListSearch` (`src/components/ListSearch.tsx`).
- There is no multi-client checkbox list today; build it on the page (section 6).

## 2. Sending

- `lib/notify.js` `sendInvoiceEmail({ to, subject, html, text, attachments, fromName, ... kind })`:
  From = `INVOICE_EMAIL_FROM || EMAIL_FROM` named by `formatInvoiceSender`; `reply_to =
  INVOICE_REPLY_TO || OWNER_EMAIL`; attachments base64 via `toResendAttachments`; tags via
  `invoiceEmailTags`. ADD a `letterSendId` param -> tag `letter_send_id`, `kind: 'letter'`, and ADD
  `status` (HTTP status, null on network error) to the returned `{ ok, error, providerId }` so the loop
  can tell a 429 from a hard refusal (additive).
- Resend allows ~2 requests/s and its batch endpoint takes no attachments: send sequentially, 600 ms
  apart; on `status === 429` wait 1,500 ms and retry once.
- Analog route: the proposal send (`server.js` ~11932-12040): owner gate -> `isCrossSiteOrigin` ->
  `isJsonContentType` -> build the PDF BEFORE anything is sent -> send -> bookkeeping in try/catch
  after "the email HAS gone out" -> `recordActivity` -> `broadcastDataChanged()`.
- Refusals borrowed from the invoice send: `invoiceEmailAddressee(client, clients)` (billing master ->
  its receiving company; `MASTER_RECIPIENT_UNSET` sentence) and `resolveInvoiceRecipients` (empty ->
  `NO_INVOICE_RECIPIENT_REASON`). The two invoice-delivery flags (`invoiceNoEmail`,
  `platformInvoicingOptOut`) do NOT refuse a letter - they are about invoices; show them as pills.
- PDF: no generic text-to-PDF renderer exists; `drawProposal` in `lib/proposal-pdf.js` is most of one.
  Add `lib/letter-pdf.js`: firm header (logo via `decodeSvgLogo`, name, `firmDetailLines`), a date line
  (`longDate(firmToday())`), the addressee block (`client.name` + `mailingAddressLines(client)`),
  paragraphs split on blank lines with page breaks, the firm footer. Export
  `buildLetterPdf({ bodyText, client, firmSettings, dateLabel, title, compress = true })` and
  `letterPdfFilename(client, year)`.
- Documents in one place: `lib/letter-documents.js` `buildLetterDocuments({ template, client, contacts,
  firmSettings, now, buildPdf })` -> `{ email: { subject, html, text }, pdf, pdfFilename, pdfError,
  fill: { missing, unknown } }` - shared by preview and send so what she previews is what leaves. For a
  letter the PDF is NOT optional: a null `pdf` makes Send skip that client.
- Preview routes mirror `server.js` ~7545-7611 (owner-only, read-only, `Cache-Control: no-store`, the
  `NEVER_IN_A_PREVIEW` source-test pattern).
- Delivery webhook (`server.js` ~6240-6340) ignores unknown tags quietly; v1.5 may file delivery on the
  send row so "Last sent" can say Delivered / Bounced.

## 3. Placeholders - `lib/letter-template.js` (pure)

Syntax `{{name}}`, inner spaces allowed, case-insensitive, `[a-z0-9_]+`.

| key | value | required |
|---|---|---|
| `client_name` | `client.name` | yes |
| `contact_first_name` / `contact_name` | the primary contact = first linked contact (`lib/primary-contact.js`), falling back to `client.contactName` / `client.contact` | yes |
| `fee` | by billing mode: monthly rate / annual fee, via `currency` from `lib/invoice-lines.js`. NOT hourly: an hourly client is billed at each team member's rate (`client.hourlyRate` is only the legacy firm default), so its `fee` is blank and it is skipped | yes |
| `monthly_fee`, `hourly_rate`, `annual_fee` | the mode-specific figure, blank for other modes (`hourly_rate` is always blank) | yes |
| `client_address` | `mailingAddressLines(client).join('\n')` | no |
| `year`, `next_year`, `today` | the firm's calendar (`firmToday`, `longDate`) | no |
| `firm_name`, `firm_email`, `firm_phone` | firm settings | no |
| `sender_name` | the session user's name | no |

- A REQUIRED placeholder that resolves to blank goes into `missing`; the text leaves it blank (never
  prints `{{...}}` to a client); Preview lists it; Send SKIPS that client with a sentence. Non-required
  ones render blank silently.
- An UNKNOWN placeholder (`{{clientname}}`) is a warning on save and preview; Send refuses the whole
  batch (409 `unknown_placeholder`) before any email leaves.
- `letterTemplateHash(template)` = sha256 of `[subject, emailBody, letterBody]` - the snapshot key.
- Add `lib/letter-template.d.ts` (the page imports the placeholder list).

## 4. Storage - two new endpoint-managed tables (needs Alex's yes: it is DDL at start-up)

Precedents: `client_notes`, `account_credits` ("NO foreign keys - the bulk save deletes and re-inserts
clients, and the ledger must survive it"), `proposals`.

```sql
create table if not exists engagement_letters (
  id text primary key,                       -- 'default' in v1; more letters later
  name text not null default 'Engagement letter',
  subject text not null default '',
  email_body text not null default '',
  letter_body text not null default '',
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists engagement_letter_sends (
  id text primary key,
  letter_id text not null,
  client_id text not null,                   -- no FK, like account_credits
  template_hash text not null,
  firm_day text not null,                    -- 'YYYY-MM-DD' on the firm's calendar
  attempt int not null default 1,
  status text not null default 'sending' check (status in ('sending', 'sent', 'failed')),
  recipients jsonb not null default '[]'::jsonb,
  subject text not null default '',
  provider_id text,
  error text,
  delivery text,                             -- v1.5: delivered | bounced | complained | delayed
  created_by text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create unique index if not exists engagement_letter_sends_once_idx
  on engagement_letter_sends (letter_id, client_id, template_hash, firm_day, attempt)
  where status <> 'failed';
create index if not exists engagement_letter_sends_client_idx on engagement_letter_sends (client_id);
```

The partial unique index is the double-send guard (the `autopay_attempts` idea): the route INSERTS the
claim row first (`on conflict do nothing returning id`); no row back = already sent / being sent today
-> skipped. A failed attempt never blocks a retry. "Send again" claims `attempt = max + 1`.

Store methods (both backends; file backend keeps them in `tmp/auth-state.json` under
`engagementLetters` / `engagementLetterSends`, like `clientNotes`): `getEngagementLetter(id)`,
`saveEngagementLetter({ id, subject, emailBody, letterBody, updatedBy })` (trim; caps 200 / 20,000),
`listEngagementLetterSends({ letterId, clientId })`, `claimEngagementLetterSend(...)` ->
`{ claimed, send }`, `completeEngagementLetterSend(id, { ok, providerId, error })`,
`nextEngagementLetterAttempt(...)`.

Bulk save: neither table is in `BULK_SAVE_LOCK_TABLES` or the fingerprint, no FKs, nothing in the
workspace payload names them - a save cannot touch a template or a send. A client deleted by a save
leaves orphan send rows (harmless; the page shows "a client no longer on file").

Rejected: the template in `firm_settings` + history in notes/activity - the Settings page PUTs the
whole settings object back (a stale tab would roll her letter back), three field lists and a test to
touch, and per-client history would have no home or idempotency key.

## 5. Routes and the send flow (`server.js`, in the proposals block)

Guards as the proposal routes: `requireSession` -> owner only (403) -> writes: `isCrossSiteOrigin`
(403), `isJsonContentType` (415), end with `broadcastDataChanged()`.

1. `GET /api/letters/template` -> `{ template, hash, placeholders, warnings: { unknown }, sender: { from, replyTo } }`.
2. `PUT /api/letters/template` `{ subject, emailBody, letterBody }` -> save, activity
   `engagement_letter_saved`, broadcast, 200 (same shape). Unknown placeholders warn, do not refuse.
3. `GET /api/letters/preview?clientId=` -> uses the STORED template (preview = send by construction):
   `{ subject, html, text, to, recipientDetails, recipientNote, pdfAvailable, pdfFilename, missing,
   unknown, flags: { neverEmailed, billedOutside, inactive, billingMasterSub }, refusal }`.
4. `GET /api/letters/preview.pdf?clientId=` -> the PDF inline; 502 `pdf_failed` when null.
5. `GET /api/letters/sends` -> `{ sends }` newest first ("Last sent" = latest `sent` per client).
6. `POST /api/letters/send` `{ clientIds (1..50), templateHash, resendToday? }`:
   - 409 `letter_changed` "The letter changed since this page loaded. Nothing was sent. Reload and send
     again." when the hash differs; 409 `unknown_placeholder` "...is not a placeholder the app fills in.
     Nothing was sent."; 409 `letter_empty` "Write the email and the letter before sending."; 502
     `letter_send_failed` "Email is not configured yet (no sending address set)." - all BEFORE any client.
   - Per client, sequentially: not found -> "This client is no longer on file."; addressee refusal;
     no recipients; `missing` -> "{{fee}} has no value for <client> - set it on the client page, or take
     the placeholder out of the letter."; `pdf === null` -> "The PDF for <client> could not be built, so
     nothing was sent to them."; claim (`attempt = resendToday ? next : 1`), `claimed === false` ->
     "<client> was already sent this letter today. Use Send again to send it a second time."; send with
     `attachments: [{ filename, content: pdf }]`, `letterSendId`, `kind: 'letter'`; 429 -> wait and retry
     once; complete the row (try/catch; an ok send never flips to failed over bookkeeping); 600 ms gap.
   - After the loop: activity `engagement_letters_sent` "<ok> of <n>", broadcast, ALWAYS 200
     `{ results, sent, failed, skipped }` once the loop started (some mail has left).
   - No owner notification, no copy to anyone. Alex's rule.
- `src/lib/api.ts`: `fetchLetterTemplate`, `saveLetterTemplate`, `previewLetterRequest`,
  `letterPreviewPdfUrl`, `listLetterSendsRequest`, `sendLettersRequest`; types in `src/lib/types.ts`.
- Port `invoiceEmailAddressee` from `server.js` into `lib/invoice-recipients.js` (exported) so the page
  and the server use ONE addressee rule; switch the server to it in the same commit.

## 6. UI - `src/pages/LettersPage.tsx` + `src/components/LetterPreviewModal.tsx`

- Panel A "The letter": Subject, Email body (~8 rows; "This is the email. The letter rides along as a
  PDF."), Letter body (~18 rows; "Blank lines start a new paragraph. The firm letterhead, the date and
  the client's address are added above it."); placeholder chips under each box that insert the token at
  the caret; an unknown-placeholder warning line; Save + `SaveBadge` + "Last saved <date> by <name>".
  Preview and Send are disabled while the editor is dirty ("Save the letter to preview or send it.").
- Panel B "Send to": `ListSearch`, "Include inactive clients" (default off), "Select all shown" /
  "Clear", "<n> selected"; table: checkbox | Client (primary contact under it) | Email (addresses, or
  "No email on file" with the checkbox disabled) | Flags (pills: Invoices never emailed, Billed outside
  the app, Inactive, Billed through <master>, No receiving company set [disabled]) | Last sent (date +
  delivery word, or "Failed: ...", or "-") | Preview.
- Send: "Send to <n> clients" -> `window.confirm("Send the engagement letter to <n> clients? Each gets
  your email with the letter attached as a PDF. Replies go to <replyTo>.")` -> chunks of 10 ->
  progressive results (ok / "Already sent today" / failed with the server's sentence) -> "Send again to
  the <k> that failed" and a per-row "Send again anyway" (`resendToday: true`) -> a 409 `letter_changed`
  reloads the template and says so. Refetch sends after each chunk and on `dataRefreshCount`.
- `LetterPreviewModal`: copy of `InvoicePreviewModal` - "What <client> receives", tabs Email / PDF
  attachment, `iframe sandbox=""` with `PREVIEW_FRAME_PREFIX`, the PDF iframe, notes (To, Missing,
  flags, PDF failure), "Built by the same code as Send. Nothing is sent or saved from here."

## 7. Tests

- lib: `letter-template` (every placeholder from a fixture; spacing/case; `missing`; `unknown`; stable
  hash; `next_year`), `letter-pdf` (`compress: false`, text/name/date/firm present; no blank address
  lines), `letter-documents` (escaping, `pdfError` when `buildPdf` throws), notify tags + `status`.
- store, both backends: DDL text with no `references`, the partial index, upsert, claim with
  `on conflict ... do nothing` and `claimed: false` on zero rows; file: round trip in `auth-state.json`,
  a bulk save leaves template and sends intact, second claim refused, failed row re-claimable, next
  attempt = 2.
- route source tests (`pinOwnerRoutes` from `proposal-routes.test.ts`; `NEVER_IN_A_PREVIEW` for the
  preview block; claim BEFORE send; `letterTemplateHash(`, `firmToday(`, `kind: 'letter'`,
  `isCrossSiteOrigin`; and that no owner-notification or BCC call appears in the send block).
- jsdom page + modal tests (template renders, Save, warning, chip insert, dirty guard, picker rules,
  confirm text with the reply address, results rows, Last sent, `sandbox=""` + base target).
- Manifest: trim first (it sits 2 bytes under 205,000), then the nav map line and a `## Letters
  (owner only)` section (~900 bytes): what it is, placeholders, picker, Preview, Send (one send per client
  per letter per day unless Send again; replies to Brittany; nothing to anyone else), Last sent, what it
  does NOT do (no e-signature, no tracking of returned letters, no pulling from a proposal). Voice
  re-provision after deploy.

## 8. Commits (each verify-green and deployable alone)

1. Stage 1: the template + send-log tables and store methods (both backends), `lib/letter-template.js`
   + `.d.ts` + tests. No route, no UI; the DDL is inert.
2. Stage 2: `lib/letter-pdf.js`, `lib/letter-documents.js`, notify additions,
   `invoiceEmailAddressee` moved to `lib/invoice-recipients.js`, the six routes +
   `assembleLetterPreview`, api/types, route tests. Reachable only by URL.
3. Stage 3: the Letters page under Engagements (editor, picker, Send), nav + route + bounce list, tests.
4. Stage 4: the per-client Preview modal, Last sent, Send again actions, tests. (3 and 4 may merge.)
5. Manifest + voice + tracker note in Brittany's words.

## 9. Decisions and assumptions

Decided: reply-to = Brittany's mailbox (already `INVOICE_REPLY_TO`); From = the invoice sender; nothing
to Alex; owner-only; a `{{fee}}` placeholder by billing mode plus the mode-specific ones; one letter in
v1 (`id = 'default'`); one send per client per letter per firm day unless Send again; chunks of 10.

Assumptions Brittany may send back (noted on her ticket): the letterhead is the firm's (logo, name,
address) and the letter ends as typed - no drawn signature line (one line to add if wanted); "the
client's email" = the invoice rule (every active linked contact plus the client record); subs that bill
through a master are listed with a pill and selectable; active clients by default, inactive behind the
checkbox; `{{next_year}}` is "the coming year".

Needs Alex's yes before stage 1: the two new tables (DDL at start-up, no FKs, outside the bulk save).
