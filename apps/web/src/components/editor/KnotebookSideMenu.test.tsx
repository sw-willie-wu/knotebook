import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
import { KnowledgeControllerContext, type KnowledgeController } from "@/components/knowledge/controller";
import { KnotebookSideMenu, NotePathContext } from "./KnotebookSideMenu";
import { HeadingAnchorButtons } from "./HeadingAnchorButtons";

// The drag handle menu = four default items + "copy block link". jsdom has no elementsFromPoint: install one that returns the paragraph, then fire a real
// mousemove on the editor so BlockNote's SideMenuView computes the state itself. Not `store.setState` directly: SideMenuView's internal state would stay
// undefined and clicking the handle makes `freezeMenu()` throw `Cannot set properties of undefined (setting 'show')` (vitest records an unhandled error and exits 1).

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

  it("lists the four default items plus copy block link; clicking copies origin + notePath + #b-<block id>", async () => {
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
    const handle = await screen.findByLabelText("Open block menu"); // BlockNote 0.52.1 English dictionary side_menu.drag_handle_label
    fireEvent.click(handle);
    expect(await screen.findByText("Delete")).toBeInTheDocument();
    expect(screen.getByText("Colors")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Copy link to block"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/n/h/note#b-blk1`));
  });

  it("non-ASCII slug: the handle menu (unencoded canonical path) and the heading # (encoded location.pathname) copy the same string", async () => {
    // A real browser's location.pathname returns the percent-encoded form for a CJK slug; canonicalNotePath returns the raw characters.
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

describe("side menu \"Delete\" does not collapse columns", () => {
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

  /** Opens the drag handle menu on the block whose text is `text` and clicks "Delete". */
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

  it("deleting the only block in a column: the row and both columns remain, an empty paragraph fills the column", async () => {
    const editor = mount(R2());
    await deleteVia(editor, "b", "b1");
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph)]  paragraph:z");
  });

  it("selecting across two columns then deleting a: the whole selection (a and b) is deleted, the row still has two columns", async () => {
    const editor = mount(R2());
    act(() => editor.setSelection("a1", "b1"));
    // Fact pinned: the second item of a cross-column selection's blocks is the column node itself.
    expect(editor.getSelection()!.blocks.map((b) => b.type)).toEqual(["paragraph", "column"]);
    await deleteVia(editor, "a", "a1");
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(paragraph) | COL(paragraph)]  paragraph:z");
  });

  // A cross-column selection deletes only the selected range; a block in the second or later column, or inside the row, also counts as a multi-selection.
  const C1 = () => [P("x", "x"), row([[P("a", "a1")], [P("b", "b1"), P("q", "q1")]], "r"), P("z", "z")];

  it("same selection, deleting b: the expanded set contains b, so a and b are deleted", async () => {
    const editor = mount(R2());
    act(() => editor.setSelection("a1", "b1"));
    await deleteVia(editor, "b", "b1");
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(paragraph) | COL(paragraph)]  paragraph:z");
  });

  it("[a | b,q] select a->b then delete a: the unselected q is kept", async () => {
    const editor = mount(C1());
    act(() => editor.setSelection("a1", "b1"));
    await deleteVia(editor, "a", "a1");
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(paragraph) | COL(paragraph:q)]  paragraph:z");
  });

  it("[a | b | c] select a->b then delete a: all three columns remain, the first two are filled with empty paragraphs", async () => {
    const editor = mount([P("x", "x"), row([[P("a", "a1")], [P("b", "b1")], [P("c", "c1")]], "r"), P("z", "z")]);
    act(() => editor.setSelection("a1", "b1"));
    await deleteVia(editor, "a", "a1");
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(paragraph) | COL(paragraph) | COL(paragraph:c)]  paragraph:z");
  });

  it("selecting from above the row to the second column (x->b) then deleting x: x, a, b are deleted, q is kept", async () => {
    const editor = mount(C1());
    act(() => editor.setSelection("x", "b1"));
    await deleteVia(editor, "x", "x");
    expect(shape(editor)).toBe("ROW[COL(paragraph) | COL(paragraph:q)]  paragraph:z");
  });

  it("the same x->b selection, deleting a: same result as deleting x", async () => {
    const editor = mount(C1());
    act(() => editor.setSelection("x", "b1"));
    await deleteVia(editor, "a", "a1");
    expect(shape(editor)).toBe("ROW[COL(paragraph) | COL(paragraph:q)]  paragraph:z");
  });

  it("[a | b,q] select a->b then delete b: same result as deleting a", async () => {
    const editor = mount(C1());
    act(() => editor.setSelection("a1", "b1"));
    await deleteVia(editor, "b", "b1");
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(paragraph) | COL(paragraph:q)]  paragraph:z");
  });

  it("selecting from above the row to below it (x->z) then deleting a inside the row: the whole row plus x and z are deleted", async () => {
    const editor = mount(R2());
    act(() => editor.setSelection("x", "z"));
    await deleteVia(editor, "a", "a1");
    expect(shape(editor)).toBe("paragraph");
  });

  it("a plain note (no columns), select a->b then delete a: deletes the whole selection, same as core", async () => {
    const editor = mount([P("a", "a1"), P("b", "b1"), P("c", "c1")]);
    act(() => editor.setSelection("a1", "b1"));
    await deleteVia(editor, "a", "a1");
    expect(shape(editor)).toBe("paragraph:c");
  });
});

