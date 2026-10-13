/**
 * A Board column's optional GROUP name (featreq-54bf39b6): Brittany's
 * "Group Boards but have a main overview you can quickly see main groups" -
 * Year-End, Core Accounting, Consulting... A column with no group sits under
 * "Other" on the Board.
 *
 * One rule, shared by both store backends (db/store.js) and the two
 * service-category routes (server.js), so the three can never disagree.
 */

/** The longest a group name may be, measured after trimming. */
export const SERVICE_CATEGORY_GROUP_MAX = 80

/**
 * The group as stored: trimmed, cut to SERVICE_CATEGORY_GROUP_MAX, an empty
 * string (or null) clears it to null. Anything else - an absent key included -
 * is `undefined`, which an update reads as "leave the stored group as it is".
 */
export function cleanServiceCategoryGroup(value) {
  if (value === null) return null
  if (typeof value !== 'string') return undefined
  return value.trim().slice(0, SERVICE_CATEGORY_GROUP_MAX).trim() || null
}

/**
 * Why a request's `groupName` is refused, or null when it is fine. Absent,
 * null and '' are fine (absent leaves it, the other two clear it); a string is
 * fine up to SERVICE_CATEGORY_GROUP_MAX characters after trimming; anything
 * else is refused rather than silently ignored.
 */
export function serviceCategoryGroupRefusal(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') return 'A group name must be text'
  if (value.trim().length > SERVICE_CATEGORY_GROUP_MAX) {
    return `A group name can be at most ${SERVICE_CATEGORY_GROUP_MAX} characters`
  }
  return null
}
