import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { AI_SSE_EVENTS, YDOC_FRAGMENT, type AiActionDto, type NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { noteSchema } from "@/collab/schema";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { AiSessionProvider, useAiSession } from "./AiSession";
import { AiPanel } from "./AiPanel";

// ── mount harness（同 `ai/apply.test.ts` 檔頭「wikilink render 需要 elementRenderer
// shim」的既有結論——這裡的 rebind／wikilink wire payload 測試會真的插入 wikilink 節點，
// 其餘測試用不到但掛著無害）─────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 編輯器泛型三元組，走 repo 慣例用 any
function mountedEditor(initial?: any[]) {
  const editor = BlockNoteEditor.create({ schema: noteSchema, initialContent: initial });
  const el = document.createElement("div");
  document.body.appendChild(el);
  editor.mount(el);
  editor.elementRenderer = (node: unknown, container: HTMLElement) =>
    flushSync(() => createRoot(container).render(node as never));
  return editor;
}

function mountedEditorOnDoc(doc: Y.Doc) {
  const options = withCollaboration({
    schema: noteSchema,
    collaboration: { fragment: doc.getXmlFragment(YDOC_FRAGMENT), user: { name: "tester", color: "#000" } },
  });
  const editor = BlockNoteEditor.create(options) as ReturnType<typeof mountedEditor>;
  const el = document.createElement("div");
  document.body.appendChild(el);
  editor.mount(el);
  editor.elementRenderer = (node: unknown, container: HTMLElement) =>
    flushSync(() => createRoot(container).render(node as never));
  return editor;
}

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
  body?: ReadableStream<Uint8Array> | null;
}

function fakeResponse({ ok, status, json, body }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))), body: body ?? null } as unknown as Response;
}

/** 一次 `POST /api/ai` 呼叫的可操作把手：測試可以在任意時間點 `push`/`close`，
 * 模擬「delta 陸續抵達」的真實時序，而不是一次性給完整結果。 */
interface AiCall {
  actionId: string;
  noteId: string;
  text: string;
  signal: AbortSignal;
  push(frame: string): void;
  close(): void;
}

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** 集中管理 `POST /api/ai` 的假回應：預設是「開一條串流、等測試手動推事件」；
 * `programError` 可以讓下一次呼叫改成 pre-stream 錯誤（一次性）。 */
function createAiFetchController() {
  const calls: AiCall[] = [];
  let nextError: { status: number; code: string; message: string } | null = null;

  function programError(status: number, code: string, message: string): void {
    nextError = { status, code, message };
  }

  function handle(init: RequestInit): Promise<Response> {
    if (nextError) {
      const { status, code, message } = nextError;
      nextError = null;
      return Promise.resolve(
        fakeResponse({ ok: false, status, json: () => Promise.resolve({ error: { code, message } }) }),
      );
    }
    const body = JSON.parse(String(init.body)) as { action_id: string; note_id: string; text: string };
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const encoder = new TextEncoder();
    calls.push({
      actionId: body.action_id,
      noteId: body.note_id,
      text: body.text,
      signal: init.signal as AbortSignal,
      push: (frame) => controller.enqueue(encoder.encode(frame)),
      close: () => controller.close(),
    });
    return Promise.resolve(fakeResponse({ ok: true, status: 200, body: stream }));
  }

  return { calls, handle, programError };
}

