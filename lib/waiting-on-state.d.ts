/**
 * Types for the shared waiting-on hand-off state machine. Same convention as
 * `checklist-identity.d.ts` — the implementation is plain JS so the server can
 * import it directly, and this file lets the React side use it too.
 */

export type WaitingOnStage = 'waiting' | 'resolved' | 'verified'

/** The two halves of the Delayed page. */
export type DelayedTab = 'blocking' | 'requesting'

/**
 * One "not approved, do it again" lap. Written by the requester's Send back,
 * which clears the resolution it is rejecting — so the resolution is stashed
 * here rather than lost, alongside the requester's new note.
 */
export type WaitingSendBack = {
  at: string
  by: string
  note?: string
  /** The resolution this send-back cleared. */
  resolvedAt?: string
  resolvedBy?: string
}

/** The shape the predicates actually read. Deliberately structural. */
export type WaitingOnLike = {
  id?: string
  blockerId?: string
  requestedBy?: string
  blockerType?: 'employee' | 'client'
  resolvedAt?: string
  resolvedBy?: string
  verifiedAt?: string
  verifiedBy?: string
  sendBacks?: WaitingSendBack[]
}

export type WaitingStepLike = {
  waiting?: boolean
  waitingOns?: WaitingOnLike[]
}

export type WaitingOnPermissionArgs = {
  entry: WaitingOnLike
  userId: string
  isOwner?: boolean
  assigneeId?: string | null
}

export const WAITING_STAGES: readonly WaitingOnStage[]
export const DELAYED_TABS: readonly DelayedTab[]
export const SAVED_WAIT_IS_PERMANENT: string
export const SELF_WAIT_REFUSAL: string
export const REFUSED_WAITING_ON_ACTIONS: readonly string[]

export function waitingOnActionRefusal(
  action: string,
): { status: number; error: string } | null
export function isSelfWait(args: {
  blockerId?: string
  requestedBy?: string
  blockerType?: 'employee' | 'client'
}): boolean

export function waitingOnStage(entry: WaitingOnLike | undefined): WaitingOnStage
export function isClientWait(entry: WaitingOnLike | undefined): boolean
export function isWaitingOnOpen(entry: WaitingOnLike | undefined): boolean
export function canMarkWaitingOnDone(args: WaitingOnPermissionArgs): boolean
export function canVerifyWaitingOn(args: WaitingOnPermissionArgs): boolean
export function canSendBackWaitingOn(args: WaitingOnPermissionArgs): boolean
export function waitingOnConcernsUser(args: {
  entry: WaitingOnLike
  userId: string
  assigneeId?: string | null
}): boolean
export function waitingOnDelayedTab(args: {
  entry: WaitingOnLike
  userId: string
  assigneeId?: string | null
}): DelayedTab | null
export function waitingStepConcernsUser(
  node: WaitingStepLike | undefined,
  args: { userId: string; assigneeId?: string | null },
): boolean
export function waitingsOnDelayedTab<T extends WaitingOnLike>(
  node: { waitingOns?: T[] } | undefined,
  args: { userId: string; assigneeId?: string | null; tab: DelayedTab },
): T[]
export function legacyWaitBelongsOnTab(
  node: WaitingStepLike | undefined,
  args: { userId: string; assigneeId?: string | null; tab: DelayedTab },
): boolean
