import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import { QueryClient } from "@tanstack/react-query";
import { COLLAB_CLOSE_NOTE_DELETED, COLLAB_CLOSE_REVOKED, YDOC_FRAGMENT, type UploadResponseDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { COLLAB_CLOSE_CLIENT_OUTDATED } from "@/collab/connection";
import { noteSchema } from "@/collab/schema";
import { FakeXhr, installFakeXhr, lastXhr } from "@/test/fake-xhr";
import type { PrecheckCtx } from "./precheck";

interface FakeProvider {
  configuration: { token: () => Promise<string>; onAuthenticated: () => void; document: Y.Doc };
  emit: (event: string, payload: unknown) => void;
  destroy: ReturnType<typeof vi.fn>;
}

const hoisted = vi.hoisted(() => ({ instances: [] as unknown[] }));

vi.mock("@hocuspocus/provider", async () => {
  const { Awareness } = await import("y-protocols/awareness");
  return {
    HocuspocusProvider: class {
      configuration: { document: Y.Doc };
      listeners = new Map<string, ((payload: unknown) => void)[]>();
      disconnect = vi.fn();
      connect = vi.fn();
      destroy = vi.fn();
      awareness: InstanceType<typeof Awareness>;
      constructor(configuration: { document: Y.Doc }) {
        this.configuration = configuration;
        this.awareness = new Awareness(configuration.document);
        hoisted.instances.push(this);
      }
      on(event: string, handler: (payload: unknown) => void) {
        this.listeners.set(event, [...(this.listeners.get(event) ?? []), handler]);
        return this;
      }
      emit(event: string, payload: unknown) {
        for (const handler of this.listeners.get(event) ?? []) handler(payload);
      }
    },
  };
});

const { acquireNoteConnection } = await import("@/collab/note-connection");
const { startUpload, retryUpload, resetUploadRunnerForTest, hasUploadRunForTest, UPLOAD_WRITE_WAIT_MS } = await import("./upload-runner");
const { createPrecheckCtxProvider } = await import("./precheck");
const store = await import("./upload-queue-store");
const rules = await import("./upload-rules");

const NOTE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOTE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MIB = 1_048_576;

const provider = (index: number) => hoisted.instances[index] as FakeProvider;
const providerOf = (doc: Y.Doc) => (hoisted.instances as FakeProvider[]).find((p) => p.configuration.document === doc)!;

function fakeResponse(ok: boolean, status: number, body: unknown): Response {
  return { ok, status, json: () => Promise.resolve(body) } as unknown as Response;
}

let tokenResponse: () => Promise<Response>;
let meResponse: (init?: RequestInit) => Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn>;

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

async function connect(p: FakeProvider, role: string) {
  tokenResponse = () => Promise.resolve(fakeResponse(true, 200, { token: "jwt", role }));
  await p.configuration.token();
  p.configuration.onAuthenticated();
}

function seed(doc: Y.Doc, blocks: unknown[]) {
  const source = new Y.Doc();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote PartialBlock generic triple, repo convention
  blocksToYXmlFragment(BlockNoteEditor.create({ schema: noteSchema }), blocks as any, source.getXmlFragment(YDOC_FRAGMENT));
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(source));
}

/** Connects as an editor, loads the blocks the server would send, and finishes the first sync. */
async function writableWith(p: FakeProvider, blocks: unknown[]) {
  await connect(p, "editor");
  seed(p.configuration.document, blocks);
  p.emit("synced", { state: true });
}

/** What the tab sent to the server: a peer that applies every update of `doc`. */
function peerOf(doc: Y.Doc): Y.Doc {
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
  doc.on("update", (update: Uint8Array) => Y.applyUpdate(peer, update));
  return peer;
}

function contentOf(doc: Y.Doc, blockId: string): Y.XmlElement | undefined {
  const walk = (node: Y.XmlElement | Y.XmlFragment): Y.XmlElement | undefined => {
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === "blockContainer" && child.getAttribute("id") === blockId) return child.get(0) as Y.XmlElement;
      const found = walk(child);
      if (found) return found;
    }
    return undefined;
  };
  return walk(doc.getXmlFragment(YDOC_FRAGMENT));
}

const videoBlock = (id = "v1", url = "") => ({ id, type: "video", props: { url } });
const response = (over: Partial<UploadResponseDto> = {}): UploadResponseDto => ({
  id: "u1",
  url: "/api/uploads/u1",
  mime: "video/mp4",
  kind: "video",
  ...over,
});

const ctxValue = (over: Partial<PrecheckCtx> = {}): PrecheckCtx => ({
  maxUploadBytes: 10 * MIB,
  maxMediaUploadBytes: 100 * MIB,
  roomBytes: null,
  ...over,
});

