// Vitest setup — runs once before the test suite. Importing jest-dom here
// registers its custom matchers (toBeInTheDocument, toHaveTextContent, etc.)
// on Vitest's `expect` so every test file can use them without re-importing.
import '@testing-library/jest-dom/vitest'
