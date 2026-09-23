/**
 * The Plans page's two tabs: Plans / Packages (featreq-f890f05b, Brittany's
 * send-back). Her words: "Can we have plans as a tab and packages as a tab at
 * the top for easier navigation?"
 *
 * Same treatment as the client detail page and the Delayed page — the shared
 * `.task-area-tabs` underline bar — and the same URL-driven resolution as
 * `resolveClientSection` / `resolveDelayedTab`, which this deliberately
 * mirrors rather than reinvents.
 *
 * Plans is always the default: unlike Delayed (which opens on whichever side
 * has work), a plain `/plans` link — including the "To 100%" plan-checklist
 * issue and every other existing link into this page — has always meant the
 * plans list, and nothing about that changed.
 */

export type PlansTab = 'plans' | 'packages'

export const PLANS_TAB_KEYS: PlansTab[] = ['plans', 'packages']

export const PLANS_TAB_LABELS: Record<PlansTab, string> = {
  plans: 'Plans',
  packages: 'Packages',
}

function asTab(value: string | null | undefined): PlansTab | null {
  return PLANS_TAB_KEYS.includes(value as PlansTab) ? (value as PlansTab) : null
}

/**
 * Which tab to open:
 *
 * 1. `?tab=` when it names a real tab — an explicit click or a deep link
 *    (e.g. `/plans?tab=packages`) always wins, which is why the page writes
 *    this param even for Plans.
 * 2. Plans.
 *
 * Derived from the URL on every render rather than mirrored into state, so a
 * link that arrives after mount still wins and there is no post-paint flash.
 */
export function resolvePlansTab(tabParam: string | null | undefined): PlansTab {
  return asTab(tabParam) ?? 'plans'
}