function stubFetch(opts: { actions: AiActionDto[]; notes: NoteDto[]; ai: ReturnType<typeof createAiFetchController> }) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/ai/actions" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ actions: opts.actions }) }));
      }
      if (url === "/api/notes" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(opts.notes) }));
      }
      if (url === "/api/ai" && method === "POST") {
        return opts.ai.handle(init!);
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

/** 測試專用：`revert-raw` 鈕刻意繞過 `AiPanel` 自己那顆會被 `disabled` 擋下點擊的還原鈕，
 * 直接呼叫 `revert()`——brief 的「revert() 撞 stale」這條驗收條件測的是 state machine
 * 本身的行為，不是「使用者按了一顆停用的鈕」（那件事 UI 層面已經由另一條測試蓋到：
 * 停用鈕本身有沒有正確顯示 `disabled`）。除此之外的每一顆「發起動作」的操作，本檔案
 * 一律經由 `AiPanel` 真正渲染出來的按鈕觸發（`startAction` helper）——不再用測試專屬的
 * driver 元件繞過 `start()` 的真實 UI 入口（fix round 1 M-1：mutation 測試證明過先前
 * driver-based 的寫法連「這條路徑在真實畫面上完全不可達」都測不出來）。 */
function RawRevertDriver() {
  const { revert } = useAiSession();
  return (
    <button type="button" onClick={revert}>
      revert-raw
    </button>
  );
}

interface RenderOverrides {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 編輯器泛型三元組，走 repo 慣例用 any
  editor?: any;
  noteId?: string;
  editable?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
function renderPanel(editor: any, noteId: string, editable: boolean, actions: AiActionDto[], notes: NoteDto[] = []) {
  const ai = createAiFetchController();
  stubFetch({ actions, notes, ai });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // 每次呼叫都重新 build 一棵**全新**的 element 樹（不是重用同一個 const）：React 對
  // 「傳進 `root.render`/`rerender` 的頂層 element 跟上一輪引用完全相同」有 bailout
  // 優化，整條子樹會被直接跳過、連 function body 都不會再跑一次——這裡的測試恰好就是
  // 要驗證「重新 render 才會反映外部變動」，若重用同一個 element 物件，`rerender()`
  // 會變成 no-op。`overrides` 讓呼叫端可以在 rerender 時真的換手 `editor`/`noteId`/
  // `editable`（I-1/I-4 兩案要模擬「筆記換手」，需要能把新值灌回同一棵樹）。
  const buildTree = (overrides: RenderOverrides = {}) => (
    <QueryClientProvider client={queryClient}>
      <AiSessionProvider
        editor={overrides.editor ?? editor}
        noteId={overrides.noteId ?? noteId}
        editable={overrides.editable ?? editable}
      >
        <RawRevertDriver />
        <AiPanel />
      </AiSessionProvider>
      <Toaster />
    </QueryClientProvider>
  );
  const result = render(buildTree());
  return { ai, queryClient, rerender: (overrides?: RenderOverrides) => result.rerender(buildTree(overrides)) };
}

const DIRECT_ACTION: AiActionDto = { id: "action-direct", name: "Rewrite", applyMode: "direct" };
const PREVIEW_ACTION: AiActionDto = { id: "action-preview", name: "Summarize", applyMode: "preview" };

const IDLE_TEXT = "Select some text and use the toolbar for a partial edit, or pick an action below to run it on the whole note.";
const EXPAND_LABEL = "Expand AI panel";

/** 面板預設收合——先展開再從 idle 態的動作清單點下去（fix round 1 M-1：這是「全文
 * 動作」在真實 UI 上唯一構得到的入口，見 `AiPanel.tsx`）。收合把手本身要等
 * `["ai-actions"]` 這個 query 落地才會出現（`actions.length === 0` 時 `AiPanel`
 * 整個不渲染，見該檔頭守門）——用 `findByRole`（會重試）而不是 `queryByRole`
 * （只查一次），否則會在 query 還 pending 的那一瞬間量到「收合把手不存在」就誤判成
 * 「已經展開了」，之後永遠等不到動作按鈕出現。 */
async function startAction(actionName: string): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: EXPAND_LABEL }));
  fireEvent.click(await screen.findByRole("button", { name: actionName }));
}

/** M-2 修復：先確認 `["ai-actions"]` 這個 query 真的落地成功（不是「還沒 resolve 所以
 * 畫面上剛好還沒有」這種 vacuous pass），才在**同一個** `waitFor` 回呼裡斷言收合把手
 * 缺席——兩個條件擺在同一個回呼，才會在「query 已經 success 但按鈕卻冒出來」時持續
 * retry 到逾時失敗，而不是在 query 還 pending 的當下就提早通過。 */
async function expectNoAiPanelAffordance(queryClient: QueryClient): Promise<void> {
  await waitFor(() => {
    expect(queryClient.getQueryState(["ai-actions"])?.status).toBe("success");
    expect(screen.queryByRole("button", { name: EXPAND_LABEL })).not.toBeInTheDocument();
  });
}

