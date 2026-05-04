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
    return
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
    }
  } catch (error) {
    console.error('[notify] Resend send failed:', error?.message || error)
  }
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
