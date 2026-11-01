/**
 * The durable pay link (`/pay/<token>`) when the invoice's link carries an
 * advance (Brittany, 2026-11-01: one link, one payment). Pure, so the route's
 * decisions are tested by running them (server.js listens at module scope).
 */

/**
 * What this open of the pay link does: 'summary' shows what the link collects
 * and mints nothing; 'mint' creates the Stripe session and redirects.
 *
 * A link with no advance always mints, exactly as before. With one, the first
 * open is the summary; its "Continue to payment" comes back with `go=1`, and
 * the route's own "total moved, go round once" redirect (`retry=1`) was
 * already confirmed by the payer, so both mint. Only a minting pass counts
 * toward the per-link limit; viewing the summary does not.
 */
export function payLinkAdvanceStep({ carried, searchParams }) {
  if (!carried) return 'mint'
  return searchParams?.get('go') === '1' || searchParams?.get('retry') === '1' ? 'mint' : 'summary'
}

const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/**
 * What a payment link that carries an advance will collect, shown before the
 * Stripe page: Invoice amount, Advance payment, Processing fee (card) and
 * Total to pay, from `advancePaymentRows` - the figures the session is built
 * from. Amounts only; no client name and no service lines (Stripe's page
 * repeats the same figures to the same link holder).
 */
export function renderPaySummaryPage({ number, rows, optional, continueHref }) {
  const table = rows
    .map(([label, value], index) => `<tr${index === rows.length - 1 ? ' class="total"' : ''}><td>${escape(label)}</td><td class="amount">${escape(value)}</td></tr>`)
    .join('')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Invoice ${escape(number)} - PB&amp;J Strategic Accounting</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: #f6f5f1; color: #1f1d1a; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 24px; box-sizing: border-box; }
  .card { background: #fff; padding: 32px 36px; border-radius: 14px; box-shadow: 0 12px 40px rgba(31, 29, 26, 0.08); max-width: 460px; width: 100%; }
  h1 { margin: 0 0 12px 0; font-size: 22px; color: #7d2a4d; text-align: center; }
  table { width: 100%; border-collapse: collapse; margin: 0 0 20px 0; }
  td { padding: 6px 0; vertical-align: top; overflow-wrap: anywhere; }
  td.amount { text-align: right; white-space: nowrap; padding-left: 12px; }
  tr.total td { border-top: 1px solid #ddd; font-weight: 700; padding-top: 10px; }
  p { line-height: 1.5; margin: 0 0 20px 0; color: #555049; }
  .center { text-align: center; }
  a.action { display: inline-block; font-weight: 600; color: #fff; background: #7d2a4d; border-radius: 10px; padding: 12px 24px; text-decoration: none; }
  p.footer { margin: 0; font-size: 13px; color: #8a837a; text-align: center; }
</style>
</head>
<body>
  <div class="card">
    <h1>Invoice ${escape(number)}</h1>
    <table>${table}</table>
    <p>The advance is held as credit toward future invoices; it is not a charge for services.${optional ? ' It is optional: you may remove it on the next page.' : ''}</p>
    <p class="center"><a class="action" href="${escape(continueHref)}">Continue to payment</a></p>
    <p class="footer">Questions? billing@pbjsa.com</p>
  </div>
</body>
</html>`
}
