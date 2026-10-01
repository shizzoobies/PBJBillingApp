/**
 * Types for the shared step-done rule in `checklist-step-done.js`, so the
 * client and the server read one definition of "done".
 */

export interface RollUpNode {
  done?: boolean
  subItems?: RollUpNode[]
}

export function rollUpItemDone(item: RollUpNode): boolean
