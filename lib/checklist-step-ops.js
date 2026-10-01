/**
 * The pure step math for a checklist item's sub-steps and sub-sub-steps: how a
 * tick cascades and rolls up, and how removing a sub-step rolls its parent up.
 *
 * It lives here, not in db/store.js, so the store (which WRITES the result) and
 * the waiting guard in lib/waiting-on-state.js (which SIMULATES the same
 * operation to refuse one that would finish a waiting step) call one
 * implementation. A guard that restates the arithmetic can drift from the store;
 * a guard that runs it cannot. Both backends of the store import these
 * functions unchanged.
 *
 * Plain JS with no Node-only imports, because the waiting guard is shared with
 * the React client. Ids are minted with `globalThis.crypto` when it has
 * `randomUUID`; a browser page served from a non-secure context does not, so
 * `shortId` falls back rather than throwing from a render.
 */

import { rollUpItemDone } from './checklist-step-done.js'

/**
 * Eight characters for a generated id. The simulation the UI runs for the
 * waiting guard normalizes steps and so may mint ids for nodes that have none;
 * those ids are thrown away, so the fallback only has to avoid throwing.
 */
export function shortId() {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (typeof uuid === 'string' && uuid.length >= 8) return uuid.slice(0, 8)
  return Math.random().toString(16).slice(2, 10).padEnd(8, '0')
}

/**
 * Normalize a raw "waiting on a person" list into a clean
 * `{ id, blockerId, requestedBy, note?, createdAt }[]`, plus the optional
 * hand-off fields (`blockerType`, `resolvedAt/By`, `verifiedAt/By` — see
 * `lib/waiting-on-state.js`). Drops malformed entries (any missing a
 * blockerId/requestedBy). Defaults to `[]`. Used on every node (item + sub +
 * sub-sub) so structured blockers survive the JSONB / file round-trip.
 *
 * A client wait still carries a `blockerId` — the server fills it in from the
 * checklist's own client — so the drop rule below needs no exception.
 */
export function normalizeWaitingOns(raw) {
  const list = Array.isArray(raw) ? raw : []
  return list
    .filter(
      (entry) =>
        entry &&
        typeof entry.blockerId === 'string' &&
        entry.blockerId &&
        typeof entry.requestedBy === 'string' &&
        entry.requestedBy,
    )
    .map((entry) => {
      const base = {
        id:
          typeof entry.id === 'string' && entry.id
            ? entry.id
            : `wo-${shortId()}`,
        blockerId: entry.blockerId,
        requestedBy: entry.requestedBy,
        createdAt:
          typeof entry.createdAt === 'string' && entry.createdAt
            ? entry.createdAt
            : new Date().toISOString(),
      }
      if (typeof entry.note === 'string' && entry.note.trim()) {
        base.note = entry.note.trim()
      }
      if (entry.blockerType === 'client') {
        base.blockerType = 'client'
      }
      // Carried through verbatim; absent means that stage hasn't happened yet.
      for (const field of ['resolvedAt', 'resolvedBy', 'verifiedAt', 'verifiedBy']) {
        if (typeof entry[field] === 'string' && entry[field]) {
          base[field] = entry[field]
        }
      }
      // Send-back history, in order. This list is the reason a rejected wait
      // loses nothing: the resolution it cleared is stashed here alongside the
      // requester's new note, so "who did it and when" survives every lap and
      // the ORIGINAL note above is never overwritten. Every read re-normalizes,
      // so dropping this here would silently erase the history on the next load.
      if (Array.isArray(entry.sendBacks)) {
        const events = entry.sendBacks
          .filter(
            (event) =>
              event &&
              typeof event.at === 'string' &&
              event.at &&
              typeof event.by === 'string' &&
              event.by,
          )
          .map((event) => {
            const stamped = { at: event.at, by: event.by }
            if (typeof event.note === 'string' && event.note.trim()) {
              stamped.note = event.note.trim()
            }
            for (const field of ['resolvedAt', 'resolvedBy']) {
              if (typeof event[field] === 'string' && event[field]) {
                stamped[field] = event[field]
              }
            }
            return stamped
          })
        if (events.length > 0) base.sendBacks = events
      }
      // Questions the person being waited on asked WITHOUT finishing. Same
      // stamped shape as a send-back and the same reason for existing: every
      // read re-normalizes, so a key that isn't listed here is erased on the
      // next load. Append-only — asking never resolves anything, so nothing
      // rewrites or removes an entry.
      if (Array.isArray(entry.questions)) {
        const asked = entry.questions
          .filter(
            (event) =>
              event &&
              typeof event.at === 'string' &&
              event.at &&
              typeof event.by === 'string' &&
              event.by,
          )
          .map((event) => {
            const stamped = { at: event.at, by: event.by }
            if (typeof event.note === 'string' && event.note.trim()) {
              stamped.note = event.note.trim()
            }
            return stamped
          })
        if (asked.length > 0) base.questions = asked
      }
      return base
    })
}

