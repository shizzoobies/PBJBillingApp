# PBJBillingApp — start here

**Read [`docs/HANDOFF.md`](docs/HANDOFF.md) before your first change.** It covers
the people involved, the ship ritual, production diagnostics, current state, and
the open questions. The rules below are the ones that break things if missed.

## Cardinal rules

1. **`db/store.js` has TWO backends** — Postgres (`DATABASE_URL` set) and a JSON
   file. Any persisted change must touch **both**. Tests run the file backend;
   production is Postgres, so a Postgres-only bug passes CI silently.
2. **`npm run verify`** (eslint + `tsc -b && vite build` + vitest) must be green
   before every push.
3. **Update `docs/capability-manifest.md`** for user-visible changes — it's the AI
   assistant's knowledge base — and **re-provision the voice agent after deploying**
   when it changes (`node scripts/provision-voice-agent.mjs`).
4. **Deploy is part of "done":** push to `main` → poll Railway → `/health` 200.
5. **Never write to the production database without explicit approval.** Read-only
   queries and rolled-back (`BEGIN` … `ROLLBACK`) write tests are fine and are the
   most reliable way to validate a change here — see HANDOFF §4.

## Commit trailer

```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

## One habit that matters

Feature requests come from the end client (Brittany) relayed by the user. When an
item comes back as **"not approved" / "still not working"**, it has usually already
shipped once — the gap is almost always **interpretation**, not code. Re-read what
they're actually looking at, or reproduce the logic against production data, before
rewriting anything.
