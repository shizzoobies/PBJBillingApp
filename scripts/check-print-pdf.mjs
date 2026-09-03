/**
 * Print regression tripwire — run this after ANY change to the print CSS, the
 * `printing-invoice` / `printing-report` body classes, or where the print
 * sheets are rendered in the tree.
 *
 *   node scripts/check-print-pdf.mjs
 *
 * NOT part of `npm run verify`, on purpose: it drives a real Chromium and
 * verify is meant to stay jsdom-fast. It is also the only check that can see
 * the two failures that shipped to Brittany, because BOTH are invisible to
 * jsdom — it has no print stylesheet and no pagination:
 *
 *   1. A print sheet rendered INSIDE #root cannot be shown while the print CSS
 *      hides #root. `display: none` on an ancestor is final. The printout is
 *      blank. Both sheets are portaled to <body> to avoid this.
 *   2. `#root { min-height: 100vh }`. In PAGED media `vh` resolves against the
 *      PAGE box, so hiding only #root's CONTENTS still leaves a full-height
 *      empty box — the PDF comes out with a blank page in front. Only hiding
 *      #root itself collapses it. A page count is the sole way to catch this;
 *      every DOM assertion passes while it is broken.
 *
 * THE PAGE COUNT IS PER-MODE, and the invoice's is 2 (featreq-97ae3214). An
 * invoice whose client has the hours breakdown on now prints a "Detailed Hours"
 * appendix after a hard `break-before: page`, so one page would be the WRONG
 * expectation there. The fixture below carries a real detail section for that
 * reason: relaxing the assertion without exercising the two-page path would
 * leave a check that passes on anything. The blank-leading-page assertion
 * (`#root` collapsed) matters MORE now, not less — with two pages a stray
 * blank one is easier to overlook and harder to explain to a client.
 *
 * It also covers the collision between the two modes. The fixture always
 * mounts BOTH sheets, because that is the real situation: the invoice sheet is
 * present whenever the Invoices page is, so a report printed from there is the
 * case where a too-broad selector prints the wrong document (or both stacked).
 *
 * Playwright is deliberately not a dependency of this app. If it is not
 * resolvable, the script says how to run it and exits 0 (skipped) rather than
 * failing a machine that simply does not have it.
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { INVOICE_FOOTER_DEFAULT } from '../lib/invoice-lines.js'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const cssHref = pathToFileURL(join(repoRoot, 'src', 'App.css')).href
// Same wording the PDF, the email and the print sheet all read off — one
// import instead of a fourth hand-typed copy that could drift from the rest.
const footerHtml = INVOICE_FOOTER_DEFAULT.replace(/&/g, '&amp;')

// PLAYWRIGHT_MODULE lets you point at an install that is not a sibling of this
// repo — an npx cache, a global install. ESM resolution ignores NODE_PATH, so
// an explicit path is the only way in.
let chromium
try {
  const from = process.env.PLAYWRIGHT_MODULE
  ;({ chromium } = await import(from ? pathToFileURL(from).href : 'playwright'))
} catch {
  console.log('SKIPPED — playwright is not installed (it is not a dependency of this app).')
  console.log('Install it somewhere and point the script at it:')
  console.log('  npm i -g playwright && npx playwright install chromium')
  console.log('  PLAYWRIGHT_MODULE="$(npm root -g)/playwright/index.mjs" \\')
  console.log('    node scripts/check-print-pdf.mjs')
  process.exit(0)
}

/**
 * The detailed-hours appendix — page 2. Enough rows that the block is a real
 * page's worth of content rather than a heading floating alone: the break rule
 * is what MAKES the second page, but a check that only ever renders one line
 * would not notice if the appendix stopped laying out at all.
 */
const detailRows = Array.from({ length: 14 }, (_, i) => {
  const day = String((i % 28) + 1).padStart(2, '0')
  // Two columns, no amount: every `time_detail` row is $0.00 by invariant, so
  // the sheet, the PDF and the email all drop that column.
  return (
    `<tr><td>Lisa Mockabee</td>` +
    `<td>Aug ${day} · 1.75 hrs · Monthly close and reconciliations</td></tr>`
  )
}).join('\n            ')

