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

/**
 * One question the person being waited on asked without finishing the wait.
 * Append-only: asking never resolves anything, so these accumulate beside the
 * send-backs as the two sides of the same conversation.
 */
export type WaitingQuestion = {
  at: string
  by: string
  note?: string
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
  questions?: WaitingQuestion[]
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
export const SAVED_WAIT_FIELDS_ARE_LOCKED: string
export const LOCKED_WAIT_STEP_FIELDS: readonly string[]
export const SELF_WAIT_REFUSAL: string
export const REFUSED_WAITING_ON_ACTIONS: readonly string[]

export function hasLiveSavedWait(node: WaitingStepLike | undefined): boolean
export function hasLiveSavedWaitInTree(
  node: (WaitingStepLike & { subItems?: unknown[] }) | undefined,
): boolean
export function waitingBlocksCompletion(
  node: (WaitingStepLike & { done?: boolean; subItems?: unknown[] }) | undefined,
): boolean

/** The step as the guard reads it: its own done and wait state plus its sub-steps. */
export type StepSimulationItem = WaitingStepLike & { done?: boolean; subItems?: unknown[] }

export const REMOVAL_WOULD_COMPLETE_WAITING_STEP: string
/** The tooltip on a waiting checkbox the owner may tick anyway: her tick closes the wait. */
export const OWNER_TICK_CLEARS_WAIT_TITLE: string
/** One wording per place a blocked checkbox's wait comes from: the tooltip and the server answer. */
export const WAITING_BLOCK_TITLES: Readonly<{ own: string; below: string; above: string }>
export function operationCompletesWaitingStep(
  itemBefore: StepSimulationItem | undefined,
  itemAfter: StepSimulationItem | undefined,
): boolean
export function waitingToggleRefusal(
  item: StepSimulationItem | undefined,
  subItemId?: string,
  subSubItemId?: string,
): {
  status: number
  error: string
  message: string
  where: 'own' | 'below' | 'above'
} | null
export function toggleWouldCompleteWaitingStep(
  item: StepSimulationItem | undefined,
  subItemId?: string,
  subSubItemId?: string,
): boolean
/**
 * The owner's tick: the item after the store's own toggle, with the waits closed
 * on exactly the nodes the tick completed. `closedWaits` has one entry per wait
 * closed. Null when the target does not exist.
 */
export function toggleClosingWaits(
  item: StepSimulationItem | undefined,
  subItemId: string | undefined,
  subSubItemId: string | undefined,
  closedBy: { userId: string; at: string },
): {
  item: StepSimulationItem
  closedWaits: Array<{ path: string[]; label: string }>
} | null
export function removalWouldCompleteWaitingStep(
  item: StepSimulationItem | undefined,
  subItemId?: string,
  subSubItemId?: string,
): boolean
export function waitForTaskLinkDenial(args: {
  checklist: { id?: string; clientId?: string } | undefined
  pool?: Array<{ id?: string; clientId?: string }>
  taskId: string
  current?: string
}): { status: number; error: string } | null
export function waitingLockRefusal(
  node: WaitingStepLike | undefined,
  patch: Record<string, unknown> | undefined,
): { status: number; error: string } | null

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
export function canAskWaitingOnQuestion(args: WaitingOnPermissionArgs): boolean
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
