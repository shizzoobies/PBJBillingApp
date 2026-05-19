#!/usr/bin/env node
/**
 * Post-deploy health check for the PB&J Strategic Accounting app.
 *
 * Run this after a Railway deploy to confirm the deployment is actually
 * serving a working build, e.g.:
 *
 *   npm run health-check https://pbjbillingapp-production.up.railway.app
 *
 * It checks three things:
 *   1. GET <url>/health returns HTTP 200.
 *   2. GET <url>/ returns 200 AND the HTML references a #root mount node and
 *      at least one <script src=...> bundle.
 *   3. The referenced JS bundle itself returns 200 with a non-trivial body.
 *
 * IMPORTANT: this script does NOT execute the app's JavaScript. It catches
 * "build broke / assets 404 / server down", but it cannot catch a runtime
 * crash inside the React app (e.g. a null-dereference on boot). The App-boot
 * smoke test in src/__tests__/app-boot.test.tsx is what guards against that —
 * run `npm run test` (or `npm run verify`) before every deploy.
 *
 * Plain Node, no dependencies — uses the built-in global `fetch` (Node 18+).
 */

const REQUEST_TIMEOUT_MS = 15_000

/**
 * Fetch with a hard timeout so a hung server can't stall the whole check.
 * Uses the built-in `AbortSignal.timeout()` (Node 18+) which manages its own
 * timer internally — no manual setTimeout handle to leak or race on exit.
 */
async function fetchWithTimeout(url, options = {}) {
  return fetch(url, {
    ...options,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: 'follow',
  })
}

/** Resolve a possibly-relative asset src against the deployed base URL. */
function resolveAssetUrl(baseUrl, src) {
  try {
    return new URL(src, baseUrl).toString()
  } catch {
    return null
  }
}

function pass(label, detail) {
  console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`)
  return true
}

function fail(label, detail) {
  console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  return false
}

async function checkHealthEndpoint(baseUrl) {
  const target = `${baseUrl}/health`
  try {
    const res = await fetchWithTimeout(target)
    if (res.status !== 200) {
      return fail('/health returns 200', `got HTTP ${res.status}`)
    }
    return pass('/health returns 200')
  } catch (error) {
    return fail('/health returns 200', `request error: ${error.message}`)
  }
}

/**
 * Check the root HTML document. Returns `{ ok, scriptUrl }` — `scriptUrl` is
 * the first resolved <script src=...> URL so the bundle check can fetch it.
 */
async function checkRootHtml(baseUrl) {
  const target = `${baseUrl}/`
  try {
    const res = await fetchWithTimeout(target)
    if (res.status !== 200) {
      return { ok: fail('/ returns 200', `got HTTP ${res.status}`), scriptUrl: null }
    }
    const html = await res.text()

    const hasRoot = /<div\s+id=["']root["']/i.test(html)
    if (!hasRoot) {
      return {
        ok: fail('/ HTML has <div id="root">', 'mount node not found in HTML'),
        scriptUrl: null,
      }
    }

    // Find every <script ... src="..."> and take the first resolvable one.
    const scriptSrcs = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)].map(
      (m) => m[1],
    )
    if (scriptSrcs.length === 0) {
      return {
        ok: fail('/ HTML references a JS bundle', 'no <script src=...> tag found'),
        scriptUrl: null,
      }
    }

    const scriptUrl = resolveAssetUrl(baseUrl, scriptSrcs[0])
    if (!scriptUrl) {
      return {
        ok: fail('/ HTML references a JS bundle', `unparseable src: ${scriptSrcs[0]}`),
        scriptUrl: null,
      }
    }

    pass('/ returns 200 with #root and a JS bundle reference', scriptSrcs[0])
    return { ok: true, scriptUrl }
  } catch (error) {
    return { ok: fail('/ returns 200', `request error: ${error.message}`), scriptUrl: null }
  }
}

async function checkBundle(scriptUrl) {
  try {
    const res = await fetchWithTimeout(scriptUrl)
    if (res.status !== 200) {
      return fail('JS bundle loads', `got HTTP ${res.status} for ${scriptUrl}`)
    }
    const body = await res.text()
    if (body.length <= 1024) {
      return fail('JS bundle is non-trivial', `body only ${body.length} bytes`)
    }
    return pass('JS bundle loads and is non-trivial', `${body.length} bytes`)
  } catch (error) {
    return fail('JS bundle loads', `request error: ${error.message}`)
  }
}

async function main() {
  const url = process.argv[2] || process.env.HEALTH_CHECK_URL
  if (!url) {
    console.error('Usage: node scripts/health-check.mjs <url>')
    console.error('   or: HEALTH_CHECK_URL=<url> node scripts/health-check.mjs')
    console.error('Example: node scripts/health-check.mjs https://pbjbillingapp-production.up.railway.app')
    process.exitCode = 1
    return
  }

  // Normalize: strip any trailing slash so `${baseUrl}/health` is well-formed.
  const baseUrl = url.replace(/\/+$/, '')
  console.log(`Health check target: ${baseUrl}\n`)

  const results = []
  results.push(await checkHealthEndpoint(baseUrl))
  const rootResult = await checkRootHtml(baseUrl)
  results.push(rootResult.ok)
  if (rootResult.scriptUrl) {
    results.push(await checkBundle(rootResult.scriptUrl))
  } else {
    results.push(fail('JS bundle loads', 'skipped — no bundle URL from / HTML'))
  }

  const passed = results.filter(Boolean).length
  const total = results.length
  console.log(`\nSummary: ${passed}/${total} checks passed.`)

  if (passed === total) {
    console.log('RESULT: PASS')
    // Set the code and let the event loop drain — calling process.exit() here
    // can race libuv handle teardown on Windows. The process ends 0 naturally.
    process.exitCode = 0
    return
  }
  console.log('RESULT: FAIL')
  process.exitCode = 1
}

main().catch((error) => {
  console.error(`Health check crashed: ${error.message}`)
  process.exitCode = 1
})