describe("AiSession + AiPanel（Task 6）", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
  let editor: any;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    editor?.unmount?.();
    vi.unstubAllGlobals();
  });

  it("actions 空（editable:true）→ 側欄發起區不渲染（含收合把手）", async () => {
    editor = mountedEditor([{ type: "paragraph", content: "文字" }]);
    const { queryClient } = renderPanel(editor, "note-1", true, []);

    await expectNoAiPanelAffordance(queryClient);
  });

  it("viewer（editable:false）→ 側欄發起區不渲染（含收合把手）", async () => {
    editor = mountedEditor([{ type: "paragraph", content: "文字" }]);
    const { queryClient } = renderPanel(editor, "note-1", false, [DIRECT_ACTION]);

    await expectNoAiPanelAffordance(queryClient);
  });

  it("M-1：idle 態側欄顯示所有可用動作按鈕——全文動作在真實 UI 的唯一入口", async () => {
    editor = mountedEditor([{ type: "paragraph", content: "文字" }]);
    renderPanel(editor, "note-1", true, [DIRECT_ACTION, PREVIEW_ACTION]);

    fireEvent.click(await screen.findByRole("button", { name: EXPAND_LABEL }));

    expect(await screen.findByRole("button", { name: DIRECT_ACTION.name })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: PREVIEW_ACTION.name })).toBeInTheDocument();
  });

  it("direct＋有選取 → 串流完自動套用；送出的 wire payload 帶正確 noteId/text（I-3）", async () => {
    editor = mountedEditor([
      { type: "paragraph", content: "段落一" },
      { type: "paragraph", content: "段落二" },
    ]);
    const ids = editor.document.map((b: { id: string }) => b.id);
    editor.setSelection(ids[0], ids[1]);

    const { ai } = renderPanel(editor, "note-1", true, [DIRECT_ACTION]);
    await startAction(DIRECT_ACTION.name);

    await waitFor(() => expect(ai.calls).toHaveLength(1));
    expect(ai.calls[0].noteId).toBe("note-1");
    expect(ai.calls[0].text).toContain("段落一");
    expect(ai.calls[0].text).toContain("段落二");

    act(() => {
      ai.calls[0].push(sseFrame(AI_SSE_EVENTS.delta, { text: "改寫結果" }));
      ai.calls[0].push(sseFrame(AI_SSE_EVENTS.done, {}));
      ai.calls[0].close();
    });

    await waitFor(() => expect(JSON.stringify(editor.document)).toContain("改寫結果"));
    expect(JSON.stringify(editor.document)).not.toContain("段落一");
    // 自動套用完成：沒有「套用」鈕，但有「還原」鈕。
    await waitFor(() => expect(screen.getByRole("button", { name: "Revert" })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
  });

  it("wire payload：錨點含 wikilink → 送出的 text 含 [[標題]]（Plan 3 序列化鋪路，I-3）", async () => {
    editor = mountedEditor([
      {
        type: "paragraph",
        content: ["See ", { type: "wikilink", props: { targetNoteId: "note-x", snapshotTitle: "目標筆記" } }, " here."],
      },
      { type: "paragraph", content: "第二段" },
    ]);
    const ids = editor.document.map((b: { id: string }) => b.id);
    editor.setSelection(ids[0], ids[1]);

    const { ai } = renderPanel(editor, "note-1", true, [DIRECT_ACTION]);
    await startAction(DIRECT_ACTION.name);

    await waitFor(() => expect(ai.calls).toHaveLength(1));
    expect(ai.calls[0].text).toContain("[[目標筆記]]");
  });

  it("preview → 顯示套用鈕，按下走守門並真的套用", async () => {
    editor = mountedEditor([
      { type: "paragraph", content: "段落一" },
      { type: "paragraph", content: "段落二" },
    ]);
    const ids = editor.document.map((b: { id: string }) => b.id);
    editor.setSelection(ids[0], ids[1]);

    const { ai } = renderPanel(editor, "note-1", true, [PREVIEW_ACTION]);
    await startAction(PREVIEW_ACTION.name);

    await waitFor(() => expect(ai.calls).toHaveLength(1));
    act(() => {
      ai.calls[0].push(sseFrame(AI_SSE_EVENTS.delta, { text: "摘要內容" }));
      ai.calls[0].push(sseFrame(AI_SSE_EVENTS.done, {}));
      ai.calls[0].close();
    });

    const applyButton = await screen.findByRole("button", { name: "Apply" });
    // preview 尚未套用：文件仍是原文。
    expect(JSON.stringify(editor.document)).toContain("段落一");

    fireEvent.click(applyButton);

    await waitFor(() => expect(JSON.stringify(editor.document)).toContain("摘要內容"));
    expect(JSON.stringify(editor.document)).not.toContain("段落一");
  });

  it("全文動作（無選取）→ 強制 preview，就算 action 是 direct", async () => {
    editor = mountedEditor([{ type: "paragraph", content: "唯一段落" }]);
    // 不呼叫 setSelection——維持游標collapsed，`getSelection()` 回 undefined。

    const { ai } = renderPanel(editor, "note-1", true, [DIRECT_ACTION]);
    await startAction(DIRECT_ACTION.name);

    await waitFor(() => expect(ai.calls).toHaveLength(1));
    act(() => {
      ai.calls[0].push(sseFrame(AI_SSE_EVENTS.delta, { text: "全文改寫" }));
      ai.calls[0].push(sseFrame(AI_SSE_EVENTS.done, {}));
      ai.calls[0].close();
    });

    // 強制 preview：即使 applyMode 是 direct，也要看到「套用」鈕、且文件尚未變動。
    await screen.findByRole("button", { name: "Apply" });
    expect(JSON.stringify(editor.document)).toContain("唯一段落");
  });

  it("I-2：選取內含非文字 block（image）→ 強制 preview，就算 action 是 direct", async () => {
    // `editor.setSelection(start, end)` 要求頭尾兩個 block 都「有內容」（image 的
    // `content: "none"` 直接被 BlockNote 拒絕，見 `@blocknote/core` 的
    // `setSelection` 實作），沒辦法直接把 image block 當成選取的起點/終點；但
    // `getSelection()` 回傳的 `.blocks` 是「共同深度下起訖索引之間的所有 block」，
    // 中間夾著的 image block 一樣會被列進去。三個 block（文字/image/文字），選頭尾
    // 兩個文字 block，兩全其美：`setSelection` 的前置條件滿足，`hasNonTextBlock`
    // 要驗證的「錨點內含 image」也滿足。
    editor = mountedEditor([
      { type: "paragraph", content: "文字段落" },
      { type: "image", props: { url: "https://example.com/a.png" } },
      { type: "paragraph", content: "文字段落二" },
    ]);
    const ids = editor.document.map((b: { id: string }) => b.id);
    editor.setSelection(ids[0], ids[2]);

    const { ai } = renderPanel(editor, "note-1", true, [DIRECT_ACTION]);
    await startAction(DIRECT_ACTION.name);

    await waitFor(() => expect(ai.calls).toHaveLength(1));
    act(() => {
      ai.calls[0].push(sseFrame(AI_SSE_EVENTS.delta, { text: "改寫結果" }));
      ai.calls[0].push(sseFrame(AI_SSE_EVENTS.done, {}));
      ai.calls[0].close();
    });

    // 錨點含 image block：即使 applyMode 是 direct，也要停在 preview，不自動套用。
    await screen.findByRole("button", { name: "Apply" });
    expect(JSON.stringify(editor.document)).toContain("文字段落");
    expect(JSON.stringify(editor.document)).not.toContain("改寫結果");
  });

  it("守門 changed：自動套用途中錨點被改 → 中止提示，結果仍留在側欄，文件不套用", async () => {
    editor = mountedEditor([
      { type: "paragraph", content: "段落一" },
      { type: "paragraph", content: "段落二" },
    ]);
    const ids = editor.document.map((b: { id: string }) => b.id);
    editor.setSelection(ids[0], ids[1]);

    const { ai } = renderPanel(editor, "note-1", true, [DIRECT_ACTION]);
    await startAction(DIRECT_ACTION.name);

    await waitFor(() => expect(ai.calls).toHaveLength(1));
    // 串流「途中」錨點被改（模擬他人協作編輯）——串流完成後守門會擋下自動套用。
    act(() => {
      editor.updateBlock(ids[0], { content: "被搶先改掉了" });
    });
    act(() => {
      ai.calls[0].push(sseFrame(AI_SSE_EVENTS.delta, { text: "改寫結果" }));
      ai.calls[0].push(sseFrame(AI_SSE_EVENTS.done, {}));
      ai.calls[0].close();
    });

    // 中止提示：guard-failed toast。
    await waitFor(() => expect(screen.getByText("The original text changed since this result was generated, so it wasn't applied.")).toBeInTheDocument());
    // 結果仍留在側欄（pendingPreview，可見「套用」鈕）。
    expect(screen.getByRole("button", { name: "Apply" })).toBeInTheDocument();
    // 文件沒有被套用結果覆蓋——保留剛才那次搶先的改動，AI 結果沒有寫入。
    expect(JSON.stringify(editor.document)).toContain("被搶先改掉了");
    expect(JSON.stringify(editor.document)).not.toContain("改寫結果");
  });

  it("I-4：apply() 前 noteId 已換手（noteMismatch）→ 文件不變＋toast，不套用", async () => {
    editor = mountedEditor([
      { type: "paragraph", content: "段落一" },
      { type: "paragraph", content: "段落二" },
    ]);
    const ids = editor.document.map((b: { id: string }) => b.id);
    editor.setSelection(ids[0], ids[1]);

    const { ai, rerender } = renderPanel(editor, "note-1", true, [PREVIEW_ACTION]);
    await startAction(PREVIEW_ACTION.name);
    await waitFor(() => expect(ai.calls).toHaveLength(1));
    act(() => {
      ai.calls[0].push(sseFrame(AI_SSE_EVENTS.delta, { text: "摘要內容" }));
      ai.calls[0].push(sseFrame(AI_SSE_EVENTS.done, {}));
      ai.calls[0].close();
    });
    await screen.findByRole("button", { name: "Apply" });
    const before = JSON.stringify(editor.document);

    // 換手 noteId（同一個 editor）：模擬「錨點記下的筆記」跟「現在的筆記」對不上——
    // `applyAiResult` 本身不收 current noteId，這半條守門歸 `AiSession`（Task 1 審查
    // I-3，`runGuardedApply` 的 `anchor.noteId !== noteId` 檢查）。這裡刻意還在
    // "done" 態（不是串流中），才不會被 `AiSession.tsx` 新增的「串流中 noteId 換手」
    // 那道防線（只對 "streaming" 態生效）搶先攔截，留得住 `apply()` 這條路徑可測。
    act(() => {
      rerender({ noteId: "note-2" });
    });

    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(JSON.stringify(editor.document)).toBe(before);
    await waitFor(() => expect(screen.getByText("The original text changed since this result was generated, so it wasn't applied.")).toBeInTheDocument());
  });

  it("I-1：串流中 noteId 換手 → 中止且不套用，舊文件不變，面板收回 idle", async () => {
    editor = mountedEditor([
      { type: "paragraph", content: "段落一" },
      { type: "paragraph", content: "段落二" },
    ]);
    const ids = editor.document.map((b: { id: string }) => b.id);
    editor.setSelection(ids[0], ids[1]);
    const before = JSON.stringify(editor.document);

    const { ai, rerender } = renderPanel(editor, "note-1", true, [DIRECT_ACTION]);
    await startAction(DIRECT_ACTION.name);
    await waitFor(() => expect(ai.calls).toHaveLength(1));

    // 模擬「串流中途切換到別篇筆記」：noteId 換手直接命中 `AiSession.tsx` 新增的
    // noteId-change effect（只在 "streaming" 態生效），abort 進行中的請求並把 state
    // 收回 idle。
    act(() => {
      rerender({ noteId: "note-2" });
    });

    expect(await screen.findByText(IDLE_TEXT)).toBeInTheDocument();
    expect(ai.calls[0].signal.aborted).toBe(true);

    // 即使舊串流之後仍然送出 delta/done（伺服器端可能還沒真的斷線），也不會寫回文件——
    // `onDelta`/`.then()` 續體都會先比對 `abortControllerRef.current !== controller`
    // 而 no-op。
    act(() => {
      ai.calls[0].push(sseFrame(AI_SSE_EVENTS.delta, { text: "改寫結果" }));
      ai.calls[0].push(sseFrame(AI_SSE_EVENTS.done, {}));
      ai.calls[0].close();
    });
    expect(JSON.stringify(editor.document)).toBe(before);
  });

  it("I-1（核心修法）：串流中 editor 換手（noteId 不變的邊界情境）→ 自動套用改用現在的 editor（live ref），不寫進舊 editor", async () => {
    const editorOld = mountedEditor([
      { type: "paragraph", content: "段落一" },
      { type: "paragraph", content: "段落二" },
    ]);
    editor = editorOld; // afterEach 清掉這一個；editorNew 在測試尾端自行 unmount。
    const idsOld = editorOld.document.map((b: { id: string }) => b.id);
    editorOld.setSelection(idsOld[0], idsOld[1]);
    const beforeOld = JSON.stringify(editorOld.document);

    const editorNew = mountedEditor([{ type: "paragraph", content: "新筆記的內容" }]);

    const { ai, rerender } = renderPanel(editorOld, "note-1", true, [DIRECT_ACTION]);
    await startAction(DIRECT_ACTION.name);
    await waitFor(() => expect(ai.calls).toHaveLength(1));

    // `editor` 換手，`noteId` 刻意保持不變——隔離測試「自動套用續體該讀
    // `editorRef.current` 還是 `start()` 當下捕捉的舊 `currentEditor`」這件事本身。
    // 若 `noteId` 也換手，`AiSession.tsx` 新增的 noteId-change effect 會直接搶先
    // abort＋reset，測不到這支修法要驗證的東西（同一個原因，見上一條測試的註解）。
    act(() => {
      rerender({ editor: editorNew });
    });

    act(() => {
      ai.calls[0].push(sseFrame(AI_SSE_EVENTS.delta, { text: "改寫結果" }));
      ai.calls[0].push(sseFrame(AI_SSE_EVENTS.done, {}));
      ai.calls[0].close();
    });

    // 舊 editor 完全沒被寫入——修法之前的 bug 會把結果寫進這裡（`currentEditor`
    // 是 start() 當下捕捉的閉包值，anchor 對它而言仍然「守門通過」，於是就真的寫進去）。
    await waitFor(() => expect(JSON.stringify(editorOld.document)).toBe(beforeOld));
    // 新 editor 也沒被寫入：`noteIdRef.current`（"note-1"）仍等於 anchor.noteId，
    // `noteMismatch` 不會擋，但 anchor 的 blockIds 對新 editor 的文件而言全部
    // 「missing」（新 editor 壓根沒有那些 block id）——一樣落在守門，只是 reason
    // 不同，殊途同歸：不寫入。
    expect(JSON.stringify(editorNew.document)).not.toContain("改寫結果");

    editorNew.unmount();
  });

  it("revert 往返：套用後可還原成原文；他人改動插入內容後，還原鈕停用（render 時即時判）", async () => {
    editor = mountedEditor([
      { type: "paragraph", content: "原文段落一" },
      { type: "paragraph", content: "原文段落二" },
    ]);
    const ids = editor.document.map((b: { id: string }) => b.id);
    editor.setSelection(ids[0], ids[1]);

    const { ai, rerender } = renderPanel(editor, "note-1", true, [DIRECT_ACTION]);
    await startAction(DIRECT_ACTION.name);
    await waitFor(() => expect(ai.calls).toHaveLength(1));
    act(() => {
      ai.calls[0].push(sseFrame(AI_SSE_EVENTS.delta, { text: "新內容" }));
      ai.calls[0].push(sseFrame(AI_SSE_EVENTS.done, {}));
      ai.calls[0].close();
    });

    await waitFor(() => expect(JSON.stringify(editor.document)).toContain("新內容"));
    const revertButton = await screen.findByRole("button", { name: "Revert" });
    expect(revertButton).toBeEnabled();

    fireEvent.click(revertButton);

    // 還原成功：文件回到原文，「套用」鈕重新出現（可以再決定要不要重套）。
    await waitFor(() => expect(JSON.stringify(editor.document)).toContain("原文段落一"));
    expect(JSON.stringify(editor.document)).not.toContain("新內容");
    const applyAgain = await screen.findByRole("button", { name: "Apply" });

    // 重新套用一次，回到「applied」狀態，才能驗證「他人改動後停用」這條。
    fireEvent.click(applyAgain);
    await waitFor(() => expect(JSON.stringify(editor.document)).toContain("新內容"));
    const revertButton2 = await screen.findByRole("button", { name: "Revert" });
    expect(revertButton2).toBeEnabled();

    // 他人（或任何外部操作）改動了剛插入的內容——`canRevert()` 是 render 時即時判，
    // 不是反應式訂閱，所以要有新一輪 render 才會反映出來（比照 brief 原文：這是
    // 「非反應式讀取」的既有特性，不是 bug）。
    const insertedId = editor.document[0].id;
    act(() => {
      editor.updateBlock(insertedId, { content: "遠端又改了一次" });
    });
    rerender();

    expect(screen.getByRole("button", { name: "Revert" })).toBeDisabled();
  });

  it("revert() 撞 stale（改動發生在 render 之後）→ toast＋applied 清空，文件不變（不還原）", async () => {
    editor = mountedEditor([
      { type: "paragraph", content: "原文段落一" },
      { type: "paragraph", content: "原文段落二" },
    ]);
    const ids = editor.document.map((b: { id: string }) => b.id);
    editor.setSelection(ids[0], ids[1]);

    const { ai } = renderPanel(editor, "note-1", true, [DIRECT_ACTION]);
    await startAction(DIRECT_ACTION.name);
    await waitFor(() => expect(ai.calls).toHaveLength(1));
    act(() => {
      ai.calls[0].push(sseFrame(AI_SSE_EVENTS.delta, { text: "新內容" }));
      ai.calls[0].push(sseFrame(AI_SSE_EVENTS.done, {}));
      ai.calls[0].close();
    });
    await waitFor(() => expect(JSON.stringify(editor.document)).toContain("新內容"));

    const insertedId = editor.document[0].id;
    act(() => {
      editor.updateBlock(insertedId, { content: "在還原之前先被改動" });
    });
    const before = JSON.stringify(editor.document);

    // 繞過 `AiPanel` 自己會被 `disabled` 擋下的還原鈕，直接呼叫 `revert()`——
    // 驗證的是 state machine 本身「撞 stale」時的行為，不是 UI 鈕的可點擊性。
    fireEvent.click(screen.getByRole("button", { name: "revert-raw" }));

    await waitFor(() => expect(screen.getByText("This change can no longer be reverted — the text may have changed since.")).toBeInTheDocument());
    expect(JSON.stringify(editor.document)).toBe(before); // 文件不變：revertAiResult 偵測到 stale 後不會呼叫 replaceBlocks
    // applied 已清空：還原鈕不再出現（pendingPreview 維持 false，也還沒有「套用」鈕）。
    expect(screen.queryByRole("button", { name: "Revert" })).not.toBeInTheDocument();
  });

  it("中斷（cancel）→ abort 且編輯器零寫入（editor.document 前後相等）", async () => {
    editor = mountedEditor([
      { type: "paragraph", content: "段落一" },
      { type: "paragraph", content: "段落二" },
    ]);
    const ids = editor.document.map((b: { id: string }) => b.id);
    editor.setSelection(ids[0], ids[1]);
    const before = JSON.stringify(editor.document);

    const { ai } = renderPanel(editor, "note-1", true, [DIRECT_ACTION]);
    await startAction(DIRECT_ACTION.name);
    await waitFor(() => expect(ai.calls).toHaveLength(1));

    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(ai.calls[0].signal.aborted).toBe(true);
    expect(JSON.stringify(editor.document)).toBe(before);
    // 取消後回到 idle（面板仍展開，因為 `start()` 已經展開過一次）。
    expect(await screen.findByText(IDLE_TEXT)).toBeInTheDocument();
  });

  it("錯誤態顯示 errors.<code> 文案＋重試鈕；重試會重新呼叫同一個 action", async () => {
    editor = mountedEditor([
      { type: "paragraph", content: "段落一" },
      { type: "paragraph", content: "段落二" },
    ]);
    const ids = editor.document.map((b: { id: string }) => b.id);
    editor.setSelection(ids[0], ids[1]);

    const { ai } = renderPanel(editor, "note-1", true, [DIRECT_ACTION]);
    ai.programError(503, "ai_not_configured", "AI 尚未設定，請聯絡管理員");
    await startAction(DIRECT_ACTION.name);

    expect(await screen.findByText("AI is not configured yet")).toBeInTheDocument();
    expect(ai.calls).toHaveLength(0); // pre-stream 錯誤不會落地成一次「串流呼叫」

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(ai.calls).toHaveLength(1));
    expect(ai.calls[0].actionId).toBe(DIRECT_ACTION.id);
  });

  it("Minor-3：done 態（preview 尚未套用）也有重試鈕，會重新呼叫同一個 action", async () => {
    editor = mountedEditor([
      { type: "paragraph", content: "段落一" },
      { type: "paragraph", content: "段落二" },
    ]);
    const ids = editor.document.map((b: { id: string }) => b.id);
    editor.setSelection(ids[0], ids[1]);

    const { ai } = renderPanel(editor, "note-1", true, [PREVIEW_ACTION]);
    await startAction(PREVIEW_ACTION.name);
    await waitFor(() => expect(ai.calls).toHaveLength(1));
    act(() => {
      ai.calls[0].push(sseFrame(AI_SSE_EVENTS.delta, { text: "摘要內容" }));
      ai.calls[0].push(sseFrame(AI_SSE_EVENTS.done, {}));
      ai.calls[0].close();
    });
    await screen.findByRole("button", { name: "Apply" });

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(ai.calls).toHaveLength(2));
    expect(ai.calls[1].actionId).toBe(PREVIEW_ACTION.id);
  });

  it("unboundCount>0 → 重綁 toast 顯示一次，且未命中的 [[連結]] 保留純文字", async () => {
    editor = mountedEditor([
      { type: "paragraph", content: "段落一" },
      { type: "paragraph", content: "段落二" },
    ]);
    const ids = editor.document.map((b: { id: string }) => b.id);
    editor.setSelection(ids[0], ids[1]);

    // notes 清單裡沒有任何一篇叫「不存在的筆記」——零命中，unboundCount 會是 1。
    const { ai } = renderPanel(editor, "note-1", true, [DIRECT_ACTION], []);
    await startAction(DIRECT_ACTION.name);
    await waitFor(() => expect(ai.calls).toHaveLength(1));
    act(() => {
      ai.calls[0].push(sseFrame(AI_SSE_EVENTS.delta, { text: "見 [[不存在的筆記]]" }));
      ai.calls[0].push(sseFrame(AI_SSE_EVENTS.done, {}));
      ai.calls[0].close();
    });

    await waitFor(() =>
      expect(screen.getByText("Some [[links]] in the result couldn't be linked automatically.")).toBeInTheDocument(),
    );
    expect(JSON.stringify(editor.document)).toContain("[[不存在的筆記]]");
  });
});

