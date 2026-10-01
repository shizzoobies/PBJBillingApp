/**
 * The one rule for "is this checklist step done?", shared by the server
 * (`db/store.js`, which decides what a push carries forward) and the client
 * (`src/lib/utils.ts`, which counts steps in the push dialog), so the dialog's
 * "N done, M open" can never drift from what the push actually does.
 *
 * Roll-up completion, recursing up to three levels (item -> sub-item ->
 * sub-sub-item): a node with children is done exactly when every child is done;
 * a node with no children keeps its own stored `done`. A step marked done with
 * an unchecked sub-step is therefore OPEN. Pure.
 */
export function rollUpItemDone(item) {
  if (Array.isArray(item.subItems) && item.subItems.length > 0) {
    return item.subItems.every((sub) => rollUpItemDone(sub))
  }
  return Boolean(item.done)
}
