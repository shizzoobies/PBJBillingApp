import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The installable-app (PWA) wiring: manifest, icons, and the mime type that
 * serves them. Source-reading tests, same shape as invoice-ai-review-routes.
 *
 * The last test pins a deliberate ABSENCE: there is no service worker, on
 * purpose. This app has a history of stale-tab bugs (see the bulk-save
 * staleness guard and the refresh toast) and a service worker's cache is a
 * second place for a stale bundle to hide. Installability does not require
 * one. If you are adding a service worker deliberately, update that test and
 * the comment in index.html together — do not just delete the assertion.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const indexHtml = readFileSync(path.join(root, 'index.html'), 'utf8')
const manifest = JSON.parse(readFileSync(path.join(root, 'public/manifest.webmanifest'), 'utf8'))
const serverSource = readFileSync(path.join(root, 'server.js'), 'utf8')

describe('the app is installable as a desktop/mobile app', () => {
  it('index.html links the manifest, theme color, and touch icon', () => {
    expect(indexHtml).toContain('<link rel="manifest" href="/manifest.webmanifest" />')
    expect(indexHtml).toContain('<meta name="theme-color" content="#ff43a4" />')
    expect(indexHtml).toContain('<link rel="apple-touch-icon" href="/icons/pwa-192.png" />')
  })

  it('the manifest carries everything Windows install requires', () => {
    expect(manifest.name).toBe('PB&J Strategic Accounting')
    expect(manifest.short_name).toBe('PB&J')
    expect(manifest.display).toBe('standalone')
    expect(manifest.start_url).toBe('/')
    expect(manifest.scope).toBe('/')
    expect(manifest.id).toBe('/')

    const sizes = manifest.icons.map((icon: { sizes: string }) => icon.sizes)
    expect(sizes).toContain('192x192')
    expect(sizes).toContain('512x512')
    const maskable = manifest.icons.find((icon: { purpose?: string }) => icon.purpose === 'maskable')
    expect(maskable, 'a maskable icon keeps the mark inside adaptive shapes').toBeTruthy()
  })

  it('every icon the manifest names exists on disk', () => {
    for (const icon of manifest.icons as { src: string }[]) {
      expect(existsSync(path.join(root, 'public', icon.src)), `missing ${icon.src}`).toBe(true)
    }
  })

  it('the server serves .webmanifest with the manifest mime type', () => {
    expect(serverSource).toContain("'.webmanifest': 'application/manifest+json; charset=utf-8'")
  })

  it('registers NO service worker — a deliberate absence, see the header comment', () => {
    expect(indexHtml).not.toContain('serviceWorker')
    const offenders: string[] = []
    for (const file of ['src/main.tsx', 'src/App.tsx']) {
      if (readFileSync(path.join(root, file), 'utf8').includes('serviceWorker.register')) {
        offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })
})
