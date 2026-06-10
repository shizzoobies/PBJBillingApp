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
    // happy-dom gives the test environment a DOM so React components mount.
    environment: 'happy-dom',
    globals: true,
    // Loads @testing-library/jest-dom matchers once before any test runs.
    setupFiles: ['./src/test/setup.ts'],
    // Only pick up the project's own tests — never node_modules. Plain-JS
    // server-side libs get .test.mjs files (outside tsc's reach, so a TS
    // test can never import a JS lib and break the clean build).
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'lib/**/*.test.mjs'],
  },
})
