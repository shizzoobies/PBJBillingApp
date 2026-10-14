/**
 * How many engagements the list answers: the newest this many, after the status and kind
 * filters. ONE copy, imported by the store (the cap) and by the Engagements page (the line
 * "Showing the newest N" when exactly this many come back), so the two never drift.
 */
export const ENGAGEMENT_LIST_LIMIT = 500
