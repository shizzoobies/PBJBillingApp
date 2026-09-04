/**
 * Types for the plain-JS `lib/data-scope.js`, so `src/` can import the shared
 * visibility predicates — the same rules `scopeAppDataForSession` applies on
 * the server — without a second TypeScript copy drifting away from them.
 */

/** Whether a checklist TEMPLATE is visible to a scoped (non-owner) session. */
export declare function isTemplateVisibleToScope(
  template: { isStandard?: boolean; clientId?: string } | null | undefined,
  /** Client ids this member is assigned to. */
  allowedClientIds: Set<string> | undefined,
): boolean

/** Whether a TIME ENTRY is visible to a scoped (non-owner) session. */
export declare function isTimeEntryVisibleToScope(
  entry:
    | {
        employeeId?: string
        isAdministrative?: boolean
        clientId?: string
        groupClientIds?: string[]
      }
    | null
    | undefined,
  /** The session member's id. */
  userId: string,
  /** Client ids this member is assigned to. */
  allowedClientIds: Set<string> | undefined,
): boolean

/**
 * The assigned team for a client — the ONE source of truth. Deliberately
 * reads only `assignedBookkeeperIds`, never the `assignedEmployeeIds` alias.
 * May contain owners: an owner sees every client regardless, so owner
 * membership is a display fact, not an access grant.
 */
export declare function assignedTeamIds(
  client: { assignedBookkeeperIds?: string[] } | null | undefined,
): string[]

/**
 * Whether a non-owner may see this client. Owner sessions bypass this
 * entirely (see `visibleClientIdSet` in server.js).
 */
export declare function isClientVisibleToUser(
  client: { assignedBookkeeperIds?: string[] } | null | undefined,
  userId: string,
): boolean

/**
 * The client ids a user reaches through TASK ASSIGNMENT: live checklists,
 * recurring templates, and template stages they are the assignee of. The
 * visibility half of the old `assignedBookkeeperIds`, computed rather than
 * stored (docs/plans/team-visibility-split-2026-09.md).
 */
export declare function taskClientIdsForUser(
  data:
    | {
        checklists?: Array<{ clientId?: string; assigneeId?: string }>
        checklistTemplates?: Array<{
          clientId?: string
          assigneeId?: string
          stages?: Array<{ assigneeId?: string }>
        }>
      }
    | null
    | undefined,
  userId: string,
): Set<string>

/**
 * Every client id a non-owner may SEE: the owner-picked team they are on UNION
 * the clients they hold a task on. A superset of the team; the team alone gates
 * money. Empty for a falsy user id.
 */
export declare function visibleClientIdsForUser(
  data:
    | {
        clients?: Array<{ id?: string; assignedBookkeeperIds?: string[] }>
        checklists?: Array<{ clientId?: string; assigneeId?: string }>
        checklistTemplates?: Array<{
          clientId?: string
          assigneeId?: string
          stages?: Array<{ assigneeId?: string }>
        }>
      }
    | null
    | undefined,
  userId: string,
): Set<string>
