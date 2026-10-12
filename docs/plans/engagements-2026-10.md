# Engagements - from a Won proposal to a signed client (Brittany, 2026-10-10)

Tracker: a new feature item will be filed for Brittany ("Engagements: proposal to signed engagement to client"); send-backs and leftovers go on it. Related: `featreq-5e195707` (Letters, the send-back on bold + multiple letters is `feat/letters-v2`), `featreq-9c29491a` (Letters leftovers), `featreq-79b6d974` / `featreq-98527217` (the closed engagement-to-billing umbrella).

Code maps for every builder (git-ignored, this machine): `.superpowers/sdd/engagements-maps/{proposals,letters,client-creation,questionnaire}.md`. Read the ones your stage touches before writing a line.

## The ask (Brittany's email, 2026-10-10, "App questions/workflow")

> Questionnaire - sent or filled collects information that then goes to a Prospect Proposal. Proposal: if denied or dead moves to closed/lost; if accepted moves to Won and an engagement is created to send. Engagements pull from the proposal: an Original whose sections are triggered by the proposal (Services monthly/quarterly/annually, Clean-up, Consulting, Payroll, Sales Tax); Amendments (add-on items - what I created for 1099s; generic amended wording plus what I add if services are added); a Superseded option for an extreme change in services. The client is created once an engagement is signed, pulling from the proposal: client name, contacts & address, rates and services, estimated hours by team, plans/services/packages, plan checklist (make sure a required checklist exists), recurring reimbursements, a retainer invoice initiated at signing and added to the review for sending. Filled in later: assigned team, statement dates, client notes, checklist detail, expenses & reimbursement, invoice customization, credit on account. The contact is created once an engagement is signed. Plans when created should be matched to a standard checklist to create a repeating one when the client is created. A package pulls plans into a group and allows adjusting the checklist required. Questionnaire: I thought it would ask questions based off what they said they needed - a future is fine.

## Decisions (Alex, 2026-10-11)

- **Client creation moves from Accept to Mark signed** (stage 3). A Won proposal with an unsigned engagement has no client yet.
- **Signed = a "Mark as signed" button** (date, optional note), owner-only. No e-signature, no upload. The signed copy comes back to Brittany's mailbox as a reply.
- **Retainer at signing = a draft retainer invoice** for one month's fee by default (the proposal's monthly total), editable on the engagement before sending; zero or blank = no retainer. It lands in "To review" in the month run.
- Everything in Letters' "Rules that bind" still binds: **nothing to Alex's mailbox**, reply-to Brittany, owner-only, the team-address guard, the source test that enforces it.
- Build order: stage 1 (outcome labels), stage 2 (engagement record + editor + send; Accept still creates the client), stage 3 (signing creates the client), stage 4 (client-page card, amendments from Letters, superseding), stage 5 (adaptive questionnaire). One deploy per stage; two independent review rounds on stages 2 and 3; rolled-back production trial for the new tables (DDL at start-up, like Letters).
- American English; the manifest is 204,961 bytes - trim before every addition.

## Shape in one paragraph

An **engagement** is one letter to one party with a signed state: kind `original` | `amendment` | `superseding`, status `draft` | `sent` | `signed` | `superseded` | `void`. Accept on a proposal flips it to Won and creates a draft Original assembled from an owner-edited **section library** (each section says which proposal service groups or lines trigger it), with the proposal's figures as `{{placeholders}}` and `**bold**` as in Letters. Brittany edits, sets the retainer amount, package and plans, previews, and sends it to the prospect as a PDF (reply-to her, tagged `engagement_id` so delivery lands on the row). **Mark as signed** creates the client and contact from the proposal, applies plans and package, copies each plan's standard checklist bundle, adds software as recurring expenses, sets estimated hours by role, and issues the retainer draft. Letters becomes the library of amendment letters; a bulk send logs an Amendment engagement per client. An upsell proposal can amend or supersede the current Original.

## Stage 1 - proposal outcomes read Won and Closed/Lost (small; `feat/proposal-outcomes`)

