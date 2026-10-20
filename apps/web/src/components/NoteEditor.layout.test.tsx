import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import type { AiActionDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ARTICLE_COLUMN, ARTICLE_COLUMN_PADDING, articleColumn } from "@/components/ui/article-column";
import { setNoteWidth } from "@/components/note-width";
import { ThemeProvider } from "@/theme";
import { NoteEditor } from "./NoteEditor";
import { NoteWidthMenu } from "./NoteWidthMenu";

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

const AI_ACTION: AiActionDto = { id: "action-1", name: "Rewrite", applyMode: "direct", kind: "quick" };

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/ai/actions" && method === "GET") {
        return Promise.resolve(
          fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ actions: [AI_ACTION] }) }),
        );
      }
      if (url === "/api/notes" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

/**
 * PR2（BC2 卡片版面）：改版前 brief 明講三層 flex class 漏掉任何一個都是
 * 「畫面在 jsdom 快照/一般互動測試裡看起來完全正常，只有真的有滾動內容、真的有
 * flex 容器擠壓時才會露餡」的靜默失敗——這裡延續同一個精神，直接斷言 class 字串
 * 本身，改測 slot 化後的新節點鏈（spec A 節逐字）：
 *
 *   根 row（flex h-full min-h-0 min-w-0 flex-1 gap-3）
 *     內文卡（flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl
 *             border border-border bg-card）
 *       {headerSlot}
 *       捲動容器（min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-clip——
 *                 `overflow-x-clip`＝#162，見 `NoteEditor.tsx` :423 附近的註解：裁掉
 *                 寬表格 hover 時「新增列」按鈕超出右緣的部分，不讓它變成這層的橫向
 *                 可捲溢出）
 *         置中 wrapper（articleColumn(width) ＋ ARTICLE_COLUMN_PADDING ＋ relative flex
 *                        min-h-full flex-col py-6——標準欄寬＝捲動容器 85%，下限 680px
 *                        （改版前的固定值，中等視窗承重）、上限 1056px；#297 的寬／全寬
 *                        不會比標準窄（92.5%、上限 1408px／不設上限），下限不變。#115 起
 *                        欄寬／內距是 `ui/article-column.ts` 的常數且內文是唯一
 *                        消費端（頁首/頁尾滿卡寬）；理由見該檔。`relative`＝#160：
 *                        BlockNote 表格 hover 浮層的 containing block，收在這層
 *                        擋掉全頁滾軸，別搬去捲動容器）
 *           note-editor（BlockNoteView，className 加 flex-1——B-1 定案：wrapper
 *             的 min-h-full 無法把百分比高度傳給孫層，必須讓 BlockNoteView 自己
 *             成為置中 wrapper 的成長項。**兩者都要斷言，缺一即假守衛**）
 *       {previewSlot}（有值時才渲染，data-testid="preview-slot"；此時捲動容器多一個 hidden）
 *       {footerSlot}
 *     VersionsPanel（panelOpen 時，經 VersionsLazyBoundary；本檔無 provider＝恆不渲染）
 *     CornerStack
 *
 * 這裡刻意掛**真正的** `<NoteEditor>`（不是 `NotePage.test.tsx`/`NoteEditorView.test.tsx`
 * 用的 mock 或只測 `NoteEditorView` 半層），驗證 `NoteEditor.tsx` 實際渲染出來的容器
 * class 跟 spec 逐字要求的一致。
 */
describe("NoteEditor 佈局（PR2 slot 化：節點鏈 + 雙層 class smoke）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("根/內文卡/捲動容器/置中 wrapper/BlockNoteView 五層 class 逐一斷言；headerSlot/footerSlot 落在正確位置", async () => {
    const doc = new Y.Doc();
    const provider = { awareness: null } as never;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <NoteEditor
            doc={doc}
            provider={provider}
            editable
            user={{ id: "u1", name: "Ann" }}
            noteId="note-1"
            headerSlot={<div data-testid="header-slot-marker">header</div>}
            footerSlot={<div data-testid="footer-slot-marker">footer</div>}
          />
        </ThemeProvider>
      </QueryClientProvider>,
    );

    const editorRoot = await screen.findByTestId("note-editor");
    const centerWrapper = editorRoot.parentElement;
    const scrollWrapper = centerWrapper?.parentElement;
    const contentCard = scrollWrapper?.parentElement;
    const root = contentCard?.parentElement;

    expect(centerWrapper).not.toBeNull();
    expect(scrollWrapper).not.toBeNull();
    expect(contentCard).not.toBeNull();
    expect(root).not.toBeNull();

    expect(root).toHaveClass("flex", "h-full", "min-h-0", "min-w-0", "flex-1", "gap-3");
    // #274：版本面板與其錯誤外框共用的寬度來源——列容器設 CSS 變數（預設 320）。拿掉 style 則兩者寬度失效。
    expect(root!.style.getPropertyValue("--versions-panel-width")).toBe("320px");
    expect(contentCard).toHaveClass(
      "flex",
      "min-h-0",
      "min-w-0",
      "flex-1",
      "flex-col",
      "overflow-hidden",
      "rounded-xl",
      "border",
      "border-border",
      "bg-card",
    );
    expect(scrollWrapper).toHaveClass("min-h-0", "min-w-0", "flex-1", "overflow-y-auto", "overflow-x-clip");
    // 欄寬與內距取自 `ui/article-column.ts`（#115：內文是唯一消費端，頁首/頁尾
    // 滿卡寬）。結構守衛在 `ui/article-column.guard.test.ts`。
    // issue #160：`relative` 是置中 wrapper 必須承重的一根——BlockNote 表格 hover
    // 浮層（`bn-extend-button` 等）走 FloatingPortal + `position: absolute`，往上找
    // 不到 positioned 祖先就會以 `<html>` 當 containing block，撐出全頁滾軸。缺了
    // 拿掉 JSX 的 `relative` 只有本案會紅。
    expect(centerWrapper).toHaveClass(
      ...ARTICLE_COLUMN.split(" "),
      ARTICLE_COLUMN_PADDING,
      "relative",
      "flex",
      "min-h-full",
      "flex-col",
      "py-6",
    );
    // 雙層斷言（缺一即假守衛）：置中 wrapper 的 min-h-full/flex-col **與** BlockNoteView
    // 的 flex-1，兩者都要在——B-1 定案的高度鏈只有兩者同時存在才成立。
    expect(editorRoot).toHaveClass("min-h-full", "flex-1");

    // headerSlot/footerSlot 落在內文卡內、分別在捲動容器的前後（不是巢狀在裡面）。
    expect(contentCard).toContainElement(screen.getByTestId("header-slot-marker"));
    expect(contentCard).toContainElement(screen.getByTestId("footer-slot-marker"));
    expect(scrollWrapper).not.toContainElement(screen.getByTestId("header-slot-marker"));
    expect(scrollWrapper).not.toContainElement(screen.getByTestId("footer-slot-marker"));

    doc.destroy();
  });

  it("previewSlot：捲動容器加 hidden、slot 渲染在同一張卡內（捲動容器之後、footer 之前），活編輯器仍在 DOM（spec §8.1、§8.4）", async () => {
    const doc = new Y.Doc();
    const provider = { awareness: null } as never;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <NoteEditor
            doc={doc}
            provider={provider}
            editable
            user={{ id: "u1", name: "Ann" }}
            noteId="note-1"
            footerSlot={<div data-testid="footer-slot-marker">footer</div>}
            previewSlot={<div data-testid="preview-marker">preview</div>}
          />
        </ThemeProvider>
      </QueryClientProvider>,
    );
    const editorRoot = await screen.findByTestId("note-editor");
    const scrollWrapper = editorRoot.parentElement!.parentElement!;
    const contentCard = scrollWrapper.parentElement!;
    expect(scrollWrapper).toHaveClass("hidden", "overflow-y-auto");
    const slot = screen.getByTestId("preview-slot");
    expect(slot).toContainElement(screen.getByTestId("preview-marker"));
    expect(slot.parentElement).toBe(contentCard);
    const order = Array.from(contentCard.children);
    expect(order.indexOf(slot)).toBe(order.indexOf(scrollWrapper) + 1);
    expect(order.indexOf(slot)).toBeLessThan(order.indexOf(screen.getByTestId("footer-slot-marker")));
    expect(editorRoot).toBeInTheDocument();
    doc.destroy();
  });

  it("沒有 previewSlot → 捲動容器沒有 hidden、沒有 preview-slot 節點", async () => {
    const doc = new Y.Doc();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <NoteEditor doc={doc} provider={{ awareness: null } as never} editable user={{ id: "u1", name: "Ann" }} noteId="note-1" />
        </ThemeProvider>
      </QueryClientProvider>,
    );
    const editorRoot = await screen.findByTestId("note-editor");
    expect(editorRoot.parentElement!.parentElement).not.toHaveClass("hidden");
    expect(screen.queryByTestId("preview-slot")).not.toBeInTheDocument();
    doc.destroy();
  });

  it("活編輯器不重掛：previewSlot 進出時 BlockNoteView 根節點是同一個 DOM 元素", async () => {
    const doc = new Y.Doc();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = (slot?: ReactNode) => (
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <NoteEditor doc={doc} provider={{ awareness: null } as never} editable user={{ id: "u1", name: "Ann" }} noteId="note-1" previewSlot={slot} />
        </ThemeProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(tree());
    const before = await screen.findByTestId("note-editor");
    rerender(tree(<div>preview</div>));
    rerender(tree());
    expect(screen.getByTestId("note-editor")).toBe(before);
    doc.destroy();
  });
});