describe("handle menu \"Ungroup columns\"", () => {
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

  /** Opens the handle menu on the block whose text is `text` and waits for the menu (keyed on "Delete"). */
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

  it("the handle of a block inside a column has \"Ungroup columns\"; clicking flattens the row into x a b z", async () => {
    const editor = mount(R2());
    await openMenu(editor, "b", "b1");
    fireEvent.click(screen.getByText("Ungroup columns"));
    expect(shape(editor)).toBe("paragraph:x  paragraph:a  paragraph:b  paragraph:z");
    expect(i18n.t("note.columns.ungroup", { lng: "zh-TW" })).toBe("取消並排");
  });

  it("the handle of a top-level block has no \"Ungroup columns\"", async () => {
    const editor = mount(R2());
    await openMenu(editor, "x", "x");
    expect(screen.queryByText("Ungroup columns")).toBeNull();
  });
});

describe("the side menu inside a column keeps only the handle", () => {
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

  /** Points SideMenuView at the block whose text is `text` and waits for the handle to appear. */
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

  it("a direct child block of a column: only the handle, no Add block", async () => {
    const editor = mount(NESTED());
    await hover(editor, "b", "b1");
    expect(screen.queryByLabelText("Add block")).toBeNull();
  });

  it("a nested child block inside a column: likewise only the handle", async () => {
    const editor = mount(NESTED());
    expect(editor.getParentBlock("n1")?.id).toBe("a1");
    await hover(editor, "n", "n1");
    expect(screen.queryByLabelText("Add block")).toBeNull();
  });

  it("a block outside columns: Add block and the handle are both present; moving into a column removes Add block", async () => {
    const editor = mount(NESTED());
    await hover(editor, "x", "x");
    expect(screen.getByLabelText("Add block")).toBeInTheDocument();
    await hover(editor, "b", "b1");
    expect(screen.queryByLabelText("Add block")).toBeNull();
  });

  it("the handle menu items inside a column are unchanged (delete, ungroup columns, colors, copy block link)", async () => {
    const editor = mount(NESTED());
    await hover(editor, "b", "b1");
    fireEvent.click(screen.getByLabelText("Open block menu"));
    expect(await screen.findByText("Delete")).toBeInTheDocument();
    expect(screen.getByText("Ungroup columns")).toBeInTheDocument();
    expect(screen.getByText("Colors")).toBeInTheDocument();
    expect(screen.getByText("Copy link to block")).toBeInTheDocument();
  });
});

