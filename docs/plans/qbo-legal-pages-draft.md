# Draft: Terms of Use and Privacy Policy pages (needed for Intuit production keys)

Drafted 2026-11-12 for featreq-e01549db. **Not published. Not legal advice.** Intuit will not issue production keys without a public terms (end-user license agreement) URL and a public privacy policy URL, and the app has neither page today. These drafts describe what the app actually does, in plain words. Alex and Brittany should read them, change anything that is not true of how the firm works, and have the firm's attorney look at them if they want that comfort. Once approved, each becomes a small public page: `https://app.pbjsatime.com/legal/terms` and `https://app.pbjsatime.com/legal/privacy`.

Things to settle before publishing are marked **[CONFIRM]**.

---

## Terms of Use

**PB&J Strategic Accounting - Time and Billing App**
Last updated: **[date of publishing]**

**1. What this is.** This app is the private time, task and billing system of PB&J Strategic Accounting ("the firm"). It is used by the firm's owners and staff. It is not offered to the public.

**2. Who may use it.** Only people the firm has invited. Each person signs in with their own account and must not share it. The firm can remove access at any time.

**3. Acceptable use.** Use the app for the firm's work only. Do not try to reach data you were not given access to, interfere with the app, or use another person's account.

**4. The firm's data.** Everything entered into the app (time, tasks, client records, invoices) belongs to the firm. Staff use it on the firm's behalf.

**5. Connection to QuickBooks Online.** A firm owner may connect the app to the firm's own QuickBooks Online company. When connected, the app sends the firm's employee time (employee, date, hours) to that company and reads the firm's employee list so each person's time lands on the right employee. The connection can be turned off at any time, from the app's Settings or from QuickBooks. QuickBooks is a service of Intuit Inc.; the firm's use of QuickBooks is governed by Intuit's own terms. This app is not made, endorsed or supported by Intuit.

**6. Clients who receive links.** Clients of the firm may receive links from the app to view or pay an invoice, answer a questionnaire, or sign a letter. Those pages are provided for that one purpose. Payment is processed by Stripe and signing by eSignatures.io under their own terms.

**7. No warranty.** The app is provided as it is. The firm and its developer work to keep it accurate and available but do not promise that it will be uninterrupted or free of errors. Figures in the app should be reviewed before they are relied on for payroll, billing or tax purposes.

**8. Limits.** To the extent the law allows, the firm and its developer are not liable for indirect or consequential losses arising from use of the app.

**9. Changes.** These terms may be updated. The date above shows the latest version.

**10. Contact.** **[CONFIRM: firm contact email and mailing address]**

---

## Privacy Policy

**PB&J Strategic Accounting - Time and Billing App**
Last updated: **[date of publishing]**

**1. Who we are.** This app is run for PB&J Strategic Accounting ("the firm", "we"). This policy covers the app at app.pbjsatime.com. **[CONFIRM: firm legal name and address]**

**2. What the app holds.**

- *About the firm's staff:* name, work email, role, sign-in details (passwords are stored only as a one-way hash; two-factor secrets where turned on), time entries, task activity, and pay-related rates entered by the owners.
- *About the firm's clients:* business and contact names, email addresses, mailing addresses, the services the firm provides to them, time and tasks recorded for them, invoices, and payment status. Card and bank details are entered on Stripe's pages and are **not** stored in the app.
- *Technical records:* sign-in sessions, an activity log of who did what, and email delivery status.

**3. What we use it for.** To run the firm: tracking time, managing recurring work, billing clients, collecting payment, preparing payroll hours, and keeping a record of what was done.

**4. QuickBooks Online.** If an owner connects the app to the firm's QuickBooks Online company:

- The app **sends** employee time (employee, date, hours, and a short description where the owner chooses) to that company.
- The app **reads** the company's name and its employee list (name, email, QuickBooks id, active or not) to match each staff member to the right QuickBooks employee.
- The app stores the access keys QuickBooks issues, **encrypted**, and uses them only for the two things above.
- The app does **not** read the company's bank feeds, transactions, customer payments or tax filings, and does not share QuickBooks data with anyone outside the firm.
- Disconnecting, in the app's Settings or in QuickBooks, revokes those keys. Time already sent stays in QuickBooks, where the firm controls it.

**5. Who else handles the data.** Only service providers the app needs to work, each for its own job: Cloudflare (hosting), Neon (the database), Resend (sending email), Stripe (payments), eSignatures.io (signing), Anthropic (the owner's in-app assistant, which is given summaries the owner asks about), ElevenLabs (the owner's voice assistant, if used), and Intuit (QuickBooks, when connected). **[CONFIRM: this list against what is switched on at publishing.]** We do not sell personal information and do not use it for advertising.

**6. Where it is kept and how it is protected.** Data is stored in the United States. Connections are encrypted (HTTPS). Access needs a personal sign-in; owners use two-factor sign-in. Secrets and access keys are kept in the host's secret store or encrypted in the database. Backups are taken nightly and kept **[CONFIRM: retention period]**.

**7. How long we keep it.** For as long as the firm needs it for its business and its record-keeping duties. Staff accounts are deactivated when someone leaves; their past time stays as part of the firm's records.

**8. Your choices.** Staff and clients can ask the firm to see or correct the information held about them, or to delete it where the firm is not required to keep it, by writing to the contact below.

**9. If something goes wrong.** If we learn of a breach affecting personal information, we will tell the people affected and any authority we are required to tell, without undue delay.

**10. Changes.** We will post any change here and update the date above.

**11. Contact.** **[CONFIRM: firm contact email and mailing address]**

---

## Notes for the build (not part of the published text)

- Two server-rendered public pages, no sign-in, same plain styling as the pay page. Text lives in one module so both the pages and a test read the same words.
- The capability manifest gets a line saying these pages exist and where.
- The list of service providers in section 5 must be kept true: add it to the ship checklist for any new third-party service.
