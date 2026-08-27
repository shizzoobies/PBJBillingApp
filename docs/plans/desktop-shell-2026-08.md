# Desktop shell (phase 2) — plan of record, NOT started

Written 2026-08-27. Phase 1 (PWA installability: manifest + icons, no service
worker) shipped separately and stands on its own. This document is the phase-2
decision package for a real Windows executable, to be built ONLY if Alex asks
for it after living with the PWA. If the PWA turns out to be enough, delete
this plan guilt-free.

## The decision that was already made

A desktop app is a **shell around `https://app.pbjsa.com`**, never a bundled
copy of the frontend. Bundling creates version skew against a server that
deploys multiple times a week; a shell pointed at prod is always exactly as
current as the web app and keeps the deploy story unchanged. This was decided
with phase 1 and is not to be re-litigated.

## Recommended stack: Tauri v2

- WebView2 host (preinstalled on Windows 11), ~5–10 MB installer, no bundled
  Node runtime, active auto-updater story.
- Electron is the fallback only if a need appears that a webview cannot do
  (background agents, local file processing). Nothing on the roadmap wants it.

## The one real design problem: magic-link sign-in

The app signs in via a 15-minute single-use link delivered by email. In a
desktop shell, the user reads mail in their browser/mail client — the link
opens the DEFAULT BROWSER, which signs in the browser, not the shell.

Options, in order of preference:

1. **Custom protocol (`pbjsa://signin?token=…`).** The email adds a second
   button ("Open in the desktop app") whose link uses the protocol; the shell
   registers the handler at install, receives the token, and completes
   sign-in inside its own webview. Server change: the magic-link email
   template gains the second link (only when the token was requested from the
   shell — send a `X-Desktop-Shell` header on the request-link call). Token
   stays single-use; whichever surface redeems it first wins.
2. **Code entry.** The email shows a short code; the shell has a "enter the
   code" box. Simpler to build, worse to use, and adds a new credential
   surface to test. Only if protocol registration proves flaky.
3. Rejected: long-lived tokens minted for the shell (new attack surface), and
   password-only in the shell (regresses the auth model).

TOTP is unaffected — it happens in-page after the link.

## Distribution and updates (the recurring cost — eyes open)

- **Code signing**: an unsigned installer trips SmartScreen ("Windows
  protected your PC") for every user. Options: an OV code-signing cert
  (~$100–300/yr, still shows reputation warnings at first), an EV cert /
  Azure Trusted Signing (~$10/mo, instant reputation), or accepting the
  SmartScreen click-through for a 4-person audience. Alex's call; Trusted
  Signing is the modern default.
- **Build**: GitHub Actions workflow (tauri-action) building on `windows-
  latest`, artifact attached to a GitHub Release. The repo already lives on
  GitHub; no new infra.
- **Updates**: because the shell loads the remote app, the shell itself
  almost never needs updating — only when the shell's own chrome changes.
  Tauri's updater pointed at GitHub Releases covers it. This is the payoff of
  the shell-not-bundle decision: the update treadmill is nearly idle.

## What the shell adds beyond the PWA (the actual reasons to build it)

- Tray icon with unread-notification badge (poll `/api/notifications` count).
- Native Windows toast notifications (the bell events, surfaced by the OS).
- Auto-start on login (optional, per-machine).
- A real installer to hand someone ("install this") instead of browser-menu
  instructions.

If none of these are being missed after a month on the PWA, phase 2 has no
reason to exist.

## Build shape (when/if approved)

1. `desktop/` directory in this repo (or a sibling repo — decide then; same
   repo keeps versioning honest), Tauri scaffold, window → prod URL, external
   links open in the default browser.
2. The `pbjsa://` protocol handler + the email template's second button
   (server change, both backends untouched — it's template-only).
3. CI build + signing + release workflow.
4. Tray/notifications/auto-start.
5. Manifest section + HANDOFF entry + tracker record, per house rules.

## OWNER-TODO if phase 2 is approved

- [ ] Decide signing: Azure Trusted Signing (recommended) vs OV cert vs
      unsigned click-through.
- [ ] Confirm the shell is for the owners only, or staff too (affects how
      much auth polish the protocol flow needs).
- [ ] Name the app window/installer ("PB&J Accounting"?).
