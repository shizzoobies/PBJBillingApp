import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // `.claude/worktrees/*` holds full git worktrees of this same repo. Linting
  // them double-lints every file AND gives the TS parser two candidate
  // tsconfig roots, which fails the whole run — so `npm run verify` breaks for
  // everyone whenever a worktree exists, on code that isn't being changed.
  globalIgnores(['dist', '.claude']),
  // The Cloudflare Worker is plain ESM JavaScript for the Workers runtime (not the browser and
  // not Node); wrangler bundles it. Lint it with the base rules and the Worker globals.
  {
    files: ['cloudflare/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.serviceworker },
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
  },
])
