# Employee time to QuickBooks Online for payroll (featreq-e01549db)

Plan written 2026-11-12. Nothing in this document is built. It records what was researched, what is still unknown, the order of work, and who has to do what. Sources for the Intuit facts are listed at the end; every Intuit claim below was read on Intuit's own pages on 2026-11-12 unless it says "unconfirmed".

## 1. What Brittany asked for

> Employee time recorded in our app should be imported into QBO as employee time, so the accountant and bookkeepers can use it for payroll without re-entering it by hand. Each time entry should arrive in QBO matched to the correct employee, with the correct date and hours.

Her ticket leaves three things open and says to confirm before building screens: where the controls live, automatic or by a button, and how often.

## 2. The one thing that decides the design

**Intuit does not say anywhere that time created through the API shows up in the hours column of Run payroll.** That is the whole point of the request, so it has to be proven before anything is built.

What Intuit does say:

- The QuickBooks Online Accounting API has a `TimeActivity` record (employee, date, hours and minutes, optional customer, service item, description). Creating one is free and needs only the ordinary accounting permission.
- Intuit's own "track time" guide splits companies in two. For a company **on QuickBooks Payroll**, the time is created with a pay type attached (`PayrollItemRef`). The pay type's id comes from a separate payroll query that Intuit only opens to apps on the **Silver partner tier ($300 a month)** or higher. For a company **not** on QuickBooks Payroll, a plain time record is enough.
- The Run payroll help article says approved time appears for "your team [that] uses QuickBooks Time", and the time-entries article says "once you approve time, you can use it for payroll." Neither mentions time that arrives through the API.
- Payroll does not exist in Intuit's sandbox. The payroll leg can only be tested in a real company.

So there are three possible worlds, and a ten-minute test in Brittany's own QuickBooks tells us which one we are in **before any code or any Intuit approval**:

| What the test shows | What we build | Monthly cost |
|---|---|---|
| A time entry typed by hand in QuickBooks (Time, then Time entries), approved, shows up in Run payroll for that employee | Plain `TimeActivity` records. The simple path. | $0 (Builder tier) |
| It shows up only when a pay type is chosen on the entry | `TimeActivity` with the pay type attached. First try reading the pay type id back off one hand-made entry per employee (free, unconfirmed that Intuit returns it); if that does not work, the Silver tier. | $0, or $300 |
| It does not show up at all (her payroll only reads QuickBooks Time, or she runs payroll somewhere else) | A different target: the QuickBooks Time API, or the other payroll provider's import, or a file she uploads. Re-plan. | depends |

