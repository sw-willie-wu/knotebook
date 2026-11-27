import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BlockNoteEditor } from "@blocknote/core";
import { ApiFail } from "@/api/client";
import { removeBlocksKeepColumns } from "@/collab/columns/keep-columns";
import { IMG, P, mountEditor, row, shape } from "@/test/columns-fixtures";

// A spy wrapper that calls through to the original implementation; no automock - that would make the real-editor cleanup case do nothing.
vi.mock("@/collab/columns/keep-columns", async (importOriginal) => {
  const m = await importOriginal<typeof import("@/collab/columns/keep-columns")>();
  return { ...m, removeBlocksKeepColumns: vi.fn(m.removeBlocksKeepColumns) };
});
beforeEach(() => {
  vi.mocked(removeBlocksKeepColumns).mockReset(); // Don't write it as an arrow that returns directly: the function returned by beforeEach would be called as teardown; mockReset also clears the mockImplementationOnce queue and restores the wrapped original implementation
});

// The toast is replaced with a spy - same technique as `NoteEditor.test.ts`: what is asserted here is
// "whether there was a hint, how many times, and what text", with no need to render the whole of Radix.
const toastMock = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/toast", () => ({ toast: toastMock }));

const { postUpload, createUploadFile } = await import("./upload-file");

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return {
    ok,
    status,
    json: json ?? (() => Promise.reject(new Error("no body"))),
  } as unknown as Response;
}

function file(name = "a.png", type = "image/png", parts: BlobPart[] = [new Uint8Array([1])]): File {
  return new File(parts, name, { type });
}

const ONE_MIB = 1048576;

/** Claims the size without allocating it. */
function fileOfSize(size: number): File {
  const f = file();
  Object.defineProperty(f, "size", { value: size });
  return f;
}

const translate = (key: string) => `t:${key}`;

