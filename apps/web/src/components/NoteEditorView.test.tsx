import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { BlockNoteEditor } from "@blocknote/core";
import { FilePanelExtension } from "@blocknote/core/extensions";
import type { DefaultReactSuggestionItem } from "@blocknote/react";
import i18n from "@/i18n";
import { noteSchema } from "@/collab/schema";
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
