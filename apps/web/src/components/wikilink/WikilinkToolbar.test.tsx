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
const MOUSE = { pointerType: "mouse" } as const;
const TOUCH = { pointerType: "touch", clientX: 10, clientY: 10 } as const;
const queryToolbar = () => screen.queryByRole("dialog", { name: "Note link" });
/** 滑鼠 hover（rev 7）：開啟延遲 250 ms，`findByRole` 的等待涵蓋它。 */
async function openToolbar(name: string) {
  fireEvent.pointerEnter(screen.getByRole("link", { name }), MOUSE);
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

describe("#269 W2 wikilink 小工具列（rev 7：hover／觸控長按開；點擊直接跳轉）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  });
  afterEach(teardown);

  it("編輯模式一般點擊：直接導到 canonical，不開工具列", async () => {
    await mount({});
    expect(fireEvent.click(screen.getByRole("link", { name: "Target" }))).toBe(false);
    await waitFor(() => expect(screen.getByTestId("loc").textContent).toBe(canonicalNotePath(TARGET)));
    await settle(300);
    expect(queryToolbar()).not.toBeInTheDocument();
  });

  it("滑鼠 hover：延遲後才出工具列、不搶焦點；只有編輯文字／更換目標／移除連結三鈕（沒有「開啟」）", async () => {
    await mount({});
    fireEvent.pointerEnter(screen.getByRole("link", { name: "Target" }), MOUSE);
    await settle(100);
    expect(queryToolbar()).not.toBeInTheDocument();
    const dialog = await screen.findByRole("dialog", { name: "Note link" });
    expect(within(dialog).getAllByRole("button").map((b) => b.textContent)).toEqual(["Edit text", "Change target", "Remove link"]);
    expect(dialog.contains(document.activeElement)).toBe(false);
    expect(screen.getByTestId("loc").textContent).toBe("/start");
  });

  it("觸控的 pointerenter 不算 hover（不開工具列）", async () => {
    await mount({});
    fireEvent.pointerEnter(screen.getByRole("link", { name: "Target" }), TOUCH);
    await settle(400);
    expect(queryToolbar()).not.toBeInTheDocument();
  });

  it("移出連結：延遲後關閉、不把焦點拉進編輯器；移進工具列不關，移出工具列才關", async () => {
    const { editor } = await mount({});
    const link = screen.getByRole("link", { name: "Target" });
    let dialog = await openToolbar("Target");
    fireEvent.pointerLeave(link, MOUSE);
    fireEvent.pointerEnter(dialog, MOUSE);
    await settle(400);
    expect(queryToolbar()).toBeInTheDocument();
    fireEvent.pointerLeave(dialog, MOUSE);
    await waitFor(() => expect(queryToolbar()).not.toBeInTheDocument());
    await settle(20);
    expect(editorHasFocus(editor)).toBe(false);

    dialog = await openToolbar("Target");
    fireEvent.pointerLeave(link, MOUSE);
    await settle(100);
    expect(queryToolbar()).toBeInTheDocument(); // 關閉也有延遲（給滑鼠走到工具列的時間）
    await waitFor(() => expect(queryToolbar()).not.toBeInTheDocument());
  });

  it("工具列裡有焦點（正在編輯文字）時滑鼠移出不關", async () => {
    await mount({});
    const dialog = await openToolbar("Target");
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit text" }));
    expect(within(dialog).getByRole("textbox", { name: "Link text" })).toHaveFocus();
    fireEvent.pointerLeave(dialog, MOUSE);
    await settle(500);
    expect(queryToolbar()).toBeInTheDocument();
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
    const remove = within(dialog).getByRole("button", { name: "Remove link" });
    fireEvent.pointerDown(remove, MOUSE); // 真實點擊先有 pointerdown：算「在工具列裡互動過」，關閉後焦點回編輯器
    fireEvent.click(remove);
    await waitFor(() => expect(editor.document[0]!.content).toEqual([{ type: "text", text: "see Target end", styles: {} }]));
    await waitFor(() => expect(editorHasFocus(editor)).toBe(true));
  });

  it("開啟時編輯器沒有焦點：移除連結／存文字後焦點回編輯器，游標落在連結原處（不是編輯器的舊選取）", async () => {
    const { editor } = await mount({});
    const tt = editor._tiptapEditor;
    const wikilinkPos = () => {
      let at = -1;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ProseMirror Node 型別在 apps/web 值層級拿不到
      tt.state.doc.descendants((n: any, pos: number) => {
        if (n.type.name === "wikilink") at = pos;
        return true;
      });
      return at;
    };
    act(() => {
      tt.commands.setTextSelection(1); // 編輯器的舊選取在文件開頭附近
    });
    const pos = wikilinkPos();
    let dialog = await openToolbar("Target");
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit text" }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Link text" }), { target: { value: "L" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(editorHasFocus(editor)).toBe(true));
    expect(tt.state.selection.from).toBe(pos + 1);

    act(() => {
      tt.commands.setTextSelection(1);
      (document.activeElement as HTMLElement).blur();
    });
    dialog = await openToolbar("L");
    const remove = within(dialog).getByRole("button", { name: "Remove link" });
    fireEvent.pointerDown(remove, MOUSE);
    fireEvent.click(remove);
    await waitFor(() => expect(editor.document[0]!.content).toEqual([{ type: "text", text: "see L end", styles: {} }]));
    await waitFor(() => expect(editorHasFocus(editor)).toBe(true));
    expect(tt.state.selection.from).toBe(pos + "L".length);
  });

  it("開啟時編輯器有焦點：存文字、移除連結後游標都留在使用者原本的位置（不搬）", async () => {
    const { editor } = await mount({});
    const tt = editor._tiptapEditor;
    act(() => {
      tt.commands.setTextSelection(2);
      editor.focus();
    });
    const before = tt.state.selection.from;
    const dialog = await openToolbar("Target");
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit text" }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Link text" }), { target: { value: "L" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(editorHasFocus(editor)).toBe(true));
    expect(tt.state.selection.from).toBe(before);

    act(() => editor.focus());
    const dialog2 = await openToolbar("L");
    const remove = within(dialog2).getByRole("button", { name: "Remove link" });
    fireEvent.pointerDown(remove, MOUSE);
    fireEvent.click(remove);
    await waitFor(() => expect(editor.document[0]!.content).toEqual([{ type: "text", text: "see L end", styles: {} }]));
    expect(tt.state.selection.from).toBe(before); // 游標在連結之前，替換不影響它的位置
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

  it("斷鏈：hover 也出工具列（方便更換或移除）；點擊只 toast、不導航", async () => {
    await mount({ snapshotTitle: "Gone" }, [OTHER]);
    const span = screen.getByText("Gone");
    fireEvent.pointerEnter(span, MOUSE);
    const dialog = await screen.findByRole("dialog", { name: "Note link" });
    expect(within(dialog).getAllByRole("button").map((b) => b.textContent)).toEqual(["Edit text", "Change target", "Remove link"]);
    fireEvent.click(span);
    expect(await screen.findByText("This linked note no longer exists.")).toBeInTheDocument();
    expect(screen.getByTestId("loc").textContent).toBe("/start");
  });

  it("開啟時編輯器有焦點：Esc 關閉 → 焦點回編輯器；點外（pointerdown 在 body）關閉 → 焦點回編輯器", async () => {
    const { editor } = await mount({});
    act(() => editor.focus());
    let dialog = await openToolbar("Target");
    act(() => (document.activeElement as HTMLElement).blur()); // 焦點落到 body（無處可去）時才需要拉回
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(queryToolbar()).not.toBeInTheDocument());
    expect(editorHasFocus(editor)).toBe(true);
    dialog = await openToolbar("Target");
    act(() => (document.activeElement as HTMLElement).blur());
    // 照真實點擊的事件序列演（@radix-ui/react-dismissable-layer dist/index.mjs）：開啟後在 setTimeout(0) 裡才掛 document 的
    // pointerdown 監聽（真實的點外一定晚於這一拍）；Popover 帶 `deferPointerDownOutside`，左鍵的點外關閉延到同一次點擊的 click 才觸發。
    await settle();
    fireEvent.pointerDown(document.body, { button: 0, pointerType: "mouse" });
    fireEvent.click(document.body);
    await waitFor(() => expect(queryToolbar()).not.toBeInTheDocument());
    expect(editorHasFocus(editor)).toBe(true);
  });

  it("開啟時編輯器沒有焦點、也沒在工具列裡互動：Esc／點外關閉都不把焦點拉進編輯器（手機上不叫出虛擬鍵盤）", async () => {
    const { editor } = await mount({});
    let dialog = await openToolbar("Target");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(queryToolbar()).not.toBeInTheDocument());
    await settle(20);
    expect(editorHasFocus(editor)).toBe(false);

    // 觸控長按開、點外關
    const link = screen.getByRole("link", { name: "Target" });
    fireEvent.pointerDown(link, TOUCH);
    await settle(600);
    fireEvent.pointerUp(link, TOUCH);
    dialog = await screen.findByRole("dialog", { name: "Note link" });
    await settle();
    fireEvent.pointerDown(document.body, { button: 0, pointerType: "touch" });
    fireEvent.click(document.body);
    await waitFor(() => expect(queryToolbar()).not.toBeInTheDocument());
    await settle(20);
    expect(editorHasFocus(editor)).toBe(false);
  });

  it("點外點到可聚焦的元素（編輯器外的輸入框）：關閉後焦點留在那裡，不被拉回編輯器", async () => {
    await mount({});
    await openToolbar("Target");
    await settle();
    const outside = screen.getByRole("textbox", { name: "Outside" });
    fireEvent.pointerDown(outside, { button: 0, pointerType: "mouse" });
    act(() => outside.focus()); // 真實的 mousedown 預設行為：焦點移到被點的輸入框
    fireEvent.click(outside);
    await waitFor(() => expect(queryToolbar()).not.toBeInTheDocument());
    await settle(20); // FocusScope 卸載時的焦點處理在 setTimeout(0)
    expect(document.activeElement).toBe(outside);
  });

  it("A 的工具列開著時滑鼠移到 B：A 關閉、只剩 B 的工具列", async () => {
    await mount({}, [TARGET, OTHER], true);
    await openToolbar("Target");
    fireEvent.pointerLeave(screen.getByRole("link", { name: "Target" }), MOUSE);
    fireEvent.pointerEnter(screen.getByRole("link", { name: "Other Note" }), MOUSE);
    await settle(500);
    const dialogs = screen.getAllByRole("dialog", { name: "Note link" });
    expect(dialogs).toHaveLength(1);
    fireEvent.click(within(dialogs[0]!).getByRole("button", { name: "Edit text" }));
    expect(within(dialogs[0]!).getByRole("textbox", { name: "Link text" })).toHaveAttribute("placeholder", "Other Note");
  });

  it("觸控長按約 500 ms：出工具列；長按後補發的 click 被攔（不導航）；下一次短按照常導航", async () => {
    await mount({});
    const link = screen.getByRole("link", { name: "Target" });
    fireEvent.pointerDown(link, TOUCH);
    await settle(300);
    expect(queryToolbar()).not.toBeInTheDocument();
    await settle(300);
    expect(queryToolbar()).toBeInTheDocument();
    fireEvent.pointerUp(link, TOUCH);
    expect(fireEvent.mouseDown(link)).toBe(false); // 補發的 mousedown 也攔（不讓 ProseMirror 搬游標、搶焦點關掉工具列）
    expect(fireEvent.click(link)).toBe(false);
    await settle(50);
    expect(screen.getByTestId("loc").textContent).toBe("/start");
    expect(queryToolbar()).toBeInTheDocument();

    fireEvent.pointerDown(link, TOUCH);
    fireEvent.pointerUp(link, TOUCH);
    fireEvent.click(link);
    await waitFor(() => expect(screen.getByTestId("loc").textContent).toBe(canonicalNotePath(TARGET)));
  });

  it("觸控短按：導航、不開工具列", async () => {
    await mount({});
    const link = screen.getByRole("link", { name: "Target" });
    fireEvent.pointerDown(link, TOUCH);
    await settle(100);
    fireEvent.pointerUp(link, TOUCH);
    fireEvent.click(link);
    await waitFor(() => expect(screen.getByTestId("loc").textContent).toBe(canonicalNotePath(TARGET)));
    await settle(600);
    expect(queryToolbar()).not.toBeInTheDocument();
  });

  it("長按中手指移動超過閾值：取消（不開工具列）；小幅抖動不取消", async () => {
    await mount({});
    const link = screen.getByRole("link", { name: "Target" });
    fireEvent.pointerDown(link, TOUCH);
    fireEvent.pointerMove(link, { ...TOUCH, clientX: 30 });
    await settle(600);
    expect(queryToolbar()).not.toBeInTheDocument();
    fireEvent.pointerUp(link, TOUCH);

    fireEvent.pointerDown(link, TOUCH);
    fireEvent.pointerMove(link, { ...TOUCH, clientX: 13, clientY: 12 });
    await settle(600);
    expect(queryToolbar()).toBeInTheDocument();
  });

  it("可編輯：觸控按壓中的 contextmenu（Android 長按）被 preventDefault 並立刻出工具列；滑鼠右鍵的 contextmenu 不攔", async () => {
    await mount({});
    const link = screen.getByRole("link", { name: "Target" });
    fireEvent.pointerDown(link, { pointerType: "mouse", button: 2 });
    expect(fireEvent.contextMenu(link)).toBe(true);
    fireEvent.pointerUp(link, { pointerType: "mouse", button: 2 });
    expect(queryToolbar()).not.toBeInTheDocument();

    fireEvent.pointerDown(link, TOUCH);
    expect(fireEvent.contextMenu(link)).toBe(false);
    await settle(50); // 立刻成立，不等 500 ms 計時
    expect(queryToolbar()).toBeInTheDocument();
    fireEvent.pointerUp(link, TOUCH);
    expect(fireEvent.click(link)).toBe(false);
    expect(screen.getByTestId("loc").textContent).toBe("/start");
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
