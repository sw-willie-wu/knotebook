import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { ApiFail } from "@/api/client";
import {
  clearUploadQueue,
  dismissUpload,
  getUploadItems,
  isUploadRetryable,
  notifyUploadSessionExpired,
  patchUpload,
  putUpload,
  resetUploadQueueForTest,
  setUploadSessionExpiredHandler,
  uploadQueueSummary,
  useUploadQueue,
  type UploadItem,
} from "./upload-queue-store";

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
      base("e", { size: 1000, status: "done" }),
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
    putUpload(base("d", { status: "done" }));
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
    patchUpload("a", { status: "done" });
    expect(unloadPrevented()).toBe(false);
    patchUpload("a", { status: "uploading" });
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
    putUpload(base("c", { status: "done" }));
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
});
