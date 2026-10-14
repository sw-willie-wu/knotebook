import { afterEach, describe, expect, it } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";
import { noteSchema } from "./schema";

// spec 2026-10-13 site-links §8.3【推】→【驗】：BlockNote 的 paste 同步走 `view.pasteHTML/pasteText`；tiptap Link 的 `handlePaste`
// （選取上貼網址）與 paste rule 都在同一次 dispatch 內完成 ⇒ 呼叫返回時文件已是最終形。Task 12 的貼上轉換以此為前提。
// 量到哪一形不同步：照實改期望值並回報——Task 12 要在那一形另補偵測。

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組，走 repo 慣例
type AnyEditor = BlockNoteEditor<any, any, any>;

const ORIGIN = window.location.origin;
const HREF = `${ORIGIN}/n/alice/target`;

function mounted(content: unknown[] = [{ type: "paragraph", content: "hello world" }]): { editor: AnyEditor; container: HTMLElement } {
  const editor = BlockNoteEditor.create({ schema: noteSchema, initialContent: content as never }) as AnyEditor;
  const container = document.createElement("div");
  document.body.appendChild(container);
  editor.mount(container);
  return { editor, container };
}

function links(editor: AnyEditor): Array<{ href: string; text: string }> {
  const out: Array<{ href: string; text: string }> = [];
  for (const block of editor.document as Array<{ content?: unknown }>) {
    if (!Array.isArray(block.content)) continue;
    for (const node of block.content as Array<{ type: string; href?: string; content?: Array<{ text: string }> }>) {
      if (node.type === "link") out.push({ href: String(node.href), text: (node.content ?? []).map((c) => c.text).join("") });
    }
  }
  return out;
}

describe("#269 事實：貼上在呼叫返回時就已是最終形", () => {
  let editor: AnyEditor;
  let container: HTMLElement;
  afterEach(() => {
    editor.unmount();
    container.remove();
  });

  it("① HTML <a>（pasteHTML）", () => {
    ({ editor, container } = mounted());
    editor.setTextCursorPosition(editor.document[0]!.id, "end");
    editor.pasteHTML(`<a href="${HREF}">x</a>`);
    expect(links(editor)).toEqual([{ href: HREF, text: "x" }]);
  });

  it("② markdown [x](url)（pasteMarkdown；0.52.1 型別回 void，同步呼叫、不 await）", () => {
    ({ editor, container } = mounted());
    editor.setTextCursorPosition(editor.document[0]!.id, "end");
    editor.pasteMarkdown(`[x](${HREF})`);
    expect(links(editor)).toEqual([{ href: HREF, text: "x" }]);
  });

  it("③ 空選取貼同 origin 絕對網址（pasteText；autolink 的 paste rule）", () => {
    ({ editor, container } = mounted());
    editor.setTextCursorPosition(editor.document[0]!.id, "end");
    editor.pasteText(` ${HREF} `);
    expect(links(editor)).toEqual([{ href: HREF, text: HREF }]);
  });

  it("④ 選取文字上貼網址（tiptap Link 的 handlePaste）", () => {
    ({ editor, container } = mounted());
    const view = editor._tiptapEditor.view;
    // 選「world」：段落內容從 1 開始（blockGroup／blockContainer／paragraph 的開 token 之後），以文字搜尋算位置。
    let from = -1;
    view.state.doc.descendants((node: { isText: boolean; text?: string }, pos: number) => {
      if (from === -1 && node.isText && String(node.text).includes("world")) from = pos + String(node.text).indexOf("world");
      return from === -1;
    });
    editor._tiptapEditor.commands.setTextSelection({ from, to: from + 5 });
    editor.pasteText(HREF);
    expect(links(editor)).toEqual([{ href: HREF, text: "world" }]);
  });

  it("⑤ 站內複製貼上（blocksToHTMLLossy 的 <a>，經 pasteHTML）", () => {
    ({ editor, container } = mounted([{ type: "paragraph", content: [{ type: "link", href: HREF, content: "y" }] }, { type: "paragraph", content: "" }]));
    const html = editor.blocksToHTMLLossy([editor.document[0]!]);
    editor.setTextCursorPosition(editor.document[1]!.id, "end");
    editor.pasteHTML(html);
    expect(links(editor).filter((l) => l.text === "y")).toHaveLength(2);
  });
});
