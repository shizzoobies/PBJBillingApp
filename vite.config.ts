import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
// `vitest/config`'s defineConfig accepts the `test` block below with full typing.
import { defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:4173',
      '/health': 'http://127.0.0.1:4173',
    },
  },
  test: {
    // The Worker imports @cloudflare/containers, which only exists inside the Workers bundle.
    // worker.test.mjs mocks it; the alias just lets the import resolve before it is installed.
    alias: { '@cloudflare/containers': fileURLToPath(new URL('./cloudflare/test-support/containers-stub.mjs', import.meta.url)) },
    // happy-dom gives the test environment a DOM so React components mount.
    environment: 'happy-dom',
    globals: true,
    // Loads @testing-library/jest-dom matchers once before any test runs.
    setupFiles: ['./src/test/setup.ts'],
    // Only pick up the project's own tests — never node_modules. Plain-JS
    // server-side libs get .test.mjs files (outside tsc's reach, so a TS
    // test can never import a JS lib and break the clean build).
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'lib/**/*.test.mjs', 'db/**/*.test.mjs', 'cloudflare/**/*.test.mjs'],
    // The whole-app tests mount <App> and wait on several mocked fetches. On a
    // loaded machine (two working copies running the suite at once) the 5 s
    // default turned slow-but-correct tests into timeouts. A passing test is
    // no slower for this; only a genuinely failing wait takes longer to say so.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
