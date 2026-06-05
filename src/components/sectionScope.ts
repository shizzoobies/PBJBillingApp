import { createContext } from 'react'

/**
 * Scopes a CollapsibleSection's persisted lock/collapse state (e.g. to a single
 * client) so the same-named section on different clients keeps its own state.
 * Empty default => global, preserving behavior for pages that don't wrap.
 */
export const SectionScopeContext = createContext('')
