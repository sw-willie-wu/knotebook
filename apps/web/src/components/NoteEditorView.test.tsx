import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BlockNoteEditor } from "@blocknote/core";
import { FilePanelExtension, FormattingToolbarExtension } from "@blocknote/core/extensions";
import type { DefaultReactSuggestionItem } from "@blocknote/react";
import type { AiActionDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { noteSchema } from "@/collab/schema";
import { AiSessionProvider } from "@/components/ai/AiSession";
import { NoteEditorView } from "./NoteEditor";

/**
 * Task 14 審查修復（Important 1）：審查者實測 mutation（拿掉 `filePanel={false}`、
 * 或把 `useMemo` 換成每 render 新建）能讓 268 個既有測試全綠通過——`NoteEditorView`
 * 這段 JSX 接線在此之前完全零覆蓋。這個檔案直接掛真的 `<BlockNoteView>`
 * （`@blocknote/mantine`，自帶 `MantineProvider`）鎖住兩條 Task 14 核心契約：
 *
 * 1. `filePanel={false}` 真的關掉了 BlockNote 內建的 `FilePanelController`
 *    （否則使用者點開檔案類 block 會同時看到兩份面板疊在一起）。
 * 2. `useMemo(() => createFilePanel(noteId), [noteId])` 真的釘住了 `filePanel` 的
 *    元件身分——`noteId` 沒變時，`NoteEditorView` 因任何原因重新 render，
 *    `FilePanelController` 不會把它當成「換了一個元件」卸載重掛（否則使用者在
 *    Embed URL 輸入到一半就會被清空）。
 *
 * jsdom 缺 `ResizeObserver`／`window.matchMedia`（mantine 的 `MantineProvider`／
 * `@blocknote/react` 的 `usePrefersColorScheme` 會摸到）——兩個一行 stub 已經補進
 * `test/setup.ts`，這裡不用再另外處理。
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 編輯器泛型三元組，走 repo 慣例用 any（同 NoteEditor.tsx/NoteEditor.test.ts）
function mountedEditor(): { editor: BlockNoteEditor<any, any, any>; container: HTMLElement } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
  const editor = BlockNoteEditor.create({ schema: noteSchema }) as BlockNoteEditor<any, any, any>;
  const container = document.createElement("div");
  document.body.appendChild(container);
  editor.mount(container);
  return { editor, container };
}

/** 插入一個 image block（有 Upload+Embed 兩個 tab，`FilePanel.tsx` 的分頁列在這個型別才會渲染），回傳它的 id。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
function insertImageBlock(editor: BlockNoteEditor<any, any, any>): string {
  const first = editor.document[0]!;
  return editor.insertBlocks([{ type: "image" } as never], first, "after")[0]!.id;
}

// SuggestionMenuController 用得到，但這個檔案不測 `[[` 觸發，回空陣列就好。
async function getItems(): Promise<DefaultReactSuggestionItem[]> {
  return [];
}

describe("NoteEditorView（Task 14：filePanel={false} + useMemo 接線）", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
  let editor: BlockNoteEditor<any, any, any>;
  let container: HTMLElement;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    ({ editor, container } = mountedEditor());
  });

  afterEach(() => {
    editor.unmount();
    container.remove();
  });

  it("filePanel={false} 關掉內建面板：開啟 FilePanel 時畫面上只有 1 個 tablist（我們自家那個，不是內建又多一個）", () => {
    const blockId = insertImageBlock(editor);
    render(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} />);

    act(() => {
      editor.getExtension(FilePanelExtension)!.showMenu(blockId);
    });

    expect(screen.getAllByRole("tablist")).toHaveLength(1);
  });

  it("useMemo 護欄：noteId 不變、元件因故重 render，Embed 輸入到一半的值不會被清掉", () => {
    const blockId = insertImageBlock(editor);
    const { rerender } = render(
      <NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} />,
    );

    act(() => {
      editor.getExtension(FilePanelExtension)!.showMenu(blockId);
    });

    fireEvent.click(screen.getByRole("tab", { name: "Embed link" }));
    const input = screen.getByPlaceholderText("Paste a link…");
    fireEvent.change(input, { target: { value: "https://example.com/half-typed" } });
    expect(input).toHaveValue("https://example.com/half-typed");

    // 同一個 noteId、只是父層重新 render（例如 editable/theme 這類跟 filePanel 無關的
    // prop 變動、或單純父元件重繪）——`filePanel` 的元件身分如果沒被 `useMemo` 釘住，
    // `FilePanelController` 會把它當一個新元件掛，底下的 Embed 輸入狀態會被砍掉重練。
    rerender(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} />);

    expect(screen.getByPlaceholderText("Paste a link…")).toHaveValue("https://example.com/half-typed");
  });
});

// ── Task 6：`formattingToolbar={false}` + 自家 `AiToolbar` 接線 ──────────────────
//
// `AiToolbar` 經 `useAiSession()` 讀 context（B1 架構決策：不拉 prop 通道），所以這裡
// 必須額外包 `QueryClientProvider`（`AiSessionProvider` 內部的 `useQuery(["ai-actions"])`／
// `useNotes()`）與 `AiSessionProvider` 本身；`NoteEditorView` 介面完全沒變，只是這組測試
// 需要更完整的 context 包裝。
//
// `FormattingToolbarExtension` 的顯示與否是內部 store（`editor.onSelectionChange` 驅動），
// 直接 `store.setState(true)` 強制顯示——比照上面 `FilePanelExtension.showMenu(blockId)`
// 的既有手法，不必真的在 jsdom 裡模擬滑鼠選取。
interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

const AI_ACTION: AiActionDto = { id: "action-1", name: "Summarize", applyMode: "preview" };

function stubAiFetch(actions: AiActionDto[]) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === "/api/ai/actions" && method === "GET") {
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ actions }) }));
    }
    if (url === "/api/notes" && method === "GET") {
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 編輯器泛型三元組，走 repo 慣例用 any（同檔案開頭 mountedEditor）
function renderWithAiSession(editor: BlockNoteEditor<any, any, any>, editable: boolean, actions: AiActionDto[]) {
  vi.stubGlobal("fetch", stubAiFetch(actions));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AiSessionProvider editor={editor} noteId="note-1" editable={editable}>
        <NoteEditorView editor={editor} editable={editable} theme="light" noteId="note-1" getItems={getItems} />
      </AiSessionProvider>
    </QueryClientProvider>,
  );
}

describe("NoteEditorView（Task 6：formattingToolbar={false} + AiToolbar 接線）", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
  let editor: BlockNoteEditor<any, any, any>;
  let container: HTMLElement;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    ({ editor, container } = mountedEditor());
  });

  afterEach(() => {
    editor.unmount();
    container.remove();
    vi.unstubAllGlobals();
  });

  it("自訂 toolbar 仍含預設按鈕（getFormattingToolbarItems 復原迴歸釘），並追加 AI 動作選單", async () => {
    renderWithAiSession(editor, true, [AI_ACTION]);

    act(() => {
      editor.getExtension(FormattingToolbarExtension)!.store.setState(true);
    });

    // 預設按鈕（BasicTextStyleButton "bold"）原樣復原——`getFormattingToolbarItems()`
    // 沒有被我們的自訂 toolbar 意外漏掉任何一項。
    expect(await screen.findByRole("button", { name: "Bold" })).toBeInTheDocument();

    // 追加的 AI 動作選單：觸發鈕帶誠實的 aria-expanded（fix round 1 I-5：這顆清單刻意
    // 不宣告 role="menu"/"menuitem"，見 `AiToolbar.tsx` 檔頭）；點開後動作清單以一般按鈕
    // 呈現。`actions` query 是非同步的，觸發鈕本身要等它落地才會出現。
    const trigger = await screen.findByRole("button", { name: "AI" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByRole("button", { name: AI_ACTION.name })).toBeInTheDocument();
  });

  it("viewer（editable:false）→ AI 項不渲染", async () => {
    renderWithAiSession(editor, false, [AI_ACTION]);

    act(() => {
      editor.getExtension(FormattingToolbarExtension)!.store.setState(true);
    });

    // AiSessionProvider 的 actions query 是非同步的——用一個穩定會出現的等待點
    // （root 容器本身）確保已經走過至少一輪 render，才斷言 AI 觸發鈕缺席。
    await screen.findByTestId("note-editor");
    expect(screen.queryByRole("button", { name: "AI" })).not.toBeInTheDocument();
  });

  // fix round 1 M-2 後半：既有覆蓋只有 viewer 那半條（editable:false），`actions.length
  // === 0`（editable:true 但沒有任何可用動作，例如全新安裝、admin 還沒設定任何 AI 動作）
  // 這半條完全零覆蓋——`AiToolbar` 的 `showAi = editable && actions.length > 0` 兩個
  // 因子任何一個關掉都要藏起來，各自需要獨立測試才不會漏掉其中一半的迴歸。
  it("actions 為空陣列（editable:true）→ AI 項不渲染", async () => {
    renderWithAiSession(editor, true, []);

    act(() => {
      editor.getExtension(FormattingToolbarExtension)!.store.setState(true);
    });

    await screen.findByRole("button", { name: "Bold" }); // 確認至少走過一輪含 actions 落地的 render
    expect(screen.queryByRole("button", { name: "AI" })).not.toBeInTheDocument();
  });
});
