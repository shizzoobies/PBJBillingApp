# PB&J Strategic Accounting App

Prototype web app for PB&J Strategic Accounting's internal time tracking, employee checklist, client billing, invoice, and subscription-plan workflows.

## Current Prototype

- React + TypeScript + Vite web app.
- Owner and employee demo views.
- Employee-scoped time entries, clients, and checklists.
- Employee/client assignment controls for owner setup.
- Billing-month selector for period-based summaries and invoice drafts.
- Owner-only client billing controls, subscription plans, billing queue, and printable invoice draft.
- API-backed prototype persistence through the local Node server.

## Local Development

```bash
npm install
npm run dev
```

`npm run dev` now starts both the Vite frontend and the local Node API server so `/api/app-data` works during development.

Useful checks:

```bash
npm run lint
npm run build
npm start
```

## Environment

- `PORT`: port for the production web server. Railway injects this automatically.
- `DATABASE_URL`: when present, the server stores shared app data in Postgres.
- `AUTH_DEMO_PASSWORD`: optional override for the temporary seeded login password. Defaults to `pbj-demo`.
- `APP_PUBLIC_URL`: public origin of the deployed app (e.g. `https://pbjbillingapp-production.up.railway.app`). Used to build magic-link URLs surfaced on the owner-only Team page. When unset, the server falls back to constructing the URL from the incoming request host.

If `DATABASE_URL` is not set, the server falls back to `tmp/app-data.json` so local development still uses the API layer without needing a database immediately.

Starter Postgres schema notes live in [db/schema.sql](<D:/PBJ Accounting Work/AP For Time Stuff/db/schema.sql:1>).

## Prototype Login

- Seeded accounts: Patrice Bell (Owner), Avery Johnson (Senior Bookkeeper), Jordan Ellis (Bookkeeper)
- Default temporary password: `pbj-demo`
- Session routes now live on the Node server, and `/api/app-data` requires an authenticated session

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

The repo also includes [railway.json](<D:/PBJ Accounting Work/AP For Time Stuff/railway.json:1>) plus a `/health` endpoint for Railway health checks.
