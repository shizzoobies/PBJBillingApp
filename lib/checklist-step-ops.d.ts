/**
 * Types for the pure step math in `checklist-step-ops.js`, shared by the store
 * (which writes the result) and the waiting guard (which simulates it).
 */

import type { WaitingOnLike } from './waiting-on-state.js'

export interface StepOpsNode {
  id?: string
  title?: string
  label?: string
  done?: boolean
  waiting?: boolean
  waitingOn?: string
  waitingForChecklistId?: string
  waitingOns?: WaitingOnLike[]
  subItems?: StepOpsNode[]
  [key: string]: unknown
}

export interface StepOpsResult {
  subItems: StepOpsNode[]
  done: boolean
}

export function normalizeWaitingOns(raw: unknown): WaitingOnLike[]
export function normalizeSubSubItems(
  raw: unknown,
  options?: { withDone?: boolean },
): StepOpsNode[]
export function normalizeSubItems(raw: unknown, options?: { withDone?: boolean }): StepOpsNode[]
export function cascadeSubItem(sub: StepOpsNode, value: boolean): StepOpsNode
export function applyItemToggle(
  rawSubItems: unknown,
  itemDone: boolean | undefined,
  target?: { subItemId?: string; subSubItemId?: string },
): StepOpsResult | null
export function applySubItemRemoval(
  rawSubItems: unknown,
  itemDone: boolean | undefined,
  subItemId: string,
): StepOpsResult | null
export function applySubSubItemRemoval(
  rawSubItems: unknown,
  target: { subItemId?: string; subSubItemId?: string },
): StepOpsResult | null