/**
 * The app's print-time DOM shape. Both sheets are mounted (see above) and both
 * are siblings of #root, exactly as the two createPortal calls leave them.
 *
 * The invoice sheet mirrors what `InvoiceDocument` now renders: section heading
 * rows, role sub-heading rows inside the hours section, a per-section total
 * row, and the `print-detail-sheet` appendix as a SIBLING section after the
 * footer (a nested one could not carry a page break of its own).
 *
 * `includeDetail: false` renders the sheet the way every one of the 51 clients
 * with the breakdown off actually prints today — no appendix section at all —
 * so the one-page shape stays exercised and a broadened break rule (e.g.
 * `break-before` moving from `.print-detail-sheet` to `.print-sheet` itself)
 * cannot pass unnoticed just because the two-page fixture still has its break.
 */
function fixture(bodyClass, { includeDetail = true } = {}) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="${cssHref}" />
  </head>
  <body class="${bodyClass}">
    <div id="root">
      <div class="app-shell">
        <aside class="sidebar">Sidebar that must never print</aside>
        <main class="workspace">
          <section class="content-grid invoice-layout">
            <div class="panel">Billing queue that must never print</div>
          </section>
        </main>
      </div>
    </div>

    <div class="print-document invoice-print" aria-hidden="true">
      <section class="print-sheet">
        <header><div><strong>PB&amp;J Strategic Accounting</strong></div></header>
        <div class="print-meta">
          <div><span>Bill to</span><strong>Acme</strong></div>
          <div>
            <span>Invoice no.</span><strong>INV-2026-08-001</strong>
            <span>Invoice Date</span><strong>August 31, 2026</strong>
            <small>Billing Period: August 2026</small>
          </div>
        </div>
        <table>
          <thead>
            <tr><th>Description</th><th>Detail</th><th>Amount</th></tr>
          </thead>
          <tbody>
            <tr class="print-section-row"><th colspan="3" scope="colgroup">Ad-Hoc / Billable Hours</th></tr>
            <tr class="print-role-row"><td colspan="3">CFO / Advisory Services</td></tr>
            <tr><td>Billable hours — Brittany Ferguson</td><td>3.50 at $150.00/hr</td><td>$525.00</td></tr>
            <tr class="print-role-row"><td colspan="3">Bookkeeping Services</td></tr>
            <tr><td>Billable hours — Lisa Mockabee</td><td>22.61 at $125.00/hr</td><td>$2,826.25</td></tr>
            <tr class="print-section-total-row"><td colspan="2">Total Ad-Hoc/Billable Hours</td><td>$3,351.25</td></tr>
          </tbody>
        </table>
        <footer><span>Total due</span><strong>$3,351.25</strong></footer>
        <p>${footerHtml}</p>
      </section>
      ${
        includeDetail
          ? `<section class="print-sheet print-detail-sheet">
        <h2>Detailed Hours</h2>
        <table>
          <thead>
            <tr><th>Description</th><th>Detail</th></tr>
          </thead>
          <tbody>
            ${detailRows}
          </tbody>
        </table>
      </section>`
          : ''
      }
    </div>

    <div class="print-document report-print" aria-hidden="true">
      <div class="report-print-sheet">
        <div class="print-header"><div class="print-header-firm-text"><strong>PB&amp;J</strong></div></div>
        <h1>August billing summary</h1>
        <section class="report-section"><h3>Hours</h3><p>Ninety-one billable hours.</p></section>
      </div>
    </div>
  </body>
