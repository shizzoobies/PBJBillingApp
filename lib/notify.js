/**
 * Phase 5: Single notification abstraction.
 *
 * Always persists to the notifications collection (drives the in-app bell).
 * If RESEND_API_KEY + EMAIL_FROM env vars are set, also sends an email via
 * the Resend HTTP API using built-in fetch. Email failures are logged but
 * never thrown — in-app notifications are the source of truth.
 *
 * Reusable for future "monthly invoice ready to send" cron (event:
 * 'invoice_ready' is wired but unused in v1).
 */

const KNOWN_EVENTS = new Set([
  'task_assigned',
  'case_advanced',
  'case_completed',
  'invoice_ready',
  'time_entry_manual',
  'waiting_cleared',
])

function defaultSubject(event, message) {
  if (event === 'task_assigned') {
    return message?.startsWith('New task:') ? message : `New task: ${message ?? ''}`.trim()
  }
  if (event === 'case_advanced') {
    return `Workflow advanced: ${message ?? ''}`.trim()
  }
  if (event === 'case_completed') {
    return `Workflow completed: ${message ?? ''}`.trim()
  }
  if (event === 'invoice_ready') {
    return `Invoice ready to send: ${message ?? ''}`.trim()
  }
  if (event === 'time_entry_manual') {
    return 'Manual time entry needs approval'
  }
  if (event === 'waiting_cleared') {
    return 'Ready to continue — a task you were waiting on is done'
  }
  return message ?? 'PB&J Strategic Accounting notification'
}

function buildEmailHtml({ message, deepLink }) {
  const safeMessage = String(message ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const linkLine = deepLink
    ? `<p style="margin:16px 0 0;"><a href="${deepLink}" style="color:#7d2a4d;font-weight:600;text-decoration:none;">Open it</a></p>`
    : ''
  return `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1f1d1a;background:#f6f5f1;padding:24px;">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:24px 28px;box-shadow:0 8px 32px rgba(31,29,26,0.06);">
    <p style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#7d2a4d;margin:0 0 8px;font-weight:700;">PB&amp;J Strategic Accounting</p>
    <p style="margin:0;font-size:15px;line-height:1.5;color:#1f1d1a;">${safeMessage}</p>
    ${linkLine}
  </div>
</body></html>`
}

async function sendResendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.EMAIL_FROM
  if (!apiKey || !from || !to) {
    return false
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to, subject, html }),
    })

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      console.error(`[notify] Resend API ${response.status}: ${body}`)
      return false
    }
    return true
  } catch (error) {
    console.error('[notify] Resend send failed:', error?.message || error)
    return false
  }
}

/**
 * Send an email-gated sign-in link. Best-effort; silent no-op if
 * RESEND_API_KEY / EMAIL_FROM are unset. Used by /api/auth/request-link.
 *
 * params: { to, firmName, signInUrl }
 */
export async function sendLoginLinkEmail({ to, firmName, signInUrl }) {
  if (!to || !signInUrl) return
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) return

  const safeFirm = String(firmName || 'PB&J Strategic Accounting')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  const subject = `Sign in to ${safeFirm}`
  const html = `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1f1d1a;background:#f6f5f1;padding:24px;">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;box-shadow:0 8px 32px rgba(31,29,26,0.06);">
    <p style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#7d2a4d;margin:0 0 8px;font-weight:700;">${safeFirm}</p>
    <h1 style="margin:0 0 12px;font-size:20px;color:#1f1d1a;">Your sign-in link</h1>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.5;color:#555049;">Click the button below to sign in. This link expires in 15 minutes and can only be used once.</p>
    <p style="margin:0 0 20px;"><a href="${signInUrl}" style="display:inline-block;background:#7d2a4d;color:#fff;font-weight:600;text-decoration:none;padding:12px 22px;border-radius:8px;font-size:15px;">Sign in</a></p>
    <p style="margin:0;font-size:12px;color:#7d7269;">If the button does not work, paste this into your browser:<br><span style="word-break:break-all;color:#555049;">${signInUrl}</span></p>
    <p style="margin:20px 0 0;font-size:12px;color:#7d7269;">If you didn&rsquo;t request this, ignore this email.</p>
  </div>
</body></html>`

  await sendResendEmail({ to, subject, html })
}

