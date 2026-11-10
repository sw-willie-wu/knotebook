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
import { resetCustomColorsForTest } from "@/lib/custom-colors";
import { resetRecentColorsForTest } from "@/lib/recent-colors";
import { layoutHostTrigger, waitForMenuShown } from "@/test/color-menu-host";
import { P, row, shape, withChildren, type AnyEditor, type PartialBlockLike } from "@/test/columns-fixtures";
import { KnotebookSideMenu, NotePathContext } from "./KnotebookSideMenu";
import { HeadingAnchorButtons } from "./HeadingAnchorButtons";

// 拖曳把手選單＝四個預設項＋「複製段落連結」。jsdom 沒有 elementsFromPoint：
// 墊一支回傳該段落的 elementsFromPoint，再對編輯器發一次真的 mousemove，讓 BlockNote 的 SideMenuView 自己算出 state。
// 不直接 `store.setState`：那樣 SideMenuView 內部的 state 仍是 undefined，點把手時 `freezeMenu()` 拋
// `Cannot set properties of undefined (setting 'show')`（vitest 記成 unhandled error、exit 1）。

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

describe("側選單「Delete」不收欄", () => {
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
    // 事實釘：跨欄選取的 blocks 第 2 項是 column 節點本身。
    expect(editor.getSelection()!.blocks.map((b) => b.type)).toEqual(["paragraph", "column"]);
    await deleteVia(editor, "a", "a1");
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(paragraph) | COL(paragraph)]  paragraph:z");
  });

  // 跨欄選取只刪選取範圍、點第 2 欄以後或列內的 block 也算多選。
  const C1 = () => [P("x", "x"), row([[P("a", "a1")], [P("b", "b1"), P("q", "q1")]], "r"), P("z", "z")];

  it("SM2b：同一選取下對 b 刪除 → 展開後的集合含 b，刪 a 與 b", async () => {
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

  it("SM2d：[a｜b｜c] 選 a→b 後對 a 刪除 → 三欄都在、前兩欄補空段落", async () => {
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

  it("SM2f：同 SM2e 的選取對 a 刪除 → 同 SM2e", async () => {
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

  it("SM2h：從列上方選到列下方（x→z）後對列內的 a 刪除 → 整列連 x、z 刪掉", async () => {
    const editor = mount(R2());
    act(() => editor.setSelection("x", "z"));
    await deleteVia(editor, "a", "a1");
    expect(shape(editor)).toBe("paragraph");
  });

  it("SM2i：一般筆記（沒有並排）選 a→b 後對 a 刪除 → 刪整個選取，同 core", async () => {
    const editor = mount([P("a", "a1"), P("b", "b1"), P("c", "c1")]);
    act(() => editor.setSelection("a1", "b1"));
    await deleteVia(editor, "a", "a1");
    expect(shape(editor)).toBe("paragraph:c");
  });
});

describe("T6 ⋮⋮「取消並排」", () => {
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

describe("C7 欄內的側邊選單只留 ⋮⋮", () => {
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

describe("⋮⋮ 的顏色子選單與自訂色面板", () => {
  beforeEach(async () => {
    localStorage.clear();
    resetRecentColorsForTest();
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    resetCustomColorsForTest();
    Reflect.deleteProperty(document, "elementsFromPoint");
    Reflect.deleteProperty(document, "elementFromPoint");
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

  const handle = () => screen.getByLabelText("Open block menu");
  const handleMenu = () => document.querySelector<HTMLElement>(".bn-drag-handle-menu");
  const colorsItem = () => document.querySelector<HTMLElement>('[data-kb-color-return="dh-colors"]');
  const item = (test: string) => document.querySelector<HTMLElement>(`[data-test="${test}"]`);
  const panel = () => document.querySelector<HTMLElement>(".bn-drag-handle-menu .kb-color-panel");
  const hexInput = () => screen.getByRole("textbox", { name: "Hex color", hidden: true }) as HTMLInputElement;
  const button = (name: string) => screen.getByRole("button", { name, hidden: true }) as HTMLButtonElement;

  /** 讓 SideMenuView 指向文字為 `text` 的 block，等 ⋮⋮ 出現。 */
  async function hover(editor: AnyEditor, text: string, id: string): Promise<void> {
    const el = screen.getByText(text);
    Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: () => [el] });
    // 表格的欄寬調整外掛在 mousemove 時呼叫 posAtCoords，要用到 jsdom 沒有的 elementFromPoint
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => el });
    act(() => {
      fireEvent.mouseMove(el, { clientX: 0, clientY: 0 });
    });
    expect(editor.getExtension(SideMenuExtension)!.store.state?.block?.id).toBe(id);
    await screen.findByLabelText("Open block menu");
  }

  /** 點 ⋮⋮ 開選單，等選單掛上，並讓 Mantine 開選單時排的初始聚焦計時器跑完。 */
  async function openHandleMenu(): Promise<void> {
    fireEvent.click(handle());
    expect(await screen.findByText("Delete")).toBeInTheDocument();
    await act(() => new Promise<void>((r) => setTimeout(r, 0)));
  }

  /** 從「Colors」以鍵盤（→）開子選單，等文字段或底色段的「自訂…」出現。 */
  async function openColorsSub(): Promise<void> {
    const colors = colorsItem()!;
    colors.focus();
    fireEvent.keyDown(colors, { key: "ArrowRight" });
    await waitFor(() => expect(item("text-color-custom") ?? item("background-color-custom")).not.toBeNull());
  }

  /** 開 ⋮⋮ → Colors → 該段的「自訂…」（`detail` 0＝鍵盤啟動），等面板掛上。 */
  async function openPanel(section: "text" | "background"): Promise<void> {
    await openHandleMenu();
    await openColorsSub();
    fireEvent.click(item(`${section}-color-custom`)!, { detail: 0 });
    await waitFor(() => expect(panel()).not.toBeNull());
  }

  /** 把手選單已關：dropdown 不在；⋮⋮ 若還在則 aria-expanded 為 false（套色改了文件之後 side menu 可能整個收起）。 */
  async function expectMenuClosed(): Promise<void> {
    await waitFor(() => {
      expect(handleMenu()).toBeNull();
      expect(screen.queryByLabelText("Open block menu")?.getAttribute("aria-expanded") ?? "false").toBe("false");
    });
  }

  /** 等 lazy 載入的 react-colorful 掛好。 */
  async function sliders(): Promise<void> {
    await waitFor(() => expect(screen.getAllByRole("slider", { hidden: true })).toHaveLength(2));
  }

  const TABLE = (id: string): PartialBlockLike =>
    ({ id, type: "table", content: { type: "tableContent", rows: [{ cells: ["cell a", "cell b"] }] } }) as PartialBlockLike;

  it("DH1：段落的 ⋮⋮ → Colors → 子選單有 Text、Background 兩段與兩個「Custom…」；其他項照舊", async () => {
    const editor = mount([P("x", "x"), P("target", "t1")]);
    await hover(editor, "target", "t1");
    await openHandleMenu();
    expect(screen.getByText("Copy link to block")).toBeInTheDocument();
    expect(colorsItem()).toHaveTextContent("Colors");
    await openColorsSub();
    expect(screen.getByText("Text")).toBeInTheDocument();
    expect(screen.getByText("Background")).toBeInTheDocument();
    expect(item("text-color-custom")).toHaveTextContent("Custom…");
    expect(item("background-color-custom")).toHaveTextContent("Custom…");
    expect(document.querySelectorAll('[data-test^="text-color-"]')).toHaveLength(11);
    expect(document.querySelectorAll('[data-test^="background-color-"]')).toHaveLength(11);
  });

  it("DH1：子選單的內建色 red（底色）→ 套到該 block、選單關", async () => {
    const editor = mount([P("x", "x"), P("target", "t1")]);
    await hover(editor, "target", "t1");
    await openHandleMenu();
    await openColorsSub();
    fireEvent.click(item("background-color-red")!);
    expect(editor.getBlock("t1")!.props.backgroundColor).toBe("red");
    await expectMenuClosed();
  });

  it("DH2：表格的 ⋮⋮ → Colors → 只有 Text 段，沒有任何 background-color-* 項", async () => {
    const editor = mount([P("x", "x"), TABLE("tb")]);
    // 前提：表格 block 有 textColor、沒有 backgroundColor
    expect(Object.keys(editor.getBlock("tb")!.props)).toContain("textColor");
    expect(Object.keys(editor.getBlock("tb")!.props)).not.toContain("backgroundColor");
    await hover(editor, "cell a", "tb");
    await openHandleMenu();
    await openColorsSub();
    expect(document.querySelectorAll('[data-test^="text-color-"]')).toHaveLength(11);
    expect(document.querySelectorAll('[data-test^="background-color-"]')).toHaveLength(0);
    expect(screen.queryByText("Background")).toBeNull();
  });

  it("DH3：沒有顏色 prop 的 block（codeBlock）→ ⋮⋮ 選單沒有 Colors", async () => {
    const editor = mount([P("x", "x"), { id: "cb", type: "codeBlock", content: "let code" } as PartialBlockLike]);
    // 前提：codeBlock 既沒有 textColor 也沒有 backgroundColor
    expect(Object.keys(editor.getBlock("cb")!.props)).not.toContain("textColor");
    expect(Object.keys(editor.getBlock("cb")!.props)).not.toContain("backgroundColor");
    await hover(editor, "let code", "cb");
    await openHandleMenu();
    expect(colorsItem()).toBeNull();
    expect(screen.queryByText("Colors")).toBeNull();
  });

  it("DH4：Custom… → 把手選單仍開、內容換成面板；輸入 #00ff00 按 Apply → 該 block 底色寫入、選單關", async () => {
    const editor = mount([P("x", "x"), P("target", "t1")]);
    await hover(editor, "target", "t1");
    await openPanel("background");
    expect(handle()).toHaveAttribute("aria-expanded", "true");
    expect(handleMenu()!.contains(panel())).toBe(true);
    expect(screen.queryByText("Delete")).toBeNull();
    fireEvent.change(hexInput(), { target: { value: "#00ff00" } });
    fireEvent.click(button("Apply"));
    expect(editor.getBlock("t1")!.props.backgroundColor).toBe("#00ff00");
    await expectMenuClosed();
  });

  it("DH5：沒有最近色時，面板最後一個 Apply 按 Tab 繞回 Back，把手選單不關", async () => {
    const editor = mount([P("x", "x"), P("target", "t1")]);
    await hover(editor, "target", "t1");
    const restore = layoutHostTrigger(handle());
    try {
      await openPanel("text");
      await waitForMenuShown(() => handleMenu()!);
      await sliders();
      fireEvent.change(hexInput(), { target: { value: "#00ff00" } });
      const apply = button("Apply");
      const back = button("Back");
      expect(apply).toBeEnabled();
      expect(screen.queryAllByRole("button", { name: /^#/, hidden: true })).toHaveLength(0);
      apply.focus();
      expect(fireEvent.keyDown(apply, { key: "Tab" })).toBe(false);
      expect(document.activeElement).toBe(back);
      expect(handle()).toHaveAttribute("aria-expanded", "true");
      back.focus();
      expect(fireEvent.keyDown(back, { key: "Tab", shiftKey: true })).toBe(false);
      expect(document.activeElement).toBe(apply);
      await act(() => new Promise<void>((r) => setTimeout(r, 400)));
      expect(handle()).toHaveAttribute("aria-expanded", "true");
      expect(panel()).not.toBeNull();
    } finally {
      restore();
    }
  });

  it("DH6：面板開著時該 block 被刪掉 → 不丟例外、文件裡沒有寫入 #00ff00、選單關", async () => {
    const editor = mount([P("x", "x"), P("target", "t1")]);
    await hover(editor, "target", "t1");
    await openPanel("background");
    fireEvent.change(hexInput(), { target: { value: "#00ff00" } });
    act(() => editor.removeBlocks(["t1"]));
    expect(editor.getBlock("t1")).toBeUndefined();
    await act(() => new Promise<void>((r) => setTimeout(r, 50)));
    // 選單開著時 side menu 是凍結的，block 被刪掉後 ⋮⋮ 與面板都還在
    expect(panel()).not.toBeNull();
    expect(handle()).toHaveAttribute("aria-expanded", "true");
    expect(() => fireEvent.click(button("Apply"))).not.toThrow();
    await expectMenuClosed();
    expect(JSON.stringify(editor.document)).not.toContain("#00ff00");
  });

  it("DH7：面板的 Back → 回到把手選單的項目列表，焦點在「Colors」", async () => {
    const editor = mount([P("x", "x"), P("target", "t1")]);
    await hover(editor, "target", "t1");
    await openPanel("text");
    fireEvent.click(button("Back"));
    await waitFor(() => expect(document.activeElement).toBe(colorsItem()));
    expect(panel()).toBeNull();
    expect(screen.getByText("Delete")).toBeInTheDocument();
    expect(handle()).toHaveAttribute("aria-expanded", "true");
  });

  it("DH8：block 底色是 #ff6600 → 子選單的底色段「Custom…」打勾、default 不打勾；開面板時色碼框是 #ff6600", async () => {
    const editor = mount([P("x", "x"), { ...P("target", "t1"), props: { backgroundColor: "#ff6600" } } as PartialBlockLike]);
    expect(editor.getBlock("t1")!.props.backgroundColor).toBe("#ff6600");
    await hover(editor, "target", "t1");
    await openHandleMenu();
    await openColorsSub();
    // Menu.Item 打勾時右側是勾號 svg，沒打勾時是 `.bn-tick-space` 佔位
    const isChecked = (el: Element) => el.querySelector(".bn-tick-space") === null && el.querySelector("svg") !== null;
    expect(isChecked(item("background-color-custom")!)).toBe(true);
    expect(isChecked(item("background-color-default")!)).toBe(false);
    fireEvent.click(item("background-color-custom")!, { detail: 0 });
    await waitFor(() => expect(panel()).not.toBeNull());
    expect(hexInput().value).toBe("#ff6600");
  });

  it("DH9：面板開著時按 Escape 關掉把手選單，再開一次 → 回到項目列表，不是面板", async () => {
    const editor = mount([P("x", "x"), P("target", "t1")]);
    await hover(editor, "target", "t1");
    await openPanel("text");
    fireEvent.keyDown(hexInput(), { key: "Escape" });
    await expectMenuClosed();
    await act(() => new Promise<void>((r) => setTimeout(r, 400)));
    await hover(editor, "target", "t1");
    await openHandleMenu();
    expect(panel()).toBeNull();
    expect(colorsItem()).not.toBeNull();
  });
});
