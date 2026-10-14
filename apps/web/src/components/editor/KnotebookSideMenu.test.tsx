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
