import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { FakeXhr, installFakeXhr, lastXhr } from "@/test/fake-xhr";
import type { PrecheckCtx } from "./precheck";

// The toast is a spy (same technique as `NoteEditor.test.ts`): what is asserted is whether there was a hint, how many times, and what text.
const toastMock = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/toast", () => ({ toast: toastMock }));
const onScreen = vi.hoisted(() => ({ value: false }));

// The write waits on the note's connection; these tests stop at the upload, so the connection never becomes writable.
vi.mock("@/collab/note-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/collab/note-connection")>()),
  isNoteOnScreen: () => onScreen.value,
  acquireNoteConnection: () => ({
    doc: null,
    provider: {},
    getState: () => ({ phase: "connecting" }),
    isSynced: () => false,
    subscribe: () => () => {},
    whenWritable: () => new Promise(() => {}),
    hasEditor: () => false,
    release: () => {},
  }),
}));

const { createUploadFile } = await import("./upload-file");
const { createPrecheckCtxProvider } = await import("./precheck");
const { resetUploadRunnerForTest } = await import("./upload-runner");
const store = await import("./upload-queue-store");

const MIB = 1_048_576;

function fileOf(name: string, size = 1, type = ""): File {
  const f = new File([new Uint8Array([1])], name, { type });
  Object.defineProperty(f, "size", { value: size });
  return f;
}

const translate = (key: string, opts?: Record<string, unknown>) => (opts === undefined ? `t:${key}` : `t:${key}:${JSON.stringify(opts)}`);
const ctx = (over: Partial<PrecheckCtx> = {}) => () => Promise.resolve<PrecheckCtx>({ maxUploadBytes: 10 * MIB, maxMediaUploadBytes: 100 * MIB, roomBytes: null, ...over });

// The upload starts after createUploadFile has resolved; a macrotask lets the pre-check, the queue and the XHR catch up.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let clockBase = 0;
beforeEach(() => {
  installFakeXhr();
  toastMock.mockClear();
  onScreen.value = false;
  // The toast de-dupe map is module-level: each test starts far past the previous one's 5 s window.
  clockBase += 1_000_000;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(clockBase);
});

