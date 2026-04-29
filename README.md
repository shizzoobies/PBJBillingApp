# PB&J Strategic Accounting App

Prototype web app for PB&J Strategic Accounting's internal time tracking, employee checklist, client billing, invoice, and subscription-plan workflows.

## Current Prototype

- React + TypeScript + Vite web app.
- Owner and employee demo views.
- Employee-scoped time entries, clients, and checklists.
- Employee/client assignment controls for owner setup.
- Billing-month selector for period-based summaries and invoice drafts.
- Owner-only client billing controls, subscription plans, billing queue, and printable invoice draft.
- Local browser storage for prototype data, so changes persist during review on the same browser.

## Local Development

```bash
npm install
npm run dev
```

Useful checks:

```bash
npm run lint
npm run build
npm start
```

## Intended Deployment Path

1. Push this project to GitHub.
2. Deploy the Vite app on Railway as the first hosted review environment.
3. Point a password-protected Cloudflare subdomain at Railway.
4. Replace local storage with a Railway Postgres database.
5. Add real authentication and role-based authorization before live client or employee data is entered.

## Backend Work Still Needed

- Real login, sessions, and role permissions.
- Employee/client assignment tables.
- Durable time entry, checklist, subscription plan, invoice, and payment records.
- Invoice numbering, PDF/email delivery, audit history, and billing-period controls.
- Cloudflare Access or application-level password protection for the first private subdomain.

## Railway Note

This rebuild now includes a tiny production static server in [server.js](<D:/PBJ Accounting Work/AP For Time Stuff/server.js:1>), so Railway can build with `npm run build` and start with `npm start`.