No schema change; the DB enum stays `accepted` / `declined`.
- `src/lib/proposals.ts` PROPOSAL_STATUS_LABELS: accepted -> "Won", declined -> "Closed/Lost". The list filter, the status pill, Activity ("Won on <date>", "Closed as lost: <note>") and the editor header follow the labels. `proposalTitle`/sorting unchanged.
- ProposalEditorPage: the Decline button reads **Close as lost**; the note becomes optional (a dead prospect has no note). Server: `POST /:id/decline` accepts an empty/missing note (cap 2000 stays). `declineProposalRequest` sends `{note: ''}` when blank.
- Accept keeps its name but the confirm says "...and this proposal is marked Won."
- Tests: proposals-page.test.tsx label expectations, proposal-routes.test.ts (decline block still `setProposalStatus(current.id, 'declined', {`), a unit test on the labels. Manifest: the Proposals paragraph (~line 274) says the outcomes are Won and Closed/Lost, Close as lost takes an optional note.

## Stage 2 - the engagement record, the section library, the editor, the send (`feat/engagements-core`; split into 2A lib, 2B store+routes, 2C UI)

### 2A - lib (pure, no store, no clock; browser-safe where noted) - lane E

**`lib/engagement-sections.js`** (+ `.d.ts`, + `.test.mjs`)
- `DEFAULT_ENGAGEMENT_SECTIONS`: the seed library, an array of `{key, title, body, trigger, sortOrder}` in this order:
  - `email` (title "Email", `trigger.always = true`, `role: 'email'`): the default email body - a short cover note with `{{contact_first_name}}`, "attached is our engagement letter", "reply with the signed copy", `{{sender_name}}`.
  - `intro` (always, role `letter`): addressed to `{{contact_name}}` / `{{client_name}}`, thanks, purpose of the letter, effective `{{start_month}}`.
  - `services_monthly` (trigger.groups = Monthly, Reconciliations, AR, AP, Reports, Additional reports): what the recurring bookkeeping/accounting covers; `{{services_monthly}}` list; `{{monthly_fee}}`.
  - `services_annual` (groups Annual and one-time): `{{services_annual}}`, `{{annual_fee}}`, `{{one_time_fee}}`.
  - `cleanup` (groups Clean-up): `{{cleanup_months}}`, `{{cleanup_fee}}`.
  - `payroll` (groups Payroll): payroll processing scope, client responsibilities.
  - `sales_tax` (groups Sales tax): filings scope, `{{sales_tax_states}}`.
  - `consulting` (trigger.serviceIds = the catalog "Client call" line id from SEED_ROWS; find it): advisory/consulting hours.
  - `fees` (always): the fee summary paragraph: `{{fee}}`, `{{software_fee}}` when any, `{{payment_terms}}`, `{{retainer_sentence}}` (empty when no retainer).
  - `terms` (always): responsibilities, term and termination, confidentiality - generic professional wording she will edit.
  - `closing` (always): "Please sign and return..." + a signature block rendered as plain lines: "Agreed and accepted:", "Signature: ______________________", "Name: {{contact_name}}", "Date: ______________", and the firm's line "{{sender_name}}, {{firm_name}}".
  Wording: plain, professional, American English, no legal boilerplate longer than a paragraph each, every section safe to send unedited. Titles become `**Title**` lines in the assembled letter (the laneB bold rule).
- `trigger` shape: `{ always?: boolean, groups?: string[], serviceIds?: string[] }`.
- `sanitizeEngagementSection(input)` -> a clean section or null (key `^[a-z0-9_]+$` max 40, title max 120, body max 20000, trigger arrays of strings max 20 each, sortOrder int). `sanitizeEngagementSections(list)` dedupes keys, keeps order by sortOrder.
- `triggeredSections(sections, snapshotLines)`: returns the letter-role sections (not `email`) whose trigger fires: `always`, or any line with `line.group` in `groups`, or `line.serviceId` in `serviceIds`. Lines considered: every snapshot line (a `flag`ged line still means the service was chosen). Sorted by sortOrder.

**`lib/engagement-assemble.js`** (+ tests)
- `assembleEngagement({sections, snapshot, kind, party, firmName})` -> `{subject, emailBody, letterBody, sectionKeys}`:
  - subject: `original` -> "Engagement letter - {{client_name}}"; `superseding` -> "Updated engagement letter - {{client_name}}"; `amendment` -> "Engagement amendment - {{client_name}}" (placeholders left for the filler).
  - emailBody = the `email` section body.
  - letterBody = triggered sections joined by a blank line, each as `**Title**\n\nbody`. The `intro` section carries no title line.
  - sectionKeys = the keys used, in order.

