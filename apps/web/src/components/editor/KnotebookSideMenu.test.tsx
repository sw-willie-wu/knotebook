import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BlockNoteEditor } from "@blocknote/core";
import { SideMenuExtension } from "@blocknote/core/extensions";
import { SideMenuController } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import i18n from "@/i18n";
import { noteSchema } from "@/collab/schema";
import { Toaster } from "@/components/ui/toast";
import { P, row, shape, withChildren, type AnyEditor, type PartialBlockLike } from "@/test/columns-fixtures";
import { KnotebookSideMenu, NotePathContext } from "./KnotebookSideMenu";
import { HeadingAnchorButtons } from "./HeadingAnchorButtons";

// spec 2026-10-13 site-links §10.3(a)：拖曳把手選單＝四個預設項＋「複製段落連結」。jsdom 沒有 elementsFromPoint：
// 墊一支回傳該段落的 elementsFromPoint，再對編輯器發一次真的 mousemove，讓 BlockNote 的 SideMenuView 自己算出 state。
// 不直接 `store.setState`：那樣 SideMenuView 內部的 state 仍是 undefined，點把手時 `freezeMenu()` 拋
// `Cannot set properties of undefined (setting 'show')`（起草時實跑，vitest 記成 unhandled error、exit 1）。

describe("#269 KnotebookDragHandleMenu", () => {
  const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    writeText.mockClear();
  });
  afterEach(() => {
    Reflect.deleteProperty(document, "elementsFromPoint");
  });

  it("四個預設項照列＋複製段落連結；點擊複製 origin＋notePath＋#b-<block id>", async () => {
    const editor = BlockNoteEditor.create({ schema: noteSchema, initialContent: [{ id: "blk1", type: "paragraph", content: "hello" }] as never });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <NotePathContext.Provider value="/n/h/note">
            <BlockNoteView editor={editor} editable sideMenu={false}>
              <SideMenuController sideMenu={KnotebookSideMenu} />
            </BlockNoteView>
          </NotePathContext.Provider>
          <Toaster />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const paragraph = screen.getByText("hello");
    Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: () => [paragraph] });
    act(() => {
      fireEvent.mouseMove(paragraph, { clientX: 0, clientY: 0 });
    });
    expect(editor.getExtension(SideMenuExtension)!.store.state?.block?.id).toBe("blk1");
    const handle = await screen.findByLabelText("Open block menu"); // BlockNote 0.52.1 英文字典 side_menu.drag_handle_label
    fireEvent.click(handle);
    expect(await screen.findByText("Delete")).toBeInTheDocument();
    expect(screen.getByText("Colors")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Copy link to block"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/n/h/note#b-blk1`));
  });

  it("非 ASCII slug：把手選單（未編碼的 canonical 路徑）與標題「#」（編碼過的 location.pathname）複製出同一字串", async () => {
    // 真瀏覽器的 location.pathname 對 CJK slug 回百分比編碼形；canonicalNotePath 回原字（NotePage.tsx 收斂 effect 的註解）。
    window.history.pushState(null, "", "/n/h/%E4%B8%AD%E6%96%87");
    try {
      const editor = BlockNoteEditor.create({ schema: noteSchema, initialContent: [{ id: "hd1", type: "heading", content: "Section" }] as never });
      function Column() {
        const [col, setCol] = useState<HTMLElement | null>(null);
        return (
          <div ref={setCol} className="relative">
            <NotePathContext.Provider value="/n/h/中文">
              <BlockNoteView editor={editor} editable sideMenu={false}>
                <SideMenuController sideMenu={KnotebookSideMenu} />
              </BlockNoteView>
            </NotePathContext.Provider>
            <HeadingAnchorButtons container={col} />
          </div>
        );
      }
      render(
        <QueryClientProvider client={new QueryClient()}>
          <MemoryRouter>
            <Column />
          </MemoryRouter>
        </QueryClientProvider>,
      );
      const heading = screen.getByText("Section");
      Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: () => [heading] });
      act(() => {
        fireEvent.mouseMove(heading, { clientX: 0, clientY: 0 });
      });
      fireEvent.click(await screen.findByLabelText("Open block menu"));
      fireEvent.click(await screen.findByText("Copy link to block"));
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
      fireEvent.pointerOver(heading);
      fireEvent.click(screen.getByRole("button", { name: "Copy link to this section" }));
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
      const [[fromMenu], [fromHeading]] = writeText.mock.calls;
      expect(fromMenu).toBe(fromHeading);
      expect(fromMenu).toBe(`${window.location.origin}/n/h/%E4%B8%AD%E6%96%87#b-hd1`);
    } finally {
      window.history.pushState(null, "", "/");
    }
  });
});

