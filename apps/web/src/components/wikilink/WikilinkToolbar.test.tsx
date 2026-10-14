import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { BlockNoteView } from "@blocknote/mantine";
import { YDOC_FRAGMENT, canonicalNotePath, type NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { noteSchema } from "@/collab/schema";
import { collabUndoManager } from "@/collab/undo";
import { Toaster } from "@/components/ui/toast";
import { OWNER_PERMS } from "@/test/fixtures";

// spec 2026-10-13 site-links §7.4、§7.6、§15.1 W2／W11（工具列那一列）。真編輯器（共編組態，同 collab/undo.test.tsx 建法）＋BlockNoteView。

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組，走 repo 慣例
type AnyEditor = BlockNoteEditor<any, any, any>;

const note = (id: string, title: string, slug: string): NoteDto => ({
  id, title, slug, ownerId: "u1", role: "owner", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  slugIsCustom: false, prevSlug: null, ownerHandle: "tester", lastEdited: null, group: null, groupId: null, permissions: OWNER_PERMS,
});
const TARGET = note("22222222-2222-4222-8222-222222222222", "Target", "target");
const OTHER = note("33333333-3333-4333-8333-333333333333", "Other Note", "other-note");

function LocationProbe() {
  const l = useLocation();
  return <p data-testid="loc">{`${l.pathname}${l.hash}`}</p>;
}

/** `second`：同一段落再放一個指向 OTHER 的 wikilink（「A 開著時點 B」案用）。編輯器外另有一個輸入框（「點外點到可聚焦元素」案用）。 */
async function mount(props: Record<string, string>, notes: NoteDto[] = [TARGET, OTHER], second = false) {
  const doc = new Y.Doc();
  const editor = BlockNoteEditor.create(
    withCollaboration({
      schema: noteSchema,
      collaboration: { provider: { awareness: undefined }, fragment: doc.getXmlFragment(YDOC_FRAGMENT), user: { id: "u1", name: "U", color: "#123456" } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- withCollaboration 的選項型別要求完整 schema 三元組
    } as any),
  ) as AnyEditor;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(["notes"], notes);
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/start"]}>
        <input aria-label="Outside" />
        <BlockNoteView editor={editor} editable />
        <Routes>
          <Route path="*" element={<LocationProbe />} />
        </Routes>
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const wikilinkB = { type: "wikilink", props: { targetNoteId: OTHER.id, snapshotTitle: "Other Note", label: "", anchorBlockId: "" } };
  await act(async () => {
    editor.replaceBlocks(editor.document, [
      {
        type: "paragraph",
        content: [
          "see ",
          { type: "wikilink", props: { targetNoteId: TARGET.id, snapshotTitle: "Target", label: "", anchorBlockId: "", ...props } },
          ...(second ? [" and ", wikilinkB] : []),
          " end",
        ],
      },
    ]);
  });
  return { doc, editor };
}

function wikilinkProps(editor: AnyEditor): Record<string, string> | undefined {
  const node = (editor.document[0]!.content as Array<{ type: string; props?: Record<string, string> }>).find((n) => n.type === "wikilink");
  return node?.props;
}
const editorHasFocus = (editor: AnyEditor) => editor._tiptapEditor.view.dom.contains(document.activeElement);
async function openToolbar(name: string) {
  fireEvent.click(screen.getByRole("link", { name }));
  return screen.findByRole("dialog", { name: "Note link" });
}
/** 讓出真實計時器一段時間（Radix 的 pointerdown 監聽、FocusScope 卸載時的焦點處理都在 setTimeout(0) 裡）。 */
const settle = (ms = 0) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

/** 斷言失敗時也要卸載（m6）：先 RTL `cleanup()` 卸掉 React root，再清 body 裡殘留的 portal。 */
function teardown() {
  cleanup();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
}

describe("#269 W2 wikilink 小工具列（可編輯時點擊）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  });
  afterEach(teardown);

  it("點擊開工具列（不導航）；「開啟」導到 canonical", async () => {
    await mount({});
    const dialog = await openToolbar("Target");
    expect(screen.getByTestId("loc").textContent).toBe("/start");
    fireEvent.click(within(dialog).getByRole("button", { name: "Open" }));
    await waitFor(() => expect(screen.getByTestId("loc").textContent).toBe(canonicalNotePath(TARGET)));
  });

  it("編輯文字：預填目前 label、送出寫回 label；全空白送出 ⇒ label 清空；關閉後焦點回編輯器", async () => {
    const { editor } = await mount({ label: "Old label" });
    let dialog = await openToolbar("Old label");
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit text" }));
    const input = within(dialog).getByRole("textbox", { name: "Link text" });
    expect(input).toHaveValue("Old label");
    fireEvent.change(input, { target: { value: " New label " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(wikilinkProps(editor)?.label).toBe(" New label "));
    await waitFor(() => expect(editorHasFocus(editor)).toBe(true));

    dialog = await openToolbar("New label"); // 可及名稱會 trim 前後空白
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit text" }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Link text" }), { target: { value: "   " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(wikilinkProps(editor)?.label).toBe(""));
  });

  it("更換目標：標題過濾、選定 ⇒ targetNoteId／snapshotTitle 換新、anchorBlockId 清空、label 保留", async () => {
    const { editor } = await mount({ label: "Keep", anchorBlockId: "b1" });
    const dialog = await openToolbar("Keep");
    fireEvent.click(within(dialog).getByRole("button", { name: "Change target" }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Find a note" }), { target: { value: "other" } });
    expect(within(dialog).queryByRole("button", { name: "Target" })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Other Note" }));
    await waitFor(() =>
      expect(wikilinkProps(editor)).toEqual({ targetNoteId: OTHER.id, snapshotTitle: "Other Note", label: "Keep", anchorBlockId: "" }),
    );
  });

  it("移除連結：節點換成純文字（顯示文字＝現行標題，不是 snapshotTitle），不帶 link mark；焦點回編輯器", async () => {
    const { editor } = await mount({ snapshotTitle: "Old" });
    const dialog = await openToolbar("Target");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove link" }));
    await waitFor(() => expect(editor.document[0]!.content).toEqual([{ type: "text", text: "see Target end", styles: {} }]));
    await waitFor(() => expect(editorHasFocus(editor)).toBe(true));
  });

  it("移除連結：wikilink 身上的其他樣式（粗體）留給文字，只丟連結", async () => {
    const { editor } = await mount({});
    const tt = editor._tiptapEditor;
    let from = -1;
    let to = -1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ProseMirror Node 型別在 apps/web 值層級拿不到
    tt.state.doc.descendants((n: any, pos: number) => {
      if (n.type.name === "paragraph") {
        from = pos + 1;
        to = pos + 1 + n.content.size;
      }
      return true;
    });
    act(() => {
      tt.commands.setTextSelection({ from, to });
      editor.addStyles({ bold: true });
    });
    await screen.findByRole("link", { name: "Target" }); // 加 mark 後 node view 重建，React 內容非同步補上
    const dialog = await openToolbar("Target");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove link" }));
    await waitFor(() => expect(editor.document[0]!.content).toEqual([{ type: "text", text: "see Target end", styles: { bold: true } }]));
  });

  it("斷鏈也開工具列（方便更換或移除），但「開啟」disabled", async () => {
    await mount({ snapshotTitle: "Gone" }, [OTHER]);
    fireEvent.click(screen.getByText("Gone"));
    const dialog = await screen.findByRole("dialog", { name: "Note link" });
    expect(within(dialog).getByRole("button", { name: "Open" })).toBeDisabled();
  });

  it("Esc 關閉 → 焦點回編輯器；點外（pointerdown 在 body）關閉 → 焦點回編輯器", async () => {
    const { editor } = await mount({});
    let dialog = await openToolbar("Target");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Note link" })).not.toBeInTheDocument());
    expect(editorHasFocus(editor)).toBe(true);
    dialog = await openToolbar("Target");
    // 照真實點擊的事件序列演（@radix-ui/react-dismissable-layer dist/index.mjs）：開啟後在 setTimeout(0) 裡才掛 document 的
    // pointerdown 監聽（真實的點外一定晚於這一拍）；Popover 帶 `deferPointerDownOutside`，左鍵的點外關閉延到同一次點擊的 click 才觸發。
    await settle();
    fireEvent.pointerDown(document.body, { button: 0, pointerType: "mouse" });
    fireEvent.click(document.body);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Note link" })).not.toBeInTheDocument());
    expect(editorHasFocus(editor)).toBe(true);
  });

  it("點外點到可聚焦的元素（編輯器外的輸入框）：關閉後焦點留在那裡，不被拉回編輯器", async () => {
    await mount({});
    await openToolbar("Target");
    await settle();
    const outside = screen.getByRole("textbox", { name: "Outside" });
    fireEvent.pointerDown(outside, { button: 0, pointerType: "mouse" });
    act(() => outside.focus()); // 真實的 mousedown 預設行為：焦點移到被點的輸入框
    fireEvent.click(outside);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Note link" })).not.toBeInTheDocument());
    await settle(20); // FocusScope 卸載時的焦點處理在 setTimeout(0)
    expect(document.activeElement).toBe(outside);
  });

  it("A 的工具列開著時點 B：A 關閉、B 的工具列保持開啟（焦點不被拉回編輯器而讓 B 判定 focus outside）", async () => {
    await mount({}, [TARGET, OTHER], true);
    await openToolbar("Target");
    await settle();
    const linkB = screen.getByRole("link", { name: "Other Note" });
    fireEvent.pointerDown(linkB, { button: 0, pointerType: "mouse" });
    fireEvent.click(linkB);
    await settle(50);
    const dialogs = screen.getAllByRole("dialog", { name: "Note link" });
    expect(dialogs).toHaveLength(1);
    fireEvent.click(within(dialogs[0]!).getByRole("button", { name: "Edit text" }));
    expect(within(dialogs[0]!).getByRole("textbox", { name: "Link text" })).toHaveAttribute("placeholder", "Other Note");
  });
});

/**
 * W11（§7.6 工具列那一列）：各一下 Ctrl+Z（UndoManager.undo）還原。量測紀律：每個動作之前 `stopCapturing()`（＝使用者停頓 >500ms，
 * 量「規則語意本身」），不用 fake timers。MEASURED 是【推】假說——實測不同就照實改並回報（文件依實測寫條件句）。
 */
const MEASURED = { editText: true, changeTarget: true, remove: true } as const;

describe("#269 W11 工具列動作的撤銷（量到的結果即斷言）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  });
  afterEach(teardown);

  for (const action of ["editText", "changeTarget", "remove"] as const) {
    it(`${action}：一下 undo 還原＝${String(MEASURED[action])}`, async () => {
      const { editor } = await mount({ label: "L" });
      const before = JSON.stringify(editor.document[0]!.content);
      collabUndoManager(editor)!.stopCapturing();
      const dialog = await openToolbar("L");
      if (action === "editText") {
        fireEvent.click(within(dialog).getByRole("button", { name: "Edit text" }));
        fireEvent.change(within(dialog).getByRole("textbox", { name: "Link text" }), { target: { value: "M" } });
        fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
      } else if (action === "changeTarget") {
        fireEvent.click(within(dialog).getByRole("button", { name: "Change target" }));
        fireEvent.click(within(dialog).getByRole("button", { name: "Other Note" }));
      } else {
        fireEvent.click(within(dialog).getByRole("button", { name: "Remove link" }));
      }
      await waitFor(() => expect(JSON.stringify(editor.document[0]!.content)).not.toBe(before));
      act(() => {
        collabUndoManager(editor)!.undo();
      });
      expect(JSON.stringify(editor.document[0]!.content) === before).toBe(MEASURED[action]);
    });
  }
});