function fileOf(name: string, size: number): File {
  const file = new File(["x"], name);
  Object.defineProperty(file, "size", { value: size });
  return file;
}

const queued = (id: string) => store.getUploadItems().find((i) => i.id === id);
const item = (id: string) => queued(id)!;
const liveProviders = () => (hoisted.instances as FakeProvider[]).filter((p) => p.destroy.mock.calls.length === 0);

const held: { release(): void }[] = [];
const hold = (noteId: string) => {
  const handle = acquireNoteConnection(noteId, { kind: "editor", onUnauthorized: () => {} });
  held.push(handle);
  return handle;
};

beforeEach(() => {
  hoisted.instances.length = 0;
  installFakeXhr();
  tokenResponse = () => new Promise(() => {});
  meResponse = () => new Promise(() => {});
  fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/collab-token")) return tokenResponse();
    if (String(input) === "/api/auth/me") return meResponse(init);
    return new Promise(() => {});
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  store.setUploadSessionExpiredHandler(undefined);
  store.setUploadUserSource(undefined);
  vi.useRealTimers();
  resetUploadRunnerForTest();
  store.resetUploadQueueForTest();
  for (const handle of held.splice(0)) handle.release();
  vi.unstubAllGlobals();
});

async function startVideo(noteId: string, over: Partial<Parameters<typeof startUpload>[0]> = {}) {
  const result = await startUpload({
    noteId,
    blockId: "v1",
    file: fileOf("clip.mp4", 2 * MIB),
    expectedUrl: "",
    precheckCtx: async () => ctxValue(),
    ...over,
  });
  if (!result.ok) throw new Error("refused");
  return result.id;
}

