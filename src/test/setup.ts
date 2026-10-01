// Vitest setup — runs once before the test suite. Importing jest-dom here
// registers its custom matchers (toBeInTheDocument, toHaveTextContent, etc.)
// on Vitest's `expect` so every test file can use them without re-importing.
import '@testing-library/jest-dom/vitest'
import { configure } from '@testing-library/react'

// `findBy...` and `waitFor` give up after 1 s by default. Under a loaded run
// that is shorter than a whole-app render takes, so correct tests failed on
// timing alone. Ten seconds is still well inside the per-test limit set in
// vite.config.ts; a lookup that succeeds returns as soon as it does.
configure({ asyncUtilTimeout: 10_000 })
