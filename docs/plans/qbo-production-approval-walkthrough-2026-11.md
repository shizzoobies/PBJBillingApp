# Getting the QuickBooks app approved for production: a walkthrough for Alex

Written 2026-11-20 for the week after Thanksgiving. It belongs with `docs/plans/qbo-time-sync-2026-11.md` (the build plan for featreq-e01549db, "Send employee time entries to QuickBooks Online for payroll"). This document is only about Intuit's approval: what it is, what has to exist before you can pass it, every screen you will click through, and what happens after. Intuit's pages were re-read on 2026-11-20; section 9 lists what could not be confirmed.

Nothing here is built or submitted yet.

## 1. The two-minute version

- **What "approved" means.** Your Intuit app has two sets of keys. The development keys you already have only talk to sandbox companies. Production keys talk to real companies, and Intuit hides them until you pass its **app assessment questionnaire**. Passing it is the approval. It applies to every app that connects to a real QuickBooks company, listed on the App Store or not. Ours will never be listed.
- **How long.** About 30 minutes for the App Details form and about 40 minutes for the questionnaire, once the facts are in hand. Intuit's first answer is automated and normally shows on the app's dashboard within about five minutes. A person only looks at it if the automated check rejects it.
- **What it costs.** Nothing. Every app sits in the free Builder tier. Creating time records is not metered at all; reading is metered, with 500,000 free reads a month, and we would use a few hundred. Over the cap Intuit blocks calls, it does not bill.
- **The catch.** The questionnaire makes you attest that connect, disconnect and reconnect were tested in a sandbox company, and that the app handles expired and revoked tokens. So the connection has to be BUILT and sandbox-tested before you submit. The questionnaire cannot be edited after you submit it. That is why the order in section 3 matters: you cannot simply get approved first and build later.
- **Your part is small.** I build and test; you click through two forms with the answers already prepared in section 6, copy two keys into the secrets file, and Brittany presses Connect once.

## 2. Where things stand today

| Piece | State |
|---|---|
| Intuit developer account, app, development keys, sandbox company | You have these set up |
| Brittany's answers | In: payroll is QuickBooks Online Payroll; she already types hours into QuickBooks and runs payroll from them, so hours our app adds the same way land in the same place; the form asks for no pay type; pay periods are two weeks, Sunday to Saturday, the current one started 2026-11-01; hourly people are Lisa and Allison |
| What we will send | Plain time records (QuickBooks calls them TimeActivity), one line per employee per day. No paid Intuit tier is needed for that |
| Connection code in our app | None yet. No sign-in-with-QuickBooks, no token storage |
| Terms and privacy pages | Drafted in `docs/plans/qbo-legal-pages-draft.md`, not published. You and Brittany need to read them; it is published under the firm's name |
| Payroll approvals in our app | Part 1 live; parts 2 and 3 (deny an entry, Approve week with a real lock, Mark paid) are being built now. The QuickBooks send is designed to take exactly "approved, locked weeks", so it comes after part 3 |

## 3. The order of everything, and who does what

| # | Step | Who | Needs first |
|---|---|---|---|
| 1 | Put the DEVELOPMENT Client ID and Client Secret in the secrets file (section 4) | You | nothing |
| 2 | Read the terms and privacy drafts with Brittany; mark what is not true | You and Brittany | nothing |
| 3 | Say yes or no to three small tables and four environment names (I will ask at that point, with the shapes) | You | nothing |
| 4 | Publish the terms and privacy pages | Me | step 2 |
| 5 | Build Connect, Disconnect, Reconnect, encrypted token storage, the Settings section; test all three against your sandbox company | Me | steps 1, 3 |
| 6 | Build employee matching, then preview and Send for a pay period; sandbox-test | Me | step 5, payroll approvals part 3 |
| 7 | Fill in App Details and the Settings tabs in the Intuit portal (section 5, parts A and B) | You | step 4 (so the page addresses exist) |
| 8 | Submit the questionnaire (section 5 part C, answers in section 6) | You | steps 5 and 6 tested |
| 9 | Copy the PRODUCTION keys into the secrets file; I upload them and restart | You, then me | step 8 approved |
| 10 | Brittany presses Connect in our app, signed in to QuickBooks as an admin | Brittany | step 9 |
| 11 | Send one test hour, look for it in Run payroll, delete it | Brittany, with us watching | step 10 |
| 12 | First real pay period | Brittany | step 11 |