</html>`
}

/**
 * Page count straight out of the PDF's page tree. Chromium's PDF writer emits
 * the catalog and page tree as plain (uncompressed) objects, so the /Count on
 * the root Pages node is readable without a PDF parser. Falls back to counting
 * individual page objects.
 */
function pdfPageCount(buffer) {
  const raw = buffer.toString('latin1')
  const count = raw.match(/\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/)
  if (count) return Number(count[1])
  const pages = raw.match(/\/Type\s*\/Page(?![s/\w])/g)
  if (pages) return pages.length
  throw new Error('could not determine the page count from the generated PDF')
}

const failures = []
const dir = mkdtempSync(join(tmpdir(), 'pbj-print-'))
const browser = await chromium.launch()

try {
  const page = await browser.newPage()

  for (const mode of [
    {
      id: 'printing-invoice-two-page',
      bodyClass: 'printing-invoice',
      label: 'invoice print (breakdown on — sheet + detailed-hours appendix)',
      shown: '.invoice-print .print-sheet',
      hidden: '.report-print .report-print-sheet',
      // Sheet + detailed-hours appendix. Two is the CORRECT count here; one
      // would mean the `break-before: page` rule stopped applying, and three
      // would mean a blank page crept back in.
      pages: 2,
    },
    {
      // Every one of the 51 clients today: the breakdown is off, so the
      // invoice sheet carries no `print-detail-sheet` appendix at all. A
      // broadened break rule (e.g. `break-before: page` moving from
      // `.print-detail-sheet` onto `.print-sheet` itself) would still pass
      // the two-page mode above and only show up here, as an extra blank page
      // on the one-page invoice every real client actually gets.
      id: 'printing-invoice-one-page',
      bodyClass: 'printing-invoice',
      label: 'invoice print (breakdown off — sheet only, no appendix)',
      shown: '.invoice-print .print-sheet',
      hidden: '.report-print .report-print-sheet',
      pages: 1,
      includeDetail: false,
    },
    {
      id: 'printing-report',
      bodyClass: 'printing-report',
      label: 'report print',
      shown: '.report-print .report-print-sheet',
      hidden: '.invoice-print .print-sheet',
      // The invoice sheet — appendix and all — is display:none in this mode, so
      // its page break must not leak into the report's page count.
      pages: 1,
    },
  ]) {
    const file = join(dir, `${mode.id}.html`)
    writeFileSync(file, fixture(mode.bodyClass, { includeDetail: mode.includeDetail !== false }), 'utf8')
    await page.goto(pathToFileURL(file).href)
    await page.emulateMedia({ media: 'print' })

    const boxes = await page.evaluate(
      ({ shown, hidden }) => {
        const area = (selector) => {
          const node = document.querySelector(selector)
          if (!node) return null
          const rect = node.getBoundingClientRect()
          return { width: Math.round(rect.width), height: Math.round(rect.height) }
        }
        return {
          shown: area(shown),
          hidden: area(hidden),
          shell: area('.app-shell'),
          root: area('#root'),
        }
      },
      { shown: mode.shown, hidden: mode.hidden },
    )

    const pdf = await page.pdf({ format: 'Letter', printBackground: true })
    const pages = pdfPageCount(pdf)

    const check = (ok, message) => {
      console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${message}`)
      if (!ok) failures.push(`${mode.label}: ${message}`)
    }

    console.log(`\n${mode.label} (body.${mode.bodyClass})`)
    console.log(
      `  pages=${pages} shown=${JSON.stringify(boxes.shown)} ` +
        `hidden=${JSON.stringify(boxes.hidden)} #root=${JSON.stringify(boxes.root)}`,
    )
    check(pages === mode.pages, `exactly ${mode.pages} page(s) (got ${pages})`)
    check(Boolean(boxes.shown && boxes.shown.height > 0), 'the intended sheet is laid out')
    check(
      Boolean(boxes.hidden && boxes.hidden.height === 0),
      'the other mode’s sheet is not laid out',
    )
    check(Boolean(boxes.root && boxes.root.height === 0), '#root is fully collapsed')
  }
} finally {
  await browser.close()
  rmSync(dir, { recursive: true, force: true })
}

// The fixture mirrors the app's markup by hand, so it can drift. This is a
// cheap reminder that the classes it asserts on still exist in the source.
for (const [file, needle] of [
  ['src/pages/InvoicesPage.tsx', 'print-document invoice-print'],
  ['src/components/AssistantReportModal.tsx', 'print-document report-print'],
  ['src/App.css', 'body.printing-invoice #root'],
  ['src/App.css', 'body.printing-report #root'],
  // The two-page expectation above is only meaningful while the appendix and
  // its page break both still exist. Rename either and this says so instead of
  // quietly asserting a page count nothing produces.
  ['src/pages/InvoicesPage.tsx', 'print-sheet print-detail-sheet'],
  ['src/App.css', 'break-before: page'],
  ['src/App.css', '.print-detail-sheet {'],
  // The section/role/total row classes the fixture's table body mirrors by
  // hand above. Renaming any of them in the TSX would leave the sheet
  // unstyled while this fixture kept asserting against the old names — this
  // says so instead of silently passing.
  ['src/pages/InvoicesPage.tsx', 'print-section-row'],
  ['src/pages/InvoicesPage.tsx', 'print-role-row'],
  ['src/pages/InvoicesPage.tsx', 'print-section-total-row'],
]) {
  if (!readFileSync(join(repoRoot, file), 'utf8').includes(needle)) {
    failures.push(`fixture is stale: "${needle}" is no longer in ${file}`)
  }
}

console.log('')
if (failures.length > 0) {
  console.error('PRINT CHECK FAILED')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(
  'PRINT CHECK PASSED — the invoice prints its sheet plus the detailed-hours ' +
    'page, the report prints one page, and neither prints the other’s sheet.',
)
