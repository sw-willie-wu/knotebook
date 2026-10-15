import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BlockNoteEditor } from "@blocknote/core";
import { BlockNoteView } from "@blocknote/mantine";
import { noteSchema } from "@/collab/schema";
import { LinkLongPress } from "./LinkLongPress";

// spec 2026-10-13 site-links rev 7 §7.4：外部連結（一般 link mark）的觸控長按 ⇒ BlockNote 原生連結工具列。
// 真編輯器＋BlockNoteView（預設帶 LinkToolbarController）；長按把游標放進連結，讓 BlockNote 既有的「游標在連結內」路徑開工具列。

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組，走 repo 慣例
type AnyEditor = BlockNoteEditor<any, any, any>;

const TOUCH = { pointerType: "touch", clientX: 10, clientY: 10 } as const;
const settle = (ms = 0) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
const linkToolbar = () => document.querySelector(".bn-link-toolbar");

type LinkContent = string | Array<{ type: "text"; text: string; styles: Record<string, boolean> }>;

async function mount(editable = true, linkContent: LinkContent = "Example") {
  const editor = BlockNoteEditor.create({ schema: noteSchema }) as AnyEditor;
  render(
    <BlockNoteView editor={editor} editable={editable}>
      <LinkLongPress />
    </BlockNoteView>,
  );
  await act(async () => {
    editor.replaceBlocks(editor.document, [
      { type: "paragraph", content: ["see ", { type: "link", href: "https://example.com/", content: linkContent }, " end"] },
    ]);
  });
  // `useEditorDOMElement`（BlockNote 的 LinkToolbarController 也用它）在掛載後下一拍才拿到編輯器根節點，監聽才掛上。
  await settle(10);
  const link = document.querySelector<HTMLAnchorElement>('a[data-inline-content-type="link"]')!;
  expect(link).not.toBeNull();
  return { editor, link };
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("外部連結觸控長按（rev 7）", () => {
  it("長按約 500 ms：游標放進連結、BlockNote 原生連結工具列出現；之前不出現", async () => {
    const { editor, link } = await mount();
    fireEvent.pointerDown(link, TOUCH);
    await settle(300);
    expect(linkToolbar()).toBeNull();
    await settle(300);
    fireEvent.pointerUp(link, TOUCH);
    const sel = editor._tiptapEditor.state.selection;
    expect(sel.empty).toBe(true);
    expect(editor.getSelectedLinkUrl()).toBe("https://example.com/");
    await screen.findByRole("button", { name: "Open in new tab" });
    expect(linkToolbar()).not.toBeNull();
  });

  it("樣式把連結切成多個 <a>：長按只有一個字的那段也找得到整條連結；整條只有一個字則不開（已知限制）", async () => {
    const { editor } = await mount(true, [
      { type: "text", text: "Exampl", styles: {} },
      { type: "text", text: "e", styles: { bold: true } },
    ]);
    const segments = [...document.querySelectorAll<HTMLAnchorElement>('a[data-inline-content-type="link"]')];
    expect(segments.map((a) => a.textContent)).toEqual(["Exampl", "e"]);
    // 尾段只有一個字：「起點後一格」正好是整條連結的終點（不 inclusive，找不到連結）
    fireEvent.pointerDown(segments[1]!, TOUCH);
    await settle(600);
    fireEvent.pointerUp(segments[1]!, TOUCH);
    expect(editor.getSelectedLinkUrl()).toBe("https://example.com/");
    await screen.findByRole("button", { name: "Open in new tab" });

    cleanup();
    const one = await mount(true, "X");
    const before = one.editor._tiptapEditor.state.selection.toJSON();
    fireEvent.pointerDown(one.link, TOUCH);
    await settle(600);
    expect(one.editor._tiptapEditor.state.selection.toJSON()).toEqual(before);
    expect(linkToolbar()).toBeNull();
  });

  it("長按計時中編輯器變唯讀（降級、過期分頁）：成立時不動選取", async () => {
    const { editor, link } = await mount();
    const before = editor._tiptapEditor.state.selection.toJSON();
    fireEvent.pointerDown(link, TOUCH);
    await settle(200);
    editor.isEditable = false;
    await settle(400);
    expect(editor._tiptapEditor.state.selection.toJSON()).toEqual(before);
  });

  it("長按成立後補發的 mousedown／mouseup／click 被攔（到不了編輯器的處理器、preventDefault）；下一次短按照常放行", async () => {
    const { editor, link } = await mount();
    const seen: string[] = [];
    const root = editor._tiptapEditor.view.dom;
    for (const type of ["mousedown", "mouseup", "click"]) root.addEventListener(type, () => seen.push(type));
    fireEvent.pointerDown(link, TOUCH);
    await settle(600);
    fireEvent.pointerUp(link, TOUCH);
    expect(fireEvent.mouseDown(link)).toBe(false);
    expect(fireEvent.mouseUp(link)).toBe(false);
    expect(fireEvent.click(link)).toBe(false);
    expect(seen).toEqual([]);

    fireEvent.pointerDown(link, TOUCH);
    fireEvent.pointerUp(link, TOUCH);
    fireEvent.mouseUp(link);
    fireEvent.click(link);
    expect(seen).toEqual(["mouseup", "click"]);
  });

  it("長按成立但沒有補發 click（iOS／Android 常見）：下一次點在連結以外的地方照常放行", async () => {
    const { editor, link } = await mount();
    const seen: string[] = [];
    const root = editor._tiptapEditor.view.dom;
    for (const type of ["mouseup", "click"]) root.addEventListener(type, () => seen.push(type));
    fireEvent.pointerDown(link, TOUCH);
    await settle(600);
    fireEvent.pointerUp(link, TOUCH);
    const plain = link.previousSibling?.parentElement ?? root;
    fireEvent.pointerDown(plain, { pointerType: "mouse" });
    fireEvent.mouseUp(plain);
    fireEvent.click(plain);
    expect(seen).toEqual(["mouseup", "click"]);
  });

  it("短按：不開工具列、不動選取", async () => {
    const { editor, link } = await mount();
    const before = editor._tiptapEditor.state.selection.toJSON();
    fireEvent.pointerDown(link, TOUCH);
    await settle(100);
    fireEvent.pointerUp(link, TOUCH);
    await settle(600);
    expect(editor._tiptapEditor.state.selection.toJSON()).toEqual(before);
    expect(linkToolbar()).toBeNull();
  });

  it("長按中手指移動超過閾值：取消", async () => {
    const { link } = await mount();
    fireEvent.pointerDown(link, TOUCH);
    fireEvent.pointerMove(link, { ...TOUCH, clientY: 40 });
    await settle(600);
    expect(linkToolbar()).toBeNull();
  });

  it("可編輯：觸控按壓中的 contextmenu 被 preventDefault（並立刻開工具列）；滑鼠右鍵的 contextmenu 不攔", async () => {
    const rendered = await mount();
    const { link } = rendered;
    fireEvent.pointerDown(link, { pointerType: "mouse", button: 2 });
    expect(fireEvent.contextMenu(link)).toBe(true);
    fireEvent.pointerUp(link, { pointerType: "mouse", button: 2 });

    const { editor } = rendered;
    fireEvent.pointerDown(link, TOUCH);
    expect(fireEvent.contextMenu(link)).toBe(false);
    expect(editor.getSelectedLinkUrl()).toBe("https://example.com/"); // 立刻成立，不等 500 ms 計時
    await screen.findByRole("button", { name: "Open in new tab" });
  });

  it("唯讀：觸控長按不攔 contextmenu、不攔後續 click（保留系統行為）", async () => {
    const { link } = await mount(false);
    fireEvent.pointerDown(link, TOUCH);
    expect(fireEvent.contextMenu(link)).toBe(true);
    await settle(600);
    fireEvent.pointerUp(link, TOUCH);
    expect(fireEvent.click(link)).toBe(true);
  });

  it("index.css：只在可編輯的編輯器裡關掉 iOS 長按連結選單（-webkit-touch-callout），唯讀不關", () => {
    const css = readFileSync(`${process.cwd()}/src/index.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rules = [...css.matchAll(/([^{}]*)\{([^}]*-webkit-touch-callout[^}]*)\}/g)];
    expect(rules).toHaveLength(1);
    const selectors = rules[0]![1]!.split(",").map((s) => s.trim());
    expect(selectors).toEqual(['.bn-editor[contenteditable="true"] a']);
    expect(rules[0]![2]).toMatch(/-webkit-touch-callout:\s*none/);
  });

  it("上一條選擇器的前提：可編輯時編輯器根節點就是 `.bn-editor[contenteditable=true]`，唯讀時不是", async () => {
    const { editor } = await mount();
    expect(editor._tiptapEditor.view.dom.matches('.bn-editor[contenteditable="true"]')).toBe(true);
    cleanup();
    const ro = await mount(false);
    expect(ro.editor._tiptapEditor.view.dom.matches('.bn-editor[contenteditable="true"]')).toBe(false);
  });
});