describe("postUpload", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("success: POST to /api/notes/:id/uploads (FormData with a file field), returns {id, url}", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({ ok: true, status: 201, json: () => Promise.resolve({ id: "u1", url: "/api/uploads/u1" }) }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await postUpload("note-1", file());

    expect(result).toEqual({ id: "u1", url: "/api/uploads/u1" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/notes/note-1/uploads");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get("file")).toBeInstanceOf(File);
  });

  it("noteId goes through encodeURIComponent (matching the existing convention in api/notes.ts)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({ ok: true, status: 201, json: () => Promise.resolve({ id: "u1", url: "/api/uploads/u1" }) }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await postUpload("weird/id with space", file());

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/notes/${encodeURIComponent("weird/id with space")}/uploads`);
  });

  it("pre-check: a file over the given limit -> throws ApiFail(413, file_too_large) directly, no request sent", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(postUpload("note-1", fileOfSize(ONE_MIB * 1.5), ONE_MIB)).rejects.toMatchObject({
      status: 413,
      code: "file_too_large",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pre-check: exactly at the limit -> sent as usual", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({ ok: true, status: 201, json: () => Promise.resolve({ id: "u1", url: "/api/uploads/u1" }) }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await postUpload("note-1", fileOfSize(ONE_MIB), ONE_MIB);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("no limit given -> no pre-check, a large file is sent as usual", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({ ok: true, status: 201, json: () => Promise.resolve({ id: "u1", url: "/api/uploads/u1" }) }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await postUpload("note-1", fileOfSize(ONE_MIB * 1.5));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("server responds non-2xx -> rejects ApiFail (the low-level function may reject)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({ ok: false, status: 415, json: () => Promise.resolve({ error: { code: "unsupported_media_type", message: "nope" } }) }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(postUpload("note-1", file())).rejects.toBeInstanceOf(ApiFail);
  });
});

describe("createUploadFile", () => {
  // The dedup Map of toastOncePerCode is module-level and shared across tests -
  // if every test pinned the fake clock to the same absolute time (e.g. all zero), the timestamp the previous test left for the same code
  // would equal or nearly equal the next test's "now", `now - last < 5000` would always hold,
  // and the next test would always be treated as still inside the dedup window and fail falsely, hiding the real behaviour (this has been hit). So at the start of each
  // test the clock is pushed forward by a large amount (far more than the 5 s dedup window), so that the judgement for the same code
  // across tests is naturally independent; `flushMacrotask` also uses `advanceTimersByTimeAsync`, since a real
  // `setTimeout` isn't triggered while the fake clock is in effect.
  let testClockBase = 0;
  beforeEach(() => {
    toastMock.mockClear();
    vi.useFakeTimers();
    testClockBase += 1_000_000;
    vi.setSystemTime(testClockBase);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // `transact` doesn't run the callback: the helper calls through to the original implementation but doesn't touch the document; the real effect of deletion is verified with the real editor.
  function fakeEditor(blocks: Set<string>) {
    return {
      getBlock: vi.fn((id: string) => (blocks.has(id) ? { id } : undefined)),
      transact: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test stand-in, the repo's BlockNoteEditor<any,any,any> convention
    } as unknown as BlockNoteEditor<any, any, any>;
  }

  async function flushMacrotask(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
  }

  it("success: returns the url, no toast, no block removal", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({ ok: true, status: 201, json: () => Promise.resolve({ id: "u1", url: "/api/uploads/u1" }) }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const blocks = new Set(["b1"]);
    const editor = fakeEditor(blocks);
    const uploadFile = createUploadFile({ noteId: "note-1", editorRef: { current: editor }, translate });

    const url = await uploadFile(file(), "b1");

    expect(url).toBe("/api/uploads/u1");
    await flushMacrotask();
    expect(toastMock).not.toHaveBeenCalled();
    expect(vi.mocked(removeBlocksKeepColumns)).not.toHaveBeenCalled();
  });

  it("maxUploadBytes getter returns 1 MiB: blocks a 1.5 MiB file, no request, returns an empty string and toasts file_too_large", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const uploadFile = createUploadFile({
      noteId: "note-1",
      editorRef: { current: fakeEditor(new Set(["b1"])) },
      translate,
      maxUploadBytes: () => ONE_MIB,
    });

    await expect(uploadFile(fileOfSize(ONE_MIB * 1.5), "b1")).resolves.toBe("");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledWith({ title: "t:errors.file_too_large" });
  });

  it("maxUploadBytes getter returns undefined: no pre-check, sent as usual", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({ ok: true, status: 201, json: () => Promise.resolve({ id: "u1", url: "/api/uploads/u1" }) }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const uploadFile = createUploadFile({
      noteId: "note-1",
      editorRef: { current: fakeEditor(new Set(["b1"])) },
      translate,
      maxUploadBytes: () => undefined,
    });

    await expect(uploadFile(fileOfSize(ONE_MIB * 1.5), "b1")).resolves.toBe("/api/uploads/u1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maxUploadBytes getter is read at upload time: the same uploadFile uses the new value on the next upload after it changes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({ ok: true, status: 201, json: () => Promise.resolve({ id: "u1", url: "/api/uploads/u1" }) }),
    );
    vi.stubGlobal("fetch", fetchMock);
    let limit: number | undefined = ONE_MIB;
    const uploadFile = createUploadFile({
      noteId: "note-1",
      editorRef: { current: fakeEditor(new Set(["b1"])) },
      translate,
      maxUploadBytes: () => limit,
    });

    await expect(uploadFile(fileOfSize(ONE_MIB * 1.5), "b1")).resolves.toBe("");
    expect(fetchMock).not.toHaveBeenCalled();

    limit = ONE_MIB * 2;
    await expect(uploadFile(fileOfSize(ONE_MIB * 1.5), "b1")).resolves.toBe("/api/uploads/u1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("failure (4xx): never rejects, returns the empty-string sentinel", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({ ok: false, status: 415, json: () => Promise.resolve({ error: { code: "unsupported_media_type", message: "nope" } }) }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const editor = fakeEditor(new Set(["b1"]));
    const uploadFile = createUploadFile({ noteId: "note-1", editorRef: { current: editor }, translate });

    await expect(uploadFile(file(), "b1")).resolves.toBe("");
  });

  it("failure: the placeholder block is removed after a macrotask (updateBlock has finished before the removal, the removal doesn't race ahead of it)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({ ok: false, status: 415, json: () => Promise.resolve({ error: { code: "unsupported_media_type", message: "nope" } }) }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const blocks = new Set(["b1"]);
    const editor = fakeEditor(blocks);
    const uploadFile = createUploadFile({ noteId: "note-1", editorRef: { current: editor }, translate });

    await uploadFile(file(), "b1");
    // Just resolved (equivalent to the line `await editor.uploadFile(...)` in handleFileInsertion just
    // finishing); at this point the synchronously following `editor.updateBlock(...)` hasn't had a chance to run, and our cleanup hasn't
    // happened either - because it is queued as a macrotask.
    expect(vi.mocked(removeBlocksKeepColumns)).not.toHaveBeenCalled();

    await flushMacrotask();

    expect(vi.mocked(removeBlocksKeepColumns)).toHaveBeenCalledWith(editor, ["b1"]);
  });

  it("failure with no blockId (e.g. the caller has no insertedBlockId): no attempt to remove any block", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({ ok: false, status: 415, json: () => Promise.resolve({ error: { code: "unsupported_media_type", message: "nope" } }) }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const editor = fakeEditor(new Set());
    const uploadFile = createUploadFile({ noteId: "note-1", editorRef: { current: editor }, translate });

    await uploadFile(file());
    await flushMacrotask();

    expect(vi.mocked(removeBlocksKeepColumns)).not.toHaveBeenCalled();
  });

  it("failure but the block was already deleted manually by the user (getBlock can't find it): silently skipped, no exception", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({ ok: false, status: 415, json: () => Promise.resolve({ error: { code: "unsupported_media_type", message: "nope" } }) }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const editor = fakeEditor(new Set()); // b1 doesn't exist
    const uploadFile = createUploadFile({ noteId: "note-1", editorRef: { current: editor }, translate });

    await uploadFile(file(), "b1");
    await flushMacrotask();

    expect(vi.mocked(removeBlocksKeepColumns)).not.toHaveBeenCalled();
  });

  it("failure but editorRef.current is null (the editor is unmounted): silently skipped, no exception", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({ ok: false, status: 415, json: () => Promise.resolve({ error: { code: "unsupported_media_type", message: "nope" } }) }),
    );
    vi.stubGlobal("fetch", fetchMock);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test stand-in, the repo's BlockNoteEditor<any,any,any> convention
    const editorRef: { current: BlockNoteEditor<any, any, any> | null } = { current: null };
    const uploadFile = createUploadFile({ noteId: "note-1", editorRef, translate });

    await uploadFile(file(), "b1");
    await expect(flushMacrotask()).resolves.toBeUndefined();
  });

  it("failure: an SVG refused as unsupported gets the SVG-specific toast", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({ ok: false, status: 415, json: () => Promise.resolve({ error: { code: "unsupported_media_type", message: "nope" } }) }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const editor = fakeEditor(new Set(["b1"]));
    const uploadFile = createUploadFile({ noteId: "note-1", editorRef: { current: editor }, translate });

    await uploadFile(file("icon.svg", "image/svg+xml"), "b1");
    await flushMacrotask();

    expect(toastMock).toHaveBeenCalledWith({ title: "t:errors.svg_unusable" });
    expect(toastMock).not.toHaveBeenCalledWith({ title: "t:errors.unsupported_media_type" });
  });

  it("toast dedup is by the text shown: an SVG 415 and a non-SVG 415 within 5 seconds both toast", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({ ok: false, status: 415, json: () => Promise.resolve({ error: { code: "unsupported_media_type", message: "nope" } }) }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const editor = fakeEditor(new Set(["b1", "b2"]));
    const uploadFile = createUploadFile({ noteId: "note-1", editorRef: { current: editor }, translate });

    await uploadFile(file("icon.svg", "image/svg+xml"), "b1");
    await flushMacrotask();
    await uploadFile(file("a.png", "image/png"), "b2");
    await flushMacrotask();

    expect(toastMock).toHaveBeenCalledTimes(2);
    expect(toastMock).toHaveBeenNthCalledWith(1, { title: "t:errors.svg_unusable" });
    expect(toastMock).toHaveBeenNthCalledWith(2, { title: "t:errors.unsupported_media_type" });
  });

  it("failure: the toast text is errors.<code>", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({ ok: false, status: 415, json: () => Promise.resolve({ error: { code: "unsupported_media_type", message: "nope" } }) }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const editor = fakeEditor(new Set(["b1"]));
    const uploadFile = createUploadFile({ noteId: "note-1", editorRef: { current: editor }, translate });

    await uploadFile(file(), "b1");
    await flushMacrotask();

    expect(toastMock).toHaveBeenCalledWith({ title: "t:errors.unsupported_media_type" });
  });

  it("toast dedup: consecutive failures of the same code within 5 seconds show only one toast", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({ ok: false, status: 415, json: () => Promise.resolve({ error: { code: "unsupported_media_type", message: "nope" } }) }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const editor = fakeEditor(new Set(["b1", "b2"]));
    const uploadFile = createUploadFile({ noteId: "note-1", editorRef: { current: editor }, translate });

    await uploadFile(file(), "b1");
    await flushMacrotask();
    await uploadFile(file(), "b2");
    await flushMacrotask();

    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it("after the toast dedup window: a failure of the same code after more than 5 seconds prompts again", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({ ok: false, status: 415, json: () => Promise.resolve({ error: { code: "unsupported_media_type", message: "nope" } }) }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const editor = fakeEditor(new Set(["b1", "b2"]));
    const uploadFile = createUploadFile({ noteId: "note-1", editorRef: { current: editor }, translate });

    await uploadFile(file(), "b1");
    await flushMacrotask();
    vi.setSystemTime(testClockBase + 5001);
    await uploadFile(file(), "b2");
    await flushMacrotask();

    expect(toastMock).toHaveBeenCalledTimes(2);
  });

  it("batch continuation: one file failing doesn't affect the next file succeeding", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        fakeResponse({ ok: false, status: 415, json: () => Promise.resolve({ error: { code: "unsupported_media_type", message: "nope" } }) }),
      )
      .mockResolvedValueOnce(
        fakeResponse({ ok: true, status: 201, json: () => Promise.resolve({ id: "u2", url: "/api/uploads/u2" }) }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const editor = fakeEditor(new Set(["b1", "b2"]));
    const uploadFile = createUploadFile({ noteId: "note-1", editorRef: { current: editor }, translate });

    const results = [];
    results.push(await uploadFile(file("a.pdf", "application/pdf"), "b1"));
    results.push(await uploadFile(file("a.png", "image/png"), "b2"));

    expect(results).toEqual(["", "/api/uploads/u2"]);
  });

  const translateWithOpts = (key: string, opts?: Record<string, unknown>) =>
    opts === undefined ? `t:${key}` : `t:${key}:${JSON.stringify(opts)}`;

  function quota409(storage: unknown) {
    return fakeResponse({
      ok: false, status: 409,
      json: () => Promise.resolve({ error: { code: "storage_quota_exceeded", message: "This space's storage quota is full." }, storage }),
    });
  }

  it("409 storage_quota_exceeded with numbers: title = errors.storage_quota_exceeded, description = storage.quotaDetail (the two numbers after formatBytes)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(quota409({ incomingBytes: 700, usedBytes: 1572864, quotaBytes: 1048576 })));
    const uploadFile = createUploadFile({ noteId: "note-1", editorRef: { current: fakeEditor(new Set(["b1"])) }, translate: translateWithOpts });
    await uploadFile(file(), "b1");
    await flushMacrotask();
    expect(toastMock).toHaveBeenCalledWith({
      title: "t:errors.storage_quota_exceeded",
      description: 't:storage.quotaDetail:{"used":"1.5 MB","quota":"1 MB"}',
    });
  });

  it("409 storage_quota_exceeded without numbers (that storage usage isn't visible): description = storage.quotaFullGeneric", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(quota409({ incomingBytes: 700 })));
    const uploadFile = createUploadFile({ noteId: "note-1", editorRef: { current: fakeEditor(new Set(["b1"])) }, translate: translateWithOpts });
    await uploadFile(file(), "b1");
    await flushMacrotask();
    expect(toastMock).toHaveBeenCalledWith({ title: "t:errors.storage_quota_exceeded", description: "t:storage.quotaFullGeneric" });
  });

  it("usedBytes present, quotaBytes null -> don't print half a pair of numbers, fall back to the generic text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(quota409({ incomingBytes: 700, usedBytes: 5, quotaBytes: null })));
    const uploadFile = createUploadFile({ noteId: "note-1", editorRef: { current: fakeEditor(new Set(["b1"])) }, translate: translateWithOpts });
    await uploadFile(file(), "b1");
    await flushMacrotask();
    expect(toastMock).toHaveBeenCalledWith({ title: "t:errors.storage_quota_exceeded", description: "t:storage.quotaFullGeneric" });
  });

  it("dedup is still by code: two 409s within 5 seconds, first with numbers and then without, toast only once", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(quota409({ incomingBytes: 1, usedBytes: 1, quotaBytes: 1 }))
      .mockResolvedValueOnce(quota409({ incomingBytes: null })));
    const uploadFile = createUploadFile({ noteId: "note-1", editorRef: { current: fakeEditor(new Set(["b1", "b2"])) }, translate: translateWithOpts });
    await uploadFile(file(), "b1");
    await flushMacrotask();
    await uploadFile(file(), "b2");
    await flushMacrotask();
    expect(toastMock).toHaveBeenCalledTimes(1);
  });
});

describe("createUploadFile with a real editor", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("an image placeholder inside a column fails to upload -> after a macrotask the column is left with an empty paragraph and the row remains", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        fakeResponse({ ok: false, status: 415, json: () => Promise.resolve({ error: { code: "unsupported_media_type", message: "nope" } }) }),
      ),
    );
    const m = mountEditor([P("x", "x"), row([[P("a", "a")], [{ ...IMG("img"), props: { url: "" } }]], "r"), P("z", "z")]);
    try {
      const uploadFile = createUploadFile({ noteId: "note-1", editorRef: { current: m.editor }, translate });
      await uploadFile(file(), "img");
      expect(shape(m.editor)).toBe("paragraph:x  ROW[COL(paragraph:a) | COL(image)]  paragraph:z");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(shape(m.editor)).toBe("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph)]  paragraph:z");
    } finally {
      m.destroy();
    }
  });
});
