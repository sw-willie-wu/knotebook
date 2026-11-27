import { useSyncExternalStore } from "react";
import type { ApiFail } from "@/api/client";
import type { PrecheckResult } from "./precheck";

export type UploadStatus = "uploading" | "writing" | "failed" | "unplaced" | "done";

export interface UploadItem {
  id: string;
  noteId: string;
  blockId: string;
  fileName: string;
  size: number;
  loaded: number;
  expectedUrl: string;
  status: UploadStatus;
  error?: ApiFail;
  precheck?: PrecheckResult & { ok: false };
}

export interface UploadQueueSummary {
  /** Items still `uploading` or `writing`. */
  active: number;
  /** 0–100 over the active items' bytes; `null` when none is active. */
  percent: number | null;
}

let items: readonly UploadItem[] = [];
const listeners = new Set<() => void>();

const isActive = (item: UploadItem) => item.status === "uploading" || item.status === "writing";

// Leaving the page stops every running upload, and a stopped upload restarts from zero.
function onBeforeUnload(event: BeforeUnloadEvent) {
  event.preventDefault();
  // Older engines prompt only for a non-empty `returnValue`.
  event.returnValue = true;
}

let unloadGuarded = false;

function syncUnloadGuard() {
  const want = items.some(isActive);
  if (want === unloadGuarded) return;
  unloadGuarded = want;
  if (want) window.addEventListener("beforeunload", onBeforeUnload);
  else window.removeEventListener("beforeunload", onBeforeUnload);
}

function commit(next: readonly UploadItem[]) {
  items = next;
  syncUnloadGuard();
  for (const listener of [...listeners]) listener();
}

export function getUploadItems(): readonly UploadItem[] {
  return items;
}

export function subscribeUploads(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useUploadQueue(): readonly UploadItem[] {
  return useSyncExternalStore(subscribeUploads, getUploadItems);
}

export function uploadQueueSummary(list: readonly UploadItem[]): UploadQueueSummary {
  let size = 0;
  let loaded = 0;
  let active = 0;
  for (const item of list) {
    if (!isActive(item)) continue;
    active += 1;
    size += item.size;
    loaded += item.status === "writing" ? item.size : Math.min(item.loaded, item.size);
  }
  if (active === 0) return { active, percent: null };
  // An empty file has nothing left to send.
  return { active, percent: size === 0 ? 100 : Math.floor((loaded / size) * 100) };
}

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

let sessionExpiredHandler: (() => void) | undefined;

/** The app registers how a lost session is confirmed; the queue itself has no router or query client. */
export function setUploadSessionExpiredHandler(handler: (() => void) | undefined): void {
  sessionExpiredHandler = handler;
}

/** For the upload runner only. */
export function notifyUploadSessionExpired(): void {
  sessionExpiredHandler?.();
}

/** The items, names and files belong to the person signed in; the runner stops whatever was still running. */
export function clearUploadQueue(): void {
  if (items.length > 0) commit([]);
}

export function dismissUpload(id: string): void {
  const item = items.find((i) => i.id === id);
  if (!item || isActive(item)) return;
  commit(items.filter((i) => i.id !== id));
}

/** For the upload runner only. */
export function putUpload(item: UploadItem): void {
  commit([...items.filter((i) => i.id !== item.id), item]);
}

/** For the upload runner only; an id no longer in the queue (dismissed) is ignored. */
export function patchUpload(id: string, patch: Partial<Omit<UploadItem, "id">>): void {
  if (!items.some((i) => i.id === id)) return;
  commit(items.map((i) => (i.id === id ? { ...i, ...patch } : i)));
}

/** Tests only. */
export function resetUploadQueueForTest(): void {
  commit([]);
}