**The test (Brittany or a bookkeeper, in the firm's real QuickBooks, nothing is submitted):**

1. In QuickBooks go to Time, then Time entries, and add one hour for one hourly employee on a day in the current pay period. Note whether the form asks for a pay type.
2. Approve it there if QuickBooks offers an Approve button.
3. Open Payroll, Run payroll, pick that employee's pay schedule, and look at the hours for that employee. Do not submit. Cancel out.
4. Delete the test hour.

An entry typed there by hand is the same record the API creates, so what she sees is what our entries would do.

## 3. Questions for Brittany (filed on the ticket as "Needs your answer")

1. Where is payroll run today: QuickBooks Online Payroll, or something else (Gusto, ADP, a payroll service)? If QuickBooks, does the firm also use QuickBooks Time?
2. The ten-minute test above, and what she saw.
3. Who is paid from hours (which employees), and what is the pay period (weekly, every two weeks, twice a month) and the day it ends?
4. A button she presses for a pay period after checking the hours, or automatic? (Recommended: a button with a preview first; automatic later, once two or three periods have matched.)

Held for after those answers: whether QuickBooks should get one line per employee per day or every single entry, whether the client should ride along on each line, and whether only approved time goes.

## 4. What Alex has to do at Intuit (the approval path)

Production access for an app that is never listed on the QuickBooks App Store still needs Intuit's app questionnaire. Nothing here costs money. Steps 1 to 3 can be done today; step 6 needs the integration built and tested in the sandbox first, because the questionnaire asks whether connect, disconnect and reconnect were tested there.

1. **Sign in at developer.intuit.com** with the Intuit account that should own the app (an account Alex controls; Brittany does not need a developer account - she only presses Connect later as the admin of her QuickBooks company).
2. **Create an app** in a workspace: name it something Brittany will recognize on the consent screen ("PB&J Time" or the firm's app name), platform QuickBooks Online, permission **Accounting** (`com.intuit.quickbooks.accounting`) only.
3. **Development keys and redirect addresses.** On Keys and credentials, Development: add the redirect address `http://localhost:4173/api/qbo/callback`. Put the development Client ID and Client Secret in the secrets file outside git (names in section 6), never in chat. Create a sandbox company from the same page.
4. *(me)* Build and sandbox-test stages 1 to 4 below.
5. **Production app details** (Keys and credentials, Production). Intuit asks for all of these; the values to enter:
   - Host domain: `app.pbjsatime.com`
   - Launch URL: `https://app.pbjsatime.com/settings`
   - Connect / reconnect URL: `https://app.pbjsatime.com/settings?qbo=connect`
   - Disconnect URL: `https://app.pbjsatime.com/qbo/disconnected`
   - Redirect address: `https://app.pbjsatime.com/api/qbo/callback`
   - End-user license agreement URL and Privacy policy URL: **the app has neither page today.** Two short public pages have to be written and shipped first (`/legal/terms`, `/legal/privacy`). I will draft the text; Alex and Brittany approve it, since it is published under the firm's name.
   - Categories: Time tracking / Payroll. Regulated industries: none. Hosting region: United States.
6. **The questionnaire** (Production, Compliance, Start questionnaire). I will prepare the answers from the built code: private app, one company, tokens encrypted at rest, client secret in the host's secret store, two-factor sign-in for owners, connect / disconnect / reconnect tested in sandbox, `invalid_grant` and expired-token handling, `intuit_tid` logged on errors, no webhooks, no data shown to anyone outside the firm. Alex submits it. Intuit publishes no review time for unlisted apps.
7. **Production keys.** When the questionnaire is approved the Show credentials switch appears. The production Client ID and Secret go into the Cloudflare secrets the usual way (`cloudflare/env-names.js`, the secrets file, `scripts/cf/secrets-upload.mjs`, `scripts/cf/restart.mjs`).
8. **Brittany connects** from Settings in the app, signing in to QuickBooks as an admin of the firm's company.
9. Only if the test in section 2 lands in the middle row and the free read-back does not work: subscribe the app to the Silver tier and add the `payroll.compensation.read` permission, then reconnect.

Costs: the Builder tier is free. Creating and updating records is never metered. Reading is metered with 500,000 free reads a month; this integration would use a few hundred.

## 5. Design (for the top row of the table; revisited after the test)

**Where it lives.** A new "QuickBooks" section on the owner's Settings page (there is no integrations section today): Connect / Disconnect, the connected company's name, the state of the connection, and the employee matching table. The sending itself sits beside the payroll hours report on the Reports page, because that is where she already checks the hours for a pay period.

**Connection.** Standard OAuth 2.0 authorization-code flow with a `state` value, on two owner-only routes (`/api/qbo/connect`, `/api/qbo/callback`) plus disconnect (which revokes at Intuit). Tokens:

- Access token lasts one hour. The refresh token lasts 100 days rolling, its value changes about every 24 hours, and two refreshes at once break the connection (`invalid_grant`). So: one refresh at a time (a row lock in Postgres plus an in-process guard), always store the newest value, and a daily keep-alive from the existing periodic jobs so a quiet month never lets it lapse.
- Refresh tokens now also have a hard five-year end; the response says when. Store it and warn the owners well ahead.
- Stored **encrypted** (AES-256-GCM, the same construction as `lib/totp.js`, with its own key - not the TOTP key, which is deliberately empty in production) in a **new table of its own**. Not in `firm_settings`: that whole row is sent to every signed-in browser, staff included.
- A broken connection (revoked in QuickBooks, password change, lapse) turns the Settings section red and sends the owners one notice with a Reconnect link. Nothing is retried blindly.

**Matching employees.** Read the QuickBooks employee list, suggest matches by email then name, and let the owner confirm each one. Stored as QuickBooks employee id per user in a small table. An unmatched person is never sent and is named in the preview.

**What is sent.** The same numbers as the payroll hours report, from the same functions (`lib/payroll-cost.js`): tracked hours with the duplicate slices of a full-mode group split left out, and each row's hours rounded to two decimals before adding (the costing-hours rule). QuickBooks takes whole hours and whole minutes, so each line is rounded to the minute; the preview shows the app's total and the QuickBooks total side by side so a rounding difference is seen before it is sent. One line per employee per day is the recommendation (it is what payroll needs and it keeps client names out of QuickBooks); per-entry lines are possible if she wants the detail.

**How it is sent.** For a pay period she picks: a preview (per employee: hours, anything unmatched, anything changed since the last send), then Send. Each line carries a request id so a retry can never create a duplicate. A ledger table records what was sent (employee, day, minutes, the QuickBooks record id and its version) so that sending the same period again updates changed days, removes days that no longer have time, and leaves the rest alone. The ledger is its own table: the owner's bulk save wipes and rewrites `time_entries`, so nothing may be stored there.

**After payroll is run.** Owners can edit or delete time in this app at any point, even in a locked month. A period that has been sent and then paid must not be silently rewritten in QuickBooks. The period gets a "sent" stamp; a later change to time inside it shows as "changed since sent" in the preview and is only pushed when she presses Send again.

**New things that need a yes from Alex when we get there** (asked at that point, not now): three tables (`qbo_connection`, `qbo_employee_map`, `qbo_time_sync`), four environment names (`QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_ENVIRONMENT`, `QBO_TOKEN_ENC_KEY`), and the two public legal pages.

## 6. Order of work

| Stage | What | Needs first |
|---|---|---|
| 0 | Brittany's answers and the ten-minute test | nothing |
| 0 | Alex creates the Intuit app, development keys, sandbox company | nothing |
| 1 | Terms and privacy pages (drafted, approved, shipped) | Alex's and Brittany's read of the text |
| 2 | Connect / disconnect / reconnect, encrypted tokens, keep-alive, Settings section. Sandbox-tested. | development keys, a yes on the tables |
| 3 | Employee matching | stage 2 |
| 4 | Preview and Send for a pay period, the ledger, re-send. Sandbox-tested. | stage 3, Brittany's answers |
| 5 | Questionnaire, production keys, Brittany connects, one test hour sent and checked in Run payroll, then deleted | stage 4, Intuit's approval |
| 6 | First real pay period, sent by her with both of us watching the numbers | stage 5 |
| 7 | Optional: automatic sending | two or three clean periods |

## 7. Facts about this app that shape the build

- Time entries: `time_entries` (`db/store.js:7516`), minutes exact to the second, date is the worker's local day as sent by the browser. Approval is `pending / approved / rejected`; timer entries are approved automatically when created, and the payroll report counts every entry whatever its approval. Whether QuickBooks should get unapproved time is a question for her.
- There is no pay period stored anywhere; the report's weekly / biweekly toggle lives only on the screen. A sent period has to store its own start and end.
- No OAuth, Intuit or token code exists. `lib/qbo-export.js` is an invoice file for import, unrelated.
- Secrets reach production only through `cloudflare/env-names.js` and the secrets upload script; a test fails the build when a `process.env` name is not listed.
- Scheduled work runs through `lib/periodic-jobs.js` (a 15-minute tick, one container instance, an in-process busy guard).
- The app serves no public terms or privacy page today.

## 8. Sources

Intuit, read 2026-11-12: TimeActivity reference; Employee reference; "Track time" Workforce use cases; Workforce "Get started"; OAuth 2.0 guide and FAQ; redirect URI rules; "Publish your app" (production keys and questionnaire); App Partner Program FAQ (updated 2026-10-02); limits and throttles; webhooks and change data capture references; general release notes (May and June 2026 entries); help articles "Create paychecks" (updated 2026-10-21), "Time entries" (2026-08-05) and "Timesheets syncing" (2026-08-03). The questionnaire's question areas come from a third-party transcription (Codat's docs), not from Intuit. Unconfirmed: that a plain API time record feeds Run payroll; that QuickBooks returns the pay type id on a hand-made entry; review time for an unlisted app; whether TimeActivity is accepted by the batch endpoint.