describe("handle color submenu and custom color panel", () => {
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

  /** Points SideMenuView at the block whose text is `text` and waits for the handle to appear. */
  async function hover(editor: AnyEditor, text: string, id: string): Promise<void> {
    const el = screen.getByText(text);
    Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: () => [el] });
    // The table column-resize plugin calls posAtCoords on mousemove, which needs elementFromPoint that jsdom lacks
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => el });
    act(() => {
      fireEvent.mouseMove(el, { clientX: 0, clientY: 0 });
    });
    expect(editor.getExtension(SideMenuExtension)!.store.state?.block?.id).toBe(id);
    await screen.findByLabelText("Open block menu");
  }

  /** Clicks the handle to open the menu, waits for it to mount, and lets the initial focus timer Mantine schedules when opening the menu run out. */
  async function openHandleMenu(): Promise<void> {
    fireEvent.click(handle());
    expect(await screen.findByText("Delete")).toBeInTheDocument();
    await act(() => new Promise<void>((r) => setTimeout(r, 0)));
  }

  /** Opens the submenu from "Colors" with the keyboard (right arrow) and waits for the text section's or background section's "Custom..." to appear. */
  async function openColorsSub(): Promise<void> {
    const colors = colorsItem()!;
    colors.focus();
    fireEvent.keyDown(colors, { key: "ArrowRight" });
    await waitFor(() => expect(item("text-color-custom") ?? item("background-color-custom")).not.toBeNull());
  }

  /** Opens handle -> Colors -> that section's "Custom..." (`detail` 0 = keyboard activation) and waits for the panel to mount. */
  async function openPanel(section: "text" | "background"): Promise<void> {
    await openHandleMenu();
    await openColorsSub();
    fireEvent.click(item(`${section}-color-custom`)!, { detail: 0 });
    await waitFor(() => expect(panel()).not.toBeNull());
  }

  /** The handle menu is closed: dropdown absent; if the handle is still there, aria-expanded is false (after applying a color changes the document, the side menu may collapse entirely). */
  async function expectMenuClosed(): Promise<void> {
    await waitFor(() => {
      expect(handleMenu()).toBeNull();
      expect(screen.queryByLabelText("Open block menu")?.getAttribute("aria-expanded") ?? "false").toBe("false");
    });
  }

  /** Waits for the lazily loaded react-colorful to mount. */
  async function sliders(): Promise<void> {
    await waitFor(() => expect(screen.getAllByRole("slider", { hidden: true })).toHaveLength(2));
  }

  const TABLE = (id: string): PartialBlockLike =>
    ({ id, type: "table", content: { type: "tableContent", rows: [{ cells: ["cell a", "cell b"] }] } }) as PartialBlockLike;

  it("paragraph handle -> Colors -> the submenu has Text and Background sections with two \"Custom...\" items; other items are unchanged", async () => {
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

  it("the submenu's built-in color red (background) applies to the block and closes the menu", async () => {
    const editor = mount([P("x", "x"), P("target", "t1")]);
    await hover(editor, "target", "t1");
    await openHandleMenu();
    await openColorsSub();
    fireEvent.click(item("background-color-red")!);
    expect(editor.getBlock("t1")!.props.backgroundColor).toBe("red");
    await expectMenuClosed();
  });

  it("table handle -> Colors -> only the Text section, no background-color-* items", async () => {
    const editor = mount([P("x", "x"), TABLE("tb")]);
    // Precondition: a table block has textColor but no backgroundColor
    expect(Object.keys(editor.getBlock("tb")!.props)).toContain("textColor");
    expect(Object.keys(editor.getBlock("tb")!.props)).not.toContain("backgroundColor");
    await hover(editor, "cell a", "tb");
    await openHandleMenu();
    await openColorsSub();
    expect(document.querySelectorAll('[data-test^="text-color-"]')).toHaveLength(11);
    expect(document.querySelectorAll('[data-test^="background-color-"]')).toHaveLength(0);
    expect(screen.queryByText("Background")).toBeNull();
  });

  it("a block without color props (codeBlock): the handle menu has no Colors", async () => {
    const editor = mount([P("x", "x"), { id: "cb", type: "codeBlock", content: "let code" } as PartialBlockLike]);
    // Precondition: codeBlock has neither textColor nor backgroundColor
    expect(Object.keys(editor.getBlock("cb")!.props)).not.toContain("textColor");
    expect(Object.keys(editor.getBlock("cb")!.props)).not.toContain("backgroundColor");
    await hover(editor, "let code", "cb");
    await openHandleMenu();
    expect(colorsItem()).toBeNull();
    expect(screen.queryByText("Colors")).toBeNull();
  });

  it("Custom...: the handle menu stays open and its content becomes the panel; entering #00ff00 and pressing Apply writes the block background and closes the menu", async () => {
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

  it("with no recent colors, Tab on the panel's last Apply wraps to Back and the handle menu stays open", async () => {
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

  it("block deleted while the panel is open: no exception, #00ff00 is not written into the document, the menu closes", async () => {
    const editor = mount([P("x", "x"), P("target", "t1")]);
    await hover(editor, "target", "t1");
    await openPanel("background");
    fireEvent.change(hexInput(), { target: { value: "#00ff00" } });
    act(() => editor.removeBlocks(["t1"]));
    expect(editor.getBlock("t1")).toBeUndefined();
    await act(() => new Promise<void>((r) => setTimeout(r, 50)));
    // While the menu is open the side menu is frozen: after the block is deleted, the handle and the panel are still there
    expect(panel()).not.toBeNull();
    expect(handle()).toHaveAttribute("aria-expanded", "true");
    expect(() => fireEvent.click(button("Apply"))).not.toThrow();
    await expectMenuClosed();
    expect(JSON.stringify(editor.document)).not.toContain("#00ff00");
  });

  it("the panel's Back returns to the handle menu's item list with focus on \"Colors\"", async () => {
    const editor = mount([P("x", "x"), P("target", "t1")]);
    await hover(editor, "target", "t1");
    await openPanel("text");
    fireEvent.click(button("Back"));
    await waitFor(() => expect(document.activeElement).toBe(colorsItem()));
    expect(panel()).toBeNull();
    expect(screen.getByText("Delete")).toBeInTheDocument();
    expect(handle()).toHaveAttribute("aria-expanded", "true");
  });

  it("block background is #ff6600: the submenu's background-section \"Custom...\" is checked and default is not; opening the panel shows #ff6600 in the hex field", async () => {
    const editor = mount([P("x", "x"), { ...P("target", "t1"), props: { backgroundColor: "#ff6600" } } as PartialBlockLike]);
    expect(editor.getBlock("t1")!.props.backgroundColor).toBe("#ff6600");
    await hover(editor, "target", "t1");
    await openHandleMenu();
    await openColorsSub();
    // A checked Menu.Item has a tick svg on the right; an unchecked one has a `.bn-tick-space` placeholder
    const isChecked = (el: Element) => el.querySelector(".bn-tick-space") === null && el.querySelector("svg") !== null;
    expect(isChecked(item("background-color-custom")!)).toBe(true);
    expect(isChecked(item("background-color-default")!)).toBe(false);
    fireEvent.click(item("background-color-custom")!, { detail: 0 });
    await waitFor(() => expect(panel()).not.toBeNull());
    expect(hexInput().value).toBe("#ff6600");
  });

  it("Escape while the panel is open closes the handle menu; reopening shows the item list, not the panel", async () => {
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

describe("drag handle menu: knowledge info", () => {
  const open = vi.fn();
  const controller: KnowledgeController = { state: null, open, close: vi.fn() };
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    open.mockClear();
  });
  afterEach(() => {
    Reflect.deleteProperty(document, "elementsFromPoint");
  });

  function mount(content: PartialBlockLike[], provided: KnowledgeController | null = controller): AnyEditor {
    const editor = BlockNoteEditor.create({ schema: noteSchema, initialContent: content as never }) as AnyEditor;
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <KnowledgeControllerContext.Provider value={provided}>
            <BlockNoteView editor={editor} editable sideMenu={false}>
              <SideMenuController sideMenu={KnotebookSideMenu} />
            </BlockNoteView>
          </KnowledgeControllerContext.Provider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return editor;
  }

  async function openMenu(editor: AnyEditor, text: string, id: string): Promise<void> {
    const el = screen.getByText(text);
    Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: () => [el] });
    act(() => {
      fireEvent.mouseMove(el, { clientX: 0, clientY: 0 });
    });
    expect(editor.getExtension(SideMenuExtension)!.store.state?.block?.id).toBe(id);
    fireEvent.click(await screen.findByLabelText("Open block menu"));
    await screen.findByText("Delete");
  }

  const heading = (id: string, text: string, props: Record<string, unknown> = {}) => ({ id, type: "heading", props: { level: 1, ...props }, content: text }) as PartialBlockLike;

  it("the menu of a top-level heading starts with Knowledge info… and a separator, and it opens the edit surface", async () => {
    const editor = mount([heading("hd1", "Section"), { id: "p1", type: "paragraph", content: "x" } as PartialBlockLike]);
    await openMenu(editor, "Section", "hd1");
    const first = document.querySelector<HTMLElement>('.bn-menu-dropdown [role="menuitem"]')!;
    expect(first.textContent).toBe("Knowledge info…");
    expect(first.nextElementSibling?.classList.contains("mantine-Menu-divider")).toBe(true);
    fireEvent.click(screen.getByText("Knowledge info…"));
    expect(open).toHaveBeenCalledWith("hd1", "edit", expect.anything());
  });

  it("on a heading that is already knowledge the item reads Edit knowledge info…", async () => {
    const editor = mount([heading("hd1", "Section", { knowledgeId: "k_00000001", knowledgeWhen: "alice" })]);
    await openMenu(editor, "Section", "hd1");
    expect(screen.getByText("Edit knowledge info…")).toBeInTheDocument();
    expect(screen.queryByText("Knowledge info…")).toBeNull();
  });

  it("the menu of a paragraph, of a heading in a column, or without a controller has no Knowledge info item", async () => {
    const editor = mount([{ id: "p1", type: "paragraph", content: "plain" } as PartialBlockLike]);
    await openMenu(editor, "plain", "p1");
    expect(screen.queryByText(/Knowledge info/)).toBeNull();
    cleanup();
    const inColumn = mount([row([[heading("c1", "Inner")], [{ id: "p2", type: "paragraph", content: "x" } as PartialBlockLike]], "r")]);
    await openMenu(inColumn, "Inner", "c1");
    expect(screen.queryByText(/Knowledge info/)).toBeNull();
    cleanup();
    const bare = mount([heading("hd1", "Section")], null);
    await openMenu(bare, "Section", "hd1");
    expect(screen.queryByText(/Knowledge info/)).toBeNull();
  });
});