describe("D25 側選單「Delete」不收欄", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    Reflect.deleteProperty(document, "elementsFromPoint");
  });

  function mount(content: PartialBlockLike[]): AnyEditor {
    const editor = BlockNoteEditor.create({ schema: noteSchema, initialContent: content as never }) as AnyEditor;
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <BlockNoteView editor={editor} editable sideMenu={false}>
            <SideMenuController sideMenu={KnotebookSideMenu} />
          </BlockNoteView>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return editor;
  }

  /** 對文字為 `text` 的 block 開 ⋮⋮、點「Delete」。 */
  async function deleteVia(editor: AnyEditor, text: string, id: string): Promise<void> {
    const el = screen.getByText(text);
    Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: () => [el] });
    act(() => {
      fireEvent.mouseMove(el, { clientX: 0, clientY: 0 });
    });
    expect(editor.getExtension(SideMenuExtension)!.store.state?.block?.id).toBe(id);
    fireEvent.click(await screen.findByLabelText("Open block menu"));
    fireEvent.click(await screen.findByText("Delete"));
  }

  const R2 = () => [P("x", "x"), row([[P("a", "a1")], [P("b", "b1")]], "r"), P("z", "z")];

  it("SM1：欄內唯一 block 刪掉 → 列與兩欄都在、該欄補空段落", async () => {
    const editor = mount(R2());
    await deleteVia(editor, "b", "b1");
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph)]  paragraph:z");
  });

  it("SM2：跨兩欄選取後對 a 刪除 → 整個選取（a 與 b）被刪、列仍兩欄", async () => {
    const editor = mount(R2());
    act(() => editor.setSelection("a1", "b1"));
    // SM2a（事實釘）：跨欄選取的 blocks 第 2 項是 column 節點本身。
    expect(editor.getSelection()!.blocks.map((b) => b.type)).toEqual(["paragraph", "column"]);
    await deleteVia(editor, "a", "a1");
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(paragraph) | COL(paragraph)]  paragraph:z");
  });

  // T3c（spec §5.4 調整 2 補充）：跨欄選取只刪選取範圍、點第 2 欄以後或列內的 block 也算多選。
  const C1 = () => [P("x", "x"), row([[P("a", "a1")], [P("b", "b1"), P("q", "q1")]], "r"), P("z", "z")];

  it("SM2b：同一選取下對 b 刪除 → 展開後的集合含 b，刪 a 與 b（R1）", async () => {
    const editor = mount(R2());
    act(() => editor.setSelection("a1", "b1"));
    await deleteVia(editor, "b", "b1");
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(paragraph) | COL(paragraph)]  paragraph:z");
  });

  it("SM2c：[a｜b,q] 選 a→b 後對 a 刪除 → 沒選到的 q 保留（C1）", async () => {
    const editor = mount(C1());
    act(() => editor.setSelection("a1", "b1"));
    await deleteVia(editor, "a", "a1");
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(paragraph) | COL(paragraph:q)]  paragraph:z");
  });

  it("SM2d：[a｜b｜c] 選 a→b 後對 a 刪除 → 三欄都在、前兩欄補空段落（C4）", async () => {
    const editor = mount([P("x", "x"), row([[P("a", "a1")], [P("b", "b1")], [P("c", "c1")]], "r"), P("z", "z")]);
    act(() => editor.setSelection("a1", "b1"));
    await deleteVia(editor, "a", "a1");
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(paragraph) | COL(paragraph) | COL(paragraph:c)]  paragraph:z");
  });

  it("SM2e：從列上方選到第 2 欄（x→b）後對 x 刪除 → x、a、b 刪掉，q 保留（C7）", async () => {
    const editor = mount(C1());
    act(() => editor.setSelection("x", "b1"));
    await deleteVia(editor, "x", "x");
    expect(shape(editor)).toBe("ROW[COL(paragraph) | COL(paragraph:q)]  paragraph:z");
  });

  it("SM2f：同 SM2e 的選取對 a 刪除 → 同 SM2e（R3）", async () => {
    const editor = mount(C1());
    act(() => editor.setSelection("x", "b1"));
    await deleteVia(editor, "a", "a1");
    expect(shape(editor)).toBe("ROW[COL(paragraph) | COL(paragraph:q)]  paragraph:z");
  });

  it("SM2g：[a｜b,q] 選 a→b 後對 b 刪除 → 同 SM2c（R2）", async () => {
    const editor = mount(C1());
    act(() => editor.setSelection("a1", "b1"));
    await deleteVia(editor, "b", "b1");
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(paragraph) | COL(paragraph:q)]  paragraph:z");
  });

  it("SM2h：從列上方選到列下方（x→z）後對列內的 a 刪除 → 整列連 x、z 刪掉（C10-a）", async () => {
    const editor = mount(R2());
    act(() => editor.setSelection("x", "z"));
    await deleteVia(editor, "a", "a1");
    expect(shape(editor)).toBe("paragraph");
  });

  it("SM2i：一般筆記（沒有並排）選 a→b 後對 a 刪除 → 刪整個選取，同 core（SD4 N5）", async () => {
    const editor = mount([P("a", "a1"), P("b", "b1"), P("c", "c1")]);
    act(() => editor.setSelection("a1", "b1"));
    await deleteVia(editor, "a", "a1");
    expect(shape(editor)).toBe("paragraph:c");
  });
});

