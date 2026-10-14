/**
 * How long a Send that claimed a letter (the "sending" log entry) counts as still running when
 * no send was logged after it. After this the claim is treated as a send that died: the store
 * lets the letter be sent again and the editor says the earlier send did not finish. ONE copy,
 * imported by lib/engagement-send.js and by the engagement editor (so it is browser-safe).
 */
export const ENGAGEMENT_SENDING_MS = 120000