**`lib/engagement-values.js`** (+ tests; browser-safe like letter-template.js)
- `ENGAGEMENT_PLACEHOLDERS`: additions to the placeholder list, each `{key, label, description, required, scope: 'engagement'}`: `one_time_fee`, `cleanup_fee`, `cleanup_months`, `software_fee`, `services_monthly` (a line-per-service list "- Name"), `services_annual`, `sales_tax_states`, `payment_terms`, `retainer_amount`, `retainer_sentence` ("A retainer of $X is due with this letter." or ''), `start_month` ("November 2026" = the month after today, or the engagement's start month when set), `hours_bookkeeper`, `hours_accountant`, `hours_cfo` (estimated monthly hours by role, one decimal).
- `lib/letter-template.js`: `letterPlaceholders` entries gain `scope: 'both'` (default); export `placeholdersFor(scope)` returning the list for `'letter'` (both only) or `'engagement'` (both + engagement). `fillTemplate` unchanged. Letters page keeps showing `placeholdersFor('letter')` - an engagement-only key typed into a Letters template is "unknown" there, as today.
- `engagementValues({engagement, snapshot, party, client, contacts, firmSettings, now, senderName, paymentTerms})` -> the full values map: the letter values for the party (client_name = party.company || client.name, contact from party.contactName / client contacts, client_address from party address lines or mailingAddressLines(client)), fee/monthly_fee/annual_fee from `snapshot.totals` (monthly -> "$X per month"; annual total -> "$X per year"; fee = monthly when > 0 else annual), the new keys from the snapshot lines and totals, retainer from `engagement.retainerAmount`, hours from `snapshot.totals.hoursByRole` (controller -> cfo). Money via the same formatter Letters uses. Blank when the figure is 0.
- `engagementTemplateHash({subject, emailBody, letterBody})` = `letterTemplateHash` (re-export).

**`lib/proposal-pricing.js`** (additive; every existing test must pass unchanged)
- Each priced line gains `role` (string|null: the catalog row's role for formula/payroll/sales-tax kinds, null for flat/software) and `hours` (number|null: count x factor x multiplier for formula kind, the hours basis for payroll/sales-tax kinds when the formula is hours-based, null otherwise). Totals gain `hoursByRole: {bookkeeper, accountant, controller}` summing `hours` over MONTHLY_GROUPS lines only (two decimals). `proposalSnapshot()` carries them. Older stored snapshots without these keys read as zeros wherever consumed (never throw).
- Unit tests: a known catalog row produces the expected hours; totals by role; flat and software lines have null hours; snapshot shape.

**`lib/engagement-documents.js`** (+ tests): `buildEngagementDocuments({engagement, values, firmSettings, buildPdf})` -> same shape as `buildLetterDocuments` ({email:{subject,html,text}, pdf, pdfFilename, pdfError, fill}); reuses `fillTemplate`, the bold renderer from laneB's `lib/letter-documents.js` (import the exported helpers; if laneB has not merged when you start, write against the names in `.superpowers/sdd/engagements-maps/letters.md` plus "renderBoldHtml(text) / stripBold(text)" and reconcile at merge), and `buildLetterPdf` with a pseudo-client `{name: party.company || client.name, addressLine1.., city, state, postalCode}` and `dateLabel = values.today`, `title = subject`. Filename `Engagement-Letter-<slug>-<year>.pdf` via `letterPdfFilename`.

### 2B - store + routes + webhook (lane F)

**Tables (db/store.js, `create ... if not exists` at start-up, no FKs, outside the bulk save, outside the fingerprint, never deleted from - exactly like `engagement_letters`):**
```
engagement_sections (
  id text primary key,                 -- 'esec-xxxxxxxx'
  key text not null unique,
  title text not null default '',
  body text not null default '',
  trigger jsonb not null default '{}',
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)
engagements (
  id text primary key,                 -- 'eng-xxxxxxxx'
  kind text not null check (kind in ('original','amendment','superseding')),
  status text not null default 'draft' check (status in ('draft','sent','signed','superseded','void')),
  proposal_id text,                    -- original / superseding: the Won proposal; amendment: null or the upsell proposal
  client_id text,                      -- null until signed for a prospect original; set for upsells and amendments
  letter_id text,                      -- the saved Letters template an amendment came from (stage 4)
  supersedes_id text,                  -- superseding: the original it replaces (stage 4)
  party jsonb not null default '{}',   -- {company, contactName, title, email, phone, addressLine1, addressLine2, city, state, postalCode}
  subject text not null default '',
  email_body text not null default '',
  letter_body text not null default '',
  section_keys jsonb not null default '[]',
  figures jsonb not null default '{}', -- snapshot at creation: {totals, lines:[{serviceId, group, name, amount, cadence, role, hours}], hoursByRole, paymentTerms}
  retainer_amount numeric,             -- null/0 = none
  package_id text,
  plan_ids text[] not null default '{}',
  template_hash text not null default '',
  email_log jsonb not null default '[]',  -- [{kind:'send'|'delivery', at, to, providerId, ok, error, event}]
  sent_at timestamptz, signed_at timestamptz, signed_by text, signed_note text,
  voided_at timestamptz,
  created_by text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
)
create index if not exists engagements_client_idx on engagements (client_id);
create index if not exists engagements_proposal_idx on engagements (proposal_id);
```
File backend: `authState.engagementSections` and `authState.engagements` arrays, one `_mutateEngagementFile(mutate)` queue slot (copy `_mutateLetterFile`). Mappers snake->camel like `mapEngagementLetterRow`.

**Store methods (pool + file branch each; caps: subject 200, bodies 20000; `EngagementStateError(message, reason)`):**
- `listEngagementSections()` -> seeded on first read when empty (insert `DEFAULT_ENGAGEMENT_SECTIONS` with ids), ordered by sort_order. `saveEngagementSections(list, {updatedBy})` -> sanitize, upsert by key, deactivate keys not in the list (never delete), return the list.
- `listEngagements({clientId?, proposalId?, status?})` newest first (Postgres cap 500). `getEngagement(id)`.
- `createEngagementFromProposal(proposal, {kind: 'original', createdBy, sections})` -> builds `party` from `proposal.prospect` (or from the linked client when `proposal.clientId` is set: name/contact/email/phone/address), `figures` from `proposal.pricingSnapshot` (+ `hoursByRole` recomputed via `priceProposal` on the current catalog when the snapshot lacks it; money always from the stored snapshot), `retainerAmount = figures.totals.monthly || null`, `packageId/planIds` null/[] (stage 3 reads them at signing), assembled subject/bodies via `assembleEngagement`, `templateHash`. Returns the row.
- `updateEngagement(id, {subject, emailBody, letterBody, retainerAmount, packageId, planIds, party})` -> refused unless status is `draft` or `sent` (editing a sent letter is allowed - a re-send makes a new email_log entry); recomputes `template_hash`; `updated_at`.
- `reassembleEngagement(id, {sections})` -> draft only; rebuilds subject/bodies/section_keys from the stored figures.
- `markEngagementSent(id, {to, providerId, ok, error, at})` -> appends to email_log; on ok sets status `sent` (from draft) and `sent_at` (first time only).
- `appendEngagementEmailEvent(id, entry)` idempotent on (kind, event, providerId) like `appendProposalEmailEvent` - the webhook path.
- `signEngagement(id, {signedOn, note, userId})` -> status must be `sent` (or `draft` with a confirm flag `allowUnsent: true` for a letter she handed over in person); sets `signed`, `signed_at` (the firm day given, as an instant at firm noon), `signed_by`, `signed_note`. Stage 2: no side effects. Stage 3 adds them inside the same store call.
- `voidEngagement(id, {userId})` -> from draft/sent only.
- `acceptProposal` (store.js:13040): after the existing work succeeds, call `createEngagementFromProposal` with the Won proposal and return `engagementId` in the result (stage 2 keeps the client creation). The route returns it; the UI navigates to the engagement.

**Routes (server.js, next to the letters block; same guards: requireSession + owner 403; writes isCrossSiteOrigin 403 + isJsonContentType 415 + broadcastDataChanged; above the /api/ catch-all):**
- `GET /api/engagement-sections` -> `{sections}`; `PUT /api/engagement-sections` body `{sections}` -> saved list (400 `sections_invalid`).
- `GET /api/engagements?clientId=&proposalId=&status=` -> `{engagements}` (list view: no bodies).
- `GET /api/engagements/:id` -> `{engagement, placeholders: placeholdersFor('engagement'), warnings, hash, sender:{from, replyTo}}`.
- `PATCH /api/engagements/:id` -> `updateEngagement`; 409 `engagement_refused` with the reason.
- `POST /api/engagements/:id/reassemble` -> draft only.
- `GET /api/engagements/:id/preview` -> `{subject, html, text, to, missing, missingNote, unknown, retired, pdfAvailable, pdfFilename, refusal}`; `GET /api/engagements/:id/preview.pdf` inline (502 `pdf_failed`).
- `POST /api/engagements/:id/send` body `{templateHash, to?}`: refusals in order 400 `engagement_invalid`, 409 `engagement_changed` (hash), 409 `unknown_placeholder`, 409 `engagement_empty`, 409 `engagement_refused` (status signed/void/superseded), 409 `team_address` (the recipient resolves to a team member's address - `withoutTeamAddresses`), 409 `no_recipient`, 502 `engagement_send_failed` (no RESEND env). Recipient = `to` when given (one address, pattern-checked, not a team address) else `party.email`. Sends through `sendInvoiceEmail({to, subject, html, text, attachments:[{filename, content: pdf}], fromName, engagementId: id, kind: 'engagement'})` - add the `engagement_id` tag in `invoiceEmailTags`; reply_to stays `INVOICE_REPLY_TO || OWNER_EMAIL`; NO cc/bcc, NO owner notification carrying the document (the Letters source test's FORBIDDEN list is extended to the engagement routes + `lib/engagement-send.js`). Then `markEngagementSent`. Activity `engagement_sent`. Returns `{engagement, ok, error}`.
- `POST /api/engagements/:id/sign` body `{signedOn: 'YYYY-MM-DD', note?, allowUnsent?}` -> `signEngagement`; activity `engagement_signed`. (Stage 3 adds the client creation and returns `{engagement, clientId, createdClient, retainerInvoiceId}`.)
- `POST /api/engagements/:id/void`.
- Webhook: a Resend event carrying the `engagement_id` tag -> `appendEngagementEmailEvent` (mirror `recordProposalDelivery`, server.js:1893; dispatch near 6398); a bounce/complaint notifies owners with the ordinary `invoice_email_bounced` event (no document attached - that is fine under the rule).
- `lib/engagement-send.js`: `assembleEngagementPreview(context, engagement)` and `sendEngagement(context, engagement, {to, templateHash, userId}, deps)` - the one place that touches the mail transport, mirroring `lib/letter-send.js` so the source test can pin it.
- Source tests (new `src/__tests__/engagement-routes.test.ts`, modeled on letter-routes.test.ts): owner gate, origin + JSON guards, route ordering above the catch-all, refusal order, the FORBIDDEN list over the engagement block + lib/engagement-send.js, reply-to rule, `withoutTeamAddresses` in the preview, DDL pins (no FKs, not in write(), not in the lock list, never deleted from) in db/store-staleness.test.mjs for both tables, file-backend lifecycle tests (create from a proposal, edit, hash, send marks sent, sign, void, reassemble, sections seed once, save deactivates missing keys), Postgres statement tests.

### 2C - UI (after 2A, 2B and feat/letters-v2 have merged; one lane)

- `src/components/navItems.ts`: `ENGAGEMENTS = {to:'/engagements', label:'Engagements', icon: FileSignature or Handshake, ownerOnly:true}`; section Engagements = [PROPOSALS, ENGAGEMENTS, LETTERS]; flat list order the same; `/engagements` routes (list + `/engagements/:id`) inside `<OwnerOnly>`, bounce list; the old `/engagements -> /proposals` redirect is REMOVED (letters-nav.test.ts updated). Letters' icon changes if Engagements takes FileSignature.
- `src/pages/EngagementsPage.tsx`: list with status filter (Draft, Sent, Signed, Superseded, Void, All), search by party; columns Party, Kind, Status, Monthly fee, Sent, Signed; row -> editor. Header: none (engagements are born from proposals and, in stage 4, from the client page). An empty state explains where they come from.
- `src/pages/EngagementEditorPage.tsx`: header (party, kind pill, status pill, "From proposal <company>" link, "Client" link when client_id set), Save/dirty like LettersPage; subject input + two textareas with the laneB **B** button + chips from `placeholdersFor('engagement')`; a "Sections" panel listing the section keys used with **Re-assemble from the proposal** (confirm: discards edits); "Signing details" card: Retainer amount (money input, default shown, "none" when blank), Package select, Plans picker (reuse the ProposalEditorPage popover); Preview (reuse LetterPreviewModal against the engagement endpoints - parameterize the modal by a fetcher); **Send** (shows the address, editable once, confirm names the party and the reply-to); **Mark as signed** (date picker default today, note, confirm; disabled until sent unless "This letter was signed in person"); **Void**; Activity list from email_log + signed/void stamps.
- Settings page: a new owner section **Engagement sections** (`SettingsPage.tsx`, after Proposal pricing): the list with title, trigger (checkbox group of PROPOSAL_GROUPS + "Always" + a service line picker), body textarea with B + chips, reorder, add, deactivate; Save all. Warn when a body has unknown placeholders.
- Proposal editor: Accept's confirm says an engagement letter will be drafted; after Accept navigate to `/engagements/:id`. The Won proposal shows "Open the engagement".
- api.ts wrappers, types.ts (`Engagement`, `EngagementSection`, `EngagementStatus`, `EngagementKind`, preview/send/sign results), jsdom tests for the list, the editor (save, hash, send confirm, sign), the settings section.
- Manifest: new `## Engagements (owner only)` section after Letters, and the sidebar lines (18, 20, 24). Trim first.

## Stage 3 - Mark as signed creates the client (`feat/engagements-signing`; two review rounds; rolled-back prod trial through the batched client insert is NOT needed - createClient is row-wise - but trial the sign transaction read-only)

- `acceptProposal`: for a prospect, NO client creation; status -> accepted; engagement created with `client_id null`; `linkProposalClient` is NOT called. For an existing client (upsell) the client_id is carried onto the engagement and nothing is written to the client at Accept (fee/plans/software move to signing). The route no longer returns `createdClient`; UI copy follows. proposal-routes.test.ts pins change accordingly (the `createClient` absent pin stays true).
- `signEngagement` side effects, in one Postgres transaction where the existing helpers allow (`createClient` already runs one; follow `_acceptWithSoftware` for the rest and roll back app-data on the file backend):
  1. No client yet: `createClient` with exactly what Accept used to pass (name, contact, email, phone, address, lifecycleStage 'onboarding', billingMode 'subscription', monthlyRate = figures.totals.monthly, paymentTerms, newPrimaryContact) PLUS `estimatedBookkeeperHours/AccountantHours/CfoHours` from `figures.hoursByRole` (controller -> cfo, one decimal) and annual billing when the proposal has only annual fees (billingMode 'annual', annualRate, annualBillingMonth = the current month). Then `linkProposalClient` (CAS) and set `engagements.client_id`.
  2. Existing client (upsell, kind amendment): `setClientMonthlyRate` when figures.totals.monthly > 0 and the client bills monthly; plans unioned; software added (`addSoftware` semantics = always on a signed engagement).
  3. Plans and package: `_setClientPlanIds(union)` then `applyPackageToClient` when `package_id`.
  4. **Plan checklist bundles**: for every plan now on the client, copy each `plan.templateIds` blueprint not already on the client (`copyTemplateToClient`, matched on `sourceTemplateId`, same as the package path) - this is "plans matched to a standard checklist to create a repeating one when the client is created". Report `clonedTemplateIds`.
  5. Software lines -> recurring expenses (`_acceptWithSoftware` logic lifted into a helper callable from signing; the proposal status flip is no longer part of it).
  6. Retainer: when `retainer_amount > 0` and the client is not opted out: `createRetainerInvoice({clientId, amount, note: 'Retainer - engagement letter signed <date>', actorUserId})` as a DRAFT (recordOnly false). Opted out -> skip and say so in the result.
  7. Activity: `client_created`, `engagement_signed`, `package_applied` (existing), `retainer_issued`.
  8. The onboarding case (`startOnboarding`) is NOT opened automatically (the client arrives in 'onboarding' as today). Note it as a question for Brittany on the ticket.
- Result `{engagement, clientId, createdClient, clonedTemplateIds, retainerInvoiceId, skipped: [...]}`; the UI shows a summary and links "Open the client" and "Open the retainer".
- The retainer route comment at server.js:7809 is updated: signing an engagement is now the signing event; the manual button remains for clients without one.
- Tests: file-backend sign creates the client with every field (compare with the Accept test at 25255), hours by role land on the client, plan bundles copied once (idempotent on re-sign attempt - sign is one-shot anyway), retainer draft appears in the month's "To review", opted-out skip, upsell path, lost CAS race retires the client as Accept did; Postgres statement order test; proposal-routes pins; month-run test that a draft retainer kind row is listed.
- Manifest: Accept no longer creates the client; signing does; what signing pulls in.

## Stage 4 - amendments, the client-page card, superseding (`feat/engagements-amend`)

- Client page (Billing tab, before Retainer): **Engagements** card: the Original (status, sent/signed dates, Open), amendments and superseding letters, "New amendment" -> picks one of the saved Letters (feat/letters-v2 list) -> `POST /api/engagements` `{kind:'amendment', clientId, letterId}` creates a draft from that letter (party from the client, figures from the client's current fee) -> editor. Staff see nothing.
- Letters bulk send: each successful send ALSO creates an engagement row `{kind:'amendment', clientId, letterId, status:'sent', party, subject, bodies, email_log:[send]}` (same transaction slot as the send-log row where possible; the send log stays the double-send guard). "Mark as signed" per client from the card. The Letters page's "Last sent" is unchanged.
- Superseding: an upsell proposal's Accept asks "Amend the current engagement" or "Supersede it" when the client has a signed Original; superseding creates kind `superseding` with `supersedes_id`; signing it SETS (not unions) plan_ids and package from the engagement, sets the fee, and marks the old Original `superseded`. Amendment keeps today's union semantics.
- Engagements list filter by kind. Manifest.

## Stage 5 - adaptive questionnaire (`feat/questionnaire-steps`)

- The sent questionnaire becomes two steps on the same token, still no script: step 1 = About you + Services you are interested in (+ software, behind); POST saves the partial answers (link mode gains a `partial_answers` save that does not consume the one-shot submit) and renders step 2 = only the count questions whose inputKey the chosen groups need (a `GROUP_INPUTS` map: Monthly -> transactions; AR -> invoicesPerWeekAR; AP -> invoicesPerWeekAP; Payroll -> employees; Sales tax -> states; Reports/Additional reports -> reportsNeeded, clientCallHours; Annual and one-time -> forms; Clean-up -> cleanupMonths) + Anything else; step 2 POST = the real submit. Back link to step 1 re-renders with saved values.
- `answersToProposalSeed` turns the ticked groups into `selections`: for each group, the catalog's active lines in that group at the Basic tier (or the single line), so the draft is priced on arrival ("Not yet priced" only when a rate is unset). The Estimate tab still lets her remove lines.
- Tests for both steps, the partial save not consuming the submit, the selections mapping, and the manifest sentence.

## Review and ship rules for every stage

- Builder commits on the lane branch with the session trailer; never pushes. Orchestrator runs an independent reviewer (Opus for stages 2-4, Sonnet for 1 and 5), one or two fix rounds, then rebases the lane onto main, `npm run verify`, and hands Alex `bash scripts/prod/ship.sh <hash>` (the deploy is his click in this mode). Voice agent re-provisioned after a manifest change (`node scripts/provision-voice-agent.mjs`).
- Stage 2B and 3 need Alex's yes for the DDL at start-up (the same shape Letters got a yes for on 10-08) - ask at the ship step, not before.
- The tracker item is filed when stage 2 ships, in Brittany's words, with the stage-3 and later notes appended as they ship.
