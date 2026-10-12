import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BlockNoteEditor, SuggestionMenu } from "@blocknote/core";
import { FilePanelExtension } from "@blocknote/core/extensions";
import type { DefaultReactSuggestionItem } from "@blocknote/react";
import type { AiActionDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { noteSchema } from "@/collab/schema";
import { SelectionAiController } from "@/components/ai/SelectionAiController";
import { createTestEditor, renderAiHost, selectInBlock, stubAiFetch } from "@/test/ai-host";
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
    render(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />);

    act(() => {
      editor.getExtension(FilePanelExtension)!.showMenu(blockId);
    });

    expect(screen.getAllByRole("tablist")).toHaveLength(1);
  });

  it("useMemo 護欄：noteId 不變、元件因故重 render，Embed 輸入到一半的值不會被清掉", () => {
    const blockId = insertImageBlock(editor);
    const { rerender } = render(
      <NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />,
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
    rerender(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />);

    expect(screen.getByPlaceholderText("Paste a link…")).toHaveValue("https://example.com/half-typed");
  });
});

// ── issue #94：`slashMenu={false}` + 自家 `/` controller 接線 ────────────────────
//
// 比照本檔開頭記載的 Task 14 前例：審查者實測，把 `slashMenu={false}` 拿掉、或把整條
// `<SuggestionMenuController triggerCharacter="/">` 刪掉，693 條測試全綠——這段接線在
// 此之前零覆蓋。`NoteEditor.tsx` 的註解寫著「不明確設 false 會同時掛兩個 `/` 選單
// controller，按 `/` 會看到兩份選單疊在一起」，這裡就是釘住那句話的地方。

describe("NoteEditorView（issue #94：/ 選單接管）", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
  let editor: BlockNoteEditor<any, any, any>;
  let container: HTMLElement;

  /** 只有一個項目的 `/` 選單來源，用來確認掛上去的是**我們的** controller。 */
  async function getSlashItems(): Promise<DefaultReactSuggestionItem[]> {
    return [{ title: "Diagram", onItemClick: () => {}, group: "Advanced" }] as DefaultReactSuggestionItem[];
  }

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    ({ editor, container } = mountedEditor());
  });

  afterEach(() => {
    editor.unmount();
    container.remove();
  });

  it("slashMenu={false}：按 / 時畫面上只有一份選單（沒有跟內建的疊在一起）", () => {
    render(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getSlashItems} />);

    act(() => {
      editor.getExtension(SuggestionMenu)!.openSuggestionMenu("/");
    });

    expect(document.querySelectorAll(".bn-suggestion-menu")).toHaveLength(1);
  });

  it("那一份選單是我們自己的（getSlashItems 的項目真的渲染出來）", async () => {
    render(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getSlashItems} />);

    act(() => {
      editor.getExtension(SuggestionMenu)!.openSuggestionMenu("/");
    });

    expect(await screen.findByText("Diagram")).toBeInTheDocument();
  });
});

// ── #263：formatting toolbar 由 children 裡的 SelectionAiController 擁有（spec §5.3）──────────────
//
// NoteEditorView 自己只設 `formattingToolbar={false}`、不再掛 FormattingToolbarController；工具列壓制與 AI 項的行為測試在
// `components/ai/SelectionAiController.test.tsx`。這裡只釘接線：沒有 children 就沒有工具列；children 是 controller 時才有。
const AI_ACTION: AiActionDto = { id: "action-1", name: "Summarize", applyMode: "preview", kind: "quick" };
const ONE_PARAGRAPH = [{ id: "p1", type: "paragraph", content: "hello world" }];

describe("NoteEditorView（#263：children 透傳；工具列由 SelectionAiController 擁有）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("沒有 children：非空選取也不出現 formatting toolbar；children 換成 SelectionAiController 後出現（預設按鈕＋AI 鈕）", async () => {
    const editor = createTestEditor(ONE_PARAGRAPH);
    stubAiFetch({ actions: [AI_ACTION] });
    const host = renderAiHost({ editor });
    await waitFor(() => expect(host.queryClient.getQueryState(["ai-actions"])?.status).toBe("success"));
    selectInBlock(editor, "p1", 0, 5);
    await act(async () => {});
    expect(document.querySelector(".bn-formatting-toolbar")).toBeNull();

    host.rerenderHost({ children: <SelectionAiController /> });
    expect(await screen.findByRole("button", { name: "Bold" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "AI" })).toBeInTheDocument();
  });

  it("viewer（editable:false）→ AI 項不渲染", async () => {
    const editor = createTestEditor(ONE_PARAGRAPH);
    stubAiFetch({ actions: [AI_ACTION] });
    const host = renderAiHost({ editor, editable: false, children: <SelectionAiController /> });
    await waitFor(() => expect(host.queryClient.getQueryState(["ai-actions"])?.status).toBe("success"));
    selectInBlock(editor, "p1", 0, 5);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "AI" })).not.toBeInTheDocument();
  });

  it("actions 為空陣列（editable:true）→ 預設按鈕照常、AI 項不渲染", async () => {
    const editor = createTestEditor(ONE_PARAGRAPH);
    stubAiFetch({ actions: [] });
    const host = renderAiHost({ editor, children: <SelectionAiController /> });
    await waitFor(() => expect(host.queryClient.getQueryState(["ai-actions"])?.status).toBe("success"));
    selectInBlock(editor, "p1", 0, 5);
    expect(await screen.findByRole("button", { name: "Bold" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "AI" })).not.toBeInTheDocument();
  });
});