/**
 * Normalize a raw sub-sub-items value (deepest level) into a clean
 * `{ id, title, done }[]`. Drops malformed entries. Sub-sub-items never nest
 * further. `withDone` controls whether `done` is included.
 */
export function normalizeSubSubItems(raw, { withDone = true } = {}) {
  const list = Array.isArray(raw) ? raw : []
  return list
    .filter((sub) => sub && typeof sub.title === 'string' && sub.title.trim())
    .map((sub) => {
      const base = {
        id:
          typeof sub.id === 'string' && sub.id
            ? sub.id
            : `subsubitem-${shortId()}`,
        title: sub.title.trim(),
      }
      if (withDone) base.done = Boolean(sub.done)
      // Preserve the per-node due spec — template nodes carry the recurring
      // `dueDayOfMonth` / fixed `dueDate`; live nodes carry only a concrete
      // resolved `dueDate`. Dropping these silently loses sub-node due dates.
      if (typeof sub.dueDate === 'string' && sub.dueDate) base.dueDate = sub.dueDate
      if (typeof sub.dueDayOfMonth === 'number' && sub.dueDayOfMonth >= 1) {
        base.dueDayOfMonth = sub.dueDayOfMonth
      }
      // Preserve structured person-blockers on live sub-sub nodes.
      if (withDone) {
        const waitingOns = normalizeWaitingOns(sub.waitingOns)
        if (waitingOns.length > 0) base.waitingOns = waitingOns
      }
      return base
    })
}

/**
 * Normalize a raw sub-items value (JSONB column or app-shaped array) into a
 * clean `{ id, title, done, subItems? }[]`. Drops malformed entries. Recurses
 * one level deeper to normalize any sub-sub-items. `withDone` controls whether
 * `done` is included (live checklists carry it; template items don't). For a
 * sub-item that has sub-sub-items `done` is derived from those.
 */
export function normalizeSubItems(raw, { withDone = true } = {}) {
  const list = Array.isArray(raw) ? raw : []
  return list
    .filter((sub) => sub && typeof sub.title === 'string' && sub.title.trim())
    .map((sub) => {
      const base = {
        id: typeof sub.id === 'string' && sub.id ? sub.id : `subitem-${shortId()}`,
        title: sub.title.trim(),
      }
      // Preserve the per-node due spec (see normalizeSubSubItems) so sub-item
      // due dates survive the JSONB round-trip.
      if (typeof sub.dueDate === 'string' && sub.dueDate) base.dueDate = sub.dueDate
      if (typeof sub.dueDayOfMonth === 'number' && sub.dueDayOfMonth >= 1) {
        base.dueDayOfMonth = sub.dueDayOfMonth
      }
      // Preserve the "waiting on" flag + note on live sub-items so they survive
      // the JSONB round-trip (drives the owner's Delayed page).
      if (withDone) {
        if (sub.waiting) base.waiting = true
        if (typeof sub.waitingOn === 'string' && sub.waitingOn.trim()) {
          base.waitingOn = sub.waitingOn.trim()
        }
        if (typeof sub.waitingForChecklistId === 'string' && sub.waitingForChecklistId) {
          base.waitingForChecklistId = sub.waitingForChecklistId
        }
        // Preserve structured person-blockers on live sub-items.
        const waitingOns = normalizeWaitingOns(sub.waitingOns)
        if (waitingOns.length > 0) base.waitingOns = waitingOns
      }
      const subSubItems = normalizeSubSubItems(sub.subItems, { withDone })
      if (subSubItems.length > 0) {
        base.subItems = subSubItems
      }
      if (withDone) {
        // A sub-item with sub-sub-items is the roll-up of those; otherwise it
        // keeps its own stored `done`.
        base.done =
          subSubItems.length > 0
            ? subSubItems.every((subSub) => Boolean(subSub.done))
            : Boolean(sub.done)
      }
      return base
    })
}

/**
 * Set every sub-sub-item under a sub-item to `value`. Returns a new sub-item.
 */
export function cascadeSubItem(sub, value) {
  const subSubItems = normalizeSubSubItems(sub.subItems, { withDone: true })
  const next = { ...sub, done: value }
  if (subSubItems.length > 0) {
    next.subItems = subSubItems.map((subSub) => ({ ...subSub, done: value }))
  }
  return next
}