describe("T6 ⋮⋮「取消並排」（spec §7.2）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    Reflect.deleteProperty(document, "elementsFromPoint");
  });

  function mount(content: PartialBlockLike[]): AnyEditor {
    const editor = BlockNoteEditor.create({ schema: noteSchema, initialContent: content as never }) as AnyEditor;
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <BlockNoteView editor={editor} editable sideMenu={false}>
            <SideMenuController sideMenu={KnotebookSideMenu} />
          </BlockNoteView>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return editor;
  }

  /** 對文字為 `text` 的 block 開 ⋮⋮，等選單出現（以「Delete」為準）。 */
  async function openMenu(editor: AnyEditor, text: string, id: string): Promise<void> {
    const el = screen.getByText(text);
    Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: () => [el] });
    act(() => {
      fireEvent.mouseMove(el, { clientX: 0, clientY: 0 });
    });
    expect(editor.getExtension(SideMenuExtension)!.store.state?.block?.id).toBe(id);
    fireEvent.click(await screen.findByLabelText("Open block menu"));
    expect(await screen.findByText("Delete")).toBeInTheDocument();
  }

  const R2 = () => [P("x", "x"), row([[P("a", "a1")], [P("b", "b1")]], "r"), P("z", "z")];

  it("SM4：欄內 block 的 ⋮⋮ 有「Ungroup columns」，點了整列攤平成 x a b z", async () => {
    const editor = mount(R2());
    await openMenu(editor, "b", "b1");
    fireEvent.click(screen.getByText("Ungroup columns"));
    expect(shape(editor)).toBe("paragraph:x  paragraph:a  paragraph:b  paragraph:z");
    expect(i18n.t("note.columns.ungroup", { lng: "zh-TW" })).toBe("取消並排");
  });

  it("SM5：頂層 block 的 ⋮⋮ 沒有「Ungroup columns」", async () => {
    const editor = mount(R2());
    await openMenu(editor, "x", "x");
    expect(screen.queryByText("Ungroup columns")).toBeNull();
  });
});

describe("C7 欄內的側邊選單只留 ⋮⋮（spec §17 #3）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    Reflect.deleteProperty(document, "elementsFromPoint");
  });

  function mount(content: PartialBlockLike[]): AnyEditor {
    const editor = BlockNoteEditor.create({ schema: noteSchema, initialContent: content as never }) as AnyEditor;
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <NotePathContext.Provider value="/n/h/note">
            <BlockNoteView editor={editor} editable sideMenu={false}>
              <SideMenuController sideMenu={KnotebookSideMenu} />
            </BlockNoteView>
          </NotePathContext.Provider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return editor;
  }

  /** 讓 SideMenuView 指向文字為 `text` 的 block，等 ⋮⋮ 出現。 */
  async function hover(editor: AnyEditor, text: string, id: string): Promise<void> {
    const el = screen.getByText(text);
    Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: () => [el] });
    act(() => {
      fireEvent.mouseMove(el, { clientX: 0, clientY: 0 });
    });
    expect(editor.getExtension(SideMenuExtension)!.store.state?.block?.id).toBe(id);
    expect(await screen.findByLabelText("Open block menu")).toBeInTheDocument();
  }

  const NESTED = () => [P("x", "x"), row([[withChildren(P("a", "a1"), [P("n", "n1")])], [P("b", "b1")]], "r"), P("z", "z")];

  it("C7-1：欄的直接子 block → 只有 ⋮⋮、沒有 Add block", async () => {
    const editor = mount(NESTED());
    await hover(editor, "b", "b1");
    expect(screen.queryByLabelText("Add block")).toBeNull();
  });

  it("C7-2：欄內巢狀子 block → 同樣只有 ⋮⋮", async () => {
    const editor = mount(NESTED());
    expect(editor.getParentBlock("n1")?.id).toBe("a1");
    await hover(editor, "n", "n1");
    expect(screen.queryByLabelText("Add block")).toBeNull();
  });

  it("C7-3：欄外 block → Add block 與 ⋮⋮ 都在；再移到欄內 → Add block 消失", async () => {
    const editor = mount(NESTED());
    await hover(editor, "x", "x");
    expect(screen.getByLabelText("Add block")).toBeInTheDocument();
    await hover(editor, "b", "b1");
    expect(screen.queryByLabelText("Add block")).toBeNull();
  });

  it("C7-4：欄內 ⋮⋮ 的選單項不變（刪除、取消並排、顏色、複製段落連結）", async () => {
    const editor = mount(NESTED());
    await hover(editor, "b", "b1");
    fireEvent.click(screen.getByLabelText("Open block menu"));
    expect(await screen.findByText("Delete")).toBeInTheDocument();
    expect(screen.getByText("Ungroup columns")).toBeInTheDocument();
    expect(screen.getByText("Colors")).toBeInTheDocument();
    expect(screen.getByText("Copy link to block")).toBeInTheDocument();
  });
});