// ── 雙編輯器守門案（spec §13.5-4(ii) 字面）─────────────────────────────────────
//
// 兩個 `BlockNoteEditor` 以 `withCollaboration` 綁同一份 `Y.Doc`（fragment 用 shared 的
// `YDOC_FRAGMENT`，比照 Plan 2/3 共編測試慣例）：第一個 editor（掛 `AiSessionProvider`）
// 發起串流，第二個 editor（純粹的「遠端協作者」，不掛任何 React context）在串流完成前
// `updateBlock` 改動錨點 block——這證明的是「遠端 CRDT update 真的會反映到快照字串」，
// 跟前面「守門 changed」那條測試（同一個 editor 自己改自己）測的是同一條守門邏輯，
// 但這裡驗證的是**跨編輯器**的資料路徑本身沒有問題（y-prosemirror 同步 → 快照字串
// 跟著變）。
describe("AiSession：雙編輯器守門案（spec §13.5-4(ii)）", () => {
  let doc: Y.Doc;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
  let editorA: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
  let editorB: any;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
    doc = new Y.Doc();
    editorA = mountedEditorOnDoc(doc);
    editorA.replaceBlocks(editorA.document, [
      { type: "paragraph", content: "共編段落一" },
      { type: "paragraph", content: "共編段落二" },
    ]);
    editorB = mountedEditorOnDoc(doc);
  });

  afterEach(() => {
    editorA.unmount();
    editorB.unmount();
    doc.destroy();
    vi.unstubAllGlobals();
  });

  it("第二個 editor 的 updateBlock 改動錨點 → 第一個 editor 的自動套用被守門 2 擋下", async () => {
    const ids = editorA.document.map((b: { id: string }) => b.id);
    editorA.setSelection(ids[0], ids[1]);

    const { ai } = renderPanel(editorA, "note-1", true, [DIRECT_ACTION]);
    await startAction(DIRECT_ACTION.name);
    await waitFor(() => expect(ai.calls).toHaveLength(1));

    // 「遠端」協作者（editorB，綁同一份 Y.Doc）改動了 editorA 剛剛錨定的那個 block——
    // y-prosemirror 同步是同步的（Yjs 觀察者在同一個 transact 裡觸發），不必等待。
    act(() => {
      editorB.updateBlock(ids[0], { content: "遠端協作者搶先改了" });
    });

    act(() => {
      ai.calls[0].push(sseFrame(AI_SSE_EVENTS.delta, { text: "AI 改寫結果" }));
      ai.calls[0].push(sseFrame(AI_SSE_EVENTS.done, {}));
      ai.calls[0].close();
    });

    await waitFor(() =>
      expect(
        screen.getByText("The original text changed since this result was generated, so it wasn't applied."),
      ).toBeInTheDocument(),
    );
    // 兩個 editor 的文件一致（同一份 Y.Doc）：遠端的改動保留，AI 結果沒有寫入。
    expect(JSON.stringify(editorA.document)).toContain("遠端協作者搶先改了");
    expect(JSON.stringify(editorA.document)).not.toContain("AI 改寫結果");
    expect(JSON.stringify(editorB.document)).toContain("遠端協作者搶先改了");
  });
});
