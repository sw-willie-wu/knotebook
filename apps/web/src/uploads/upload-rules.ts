import type { UploadItem } from "./upload-queue-store";

// Kept out of the queue store: the store sits in the entry bundle, and only the lazy list and the runner need these.

const SAME_ANSWER_STATUSES = new Set([401, 403, 404, 415]);
const SAME_ANSWER_CODES = new Set(["invalid_body", "upload_write_rejected", "upload_write_outdated", "upload_write_deleted"]);

/**
 * Lists the failures a second attempt would meet again (a pre-check refusal, a type or body the server refused, lost
 * access, a missing or trashed note, a signed-out session, a refused write), so an answer nobody listed, such as a
 * busy server or a proxy timeout, keeps its Retry. A size or room refusal stays retryable: the retry's fresh pre-check
 * turns it into the reason when the limit or the room hasn't changed.
 */
export function isUploadRetryable(item: UploadItem): boolean {
  const error = item.error;
  if (item.status !== "failed" || item.precheck !== undefined || !error) return false;
  return !SAME_ANSWER_STATUSES.has(error.status) && !SAME_ANSWER_CODES.has(error.code);
}

export function uploadRetryWaitMs(item: UploadItem, now: number = Date.now()): number {
  return item.retryAt === undefined ? 0 : Math.max(0, item.retryAt - now);
}
