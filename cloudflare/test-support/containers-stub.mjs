// Stand-in for @cloudflare/containers under vitest only (vite.config.ts test.alias), so
// `npm run verify` passes whether or not the package is installed. worker.test.mjs
// replaces it with vi.mock; this file just has to resolve and export the same names.
export class Container {}
export function getContainer() {
  throw new Error('@cloudflare/containers is stubbed in tests; mock getContainer')
}
