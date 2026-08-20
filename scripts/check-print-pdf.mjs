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
 *      empty box — the PDF comes out 2 pages with a blank one in front. Only
 *      hiding #root itself collapses it. A page count is the sole way to catch
 *      this; every DOM assertion passes while it is broken.
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

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const cssHref = pathToFileURL(join(repoRoot, 'src', 'App.css')).href

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
 * The app's print-time DOM shape. Both sheets are mounted (see above) and both
 * are siblings of #root, exactly as the two createPortal calls leave them.
 */
function fixture(bodyClass) {
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
        <div class="print-meta"><div><span>Bill to</span><strong>Acme</strong></div></div>
        <table>
          <tbody>
            <tr><td>Billable hours</td><td>August</td><td>$400.00</td></tr>
          </tbody>
        </table>
        <footer><span>Total due</span><strong>$400.00</strong></footer>
      </section>
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
      bodyClass: 'printing-invoice',
      label: 'invoice print',
      shown: '.invoice-print .print-sheet',
      hidden: '.report-print .report-print-sheet',
    },
    {
      bodyClass: 'printing-report',
      label: 'report print',
      shown: '.report-print .report-print-sheet',
      hidden: '.invoice-print .print-sheet',
    },
  ]) {
    const file = join(dir, `${mode.bodyClass}.html`)
    writeFileSync(file, fixture(mode.bodyClass), 'utf8')
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
    check(pages === 1, `exactly one page (got ${pages})`)
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
console.log('PRINT CHECK PASSED — both modes print one page, and only their own sheet.')