afterEach(() => {
  resetUploadRunnerForTest();
  store.resetUploadQueueForTest();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function upload(over: Partial<Parameters<typeof createUploadFile>[0]> = {}) {
  const uploadFile = createUploadFile({ noteId: "note-1", translate, precheckCtx: ctx(), ...over });
  return async (file: File, blockId?: string) => {
    const result = await uploadFile(file, blockId);
    await flush();
    return result;
  };
}

describe("createUploadFile", () => {
  it("resolves with the name before the pre-check has answered; the upload is queued once it does", async () => {
    let answer!: (ctx: PrecheckCtx) => void;
    const uploadFile = createUploadFile({ noteId: "note-1", translate, precheckCtx: () => new Promise((resolve) => (answer = resolve)) });
    await expect(uploadFile(fileOf("clip.mp4", 2 * MIB, "video/mp4"), "b1")).resolves.toEqual({ props: { name: "clip.mp4" } });
    expect(store.getUploadItems()).toEqual([]);
    expect(FakeXhr.instances).toHaveLength(0);
    answer({ maxUploadBytes: 10 * MIB, maxMediaUploadBytes: 100 * MIB, roomBytes: null });
    await flush();
    expect(FakeXhr.instances).toHaveLength(1);
    expect(lastXhr().url).toBe("/api/notes/note-1/uploads");
    expect(store.getUploadItems()).toMatchObject([{ noteId: "note-1", blockId: "b1", expectedUrl: "", status: "uploading" }]);
  });

  it("an mp4 over the media limit and a pdf over the room: nothing is sent, the block's item carries the reason", async () => {
    const uploadFile = upload({ precheckCtx: ctx({ roomBytes: 3 * MIB }) });
    await expect(uploadFile(fileOf("all-day.mp4", 300 * MIB, "video/mp4"), "b1")).resolves.toEqual({ props: { name: "all-day.mp4" } });
    await expect(uploadFile(fileOf("quote.pdf", 5 * MIB, "application/pdf"), "b2")).resolves.toEqual({ props: { name: "quote.pdf" } });
    expect(FakeXhr.instances).toHaveLength(0);
    expect(store.getUploadItems().map((i) => [i.blockId, i.status, i.precheck?.reason])).toEqual([
      ["b1", "failed", "tooLarge"],
      ["b2", "failed", "noRoom"],
    ]);
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("someone who can't see the space's usage (share editor): no usage request, the upload is sent and the server decides", async () => {
    const fetchMock = vi.fn((url: string) => Promise.resolve(Response.json(url === "/api/auth/config" ? { maxUploadBytes: 10 * MIB, maxMediaUploadBytes: 100 * MIB } : {})));
    vi.stubGlobal("fetch", fetchMock);
    const precheckCtx = createPrecheckCtxProvider(new QueryClient(), { groupId: "g1", canViewUsage: false });
    await upload({ precheckCtx })(fileOf("quote.pdf", 5 * MIB, "application/pdf"), "b1");
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["/api/auth/config"]);
    expect(FakeXhr.instances).toHaveLength(1);
  });

  it("a provider whose usage fetch fails: the upload is still sent and createUploadFile resolves", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => (url === "/api/auth/config" ? Promise.resolve(Response.json({ maxUploadBytes: 10 * MIB })) : Promise.reject(new TypeError("offline")))),
    );
    const precheckCtx = createPrecheckCtxProvider(new QueryClient(), { groupId: null, canViewUsage: true });
    await expect(upload({ precheckCtx })(fileOf("quote.pdf", 5 * MIB, "application/pdf"), "b1")).resolves.toEqual({ props: { name: "quote.pdf" } });
    expect(FakeXhr.instances).toHaveLength(1);
  });

  it("files handed over one after another don't wait for each other's pre-check: all three checks are running at once", async () => {
    let calls = 0;
    let answer!: (ctx: PrecheckCtx) => void;
    const shared = new Promise<PrecheckCtx>((resolve) => (answer = resolve));
    const uploadFile = createUploadFile({ noteId: "note-1", translate, precheckCtx: () => (calls += 1, shared) });
    for (const blockId of ["b1", "b2", "b3"]) await uploadFile(fileOf(`${blockId}.pdf`, MIB, "application/pdf"), blockId);
    expect(calls).toBe(3);
    expect(FakeXhr.instances).toHaveLength(0);
    answer({ maxUploadBytes: 10 * MIB, roomBytes: null });
    await flush();
    expect(FakeXhr.instances).toHaveLength(3);
  });

  it("never rejects, even when the provider itself rejects", async () => {
    await expect(upload({ precheckCtx: () => Promise.reject(new Error("boom")) })(fileOf("a.png", 1, "image/png"), "b1")).resolves.toEqual({
      props: { name: "a.png" },
    });
    expect(FakeXhr.instances).toHaveLength(1);
  });

  it("no block id (nothing to place the file into): nothing is sent", async () => {
    await expect(upload()(fileOf("a.png", 1, "image/png"))).resolves.toEqual({ props: { name: "a.png" } });
    expect(FakeXhr.instances).toHaveLength(0);
  });

  it("a failure toasts errors.<code> once; the item stays for the block", async () => {
    await upload()(fileOf("a.png", 1, "image/png"), "b1");
    lastXhr().respond(415, { error: { code: "unsupported_media_type", message: "nope" } });
    await flush();
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith({ title: "t:errors.unsupported_media_type" });
    expect(store.getUploadItems()[0]).toMatchObject({ blockId: "b1", status: "failed" });
  });

  it("a failure while the note's editor is on screen doesn't toast: the block shows it", async () => {
    onScreen.value = true;
    await upload()(fileOf("a.png", 1, "image/png"), "b1");
    lastXhr().respond(415, { error: { code: "unsupported_media_type", message: "nope" } });
    await flush();
    expect(toastMock).not.toHaveBeenCalled();
    expect(store.getUploadItems()[0]).toMatchObject({ blockId: "b1", status: "failed" });
  });

  it("the editor is checked when the upload fails, not when it started", async () => {
    onScreen.value = true;
    await upload()(fileOf("a.png", 4, "image/png"), "b1");
    onScreen.value = false;
    lastXhr().respond(415, { error: { code: "unsupported_media_type", message: "nope" } });
    await flush();
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it("progress before the failure doesn't end the watch: the failure still toasts", async () => {
    await upload()(fileOf("a.png", 4, "image/png"), "b1");
    lastXhr().progress(1, 4);
    lastXhr().progress(2, 4);
    lastXhr().respond(415, { error: { code: "unsupported_media_type", message: "nope" } });
    await flush();
    expect(toastMock).toHaveBeenCalledWith({ title: "t:errors.unsupported_media_type" });
  });

  it("an SVG refused as unsupported gets the SVG-specific toast", async () => {
    await upload()(fileOf("icon.svg", 1, "image/svg+xml"), "b1");
    lastXhr().respond(415, { error: { code: "unsupported_media_type", message: "nope" } });
    await flush();
    expect(toastMock).toHaveBeenCalledWith({ title: "t:errors.svg_unusable" });
    expect(toastMock).not.toHaveBeenCalledWith({ title: "t:errors.unsupported_media_type" });
  });

  it("de-dupe is by the text shown: an SVG 415 and a non-SVG 415 within 5 s both toast; the same text twice toasts once", async () => {
    const uploadFile = upload();
    await uploadFile(fileOf("icon.svg", 1, "image/svg+xml"), "b1");
    lastXhr().respond(415, { error: { code: "unsupported_media_type", message: "nope" } });
    await uploadFile(fileOf("a.png", 1, "image/png"), "b2");
    lastXhr().respond(415, { error: { code: "unsupported_media_type", message: "nope" } });
    await uploadFile(fileOf("b.png", 1, "image/png"), "b3");
    lastXhr().respond(415, { error: { code: "unsupported_media_type", message: "nope" } });
    await flush();
    expect(toastMock.mock.calls).toEqual([[{ title: "t:errors.svg_unusable" }], [{ title: "t:errors.unsupported_media_type" }]]);
  });

  it("after the 5 s window the same failure toasts again", async () => {
    const uploadFile = upload();
    await uploadFile(fileOf("a.png", 1, "image/png"), "b1");
    lastXhr().respond(415, { error: { code: "unsupported_media_type", message: "nope" } });
    await flush();
    vi.setSystemTime(clockBase + 5001);
    await uploadFile(fileOf("b.png", 1, "image/png"), "b2");
    lastXhr().respond(415, { error: { code: "unsupported_media_type", message: "nope" } });
    await flush();
    expect(toastMock).toHaveBeenCalledTimes(2);
  });

  it("409 storage_quota_exceeded: title plus the usage sentence", async () => {
    await upload()(fileOf("a.png", 1, "image/png"), "b1");
    lastXhr().respond(409, { error: { code: "storage_quota_exceeded", message: "x" }, storage: { incomingBytes: null, usedBytes: 1572864, quotaBytes: 1048576 } });
    await flush();
    expect(toastMock).toHaveBeenCalledWith({ title: "t:errors.storage_quota_exceeded", description: 't:storage.quotaDetail:{"used":"1.5 MB","quota":"1 MB"}' });
  });

  it("an upload replaced by a newer pick for the same block doesn't toast", async () => {
    const uploadFile = upload();
    await uploadFile(fileOf("a.png", 1, "image/png"), "b1");
    const first = lastXhr();
    await uploadFile(fileOf("b.png", 1, "image/png"), "b1");
    expect(first.aborted).toBe(true);
    await flush();
    expect(toastMock).not.toHaveBeenCalled();
  });
});