/**
 * Pure toggle of a checklist item's `done`/`subItems`, recursing the three
 * levels. Given the item's current `subItems` and `done`, plus which depth is
 * being toggled, returns the next `{ subItems, done }` — or `null` when the
 * referenced sub-item / sub-sub-item does not exist.
 *
 * - `subSubItemId`: flip that sub-sub-item; recompute its sub-item, then the
 *   top item.
 * - `subItemId` only: flip that sub-item, cascading down to all its
 *   sub-sub-items; recompute the top item.
 * - neither: flip the top item, cascading all the way down.
 */
export function applyItemToggle(rawSubItems, itemDone, { subItemId, subSubItemId } = {}) {
  const subItems = normalizeSubItems(rawSubItems, { withDone: true })

  if (subSubItemId) {
    if (!subItemId) return null
    const parent = subItems.find((sub) => sub.id === subItemId)
    if (!parent) return null
    const parentSubSubItems = normalizeSubSubItems(parent.subItems, { withDone: true })
    if (!parentSubSubItems.some((subSub) => subSub.id === subSubItemId)) return null
    const nextSubItems = subItems.map((sub) => {
      if (sub.id !== subItemId) return sub
      const nextSubSubItems = parentSubSubItems.map((subSub) =>
        subSub.id === subSubItemId ? { ...subSub, done: !subSub.done } : subSub,
      )
      return {
        ...sub,
        subItems: nextSubSubItems,
        done: nextSubSubItems.every((subSub) => subSub.done),
      }
    })
    return { subItems: nextSubItems, done: nextSubItems.every((sub) => sub.done) }
  }

  if (subItemId) {
    const target = subItems.find((sub) => sub.id === subItemId)
    if (!target) return null
    // Toggling a sub-item flips it and cascades to every sub-sub-item.
    const cascadeValue = !rollUpItemDone(target)
    const nextSubItems = subItems.map((sub) =>
      sub.id === subItemId ? cascadeSubItem(sub, cascadeValue) : sub,
    )
    return { subItems: nextSubItems, done: nextSubItems.every((sub) => sub.done) }
  }

  if (subItems.length > 0) {
    // Toggling the top item cascades to every sub-item and sub-sub-item.
    const cascadeValue = !subItems.every((sub) => rollUpItemDone(sub))
    const nextSubItems = subItems.map((sub) => cascadeSubItem(sub, cascadeValue))
    return { subItems: nextSubItems, done: cascadeValue }
  }

  return { subItems, done: !itemDone }
}

/**
 * Pure removal of one sub-item from a checklist item: returns the next
 * `{ subItems, done }` — or `null` when the sub-item does not exist. With
 * sub-items left the item's `done` is their roll-up (removing the last open one
 * completes it); with none left the item is a flat step again and keeps its
 * stored `done`.
 */
export function applySubItemRemoval(rawSubItems, itemDone, subItemId) {
  const subItems = normalizeSubItems(rawSubItems, { withDone: true })
  if (!subItems.some((sub) => sub.id === subItemId)) return null
  const nextSubItems = subItems.filter((sub) => sub.id !== subItemId)
  const done =
    nextSubItems.length > 0 ? nextSubItems.every((sub) => sub.done) : Boolean(itemDone)
  return { subItems: nextSubItems, done }
}

/**
 * Pure removal of one sub-sub-item: returns the next `{ subItems, done }` — or
 * `null` when the sub-item / sub-sub-item does not exist. The sub-item's `done`
 * becomes the roll-up of what is left (or its stored `done` once it has no
 * sub-sub-items), then the top item's `done` is the roll-up of its sub-items.
 */
export function applySubSubItemRemoval(rawSubItems, { subItemId, subSubItemId } = {}) {
  const subItems = normalizeSubItems(rawSubItems, { withDone: true })
  const parent = subItems.find((sub) => sub.id === subItemId)
  if (!parent) return null
  const parentSubSubItems = normalizeSubSubItems(parent.subItems, { withDone: true })
  if (!parentSubSubItems.some((subSub) => subSub.id === subSubItemId)) return null
  const nextSubItems = subItems.map((sub) => {
    if (sub.id !== subItemId) return sub
    const nextSubSubItems = parentSubSubItems.filter((subSub) => subSub.id !== subSubItemId)
    // With sub-sub-items the sub-item is the roll-up; with none left, keep its
    // current stored `done`.
    const nextDone =
      nextSubSubItems.length > 0
        ? nextSubSubItems.every((subSub) => subSub.done)
        : Boolean(sub.done)
    const nextSub = { ...sub, done: nextDone }
    if (nextSubSubItems.length > 0) {
      nextSub.subItems = nextSubSubItems
    } else {
      delete nextSub.subItems
    }
    return nextSub
  })
  return { subItems: nextSubItems, done: nextSubItems.every((sub) => sub.done) }
}
