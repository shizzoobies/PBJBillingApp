# Feasibility: Microsoft Teams / Outlook → auto-create a checklist

_Prepared 2026-06-19 in response to Brittany + Allison's ask: "when we send notes
in Teams, could it auto-create a checklist?" (and the related Outlook idea)._

**Short answer:** Yes, it's doable, and the app side is small. The work and the
real decisions live on the Microsoft 365 side. This is a **feasibility write-up
for a decision — nothing is built yet.** Recommended path below.

---

## The one piece the app needs (common to every option)

Regardless of how the message leaves Teams/Outlook, it has to arrive at the app
as an authenticated HTTP call. So the app-side work is a single new endpoint:

- **`POST /api/integrations/checklist-intake`** — guarded by a shared secret
  header (same pattern we already use for the voice-tool webhooks:
  `x-voice-secret` → here `x-intake-secret`, stored as a Railway env var).
- Body (JSON): `{ clientName | clientId, title, items?: string[], dueDate?, assignee?, sourceNote? }`.
- It resolves the client (by id, or fuzzy-match on name), creates a checklist
  (reusing the existing `createChecklist` store path), de-dupes on a caller-supplied
  `externalId` so a retried/edited Teams message can't create duplicates, logs to
  `activity_log`, and returns the new checklist id.
- ~0.5–1 day of app work, fully testable on our side with `curl`.

Everything else is "how does a Teams/Outlook message turn into that POST."

---

## Options (ranked: least effort → most power)

### Option 1 — Power Automate flow → our endpoint  ⭐ recommended starting point
Microsoft **retired the old Teams "Incoming Webhook" connectors**; the modern
equivalent is **Power Automate (Workflows)**. A flow:
1. Trigger: "When a new channel message is added" (a dedicated "New work" channel),
   OR a **message action** ("…" on a message → "Send to PB&J") so it's deliberate,
   not every message.
2. Action: HTTP POST to `/api/integrations/checklist-intake` with the secret +
   the message text mapped into `title`/`items`/`sourceNote`.

- **Pros:** no Azure app registration, no hosting, no bot. Allison/Alex can build
  and tweak it in the Power Automate UI. Fastest to a working demo.
- **Cons / decisions:**
  - The **HTTP action is a *premium* Power Automate connector** — needs a Power
    Automate premium license (sometimes already in an M365 plan; **verify with
    your M365 admin / licensing**). Workaround if premium isn't available: use a
    free **custom connector** or the email path (Option 2).
  - How do we know **which client** a message is for? Options: one Teams channel
    per client; a `#ClientName` tag in the message; or pick from a dropdown in a
    message-action form. **This is the main thing to decide with Brittany.**
  - Free-text → structured items needs a convention (e.g. each line = a checklist
    item; first line = title).

### Option 2 — Outlook / email-to-checklist
Forward (or BCC) an email to a dedicated address → it becomes a checklist.
- **Pros:** dead-simple mental model; works from Outlook, phone, anywhere; no
  premium connector. Good if "notes" often start as emails.
- **Cons:** needs an **inbound email** path. Our current provider (Resend) is
  outbound-only, so this means either (a) a provider with inbound parse webhooks
  (Postmark/Mailgun/SendGrid inbound), or (b) Microsoft Graph mailbox
  subscription (an Azure app — more setup). Client identification still needs a
  convention (subject tag, or the address e.g. `client+acme@…`).

### Option 3 — Full Teams bot / message extension (Microsoft Graph + Azure AD)
A proper Teams app: adaptive-card forms, slash commands, read channel context.
- **Pros:** best UX (structured card: pick client, due date, assignee inline).
- **Cons:** **Azure AD app registration, admin consent, Bot Framework, hosting a
  bot endpoint, and ongoing maintenance.** ~1–2 weeks + upkeep. Overkill for v1.

---

## Recommendation

1. **Build the app-side intake endpoint** (Option-agnostic; ~1 day) behind a
   shared secret, with client-name resolution + dedupe + activity logging.
2. **Start with Option 1 (Power Automate + a deliberate message action)** if a
   premium connector is available; otherwise **Option 2 (email-to-checklist)**.
3. Defer Option 3 (full bot) unless the team wants the richer in-Teams card UX
   after living with v1.

## Decisions needed before building (for Alex + Brittany + Allison)
- [ ] **Trigger:** every message in a channel, or a deliberate "Send to PB&J"
      message action / keyword? (Strongly recommend deliberate — auto-creating a
      checklist from *every* note will create noise.)
- [ ] **Client identification:** channel-per-client, a `#tag`, or a pick-list?
- [ ] **M365 licensing:** is Power Automate **premium** (HTTP action) available?
      (Determines Option 1 vs 2.)
- [ ] **Who owns the M365/Azure setup** (the flow / inbound mail / app reg)?
- [ ] **Field mapping:** how should free text become title + items + due date +
      assignee? What's the default assignee/board column for intake checklists?
- [ ] **Outlook too, or Teams first?**

## Security notes (whichever path)
- Shared-secret header + (optionally) source IP allowlist; rate-limit the endpoint.
- It CREATES data, so it must be authenticated and never exposed unauthenticated.
- Resolve/validate the client server-side; reject unknown clients rather than
  guessing. Dedupe on `externalId` to survive retries/edits.
- Rotate the intake secret like any other (see the ElevenLabs key rotation note).

---

_Status: feasibility only. Next step is the decision checklist above; then the
~1-day intake endpoint, then the chosen M365 trigger._