/**
 * Email a feature request from the owner to the developer. Best-effort like
 * every other email here — returns true when the send was attempted with a
 * configured pipeline, false when email isn't configured. The in-app record
 * is the source of truth either way.
 *
 * params: { fromName, title, description }
 */
export async function sendFeatureRequestEmail({ fromName, title, description }) {
  // Route to the admin address; fall back to the legacy override / default
  // only if ADMIN_EMAIL isn't set.
  const to =
    process.env.ADMIN_EMAIL ||
    process.env.FEATURE_REQUEST_EMAIL ||
    'asoalexander@gmail.com'
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) return false

  const safe = (value) => String(value ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const subject = `Feature request: ${String(title ?? '').slice(0, 120)}`
  const html = `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1f1d1a;background:#f6f5f1;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:24px 28px;box-shadow:0 8px 32px rgba(31,29,26,0.06);">
    <p style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#7d2a4d;margin:0 0 8px;font-weight:700;">PB&amp;J Strategic Accounting — feature request</p>
    <h1 style="margin:0 0 6px;font-size:18px;color:#1f1d1a;">${safe(title)}</h1>
    <p style="margin:0 0 16px;font-size:12px;color:#7d7269;">Requested by ${safe(fromName)} via the in-app assistant</p>
    <p style="margin:0;font-size:15px;line-height:1.6;color:#1f1d1a;white-space:pre-wrap;">${safe(description)}</p>
  </div>
</body></html>`

  // Return the ACTUAL delivery result so the UI can't claim "Sent!" when
  // Resend rejected the message (e.g. an unverified recipient/domain).
  return sendResendEmail({ to, subject, html })
}

/**
 * Email an assistant-generated report to the owner. Best-effort; returns true
 * only when Resend actually accepted it. `body` is plain text/markdown from
 * the assistant; it's rendered into a simple branded shell with line breaks
 * preserved. Recipient is OWNER_EMAIL (the firm owner).
 *
 * params: { to, firmName, subject, body, appBaseUrl }
 */
export async function sendReportEmail({ to, firmName, subject, body, appBaseUrl }) {
  if (!to || !String(body ?? '').trim()) return false
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) return false

  const safe = (value) => String(value ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const safeFirm = safe(firmName || 'PB&J Strategic Accounting')
  const base = String(appBaseUrl || '').replace(/\/$/, '')
  const heading = safe(subject || 'Your report')
  const bodyHtml = safe(body).replace(/\n/g, '<br>')
  const openLine = base
    ? `<p style="margin:18px 0 0;"><a href="${base}/" style="color:#7d2a4d;font-weight:600;text-decoration:none;">Open the app</a></p>`
    : ''
  const html = `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1f1d1a;background:#f6f5f1;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:24px 28px;box-shadow:0 8px 32px rgba(31,29,26,0.06);">
    <p style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#7d2a4d;margin:0 0 8px;font-weight:700;">${safeFirm} — assistant report</p>
    <h1 style="margin:0 0 14px;font-size:18px;color:#1f1d1a;">${heading}</h1>
    <div style="margin:0;font-size:14.5px;line-height:1.6;color:#1f1d1a;">${bodyHtml}</div>
    ${openLine}
  </div>
</body></html>`

  return sendResendEmail({ to, subject: `${heading} — ${safeFirm}`, html })
}

/**
 * Weekly digest of automation opportunities (Phase 3). Best-effort like the
 * other emails — returns true when a send was attempted with a configured
 * pipeline, false when email isn't configured or there's nothing to report.
 *
 * params: { to, firmName, suggestions: [{ title, body }], appBaseUrl }
 */
