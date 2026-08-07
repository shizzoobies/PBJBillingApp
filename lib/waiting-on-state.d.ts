/**
 * Types for the shared waiting-on hand-off state machine. Same convention as
 * `checklist-identity.d.ts` — the implementation is plain JS so the server can
 * import it directly, and this file lets the React side use it too.
 */

export type WaitingOnStage = 'waiting' | 'resolved' | 'verified'

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

export function waitingOnStage(entry: WaitingOnLike | undefined): WaitingOnStage
export function isClientWait(entry: WaitingOnLike | undefined): boolean
export function isWaitingOnOpen(entry: WaitingOnLike | undefined): boolean
export function canMarkWaitingOnDone(args: WaitingOnPermissionArgs): boolean
export function canVerifyWaitingOn(args: WaitingOnPermissionArgs): boolean
export function waitingOnConcernsUser(args: {
  entry: WaitingOnLike
  userId: string
  assigneeId?: string | null
}): boolean
export function waitingStepConcernsUser(
  node: WaitingStepLike | undefined,
  args: { userId: string; assigneeId?: string | null },
): boolean