/** #297 §4.2：內文欄跟著這篇的站內寬度（`useNoteWidth(noteId)`），換寬度不重建編輯器。 */
describe("NoteEditor 內文寬度（#297）", () => {
  const STANDARD_MAX = "max-w-[clamp(42.5rem,85%,66rem)]";

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    localStorage.clear();
    stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // L3／L5 會留下 note.width.note-1，不帶到後面的檔案。
    localStorage.clear();
  });

  function renderEditor(noteId: string, doc: Y.Doc, headerSlot?: ReactNode) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = (id: string, d: Y.Doc) => (
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <NoteEditor
            doc={d}
            provider={{ awareness: null } as never}
            editable
            user={{ id: "u1", name: "Ann" }}
            noteId={id}
            headerSlot={headerSlot}
          />
        </ThemeProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(tree(noteId, doc));
    return { rerender: (id: string, d: Y.Doc) => rerender(tree(id, d)) };
  }

  it("L1 預設：欄是標準寬", async () => {
    const doc = new Y.Doc();
    renderEditor("note-1", doc);
    await screen.findByTestId("note-editor");
    expect(screen.getByTestId("article-column")).toHaveClass(...articleColumn("standard").split(" "));
    doc.destroy();
  });

  it("L2 localStorage 已存 wide → 掛載就是寬，沒有標準的 max-w", async () => {
    localStorage.setItem("note.width.note-1", "wide");
    const doc = new Y.Doc();
    renderEditor("note-1", doc);
    await screen.findByTestId("note-editor");
    const column = screen.getByTestId("article-column");
    expect(column).toHaveClass(...articleColumn("wide").split(" "));
    expect(column).not.toHaveClass(STANDARD_MAX);
    doc.destroy();
  });

  it("L3 掛載後改成全寬 → 欄跟著變，BlockNoteEditor.create 不再被呼叫", async () => {
    const doc = new Y.Doc();
    renderEditor("note-1", doc);
    await screen.findByTestId("note-editor");
    const create = vi.spyOn(BlockNoteEditor, "create");
    try {
      act(() => setNoteWidth("note-1", "full"));
      const column = screen.getByTestId("article-column");
      expect(column).toHaveClass("max-w-none");
      expect(column).not.toHaveClass(STANDARD_MAX);
      expect(create).toHaveBeenCalledTimes(0);
    } finally {
      create.mockRestore();
    }
    doc.destroy();
  });

  it("L4 另一個分頁改了這篇（storage 事件）→ 開著的欄即時跟上", async () => {
    const doc = new Y.Doc();
    renderEditor("note-1", doc);
    await screen.findByTestId("note-editor");
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "note.width.note-1", newValue: "wide" }));
    });
    expect(screen.getByTestId("article-column")).toHaveClass(...articleColumn("wide").split(" "));
    doc.destroy();
  });

  it("L5 換篇：note-2 是標準；note-1 設全寬後換回 note-1 → 全寬", async () => {
    const doc1 = new Y.Doc();
    const doc2 = new Y.Doc();
    const { rerender } = renderEditor("note-1", doc1);
    await screen.findByTestId("note-editor");
    rerender("note-2", doc2);
    expect(screen.getByTestId("article-column")).toHaveClass(...articleColumn("standard").split(" "));
    act(() => setNoteWidth("note-1", "full"));
    expect(screen.getByTestId("article-column")).toHaveClass(...articleColumn("standard").split(" "));
    rerender("note-1", doc1);
    expect(screen.getByTestId("article-column")).toHaveClass("max-w-none");
    doc1.destroy();
    doc2.destroy();
  });

  it("L6 頁首寬度選單（headerSlot，與 NotePage 同組合）選 Wide → 欄變寬；再選 Full width → 全寬", async () => {
    const doc = new Y.Doc();
    renderEditor("note-1", doc, <NoteWidthMenu noteId="note-1" />);
    await screen.findByTestId("note-editor");
    const pick = async (name: string) => {
      fireEvent.pointerDown(screen.getByRole("button", { name: /^Width/ }), { button: 0 });
      fireEvent.click(await screen.findByRole("menuitemradio", { name }));
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    };
    await pick("Wide");
    const column = screen.getByTestId("article-column");
    expect(column).toHaveClass(...articleColumn("wide").split(" "));
    expect(column).not.toHaveClass(STANDARD_MAX);
    await pick("Full width");
    expect(screen.getByTestId("article-column")).toHaveClass("max-w-none");
    doc.destroy();
  });
});
