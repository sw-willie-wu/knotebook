import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { ApiFail } from "@/api/client";
import {
  clearUploadQueue,
  dismissUpload,
  getUploadItems,
  notifyUploadSessionExpired,
  patchUpload,
  putUpload,
  resetUploadQueueForTest,
  removeUpload,
  setUploadSessionExpiredHandler,
  setUploadUserSource,
  currentUploadUserId,
  uploadQueueSummary,
  useUploadQueue,
  type UploadItem,
} from "./upload-queue-store";
import { isUploadRetryable, uploadRetryWaitMs } from "./upload-rules";

const base = (id: string, over: Partial<UploadItem> = {}): UploadItem => ({
  id,
  noteId: "note-1",
  blockId: `b-${id}`,
  fileName: `${id}.mp4`,
  size: 100,
  loaded: 0,
  expectedUrl: "",
  status: "uploading",
  ...over,
});

const unloadPrevented = () => {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

afterEach(() => {
  setUploadSessionExpiredHandler(undefined);
  setUploadUserSource(undefined);
  resetUploadQueueForTest();
  vi.restoreAllMocks();
});

describe("upload queue store", () => {
  it("summary counts only uploading and writing items; the percentage is over their bytes, writing counted as sent", () => {
    const list = [
      base("a", { size: 100, loaded: 50 }),
      base("b", { size: 300, status: "writing", loaded: 10 }),
      base("c", { size: 1000, status: "failed" }),
      base("d", { size: 1000, status: "unplaced" }),
    ];
    expect(uploadQueueSummary(list)).toEqual({ active: 2, percent: 87 });
    expect(uploadQueueSummary([base("c", { status: "failed" })])).toEqual({ active: 0, percent: null });
    expect(uploadQueueSummary([base("z", { size: 0 })])).toEqual({ active: 1, percent: 100 });
  });

  it("useUploadQueue re-renders with each change and keeps noteId for linking back", () => {
    const { result } = renderHook(() => useUploadQueue());
    expect(result.current).toEqual([]);
    act(() => putUpload(base("a", { noteId: "note-7" })));
    expect(result.current).toEqual([expect.objectContaining({ id: "a", noteId: "note-7" })]);
    act(() => patchUpload("a", { loaded: 40 }));
    expect(result.current[0]!.loaded).toBe(40);
  });

  it("beforeunload is guarded only while an item is uploading or writing", () => {
    const add = vi.spyOn(window, "addEventListener");
    putUpload(base("f", { status: "failed" }));
    putUpload(base("u", { status: "unplaced" }));
    expect(add.mock.calls.filter(([type]) => type === "beforeunload")).toHaveLength(0);
    expect(unloadPrevented()).toBe(false);

    putUpload(base("a"));
    expect(unloadPrevented()).toBe(true);
    const handler = add.mock.calls.find(([type]) => type === "beforeunload")![1] as (e: unknown) => void;
    const legacy = { preventDefault: vi.fn(), returnValue: "" as unknown };
    handler(legacy);
    expect(legacy.preventDefault).toHaveBeenCalledTimes(1);
    expect(legacy.returnValue).toBeTruthy();
    patchUpload("a", { status: "writing" });
    expect(unloadPrevented()).toBe(true);
    removeUpload("a");
    expect(unloadPrevented()).toBe(false);
    putUpload(base("a"));
    expect(unloadPrevented()).toBe(true);
    patchUpload("a", { status: "failed" });
    expect(unloadPrevented()).toBe(false);
  });

  it("dismissUpload removes a finished item but not a running one", () => {
    putUpload(base("a"));
    putUpload(base("b", { status: "failed" }));
    dismissUpload("a");
    dismissUpload("b");
    expect(getUploadItems().map((i) => i.id)).toEqual(["a"]);
  });

  it("patchUpload ignores an id no longer in the queue", () => {
    putUpload(base("a", { status: "failed" }));
    dismissUpload("a");
    patchUpload("a", { status: "uploading" });
    expect(getUploadItems()).toEqual([]);
  });

  const failedWith = (status: number, code: string) => base("a", { status: "failed", error: new ApiFail(status, code, "x") });

  it.each([
    [0, "upload_interrupted"],
    [500, "internal"],
    [503, "internal"],
    [429, "rate_limited"],
    [413, "file_too_large"],
    [409, "storage_quota_exceeded"],
    [409, "server_busy"],
    [408, "internal"],
    [418, "something_new"],
    [400, "bad_request"],
  ])("isUploadRetryable: %i %s can get past on a second attempt", (status, code) => {
    expect(isUploadRetryable(failedWith(status, code))).toBe(true);
  });

  it.each([
    [415, "unsupported_media_type"],
    [400, "invalid_body"],
    [403, "forbidden"],
    [404, "not_found"],
    [404, "in_trash"],
    [401, "unauthorized"],
    [403, "upload_write_rejected"],
    [0, "upload_write_outdated"],
    [404, "upload_write_deleted"],
  ])("isUploadRetryable: %i %s would fail the same way", (status, code) => {
    expect(isUploadRetryable(failedWith(status, code))).toBe(false);
  });

  it("isUploadRetryable: not for a pre-check refusal, a failed item without an error, or an item that isn't failed", () => {
    expect(isUploadRetryable(base("a", { status: "failed", precheck: { ok: false, reason: "noRoom", roomBytes: 1 } }))).toBe(false);
    expect(isUploadRetryable(base("a", { status: "failed" }))).toBe(false);
    expect(isUploadRetryable(base("a", { status: "uploading", error: new ApiFail(0, "upload_interrupted", "x") }))).toBe(false);
    expect(isUploadRetryable(base("a", { status: "unplaced" }))).toBe(false);
  });

  it("clearUploadQueue empties the queue, running items included, and lifts the leave-page guard", () => {
    putUpload(base("a"));
    putUpload(base("b", { status: "failed" }));
    putUpload(base("c", { status: "unplaced" }));
    clearUploadQueue();
    expect(getUploadItems()).toEqual([]);
    expect(unloadPrevented()).toBe(false);
  });

  it("the session-expired handler is called when registered; unregistered, notifying does nothing", () => {
    const handler = vi.fn();
    notifyUploadSessionExpired();
    setUploadSessionExpiredHandler(handler);
    notifyUploadSessionExpired();
    expect(handler).toHaveBeenCalledTimes(1);
    setUploadSessionExpiredHandler(undefined);
    notifyUploadSessionExpired();
    expect(handler).toHaveBeenCalledTimes(1);
  });
  it("removeUpload drops an item whatever its status, running ones included", () => {
    putUpload(base("a", { status: "writing" }));
    putUpload(base("b", { status: "failed" }));
    removeUpload("a");
    expect(getUploadItems().map((i) => i.id)).toEqual(["b"]);
    removeUpload("missing");
    expect(getUploadItems().map((i) => i.id)).toEqual(["b"]);
  });

  it("uploadRetryWaitMs: the time left before the server said to try again, never negative; 0 without a retryAt", () => {
    expect(uploadRetryWaitMs(base("a", { status: "failed" }), 1_000)).toBe(0);
    expect(uploadRetryWaitMs(base("a", { status: "failed", retryAt: 5_000 }), 1_000)).toBe(4_000);
    expect(uploadRetryWaitMs(base("a", { status: "failed", retryAt: 5_000 }), 9_000)).toBe(0);
  });

  it("the user source: unregistered, the signed-in id is unknown; registered, it answers from the source", () => {
    expect(currentUploadUserId()).toBeUndefined();
    setUploadUserSource(() => "alice");
    expect(currentUploadUserId()).toBe("alice");
  });

  it("imports only types from the pre-check module and nothing from the runner or the rules, so none of them reaches the entry", () => {
    const src = readFileSync(join(process.cwd(), "src/uploads/upload-queue-store.ts"), "utf8");
    const fromPrecheck = [...src.matchAll(/^import\s+(type\s+)?[^;]*from\s+["']\.\/precheck["']/gm)];
    expect(fromPrecheck.length).toBeGreaterThan(0);
    for (const m of fromPrecheck) expect(m[1], m[0]).toBeDefined();
    expect(src).not.toMatch(/upload-runner|upload-rules/);
  });
});
