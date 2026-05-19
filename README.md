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

## Testing & verification

The app has an automated safety net (Vitest). Run it before pushing and after every deploy.

**Before every push — `npm run verify`:**

```bash
npm run verify
```

`verify` runs lint, then the production build (`tsc -b && vite build`), then the test suite (`npm test`). It must be green before you push. The build alone is **not** enough — `npm run build` only type-checks and bundles, it never actually runs the app, so a runtime crash on boot can pass the build and still ship a blank screen. The test suite is what catches that.

**The tests:**

```bash
npm test          # run all tests once (CI mode)
npm run test:watch  # re-run on file changes while developing
```

The most important test is the **App-boot smoke test** (`src/__tests__/app-boot.test.tsx`): it mounts the real `<App>` against a mocked backend in both the logged-out and logged-in states and fails if the app throws or renders blank on boot. There are also focused unit tests for the riskiest pure logic (TOTP two-factor, productivity date ranges, recurring-checklist materialization).

**After a Railway deploy — `npm run health-check <url>`:**

```bash
npm run health-check https://pbjbillingapp-production.up.railway.app
```

The health check confirms the deployed server is up, that `/health` returns 200, that the root HTML serves a `#root` mount node plus a JS bundle reference, and that the bundle itself loads. It catches "build broke / assets 404 / server down". It does **not** execute the app's JavaScript — the App-boot smoke test above is what guards against runtime crashes, so make sure `npm run verify` passed before deploying.

## Environment

- `PORT`: port for the production web server. Railway injects this automatically.
- `DATABASE_URL`: when present, the server stores shared app data in Postgres.
- `APP_PUBLIC_URL`: public origin of the deployed app (e.g. `https://pbjbillingapp-production.up.railway.app`). Used to build the sign-in link URL embedded in authentication emails. When unset, the server falls back to constructing the URL from the incoming request host.
- `OWNER_EMAIL`: **recommended for first-time bootstrap.** The real inbox for Brittany Ferguson (the primary Owner account). On every server start, the server idempotently updates her email to this value. Without it, her account keeps a `@pbj.local` placeholder and **she will never receive a sign-in link.**
- `ADMIN_EMAIL`: **recommended for multi-owner setup.** Creates (or updates) a second Owner account for Alex Anderson using this email address. Useful when a second person needs independent owner-level sign-in. Without it, this second account is not created.
- `RESEND_API_KEY`: **required for sign-in.** When set, sign-in links and notification emails are sent via the [Resend](https://resend.com) HTTP API. The app technically still runs without it, but **no one can sign in until it's configured.**
- `EMAIL_FROM`: **required for sign-in.** The `From:` address used for sign-in and notification emails (e.g. `notifications@pbj.local`). Without it, no sign-in emails go out and **no one can sign in.**

If `DATABASE_URL` is not set, the server falls back to `tmp/app-data.json` so local development still uses the API layer without needing a database immediately.

Starter Postgres schema notes live in [db/schema.sql](<D:/PBJ Accounting Work/AP For Time Stuff/db/schema.sql:1>).

## Authentication

Authentication is fully email-gated. There is no shared password and there are no copyable persistent magic-link URLs.

- The two role-segmented entry pages are `/staff` (bookkeeper sign-in) and `/owner` (owner sign-in). The owner bookmarks `/owner`; bookkeepers should never see it. The site root and the legacy `/login` URL both redirect to `/staff` so the owner page stays unadvertised.
- Each sign-in attempt POSTs the user's email to `/api/auth/request-link`. If the email is registered and matches the requested role, the server emails a one-time link to `${APP_PUBLIC_URL}/verify/<token>`. Links expire in 15 minutes and are single-use.
- The endpoint always returns the same generic ok response whether the email exists or not, so it can't be used to enumerate registered users. There's a per-email rate limit (3 / 5 minutes).
- Visiting `/verify/<token>` consumes the token, sets a 30-day session cookie (`HttpOnly; Secure; SameSite=Lax`; `Secure` is added only in production), and redirects to the dashboard. The cookie expiry slides forward on every authenticated request.
- The owner-only Team page lists each member's active sessions with device / IP / last-seen, and supports per-device "Sign out this device" plus "Sign out everywhere" actions.
- Bookkeeper invites are email-driven: when the owner invites someone, the server emails them a sign-in link directly. The owner never sees a token or URL. A "Resend sign-in link" button is available on each member's card.

> **Migration note:** when this build is first deployed, any sessions in memory on the previous server are invalidated. Everyone (including the owner) must visit `/staff` or `/owner` and request a fresh sign-in link.

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