export async function sendDigestEmail({ to, firmName, suggestions, appBaseUrl }) {
  if (!to || !Array.isArray(suggestions) || suggestions.length === 0) return false
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) return false

  const safe = (value) => String(value ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const safeFirm = safe(firmName || 'PB&J Strategic Accounting')
  const base = String(appBaseUrl || '').replace(/\/$/, '')
  const items = suggestions
    .slice(0, 3)
    .map(
      (s) => `
      <div style="margin:0 0 14px;padding:14px 16px;background:#faf9f6;border-radius:10px;">
        <p style="margin:0 0 4px;font-size:15px;font-weight:600;color:#1f1d1a;">${safe(s.title)}</p>
        <p style="margin:0;font-size:14px;line-height:1.5;color:#555049;">${safe(s.body)}</p>
      </div>`,
    )
    .join('')
  const openLine = base
    ? `<p style="margin:18px 0 0;"><a href="${base}/" style="display:inline-block;background:#7d2a4d;color:#fff;font-weight:600;text-decoration:none;padding:11px 20px;border-radius:8px;font-size:14px;">Open the app</a></p>`
    : ''
  const subject = `${suggestions.length} automation ${suggestions.length === 1 ? 'opportunity' : 'opportunities'} this week`
  const html = `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1f1d1a;background:#f6f5f1;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:24px 28px;box-shadow:0 8px 32px rgba(31,29,26,0.06);">
    <p style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#7d2a4d;margin:0 0 8px;font-weight:700;">${safeFirm} — weekly digest</p>
    <h1 style="margin:0 0 6px;font-size:18px;color:#1f1d1a;">${safe(subject)}</h1>
    <p style="margin:0 0 18px;font-size:14px;color:#7d7269;">Your assistant noticed a few things that could save you time:</p>
    ${items}
    ${openLine}
    <p style="margin:20px 0 0;font-size:12px;color:#7d7269;">Open the assistant (sparkle button) to act on any of these or turn the digest off.</p>
  </div>
</body></html>`

  await sendResendEmail({ to, subject, html })
  return true
}

/**
 * notify(store, userId, event, payload)
 *
 * payload: {
 *   message: string,                   // required, short bell summary
 *   link?: string,                     // optional in-app route to deep-link to
 *   subject?: string,                  // optional email subject override
 *   appPublicUrl?: string,             // optional, if not set the email omits the deep link
 *   ...extra fields persisted into notification.payload
 * }
 *
 * Returns the created notification (or null if userId/event invalid).
 */
export async function notify(store, userId, event, payload = {}) {
  if (!userId || !event) {
    return null
  }
  if (!KNOWN_EVENTS.has(event)) {
    console.error(`[notify] Unknown event "${event}" — persisting anyway.`)
  }

  const message = String(payload.message ?? '').trim() || event
  const link = typeof payload.link === 'string' ? payload.link : null
  const { subject: subjectOverride, appPublicUrl, ...rest } = payload
  // The persisted payload should keep the raw event data (excluding internal-only routing fields).
  const persistPayload = { ...rest, message, link }

  const notification = await store.createNotification(userId, event, message, link, persistPayload)

  // Best-effort email side. Silent no-op if RESEND_API_KEY/EMAIL_FROM unset.
  if (process.env.RESEND_API_KEY && process.env.EMAIL_FROM) {
    try {
      const member = await store.getTeamMember(userId)
      const to = member?.email
      if (to) {
        const baseUrl = (appPublicUrl || process.env.APP_PUBLIC_URL || '').replace(/\/$/, '')
        let deepLink = null
        if (baseUrl) {
          if (member.magicToken && !member.tokenRevokedAt) {
            deepLink = `${baseUrl}/login/${encodeURIComponent(member.magicToken)}`
          } else {
            deepLink = `${baseUrl}/`
          }
        }
        const subject = subjectOverride || defaultSubject(event, message)
        const html = buildEmailHtml({ message, deepLink })
        await sendResendEmail({ to, subject, html })
      }
    } catch (error) {
      console.error('[notify] email pipeline error:', error?.message || error)
    }
  }

  return notification
}