describe("startUpload / the background write", () => {
  it("an upload started in note A finishes after the person moved to note B: A's block gets the URL and A's connection is closed after the write", async () => {
    const editorA = acquireNoteConnection(NOTE_A, { kind: "editor", onUnauthorized: () => {} });
    const docA = editorA.doc;
    await writableWith(providerOf(docA), [videoBlock()]);
    const peer = peerOf(docA);

    const id = await startVideo(NOTE_A);
    editorA.release();
    hold(NOTE_B);
    expect(providerOf(docA).destroy).not.toHaveBeenCalled();

    lastXhr().respond(201, response());
    await flush();

    expect(queued(id)).toBeUndefined();
    expect(hasUploadRunForTest(id)).toBe(false);
    expect(contentOf(peer, "v1")?.getAttribute("url")).toBe("/api/uploads/u1");
    expect(contentOf(peer, "v1")?.getAttribute("name")).toBe("clip.mp4");
    expect(providerOf(docA).destroy).toHaveBeenCalledTimes(1);
  });

  it("reopening A during the upload reuses the queue's connection and the open editor sees the write", async () => {
    const first = acquireNoteConnection(NOTE_A, { kind: "editor", onUnauthorized: () => {} });
    await writableWith(provider(0), [videoBlock()]);
    await startVideo(NOTE_A);
    first.release();

    const again = hold(NOTE_A);
    expect(hoisted.instances).toHaveLength(1);
    expect(again.doc).toBe(first.doc);

    lastXhr().respond(201, response());
    await flush();
    expect(contentOf(again.doc, "v1")?.getAttribute("url")).toBe("/api/uploads/u1");
    expect(provider(0).destroy).not.toHaveBeenCalled();
  });

  it("a second file picked for the same block replaces the first: the first stops, the newer file is written (not unplaced)", async () => {
    const editor = hold(NOTE_A);
    await writableWith(provider(0), [videoBlock("v1", "/api/uploads/old")]);
    const first = await startVideo(NOTE_A, { expectedUrl: "/api/uploads/old" });
    const firstXhr = lastXhr();
    const second = await startVideo(NOTE_A, { expectedUrl: "/api/uploads/old", file: fileOf("take2.mp4", 2 * MIB) });

    expect(firstXhr.aborted).toBe(true);
    expect(queued(first)).toBeUndefined();
    expect(hasUploadRunForTest(first)).toBe(false);
    lastXhr().respond(201, response({ id: "u2", url: "/api/uploads/u2" }));
    await flush();

    expect(queued(second)).toBeUndefined();
    expect(store.getUploadItems()).toEqual([]);
    expect(contentOf(editor.doc, "v1")?.getAttribute("url")).toBe("/api/uploads/u2");
  });

  it("the same block id in another note is a different block: both uploads keep running", async () => {
    hold(NOTE_A);
    hold(NOTE_B);
    const inA = await startVideo(NOTE_A);
    const inB = await startVideo(NOTE_B);
    expect(queued(inA)?.status).toBe("uploading");
    expect(queued(inB)?.status).toBe("uploading");
  });

  it("a refused replacement leaves the running upload untouched", async () => {
    hold(NOTE_A);
    const first = await startVideo(NOTE_A, { expectedUrl: "/api/uploads/old" });
    const firstXhr = lastXhr();
    const refused = await startUpload({
      noteId: NOTE_A,
      blockId: "v1",
      file: fileOf("huge.mp4", 500 * MIB),
      expectedUrl: "/api/uploads/old",
      precheckCtx: async () => ctxValue(),
      recordRefusal: false,
    });
    expect(refused.ok).toBe(false);
    expect(firstXhr.aborted).toBe(false);
    expect(queued(first)?.status).toBe("uploading");
    expect(hasUploadRunForTest(first)).toBe(true);
  });

  it("an accepted replacement whose check outlasts the first upload's write: it expects the URL written meanwhile and is written, not unplaced", async () => {
    const editor = hold(NOTE_A);
    await writableWith(provider(0), [videoBlock("v1", "/api/uploads/old")]);
    await startVideo(NOTE_A, { expectedUrl: "/api/uploads/old" });
    const firstXhr = lastXhr();
    let answer!: (ctx: PrecheckCtx) => void;
    const second = startUpload({
      noteId: NOTE_A,
      blockId: "v1",
      file: fileOf("take2.mp4", 2 * MIB),
      expectedUrl: () => contentOf(editor.doc, "v1")?.getAttribute("url") ?? "",
      precheckCtx: () => new Promise((resolve) => (answer = resolve)),
    });

    firstXhr.respond(201, response());
    await flush();
    expect(contentOf(editor.doc, "v1")?.getAttribute("url")).toBe("/api/uploads/u1");

    answer(ctxValue());
    const started = await second;
    if (!started.ok) throw new Error("refused");
    expect(queued(started.id)?.expectedUrl).toBe("/api/uploads/u1");
    lastXhr().respond(201, response({ id: "u2", url: "/api/uploads/u2" }));
    await flush();
    expect(contentOf(editor.doc, "v1")?.getAttribute("url")).toBe("/api/uploads/u2");
    expect(store.getUploadItems()).toEqual([]);
  });

  it("a newer accepted file removes the block's older refusal, failure and unplaced items; other blocks keep theirs", async () => {
    hold(NOTE_A);
    await startUpload({ noteId: NOTE_A, blockId: "v1", file: fileOf("huge.mp4", 500 * MIB), expectedUrl: "", precheckCtx: async () => ctxValue() });
    store.putUpload({ id: "old-unplaced", noteId: NOTE_A, blockId: "v1", fileName: "a.mp4", size: 1, loaded: 1, expectedUrl: "", status: "unplaced" });
    store.putUpload({ id: "old-failed", noteId: NOTE_A, blockId: "v1", fileName: "b.mp4", size: 1, loaded: 0, expectedUrl: "", status: "failed", error: new ApiFail(0, "upload_interrupted", "x") });
    store.putUpload({ id: "elsewhere", noteId: NOTE_A, blockId: "v2", fileName: "c.mp4", size: 1, loaded: 1, expectedUrl: "", status: "unplaced" });
    expect(store.getUploadItems().filter((i) => i.blockId === "v1")).toHaveLength(3);

    const id = await startVideo(NOTE_A);

    expect(store.getUploadItems().map((i) => i.id).sort()).toEqual(["elsewhere", id].sort());
  });

  it("the block deleted during the upload -> unplaced, nothing written", async () => {
    const editor = hold(NOTE_A);
    await writableWith(provider(0), [{ id: "p1", type: "paragraph", content: "x" }, videoBlock()]);
    const id = await startVideo(NOTE_A);

    const group = editor.doc.getXmlFragment(YDOC_FRAGMENT).get(0) as Y.XmlElement;
    group.delete(1, 1);
    lastXhr().respond(201, response());
    await flush();

    expect(item(id).status).toBe("unplaced");
    expect(contentOf(editor.doc, "v1")).toBeUndefined();
  });

  it("the block's URL changed meanwhile -> unplaced, the other URL is kept", async () => {
    const editor = hold(NOTE_A);
    await writableWith(provider(0), [videoBlock()]);
    const id = await startVideo(NOTE_A);

    contentOf(editor.doc, "v1")!.setAttribute("url", "https://example.com/other.mp4");
    lastXhr().respond(201, response());
    await flush();

    expect(item(id).status).toBe("unplaced");
    expect(contentOf(editor.doc, "v1")?.getAttribute("url")).toBe("https://example.com/other.mp4");
  });

  it("access revoked during the upload (whenWritable rejected) -> failed without a retry, connection released at once", async () => {
    const editor = acquireNoteConnection(NOTE_A, { kind: "editor", onUnauthorized: () => {} });
    const p = provider(0);
    await writableWith(p, [videoBlock()]);
    const id = await startVideo(NOTE_A);
    editor.release();

    p.emit("close", { event: { code: 1000, reason: COLLAB_CLOSE_REVOKED } });
    p.emit("close", { event: { code: 1006, reason: "" } });
    tokenResponse = () => Promise.resolve(fakeResponse(true, 200, { token: "jwt", role: "none" }));
    await p.configuration.token();

    lastXhr().respond(201, response());
    await flush();

    expect(item(id)).toMatchObject({ status: "failed", error: { code: "upload_write_rejected" } });
    expect(rules.isUploadRetryable(item(id))).toBe(false);
    expect(hasUploadRunForTest(id)).toBe(false);
    expect(p.destroy).toHaveBeenCalledTimes(1);
    expect(contentOf(p.configuration.document, "v1")?.getAttribute("url")).toBe("");
  });

  it.each([
    ["the note was deleted", COLLAB_CLOSE_NOTE_DELETED, "upload_write_deleted"],
    ["the tab is out of date", COLLAB_CLOSE_CLIENT_OUTDATED, "upload_write_outdated"],
  ])("a write refused because %s gets its own message, without a retry", async (_case, reason, code) => {
    const editor = acquireNoteConnection(NOTE_A, { kind: "editor", onUnauthorized: () => {} });
    const p = provider(0);
    await writableWith(p, [videoBlock()]);
    const id = await startVideo(NOTE_A);
    editor.release();
    p.emit("close", { event: { code: 1000, reason } });

    lastXhr().respond(201, response());
    await flush();

    expect(item(id)).toMatchObject({ status: "failed", error: { code } });
    expect(rules.isUploadRetryable(item(id))).toBe(false);
    expect(hasUploadRunForTest(id)).toBe(false);
    expect(p.destroy).toHaveBeenCalledTimes(1);
  });

  it("a refusal the server will repeat (415) has no retry and drops the file", async () => {
    const id = await startVideo(NOTE_A);
    lastXhr().respond(415, { error: { code: "unsupported_media_type", message: "x" } });
    await flush();
    expect(item(id)).toMatchObject({ status: "failed", error: { status: 415 } });
    expect(rules.isUploadRetryable(item(id))).toBe(false);
    expect(hasUploadRunForTest(id)).toBe(false);
    await retryUpload(id);
    expect(FakeXhr.instances).toHaveLength(1);
  });

  it("the write waits at most UPLOAD_WRITE_WAIT_MS: timed out -> failed as interrupted (not as lost access); a retry repeats only the write on a reopened connection", async () => {
    vi.useFakeTimers();
    const id = await startVideo(NOTE_A);
    const p = provider(0);
    expect(item(id).stored).toBeUndefined();
    lastXhr().respond(201, response());
    await vi.advanceTimersByTimeAsync(UPLOAD_WRITE_WAIT_MS);

    expect(item(id)).toMatchObject({ status: "failed", error: { code: "upload_interrupted" }, stored: true });
    expect(rules.isUploadRetryable(item(id))).toBe(true);
    expect(hasUploadRunForTest(id)).toBe(true);
    expect(p.destroy).toHaveBeenCalledTimes(1);

    const xhrs = FakeXhr.instances.length;
    await retryUpload(id);
    expect(item(id).status).toBe("writing");
    expect(hoisted.instances).toHaveLength(2);
    await writableWith(provider(1), [videoBlock()]);
    await vi.advanceTimersByTimeAsync(0);

    expect(FakeXhr.instances).toHaveLength(xhrs);
    expect(queued(id)).toBeUndefined();
    expect(contentOf(provider(1).configuration.document, "v1")?.getAttribute("url")).toBe("/api/uploads/u1");
  });

  it("progress updates the item's loaded bytes, scaled to the file size", async () => {
    const id = await startVideo(NOTE_A);
    lastXhr().progress(500, 1000);
    expect(item(id)).toMatchObject({ status: "uploading", loaded: MIB });
    expect(store.uploadQueueSummary(store.getUploadItems())).toEqual({ active: 1, percent: 50 });
  });

  it("a pre-check refusal sends no request, opens no connection and records a failed item with the reason", async () => {
    const result = await startUpload({
      noteId: NOTE_A,
      blockId: "v1",
      file: fileOf("big.mp4", 200 * MIB),
      expectedUrl: "",
      precheckCtx: async () => ctxValue(),
    });
    expect(result).toMatchObject({ ok: false, result: { reason: "tooLarge" } });
    expect(FakeXhr.instances).toHaveLength(0);
    expect(hoisted.instances).toHaveLength(0);
    expect(store.getUploadItems()).toEqual([
      expect.objectContaining({ status: "failed", blockId: "v1", precheck: expect.objectContaining({ reason: "tooLarge" }) }),
    ]);
  });

  it("recordRefusal: false records nothing", async () => {
    const result = await startUpload({
      noteId: NOTE_A,
      blockId: "v1",
      file: fileOf("doc.pdf", 20 * MIB),
      expectedUrl: "https://example.com/old.pdf",
      precheckCtx: async () => ctxValue(),
      recordRefusal: false,
    });
    expect(result.ok).toBe(false);
    expect(FakeXhr.instances).toHaveLength(0);
    expect(store.getUploadItems()).toEqual([]);
  });
});

