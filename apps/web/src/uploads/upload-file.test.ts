import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BlockNoteEditor } from "@blocknote/core";
import { MAX_UPLOAD_BYTES } from "@knotebook/shared";
import { ApiFail } from "@/api/client";

// toast 換成 spy——同 `NoteEditor.test.ts` 的手法：這裡要斷言的是「有沒有提示、
// 提示了幾次、文案是什麼」，不必把 Radix 整套渲染起來。
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

/** 建一個「聲稱」超過 `MAX_UPLOAD_BYTES` 的 File——不真的配置那麼多記憶體。 */
function oversizedFile(): File {
  const f = file();
  Object.defineProperty(f, "size", { value: MAX_UPLOAD_BYTES + 1 });
  return f;
}

const translate = (key: string) => `t:${key}`;

describe("postUpload", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("成功：POST 到 /api/notes/:id/uploads（FormData 帶 file 欄位），回傳 {id, url}", async () => {
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

  it("noteId 經 encodeURIComponent（呼應 api/notes.ts 既有慣例）", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({ ok: true, status: 201, json: () => Promise.resolve({ id: "u1", url: "/api/uploads/u1" }) }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await postUpload("weird/id with space", file());

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/notes/${encodeURIComponent("weird/id with space")}/uploads`);
  });

  it("前驗：檔案超過 MAX_UPLOAD_BYTES → 直接丟 ApiFail(413, file_too_large)，不發請求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(postUpload("note-1", oversizedFile())).rejects.toMatchObject({
      status: 413,
      code: "file_too_large",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("server 端回應非 2xx → reject ApiFail（低階函式可 reject）", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({ ok: false, status: 415, json: () => Promise.resolve({ error: { code: "unsupported_media_type", message: "nope" } }) }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(postUpload("note-1", file())).rejects.toBeInstanceOf(ApiFail);
  });
});

describe("createUploadFile", () => {
  // toastOncePerCode 的去重 Map 是 module 級的（brief 明訂），跨測試共用同一份——
  // 若每個測試都把假時鐘釘在同一個絕對時間點（例如都歸零），前一個測試對同一個 code
  // 留下的時間戳跟下一個測試的「now」會相等或極接近，`now - last < 5000` 恆成立，
  // 下一個測試永遠被當成還在去重窗口內、假紅到看不出真正的行為（實測踩過）。改成每個
  // 測試起跑時把時鐘往前推一大段（遠大於 5 秒的去重窗口），讓不同測試對同一個 code
  // 的判定天然互不相干；`flushMacrotask` 也改用 `advanceTimersByTimeAsync`，真實
  // `setTimeout` 在假時鐘生效時本來就不會被觸發。
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

  function fakeEditor(blocks: Set<string>) {
    return {
      getBlock: vi.fn((id: string) => (blocks.has(id) ? { id } : undefined)),
      removeBlocks: vi.fn((ids: string[]) => {
        for (const id of ids) blocks.delete(id);
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 測試替身，同 repo 慣例的 BlockNoteEditor<any,any,any>
    } as unknown as BlockNoteEditor<any, any, any>;
  }

  async function flushMacrotask(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
  }

  it("成功：回傳 url，不 toast、不移除 block", async () => {
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
    expect(editor.removeBlocks).not.toHaveBeenCalled();
    expect(blocks.has("b1")).toBe(true);
  });

  it("失敗（4xx）：絕不 reject，回傳空字串 sentinel", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({ ok: false, status: 415, json: () => Promise.resolve({ error: { code: "unsupported_media_type", message: "nope" } }) }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const editor = fakeEditor(new Set(["b1"]));
    const uploadFile = createUploadFile({ noteId: "note-1", editorRef: { current: editor }, translate });

    await expect(uploadFile(file(), "b1")).resolves.toBe("");
  });

  it("失敗：placeholder block 在 macrotask 後被清掉（updateBlock 已經跑完才移除，不搶在它前面）", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({ ok: false, status: 415, json: () => Promise.resolve({ error: { code: "unsupported_media_type", message: "nope" } }) }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const blocks = new Set(["b1"]);
    const editor = fakeEditor(blocks);
    const uploadFile = createUploadFile({ noteId: "note-1", editorRef: { current: editor }, translate });

    await uploadFile(file(), "b1");
    // 剛 resolve 完（等同 handleFileInsertion 的 `await editor.uploadFile(...)` 那一行剛
    // 跑完），此時同步接續的 `editor.updateBlock(...)` 尚未有機會執行，我們的清除也還
    // 沒發生——因為它排在 macrotask。
    expect(editor.removeBlocks).not.toHaveBeenCalled();

    await flushMacrotask();

    expect(editor.removeBlocks).toHaveBeenCalledWith(["b1"]);
    expect(blocks.has("b1")).toBe(false);
  });

  it("失敗且沒有 blockId（例如呼叫端沒有 insertedBlockId）：不嘗試移除任何 block", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({ ok: false, status: 415, json: () => Promise.resolve({ error: { code: "unsupported_media_type", message: "nope" } }) }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const editor = fakeEditor(new Set());
    const uploadFile = createUploadFile({ noteId: "note-1", editorRef: { current: editor }, translate });

    await uploadFile(file());
    await flushMacrotask();

    expect(editor.removeBlocks).not.toHaveBeenCalled();
  });

  it("失敗但 block 已被使用者手動刪除（getBlock 找不到）：靜默略過，不丟例外", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({ ok: false, status: 415, json: () => Promise.resolve({ error: { code: "unsupported_media_type", message: "nope" } }) }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const editor = fakeEditor(new Set()); // b1 不存在
    const uploadFile = createUploadFile({ noteId: "note-1", editorRef: { current: editor }, translate });

    await uploadFile(file(), "b1");
    await flushMacrotask();

    expect(editor.removeBlocks).not.toHaveBeenCalled();
  });

  it("失敗但 editorRef.current 為 null（editor 已卸載）：靜默略過，不丟例外", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({ ok: false, status: 415, json: () => Promise.resolve({ error: { code: "unsupported_media_type", message: "nope" } }) }),
    );
    vi.stubGlobal("fetch", fetchMock);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 測試替身，同 repo 慣例的 BlockNoteEditor<any,any,any>
    const editorRef: { current: BlockNoteEditor<any, any, any> | null } = { current: null };
    const uploadFile = createUploadFile({ noteId: "note-1", editorRef, translate });

    await uploadFile(file(), "b1");
    await expect(flushMacrotask()).resolves.toBeUndefined();
  });

  it("失敗：toast 文案是 errors.<code>", async () => {
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

  it("toast 去重：同 code 在 5 秒內連續失敗只顯示一則", async () => {
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

  it("toast 去重窗口過後：超過 5 秒的同 code 失敗再次提示", async () => {
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

  it("批次後續檔案續傳：一個檔案失敗不影響下一個檔案成功", async () => {
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
});