Steps 1 to 3 are the only things you can usefully do the day you get back. Step 7 can be done any time after the pages are live; nothing is submitted until you press Submit on the questionnaire in step 8.

## 4. What to have in hand before you sit down

- **Your Intuit sign-in**, the account that owns the app.
- **The development keys.** In the portal: My Hub, App dashboard, open the app, Keys and credentials, Development. Copy the Client ID and Client Secret into `D:\PBJ Accounting Work\secrets\prod.env` under the names `QBO_CLIENT_ID` and `QBO_CLIENT_SECRET` with `QBO_ENVIRONMENT=sandbox` (I will confirm the exact names when I ask for the yes in step 3). Never paste them into chat or a commit.
- **The development redirect address.** Settings, Redirect URIs tab, Development, Add URI: `http://localhost:4173/api/qbo/callback`. Note: the redirect addresses live under **Settings**, not under Keys and credentials.
- **An app name Brittany will recognize** on the QuickBooks consent screen, for example "PB&J Time". Intuit's naming rules say not to put "QuickBooks" or "Intuit" in an app's name or logo.
- **A square logo** for the app (the firm's mark is fine).
- **One fact from Brittany:** which QuickBooks Online plan the firm's company is on (Simple Start, Essentials, Plus or Advanced). The questionnaire asks.
- **Honest yes or no** to: has the firm or this app ever had a data breach that required notifying people; any lawsuits, complaints or government requests about the app. For us these are "no" unless you know otherwise.

## 5. The portal, screen by screen

Everything is at developer.intuit.com. Sign in, then **My Hub**, **App dashboard**, and open the app.

### Part A. App Details (about 30 minutes; you can save and come back)

Left side: **Keys and credentials**, then **Production**, then **App Details**. Fill the sections in order:

| Field | What to enter |
|---|---|
| Contact email and details | Yours. Every message from Intuit about the app goes to the email on the account |
| End User License Agreement URL | `https://app.pbjsatime.com/legal/terms` |
| Privacy Policy URL | `https://app.pbjsatime.com/legal/privacy` |
| Host domain | `app.pbjsatime.com` |
| Launch URL | `https://app.pbjsatime.com/sign-in` (Intuit wants the app's sign-in page here for an app that does not use Intuit sign-in) |
| Disconnect URL | `https://app.pbjsatime.com/qbo/disconnected` (a small public page that says the company was disconnected and how to reconnect; I will build it) |
| Connect / reconnect URL | `https://app.pbjsatime.com/qbo/reconnect` (a page that works for whoever presses it, sends them to sign in and then to Settings; I will build it). This field became mandatory on 2026-02-24: QuickBooks itself shows customers a reconnect prompt 30 days before a connection expires and links here |
| Categories (up to four) | Time tracking, and Payroll if it is offered. I could not see the list without a sign-in; pick the closest |
| Regulated industries | None |
| Regions where the app is hosted | United States |

Intuit's own support has said placeholder addresses are tolerated for an app that will never be listed. We will use real pages anyway: they are short, they are true, and they are what Brittany's staff would see.

### Part B. The Settings tabs (10 minutes)

Left side: **Settings**. Walk every tab once:

- **Basic app info:** the app name and the logo.
- **App URLs:** the same addresses as part A, under Production.
- **App terms of service:** the two legal addresses.
- **App categories:** as above.
- **Geolocation:** United States (the IP address box is optional; leave it).
- **Redirect URIs:** Production, Add URI: `https://app.pbjsatime.com/api/qbo/callback`. It must be https, must match what the app sends character for character (capital letters and a trailing slash count), and may not carry anything after a question mark.
- **Accepted connections:** United States.
- **Scopes:** Accounting only (`com.intuit.quickbooks.accounting`). A scope can be added later but never removed, so do not tick anything else.

Also **My Hub**, **Account Profile**: check your own contact details are current.

### Part C. The questionnaire (about 40 minutes; do it in one sitting)

Left side: **Keys and credentials**, **Production**, **Compliance**, **Start Questionnaire**.

- Save often.
- **It cannot be edited after you submit.** Read the answer sheet in section 6 beside it and stop if a question does not match the sheet; send me the wording and I will tell you the true answer for our code.
- You are answering for the firm's app, so answer what is true. Where the sheet says "true answer", it is a fact only you or Brittany know.
- Press Submit only after I have told you the sandbox tests in step 5 and 6 of section 3 passed.

### Part D. The result

- You get a confirmation email. Within about five minutes the result shows on the app dashboard (Production Settings, App assessment questionnaire).
- **Approved:** nothing more to do. Go to part E.
- **Not approved, with reasons shown:** the dashboard lists what to change and lets you resubmit. Send me the reasons.
- **Rejected:** Intuit emails the account's address with what it needs, and a person reviews it. Intuit publishes no turnaround for that. To ask for help: a ticket at help.developer.intuit.com, product "App assessment questionnaire", category "Get help with questionnaire".

### Part E. Production keys

- **Keys and credentials**, **Production**: a **Show credentials** switch appears once the questionnaire is approved. Turn it on.
- Copy the production Client ID and Client Secret into `D:\PBJ Accounting Work\secrets\prod.env`, replacing the development pair, and set `QBO_ENVIRONMENT=production`. Tell me they are there; never send them to me.
- I upload them to Cloudflare the usual way and restart the app.
- Production keys only work with real companies and development keys only with sandbox ones, so from this moment the app talks to the real QuickBooks.

### Part F. Brittany connects

- In our app: Settings, QuickBooks, **Connect to QuickBooks**.
- She signs in to QuickBooks as an admin of the firm's company and approves the consent screen, which shows the app's name and "Accounting". (Intuit's pages do not say whether a non-admin can connect; an admin is the safe choice.)
- The Settings section then shows the company's name and "Connected".
- She matches Lisa and Allison to their QuickBooks employee records on the same screen.
- Then the one-hour test: send a single hour, find it under Time entries and in Run payroll without submitting anything, and delete it.

## 6. Answer sheet for the questionnaire

Intuit does not publish the questions. These come from two other companies' write-ups of the form (Codat and Apideck), so the wording you see may differ and there may be questions not listed here. The answers are for OUR app as designed; I will re-check each one against the finished code before you submit, and this sheet gets updated then.

| Section | Question, roughly | Our answer |
|---|---|---|
| App details | Confirm your profile, email, the legal addresses, host domain, launch and disconnect addresses, a category, regulated industries, hosting location | As in section 5 part A. Regulated industries: none |
| General | Any complaints, lawsuits or government requests | True answer (expected: none) |
| App information | Did you build it, or is it built on another platform or tool | We built it ourselves |
| App information | Where does the app call QuickBooks from | A hosted web app (our server, on Cloudflare) |
| App information | How does it use QuickBooks data | It creates time records for employees and reads the employee list to match people. It reads nothing else |
| App information | Private or public; how many QuickBooks customers | Private. One company, the firm's own |
| App information | Which QuickBooks users can use it | The firm's own owners, who are admins of its QuickBooks company |
| App information | Does it connect to other, non-Intuit services | Yes: card payments (Stripe), email delivery, e-signature. None of them receive QuickBooks data |
| Authorization | Did you test connect, disconnect and reconnect in a sandbox company | Yes (this must be true before you submit; Intuit is reported to reject a "no") |
| Authorization | How often do you refresh the access token | Only when it has expired, one refresh at a time |
| Authorization | Do you retry failed authorization requests | No blind retries. A refused token is never reused; the owner is asked to reconnect |
| Authorization | Do you ask customers to reconnect after an authorization error | Yes: the Settings section turns red and the owners get one notice with a Reconnect link |
| Authorization | Did you use the discovery document | Yes |
| Authorization | Do you handle an expired access token, an expired refresh token, "invalid_grant", and forged-request (CSRF) errors | Yes to all four |
| Authorization | Do you rely on the OAuth Playground or offline tools to get tokens | No |
| API usage | Which APIs | Accounting only |
| API usage | How many calls per customer | Very few: a few hundred a month |
| Accounting API | Which QuickBooks plans do your customers use | The firm's plan (ask Brittany) |
| Accounting API | Do you handle a customer gaining or losing plan features | Yes. We use only time records and the employee list |
| Accounting API | Multi-currency, sales tax | Not used |
| Accounting API | Webhooks, change data capture | Not used |
| Error handling | Did you test handling of API errors, including bad requests | Yes |
| Error handling | Do you capture Intuit's transaction id (`intuit_tid`) on errors | Yes, it is logged with every failed call |
| Error handling | Do you keep error logs you could share with Intuit support | Yes |
| Error handling | Can a customer contact support from inside the app | Yes: the Updates tracker and the firm's own contact |
| Security | Any past breach that required notifying people | True answer (expected: no) |
| Security | Does a team assess security problems | True answer: the developer reviews and patches; there is no separate security team |
| Security | Are the Client ID and Secret stored securely | Yes: in the host's secret store, never in the code |
| Security | Multi-factor sign-in, CAPTCHA and similar | True answers: owners sign in with two-factor; no CAPTCHA |
| Security | Is one customer's QuickBooks data shown to anyone else | No |

What the app must really do for those answers to be true (my build list, for reference): a `state` value checked on return; the sign-in code exchanged once; the newest refresh token saved from every response; one refresh at a time; tokens and the company id stored encrypted with a key kept apart from the data; Disconnect revokes at Intuit; a disconnect made from inside QuickBooks is noticed and shown; nothing from QuickBooks is logged; https everywhere.

## 7. After approval: things to know

- **The connection needs care, not attention.** The refresh token rolls over at least daily; the app keeps it alive on its own. If it ever breaks (someone disconnects inside QuickBooks, a password change), Settings turns red and Brittany presses Reconnect.
- **Five-year limit.** Since late 2025 every connection ends five years after it was made, no matter what. QuickBooks warns the customer 30 days ahead and the app will too.
- **If we change the app a lot** (for example adding the paid payroll permission), Intuit asks you to open a support ticket and retake the questionnaire.
- **Do not add the batch call later without checking the price.** Single creates are free; Intuit meters its batch endpoint.
- **A yearly security check** may apply. Intuit's pages disagree on whether it covers private apps; if an email arrives about it, forward it to me.

## 8. What can go wrong, and what to do

| What you see | Likely cause | Do |
|---|---|---|
| No Show credentials switch | The questionnaire is not approved yet, or was rejected | Check Production Settings, App assessment questionnaire, and your email |
| "Not approved" with reasons | An answer conflicts with a requirement (most often the sandbox test question, or the token-handling ones) | Send me the reasons; fix; resubmit |
| "Rejected" and an email | A person is reviewing | Answer the email with exactly what it asks; open a help ticket if it stalls |
| Connect fails with a redirect error | The redirect address in the portal and the one the app sends differ by a character | Compare them character by character under Settings, Redirect URIs, Production |
| Connect works in sandbox, fails in production | The wrong key pair is in the secrets file | Production keys with a real company only |
| The test hour does not show in Run payroll | QuickBooks is not picking API time for that employee's pay schedule | Stop. Do not run payroll from it. This is the one thing Intuit does not promise in writing; we re-plan |

## 9. What could not be confirmed

- The exact wording and number of questions (Intuit does not publish them).
- The category list and the exact label of the reconnect field (they are only visible signed in).
- Whether the person who presses Connect must be a QuickBooks admin.
- Whether Intuit's yearly security assessment applies to a private app.
- Whether Intuit enforces its Connect-button and naming rules on apps that are not listed.
- Intuit's turnaround when a person reviews a rejected questionnaire.
- Still open from the build plan: that a time record created through the API feeds Run payroll for this company (Brittany's answer says hand-typed entries do, and an API entry is the same record; the one-hour test in part F proves it).

## 10. Sources

Read on Intuit's own pages on 2026-11-20: "Publish your app" and its platform, technical and security requirement pages; "App settings"; "Set redirect URI"; "Get client ID and client secret"; the OAuth 2.0 guide and FAQ; "REST API features"; "Minor versions"; "Limits and throttles"; the App Partner Program FAQ (updated 2026-10-02); help articles "App assessment and compliance FAQ" (2026-10-29), "Platform service fees" (2025-10-27) and "API classification for the Intuit App Partner Program" (2026-10-29); the Intuit developer blog post on the refresh token policy (2025-11-12, updated 2026-02-24); an Intuit support reply about internal-use apps (2025-07-31). The questionnaire's questions come from Codat's and Apideck's public write-ups, not from Intuit.
