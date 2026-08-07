import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { createRef, forwardRef, useImperativeHandle, useState, type ReactNode } from "react";
import { createPortal, flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { noteSchema } from "@/collab/schema";
import { insertWikilink } from "@/components/wikilink/spec";
import type { CollabState } from "./connection";
import { createLinkSync, extractLinkTargets } from "./link-sync";

// `createLinkSync` 對 400 的處理會 `toast()` + 查 i18n 文案（見 link-sync.ts 的
// `handleFailure`）——換成最小替身，避免這個檔案的單元測試依賴真的 Radix
// toast store／i18next 初始化時序（同 `NoteEditor.test.ts` 的 toast mock 手法）。
const toastMock = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/toast", () => ({ toast: toastMock }));
const i18nMock = vi.hoisted(() => ({ t: vi.fn((key: string) => key) }));
vi.mock("@/i18n", () => ({ default: i18nMock }));

const NOTE_ID = "11111111-1111-1111-1111-111111111111";
const TARGET_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TARGET_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const LINKS_PATH = `/api/notes/${NOTE_ID}/links`;
/** 與 link-sync.ts 內的 `DEBOUNCE_MS` 對齊（該常數未匯出，這裡用同值常數避免魔數重複打字打錯）。 */
const DEBOUNCE_MS_FOR_TEST = 2_000;

function wikilinkElement(targetNoteId: string): Y.XmlElement {
  const el = new Y.XmlElement("wikilink");
  el.setAttribute("targetNoteId", targetNoteId);
  el.setAttribute("snapshotTitle", "t");
  return el;
}

/** 直接操作 Y.Doc 的 XmlFragment（不透過編輯器）：把 fragment 內容換成一個 paragraph，
 * 底下巢狀放給定的 wikilink 節點——模擬「使用者編輯完內容，wikilink 集合變成這樣」。
 * 整段包在 `doc.transact` 裡：只觸發一次 `update` 事件，符合一次真實編輯的樣子。 */
function setWikilinks(doc: Y.Doc, targetNoteIds: string[]): void {
  doc.transact(() => {
    const fragment = doc.getXmlFragment(YDOC_FRAGMENT);
    fragment.delete(0, fragment.length);
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, targetNoteIds.map(wikilinkElement));
    fragment.insert(0, [paragraph]);
  });
}

function connected(role: "owner" | "editor" | "viewer" | "none"): CollabState {
  return { phase: "connected", role };
}

describe("extractLinkTargets", () => {
  it("遞迴走訪找出巢狀 wikilink 節點的 targetNoteId：去重、排序、濾掉非 uuid 格式", () => {
    const doc = new Y.Doc();
    setWikilinks(doc, [TARGET_B, TARGET_A, TARGET_B, "not-a-uuid"]);

    expect(extractLinkTargets(doc)).toEqual([TARGET_A, TARGET_B]);

    doc.destroy();
  });

  it("fragment 空、或完全沒有 wikilink 節點 → 空陣列", () => {
    const doc = new Y.Doc();
    doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [new Y.XmlElement("paragraph")]);

    expect(extractLinkTargets(doc)).toEqual([]);

    doc.destroy();
  });
});