describe("sign-out (401)", () => {
  it("an upload 401 tells the app once, though it stops two uploads", async () => {
    const expired = vi.fn();
    store.setUploadSessionExpiredHandler(expired);
    await startVideo(NOTE_A);
    const firstXhr = lastXhr();
    await startVideo(NOTE_B, { blockId: "v2" });

    firstXhr.respond(401, { error: { code: "unauthorized", message: "x" } });
    await flush();
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it("the queue's token 401 tells the app once, though both holders of the connection report it", async () => {
    const expired = vi.fn();
    store.setUploadSessionExpiredHandler(expired);
    await startVideo(NOTE_A);
    await startVideo(NOTE_A, { blockId: "v2" });
    tokenResponse = () => Promise.resolve(fakeResponse(false, 401, { error: { code: "unauthorized", message: "x" } }));
    await expect(provider(0).configuration.token()).rejects.toThrow();
    await flush();
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it("sign-out also stops an item waiting to write, and drops every run", async () => {
    const writing = await startVideo(NOTE_A);
    lastXhr().respond(201, response());
    await flush();
    expect(item(writing).status).toBe("writing");
    const uploading = await startVideo(NOTE_B, { blockId: "v2" });

    lastXhr().respond(401, { error: { code: "unauthorized", message: "x" } });
    await flush();

    for (const id of [writing, uploading]) {
      expect(item(id)).toMatchObject({ status: "failed", error: { status: 401 } });
      expect(hasUploadRunForTest(id)).toBe(false);
    }
    expect(provider(0).destroy).toHaveBeenCalledTimes(1);
  });

  it("a 401 while an item waits to write is not overwritten by the released wait's rejection", async () => {
    const id = await startVideo(NOTE_A);
    lastXhr().respond(201, response());
    await flush();
    expect(item(id).status).toBe("writing");

    tokenResponse = () => Promise.resolve(fakeResponse(false, 401, { error: { code: "unauthorized", message: "x" } }));
    await expect(provider(0).configuration.token()).rejects.toThrow();
    await flush();

    expect(item(id)).toMatchObject({ status: "failed", error: { status: 401, code: "unauthorized" } });
  });

  it("an upload answered 401 fails every running upload with the signed-out error, aborts the others and offers no retry", async () => {
    const first = await startVideo(NOTE_A);
    const firstXhr = lastXhr();
    const second = await startVideo(NOTE_B, { blockId: "v2" });
    const secondXhr = lastXhr();

    firstXhr.respond(401, { error: { code: "unauthorized", message: "x" } });
    await flush();

    for (const id of [first, second]) {
      expect(item(id)).toMatchObject({ status: "failed", error: { status: 401, code: "unauthorized" } });
      expect(rules.isUploadRetryable(item(id))).toBe(false);
    }
    expect(secondXhr.aborted).toBe(true);
    await retryUpload(first);
    expect(FakeXhr.instances).toHaveLength(2);
    expect(item(first).status).toBe("failed");
  });

  it("the queue's connection reporting 401 (its token request) fails running uploads the same way", async () => {
    const id = await startVideo(NOTE_A);
    tokenResponse = () => Promise.resolve(fakeResponse(false, 401, { error: { code: "unauthorized", message: "x" } }));
    await expect(provider(0).configuration.token()).rejects.toThrow();
    await flush();

    expect(item(id)).toMatchObject({ status: "failed", error: { status: 401 } });
    expect(lastXhr().aborted).toBe(true);
    expect(provider(0).destroy).toHaveBeenCalledTimes(1);
  });
});

describe("after upload_interrupted", () => {
  it("the refetched usage shows less room than the file: noRoom recorded, no retry, no second request", async () => {
    const ctx = vi.fn().mockResolvedValueOnce(ctxValue({ roomBytes: 50 * MIB })).mockResolvedValue(ctxValue({ roomBytes: MIB }));
    const id = await startVideo(NOTE_A, { precheckCtx: ctx });
    lastXhr().onerror?.();
    await flush();

    expect(ctx).toHaveBeenCalledTimes(2);
    expect(item(id)).toMatchObject({ status: "failed", precheck: { reason: "noRoom", roomBytes: MIB } });
    expect(rules.isUploadRetryable(item(id))).toBe(false);
    expect(hasUploadRunForTest(id)).toBe(false);
    await retryUpload(id);
    expect(FakeXhr.instances).toHaveLength(1);
  });

  it("with enough room it is retryable, and retryUpload checks again with fresh values before sending", async () => {
    let answer: (ctx: PrecheckCtx) => void = () => {};
    const ctx = vi
      .fn<() => Promise<PrecheckCtx>>()
      .mockResolvedValueOnce(ctxValue({ roomBytes: 50 * MIB }))
      .mockResolvedValueOnce(ctxValue({ roomBytes: 50 * MIB }))
      .mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const id = await startVideo(NOTE_A, { precheckCtx: ctx });
    lastXhr().onerror?.();
    await flush();
    expect(item(id)).toMatchObject({ status: "failed", error: { code: "upload_interrupted" } });
    expect(item(id).precheck).toBeUndefined();
    expect(rules.isUploadRetryable(item(id))).toBe(true);

    const retried = retryUpload(id);
    await flush();
    expect(ctx).toHaveBeenCalledTimes(3);
    expect(FakeXhr.instances).toHaveLength(1);
    answer(ctxValue({ roomBytes: 50 * MIB }));
    await retried;
    expect(FakeXhr.instances).toHaveLength(2);
    expect(item(id)).toMatchObject({ status: "uploading", loaded: 0 });
    expect(item(id).error).toBeUndefined();
  });

  it("a retry whose fresh check refuses keeps the item failed with the reason and sends nothing", async () => {
    const ctx = vi
      .fn<() => Promise<PrecheckCtx>>()
      .mockResolvedValueOnce(ctxValue())
      .mockResolvedValueOnce(ctxValue())
      .mockResolvedValue(ctxValue({ roomBytes: 0 }));
    const id = await startVideo(NOTE_A, { precheckCtx: ctx });
    lastXhr().onerror?.();
    await flush();
    await retryUpload(id);
    expect(FakeXhr.instances).toHaveLength(1);
    expect(item(id)).toMatchObject({ status: "failed", precheck: { reason: "noRoom" } });
    expect(item(id).error).toBeUndefined();
    expect(rules.isUploadRetryable(item(id))).toBe(false);
  });

  it("a provider whose fetches fail: retryable, and no unhandled rejection", async () => {
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);
    process.on("unhandledRejection", unhandled);
    try {
      fetchMock.mockImplementation((input: RequestInfo | URL) => {
        if (String(input).endsWith("/collab-token")) return tokenResponse();
        return Promise.reject(new TypeError("Failed to fetch"));
      });
      const precheckCtx = createPrecheckCtxProvider(new QueryClient(), { groupId: null, canViewUsage: true });
      const id = await startVideo(NOTE_A, { precheckCtx });
      lastXhr().onerror?.();
      await flush();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(item(id)).toMatchObject({ status: "failed", error: { code: "upload_interrupted" } });
      expect(rules.isUploadRetryable(item(id))).toBe(true);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("unhandledrejection", unhandled);
      process.off("unhandledRejection", unhandled);
    }
  });

  it("a provider that rejects outright is treated as unknown room, never as a rejection of startUpload", async () => {
    const id = await startVideo(NOTE_A, { precheckCtx: () => Promise.reject(new Error("boom")) });
    expect(item(id).status).toBe("uploading");
  });
});

describe("clearUploadQueue (sign-out or another account)", () => {
  it("stops every upload: XHRs aborted, connections closed, no file kept", async () => {
    const running = await startVideo(NOTE_A);
    const runningXhr = lastXhr();
    const retryable = await startVideo(NOTE_B, { blockId: "v2" });
    lastXhr().onerror?.();
    await flush();
    expect(rules.isUploadRetryable(item(retryable))).toBe(true);
    expect(hasUploadRunForTest(retryable)).toBe(true);

    store.clearUploadQueue();

    expect(store.getUploadItems()).toEqual([]);
    expect(runningXhr.aborted).toBe(true);
    expect(hasUploadRunForTest(running)).toBe(false);
    expect(hasUploadRunForTest(retryable)).toBe(false);
    expect((hoisted.instances as FakeProvider[]).filter((p) => p.destroy.mock.calls.length === 0)).toHaveLength(0);
    await retryUpload(retryable);
    expect(FakeXhr.instances).toHaveLength(2);
  });
});

describe("dismissUpload", () => {
  it("dismissed while a retry's re-check is pending: nothing is sent and no connection stays open", async () => {
    let answer: (ctx: PrecheckCtx) => void = () => {};
    const ctx = vi
      .fn<() => Promise<PrecheckCtx>>()
      .mockResolvedValueOnce(ctxValue())
      .mockResolvedValueOnce(ctxValue())
      .mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const id = await startVideo(NOTE_A, { precheckCtx: ctx });
    lastXhr().onerror?.();
    await flush();
    expect(rules.isUploadRetryable(item(id))).toBe(true);

    const retried = retryUpload(id);
    await flush();
    store.dismissUpload(id);
    answer(ctxValue());
    await retried;
    await flush();

    expect(FakeXhr.instances).toHaveLength(1);
    const live = (hoisted.instances as FakeProvider[]).filter((p) => p.destroy.mock.calls.length === 0);
    expect(live).toHaveLength(0);
  });

  it("drops a failed item; a running one is not dismissed", async () => {
    const running = await startVideo(NOTE_A);
    store.dismissUpload(running);
    expect(item(running).status).toBe("uploading");

    lastXhr().respond(413, { error: { code: "file_too_large", message: "x" } });
    await flush();
    expect(item(running).status).toBe("failed");
    store.dismissUpload(running);
    expect(store.getUploadItems()).toEqual([]);
    await retryUpload(running);
    expect(FakeXhr.instances).toHaveLength(1);
  });
});

describe("retry guards", () => {
  it("a 429 that says when to try again: Retry sends nothing before then, and uploads once the wait is over", async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
    const id = await startVideo(NOTE_A);
    lastXhr().respond(429, { error: { code: "too_many_requests", message: "x" }, retryAfterMs: 30_000 });
    await flush();
    expect(item(id)).toMatchObject({ status: "failed", retryAt: 1_030_000 });
    expect(rules.isUploadRetryable(item(id))).toBe(true);

    vi.setSystemTime(1_029_999);
    await retryUpload(id);
    await flush();
    expect(FakeXhr.instances).toHaveLength(1);
    expect(item(id).status).toBe("failed");

    vi.setSystemTime(1_030_000);
    await retryUpload(id);
    await flush();
    expect(FakeXhr.instances).toHaveLength(2);
    expect(item(id)).toMatchObject({ status: "uploading" });
    expect(item(id).retryAt).toBeUndefined();
  });

  it("a failure without retryAfterMs leaves no wait behind from an earlier one", async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
    const id = await startVideo(NOTE_A);
    lastXhr().respond(429, { error: { code: "too_many_requests", message: "x" }, retryAfterMs: 1_000 });
    await flush();
    vi.setSystemTime(1_001_000);
    await retryUpload(id);
    await flush();
    lastXhr().respond(503, { error: { code: "internal", message: "x" } });
    await flush();
    expect(item(id)).toMatchObject({ status: "failed", error: { status: 503 } });
    expect(item(id).retryAt).toBeUndefined();
  });

  it("the item records who was signed in when it started", async () => {
    store.setUploadUserSource(() => "alice");
    const id = await startVideo(NOTE_A);
    expect(item(id).ownerId).toBe("alice");
  });

  const me = {
    bob: () => Promise.resolve(fakeResponse(true, 200, { id: "bob" })),
    signedOut: () => Promise.resolve(fakeResponse(false, 401, { error: { code: "unauthorized", message: "x" } })),
    alice: () => Promise.resolve(fakeResponse(true, 200, { id: "alice" })),
    unreachable: () => Promise.reject(new TypeError("Failed to fetch")),
    busy: () => Promise.resolve(fakeResponse(false, 503, { error: { code: "server_busy", message: "x" } })),
  };

  it.each([
    ["another account", "bob", "notifies"],
    ["signed out", "signedOut", "notifies"],
    ["the same person", "alice", "sends"],
    ["the server unreachable", "unreachable", "unconfirmed"],
    ["the server busy", "busy", "unconfirmed"],
  ] as const)("a retry when the server now says %s (%s): %s", async (_label, answer, outcome) => {
    const sends = outcome === "sends";
    meResponse = me[answer];
    const expired = vi.fn();
    store.setUploadSessionExpiredHandler(expired);
    store.setUploadUserSource(() => "alice");
    const ctx = vi.fn(async () => ctxValue());
    const id = await startVideo(NOTE_A, { precheckCtx: ctx });
    lastXhr().onerror?.();
    await flush();
    expect(rules.isUploadRetryable(item(id))).toBe(true);
    const checks = ctx.mock.calls.length;

    await retryUpload(id);
    await flush();
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === "/api/auth/me")).toHaveLength(1);
    expect(FakeXhr.instances).toHaveLength(sends ? 2 : 1);
    expect(ctx.mock.calls.length).toBe(sends ? checks + 1 : checks);
    expect(expired).toHaveBeenCalledTimes(outcome === "notifies" ? 1 : 0);
    if (!sends) expect(liveProviders()).toHaveLength(0);
    if (outcome === "unconfirmed") {
      expect(item(id)).toMatchObject({ status: "failed", error: { code: "upload_session_unconfirmed" } });
      expect(rules.isUploadRetryable(item(id))).toBe(true);
      expect(hasUploadRunForTest(id)).toBe(true);
    }
    expect(item(id).retrying).toBeUndefined();
  });

  it("while the account check runs the item says it is retrying; a check that never answers gives up after 10 s, sends nothing and keeps Retry", async () => {
    vi.useFakeTimers();
    meResponse = (init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    store.setUploadUserSource(() => "alice");
    const id = await startVideo(NOTE_A);
    lastXhr().onerror?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(rules.isUploadRetryable(item(id))).toBe(true);

    const retried = retryUpload(id);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(item(id).retrying).toBe(true);
    expect(FakeXhr.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await retried;
    expect(item(id)).toMatchObject({ status: "failed", error: { code: "upload_session_unconfirmed" } });
    expect(item(id).retrying).toBeUndefined();
    expect(FakeXhr.instances).toHaveLength(1);

    meResponse = me.alice;
    await retryUpload(id);
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeXhr.instances).toHaveLength(2);
  });

  it("no one known when it started (no user source): a retry doesn't ask the server", async () => {
    const id = await startVideo(NOTE_A);
    expect(item(id).ownerId).toBeUndefined();
    lastXhr().onerror?.();
    await flush();
    await retryUpload(id);
    await flush();
    expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/auth/me")).toBe(false);
    expect(FakeXhr.instances).toHaveLength(2);
  });

  it("the write-only retry (file already stored) is refused the same way when another account is signed in", async () => {
    vi.useFakeTimers();
    meResponse = me.bob;
    store.setUploadUserSource(() => "alice");
    const id = await startVideo(NOTE_A);
    lastXhr().respond(201, response());
    await vi.advanceTimersByTimeAsync(UPLOAD_WRITE_WAIT_MS);
    expect(item(id)).toMatchObject({ status: "failed", error: { code: "upload_interrupted" } });
    const providers = hoisted.instances.length;

    await retryUpload(id);
    await vi.advanceTimersByTimeAsync(0);
    expect(item(id).status).toBe("failed");
    expect(hoisted.instances).toHaveLength(providers);
    expect(liveProviders()).toHaveLength(0);
  });

  it("dismissed while a write-only retry's account check is pending: no connection is opened", async () => {
    vi.useFakeTimers();
    let answer: (res: Response) => void = () => {};
    meResponse = () => new Promise((resolve) => (answer = resolve));
    store.setUploadUserSource(() => "alice");
    const id = await startVideo(NOTE_A);
    lastXhr().respond(201, response());
    await vi.advanceTimersByTimeAsync(UPLOAD_WRITE_WAIT_MS);
    expect(item(id)).toMatchObject({ status: "failed", error: { code: "upload_interrupted" } });
    const providers = hoisted.instances.length;

    const retried = retryUpload(id);
    await vi.advanceTimersByTimeAsync(0);
    store.dismissUpload(id);
    answer(fakeResponse(true, 200, { id: "alice" }));
    await retried;
    await vi.advanceTimersByTimeAsync(0);
    expect(hoisted.instances).toHaveLength(providers);
    expect(liveProviders()).toHaveLength(0);
  });

  it("dismissed while the account check is pending: nothing is sent", async () => {
    let answer: (res: Response) => void = () => {};
    meResponse = () => new Promise((resolve) => (answer = resolve));
    store.setUploadUserSource(() => "alice");
    const id = await startVideo(NOTE_A);
    lastXhr().onerror?.();
    await flush();
    const retried = retryUpload(id);
    await flush();
    store.dismissUpload(id);
    answer(fakeResponse(true, 200, { id: "alice" }));
    await retried;
    await flush();
    expect(FakeXhr.instances).toHaveLength(1);
    expect(liveProviders()).toHaveLength(0);
  });
});