describe("createLinkSync", () => {
  let doc: Y.Doc;
  let api: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    doc = new Y.Doc();
    toastMock.mockClear();
    i18nMock.t.mockClear();
  });

  afterEach(() => {
    doc.destroy();
    vi.useRealTimers();
  });

  function linksBody(targetNoteIds: string[]): RequestInit {
    return expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ link_target_ids: targetNoteIds }),
    }) as unknown as RequestInit;
  }

  it("synced 後立即提交一次，不等 debounce", async () => {
    api = vi.fn().mockResolvedValue(undefined);
    setWikilinks(doc, [TARGET_A]);
    const linkSync = createLinkSync({ noteId: NOTE_ID, doc, api });
    linkSync.start();

    linkSync.onSynced();
    await vi.advanceTimersByTimeAsync(0);

    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith(LINKS_PATH, linksBody([TARGET_A]));
  });

  it("start() 本身不提交：沒收到 synced 之前，doc 變動也不會送出", async () => {
    api = vi.fn().mockResolvedValue(undefined);
    const linkSync = createLinkSync({ noteId: NOTE_ID, doc, api });
    linkSync.start();

    setWikilinks(doc, [TARGET_A]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS_FOR_TEST);

    expect(api).not.toHaveBeenCalled();
  });

  it("未變不送：debounce 之後重算集合與上次成功提交相同就不再打 API", async () => {
    api = vi.fn().mockResolvedValue(undefined);
    setWikilinks(doc, [TARGET_A]);
    const linkSync = createLinkSync({ noteId: NOTE_ID, doc, api });
    linkSync.start();
    linkSync.onSynced();
    await vi.advanceTimersByTimeAsync(0);
    expect(api).toHaveBeenCalledTimes(1);

    // 內容變動但重算後的 wikilink 集合不變（例如打字、或再插入同一個目標）。
    setWikilinks(doc, [TARGET_A]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS_FOR_TEST);

    expect(api).toHaveBeenCalledTimes(1);
  });

  it("集合真的變動：debounce 之後重送新的完整集合", async () => {
    api = vi.fn().mockResolvedValue(undefined);
    setWikilinks(doc, [TARGET_A]);
    const linkSync = createLinkSync({ noteId: NOTE_ID, doc, api });
    linkSync.start();
    linkSync.onSynced();
    await vi.advanceTimersByTimeAsync(0);
    expect(api).toHaveBeenCalledTimes(1);

    setWikilinks(doc, [TARGET_A, TARGET_B]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS_FOR_TEST);

    expect(api).toHaveBeenCalledTimes(2);
    expect(api).toHaveBeenLastCalledWith(LINKS_PATH, linksBody([TARGET_A, TARGET_B]));
  });

  it("debounce 會用最新一次變動重新計時，不是每次變動各自算 2s", async () => {
    api = vi.fn().mockResolvedValue(undefined);
    setWikilinks(doc, [TARGET_A]);
    const linkSync = createLinkSync({ noteId: NOTE_ID, doc, api });
    linkSync.start();
    linkSync.onSynced();
    await vi.advanceTimersByTimeAsync(0);
    expect(api).toHaveBeenCalledTimes(1);

    setWikilinks(doc, [TARGET_A, TARGET_B]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS_FOR_TEST - 1);
    setWikilinks(doc, [TARGET_A, TARGET_B]); // 同一集合，但重置了 debounce 計時
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS_FOR_TEST - 1);
    expect(api).toHaveBeenCalledTimes(1); // 還沒滿 2s 靜止，不該送

    await vi.advanceTimersByTimeAsync(1);
    expect(api).toHaveBeenCalledTimes(2);
  });

  it("遠端更新（非本地 origin 的 Y.applyUpdate）一樣觸發 debounce 重算提交（spec：含遠端）", async () => {
    // `doc.on("update", …)` 的 handler（`onDocUpdate`）刻意不檢查事件的 origin 參數——
    // 這裡專門用「另一個 Y.Doc 编輯後 Y.applyUpdate 回本體、origin 給一個跟本地 transact
    // 明顯不同的字串」來造出貨真價實的「遠端」更新（不是同一個 doc 上用預設 origin 呼叫
    // `doc.transact`），確保就算未來有人把 `onDocUpdate` 改成只認本地 origin，這裡也會紅。
    api = vi.fn().mockResolvedValue(undefined);
    const linkSync = createLinkSync({ noteId: NOTE_ID, doc, api });
    linkSync.start();
    linkSync.onSynced();
    await vi.advanceTimersByTimeAsync(0);
    expect(api).toHaveBeenCalledTimes(1); // 初始空集合
    expect(api).toHaveBeenLastCalledWith(LINKS_PATH, linksBody([]));

    const remote = new Y.Doc();
    setWikilinks(remote, [TARGET_A]);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote), "remote-peer");

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS_FOR_TEST);

    expect(api).toHaveBeenCalledTimes(2);
    expect(api).toHaveBeenLastCalledWith(LINKS_PATH, linksBody([TARGET_A]));

    remote.destroy();
  });

  it("重連重置必重送：每次 onSynced 都重置快取，內容沒變也重送一次", async () => {
    api = vi.fn().mockResolvedValue(undefined);
    setWikilinks(doc, [TARGET_A]);
    const linkSync = createLinkSync({ noteId: NOTE_ID, doc, api });
    linkSync.start();

    linkSync.onSynced();
    await vi.advanceTimersByTimeAsync(0);
    expect(api).toHaveBeenCalledTimes(1);

    linkSync.onSynced();
    await vi.advanceTimersByTimeAsync(0);
    expect(api).toHaveBeenCalledTimes(2);
    expect(api).toHaveBeenLastCalledWith(LINKS_PATH, linksBody([TARGET_A]));
  });

  it("stop() 之後不再有任何提交（監聽已移除、排程已清空）", async () => {
    api = vi.fn().mockResolvedValue(undefined);
    setWikilinks(doc, [TARGET_A]);
    const linkSync = createLinkSync({ noteId: NOTE_ID, doc, api });
    linkSync.start();
    linkSync.onSynced();
    await vi.advanceTimersByTimeAsync(0);
    expect(api).toHaveBeenCalledTimes(1);

    linkSync.stop();
    setWikilinks(doc, [TARGET_A, TARGET_B]);
    await vi.advanceTimersByTimeAsync(60_000);
    linkSync.onSynced();
    await vi.advanceTimersByTimeAsync(0);

    expect(api).toHaveBeenCalledTimes(1);
  });

  it("409 not_loaded：1s 後重試一次，仍失敗就放棄、不再自動重試", async () => {
    api = vi
      .fn()
      .mockRejectedValueOnce(new ApiFail(409, "not_loaded", "x"))
      .mockRejectedValueOnce(new ApiFail(409, "not_loaded", "x"));
    setWikilinks(doc, [TARGET_A]);
    const linkSync = createLinkSync({ noteId: NOTE_ID, doc, api });
    linkSync.start();

    linkSync.onSynced();
    await vi.advanceTimersByTimeAsync(0);
    expect(api).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(api).toHaveBeenCalledTimes(1); // 還沒滿 1s

    await vi.advanceTimersByTimeAsync(1);
    expect(api).toHaveBeenCalledTimes(2); // 唯一一次重試

    await vi.advanceTimersByTimeAsync(60_000);
    expect(api).toHaveBeenCalledTimes(2); // 放棄，不會有第三次
    expect(toastMock).not.toHaveBeenCalled(); // not_loaded 全程靜默（無 UI 路徑）
  });

  it("409 not_loaded 重試就成功：狀態回復正常，之後未變不再送", async () => {
    api = vi.fn().mockRejectedValueOnce(new ApiFail(409, "not_loaded", "x")).mockResolvedValueOnce(undefined);
    setWikilinks(doc, [TARGET_A]);
    const linkSync = createLinkSync({ noteId: NOTE_ID, doc, api });
    linkSync.start();

    linkSync.onSynced();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(api).toHaveBeenCalledTimes(2);

    setWikilinks(doc, [TARGET_A]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS_FOR_TEST);
    expect(api).toHaveBeenCalledTimes(2); // 未變不送
  });

  it("409 server_busy（非 not_loaded）：視同 5xx 走指數退避，不是 1s 的快速重試", async () => {
    api = vi.fn().mockRejectedValueOnce(new ApiFail(409, "server_busy", "x")).mockResolvedValueOnce(undefined);
    setWikilinks(doc, [TARGET_A]);
    const linkSync = createLinkSync({ noteId: NOTE_ID, doc, api });
    linkSync.start();

    linkSync.onSynced();
    await vi.advanceTimersByTimeAsync(0);
    expect(api).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(api).toHaveBeenCalledTimes(1); // 退避起始值是 1s，not_loaded 的 1s 剛好同值，
    // 用下一步的倍增行為（下一個測試）才真正區分兩者；這裡先確認沒有在 1s 之前就重試。

    await vi.advanceTimersByTimeAsync(1);
    expect(api).toHaveBeenCalledTimes(2);
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("409 server_busy 連續失敗兩次：第二次重試落在 +2000ms（指數倍增），不是 not_loaded 那種「用掉一次就放棄」", async () => {
    // 這條測試專門把 server_busy 與 not_loaded 兩條路徑徹底分開驗證：not_loaded 在
    // 第一次重試失敗後就會放棄（見前一個 describe 區塊「409 not_loaded：1s 後重試一次，
    // 仍失敗就放棄」），若實作把 409 分流誤改成「一律走 not_loaded 的快速重試＋單次放棄」
    // （例如漏判 `err.code !== "not_loaded"`），這裡第二次失敗之後 api 會停在 2 次不再
    // 重試——下面 +1999ms 仍是 2 次、+2000ms 才變 3 次的斷言就會紅。
    api = vi
      .fn()
      .mockRejectedValueOnce(new ApiFail(409, "server_busy", "x"))
      .mockRejectedValueOnce(new ApiFail(409, "server_busy", "x"))
      .mockResolvedValueOnce(undefined);
    setWikilinks(doc, [TARGET_A]);
    const linkSync = createLinkSync({ noteId: NOTE_ID, doc, api });
    linkSync.start();

    linkSync.onSynced();
    await vi.advanceTimersByTimeAsync(0);
    expect(api).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000); // 第一次退避：1s 後重試，第二次也失敗
    expect(api).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(api).toHaveBeenCalledTimes(2); // 倍增後的延遲是 2s，還沒到——若走 not_loaded
    // 的「放棄」邏輯，這裡永遠停在 2 次，等再久都不會變。

    await vi.advanceTimersByTimeAsync(1);
    expect(api).toHaveBeenCalledTimes(3); // 第三次重試準時落在 +2000ms，證明是指數倍增
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("5xx 退避上限 60s：連續失敗時延遲倍增，超過上限後鎖在 60s", async () => {
    api = vi.fn().mockRejectedValue(new ApiFail(500, "internal", "x"));
    setWikilinks(doc, [TARGET_A]);
    const linkSync = createLinkSync({ noteId: NOTE_ID, doc, api });
    linkSync.start();

    linkSync.onSynced();
    await vi.advanceTimersByTimeAsync(0);
    expect(api).toHaveBeenCalledTimes(1);

    const delays = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000];
    let calls = 1;
    for (const delay of delays) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(api).toHaveBeenCalledTimes(calls);
      await vi.advanceTimersByTimeAsync(1);
      calls += 1;
      expect(api).toHaveBeenCalledTimes(calls);
    }
  });

  it("網路層錯誤（非 ApiFail，`api()` 對網路失敗丟原生 Error）：視同 5xx 走退避", async () => {
    api = vi.fn().mockRejectedValueOnce(new Error("network down")).mockResolvedValueOnce(undefined);
    setWikilinks(doc, [TARGET_A]);
    const linkSync = createLinkSync({ noteId: NOTE_ID, doc, api });
    linkSync.start();

    linkSync.onSynced();
    await vi.advanceTimersByTimeAsync(0);
    expect(api).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(api).toHaveBeenCalledTimes(2);
  });

  it("403：閂住不再送，直到 onCollabState 觀察到 connected+canEdit 才解閂並立即重送", async () => {
    api = vi.fn().mockRejectedValueOnce(new ApiFail(403, "forbidden", "x")).mockResolvedValueOnce(undefined);
    setWikilinks(doc, [TARGET_A]);
    const linkSync = createLinkSync({ noteId: NOTE_ID, doc, api });
    linkSync.start();

    linkSync.onSynced();
    await vi.advanceTimersByTimeAsync(0);
    expect(api).toHaveBeenCalledTimes(1);

    // 閂住期間：內容再變、等再久都不會送。
    setWikilinks(doc, [TARGET_A, TARGET_B]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api).toHaveBeenCalledTimes(1);

    // 還沒解閂：connected 但角色不能編輯。
    linkSync.onCollabState(connected("viewer"));
    await vi.advanceTimersByTimeAsync(0);
    expect(api).toHaveBeenCalledTimes(1);

    // 解閂條件成立：connected + canEdit。
    linkSync.onCollabState(connected("editor"));
    await vi.advanceTimersByTimeAsync(0);

    expect(api).toHaveBeenCalledTimes(2);
    expect(api).toHaveBeenLastCalledWith(LINKS_PATH, linksBody([TARGET_A, TARGET_B]));
  });

  it("403 解閂後再次呼叫 onCollabState 不會重複觸發（閂已經不是 403 了）", async () => {
    api = vi.fn().mockRejectedValueOnce(new ApiFail(403, "forbidden", "x")).mockResolvedValueOnce(undefined);
    setWikilinks(doc, [TARGET_A]);
    const linkSync = createLinkSync({ noteId: NOTE_ID, doc, api });
    linkSync.start();
    linkSync.onSynced();
    await vi.advanceTimersByTimeAsync(0);

    linkSync.onCollabState(connected("owner"));
    await vi.advanceTimersByTimeAsync(0);
    expect(api).toHaveBeenCalledTimes(2);

    linkSync.onCollabState(connected("owner"));
    await vi.advanceTimersByTimeAsync(0);
    expect(api).toHaveBeenCalledTimes(2); // 未變不送，不是「又解閂了一次」
  });

  it("400：閂住並 toast；集合維持觸發 400 當下的內容就一直閂著", async () => {
    api = vi.fn().mockRejectedValueOnce(new ApiFail(400, "invalid_body", "x"));
    setWikilinks(doc, [TARGET_A]);
    const linkSync = createLinkSync({ noteId: NOTE_ID, doc, api });
    linkSync.start();

    linkSync.onSynced();
    await vi.advanceTimersByTimeAsync(0);
    expect(api).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith({ title: "errors.invalid_body", variant: "destructive" });

    // 內容不變：即使 doc 觸發 update 事件、等很久，仍然閂著。
    setWikilinks(doc, [TARGET_A]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("400 解閂：重算結果與觸發 400 的集合內容不同時解閂並送出新集合", async () => {
    api = vi.fn().mockRejectedValueOnce(new ApiFail(400, "invalid_body", "x")).mockResolvedValueOnce(undefined);
    setWikilinks(doc, [TARGET_A]);
    const linkSync = createLinkSync({ noteId: NOTE_ID, doc, api });
    linkSync.start();

    linkSync.onSynced();
    await vi.advanceTimersByTimeAsync(0);
    expect(api).toHaveBeenCalledTimes(1);

    setWikilinks(doc, [TARGET_A, TARGET_B]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS_FOR_TEST);

    expect(api).toHaveBeenCalledTimes(2);
    expect(api).toHaveBeenLastCalledWith(LINKS_PATH, linksBody([TARGET_A, TARGET_B]));
  });

  it("onCollabState 在未閂住時是 no-op（不會意外送出）", async () => {
    api = vi.fn().mockResolvedValue(undefined);
    const linkSync = createLinkSync({ noteId: NOTE_ID, doc, api });
    linkSync.start();

    linkSync.onCollabState(connected("editor"));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(api).not.toHaveBeenCalled();
  });
});

// ── 走訪等價測試（spec §12.5-1）─────────────────────────────────────────────
//
// server 端不依賴 BlockNote，無法測「editor 半邊」（Task 4 只測 docClock）；這裡補上
// 唯一能驗證「Y.Doc 走訪抽取集合 == editor.document 遍歷抽取集合」的地方：用 Task 3 的
// mount harness（`BlockNoteEditor.create` + `editor.mount`，headless 下 y-prosemirror
// 不會把內容寫回 Y.Doc，見 `menu.test.tsx` 檔頭同名章節）造一個綁定同一個 Y.Doc 的真編輯器，
// 用 `insertWikilink`（Task 2 的 spec.ts）插入真正的 wikilink 節點，比對兩條路徑抽出的
// targetNoteId 集合。
type ElementRendererHandle = (node: ReactNode, container: HTMLElement) => void;

const TestElementRenderer = forwardRef<ElementRendererHandle>((_props, ref) => {
  const [singleRenderData, setSingleRenderData] = useState<{ node: ReactNode; container: HTMLElement } | undefined>();

  useImperativeHandle(
    ref,
    () => (node: ReactNode, container: HTMLElement) => {
      flushSync(() => setSingleRenderData({ node, container }));
      setSingleRenderData(undefined);
    },
    [],
  );

  return singleRenderData ? createPortal(singleRenderData.node, singleRenderData.container) : null;
});
TestElementRenderer.displayName = "TestElementRenderer";

function mountedEditorOnDoc(doc: Y.Doc) {
  // `withCollaboration`（同 `NoteEditor.tsx` 的 `buildNoteEditorOptions`）不是把
  // `collaboration` 這個欄位單純透傳給 `BlockNoteEditor.create`——它會把真正的
  // `CollaborationExtension(options.collaboration)` 塞進回傳物件的 `extensions`
  // 陣列（`@blocknote/core` 的 `collaboration` 欄位本身不是原生選項，純綁定邏輯全在
  // 這支擴充功能裡）；直接把 `collaboration: {...}` 傳給 `.create()` 不會真的把
  // y-prosemirror 接上這個 Y.Doc，寫入操作就不會落地進 fragment，本測試會靜默失敗
  // （`extractLinkTargets(doc)` 永遠是空集合）。
  const options = withCollaboration({
    schema: noteSchema,
    collaboration: {
      fragment: doc.getXmlFragment(YDOC_FRAGMENT),
      user: { name: "tester", color: "#000" },
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 編輯器泛型三元組，走 repo 慣例用 any（同 menu.test.tsx）
  const editor = BlockNoteEditor.create(options) as BlockNoteEditor<any, any, any>;
  const container = document.createElement("div");
  document.body.appendChild(container);
  editor.mount(container);

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(["notes"], []);

  const rendererRef = createRef<ElementRendererHandle>();
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <TestElementRenderer ref={rendererRef} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  editor.elementRenderer = rendererRef.current!;

  return { editor, container };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
function extractViaEditorDocument(editor: BlockNoteEditor<any, any, any>): string[] {
  const found: string[] = [];

  interface BlockLike {
    content?: unknown;
    children?: BlockLike[];
  }

  const walk = (blocks: BlockLike[]): void => {
    for (const block of blocks) {
      if (Array.isArray(block.content)) {
        for (const item of block.content as unknown[]) {
          if (
            typeof item === "object" &&
            item !== null &&
            "type" in item &&
            (item as { type: unknown }).type === "wikilink"
          ) {
            const props = (item as unknown as { props: { targetNoteId: string } }).props;
            found.push(props.targetNoteId);
          }
        }
      }
      if (Array.isArray(block.children) && block.children.length > 0) walk(block.children);
    }
  };

  walk(editor.document as BlockLike[]);
  return [...new Set(found)].sort();
}

describe("走訪等價：Y.Doc 走訪抽取集合 == editor.document 遍歷抽取集合", () => {
  let doc: Y.Doc;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
  let editor: BlockNoteEditor<any, any, any>;
  let container: HTMLElement;

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    doc = new Y.Doc();
    ({ editor, container } = mountedEditorOnDoc(doc));
  });

  afterEach(() => {
    editor.unmount();
    container.remove();
    doc.destroy();
    vi.unstubAllGlobals();
  });

  it("單一 wikilink：兩條路徑抽出同一個目標", () => {
    insertWikilink(editor, { targetNoteId: TARGET_A, snapshotTitle: "A" });

    expect(extractLinkTargets(doc)).toEqual(extractViaEditorDocument(editor));
    expect(extractLinkTargets(doc)).toEqual([TARGET_A]);
  });

  it("多個 wikilink 分散在不同 block：兩條路徑抽出的集合一致", () => {
    insertWikilink(editor, { targetNoteId: TARGET_A, snapshotTitle: "A" });

    const firstBlockId = editor.document[0]!.id;
    const [newBlock] = editor.insertBlocks([{ type: "paragraph" }], firstBlockId, "after");
    editor.setTextCursorPosition(newBlock!.id, "start");
    insertWikilink(editor, { targetNoteId: TARGET_B, snapshotTitle: "B" });

    const viaDoc = extractLinkTargets(doc);
    const viaEditor = extractViaEditorDocument(editor);

    expect(viaDoc).toEqual(viaEditor);
    expect(viaDoc).toEqual([TARGET_A, TARGET_B].sort());
  });

  it("沒有任何 wikilink：兩條路徑都是空集合", () => {
    editor.insertInlineContent(["plain text, no links here"]);

    expect(extractLinkTargets(doc)).toEqual([]);
    expect(extractViaEditorDocument(editor)).toEqual([]);
  });
});
