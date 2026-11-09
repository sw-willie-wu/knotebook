/**
 * 筆記大小上限的前端檢查，用**真的** BlockNote＋y-prosemirror（`buildNoteEditorOptions` 建的編輯器，帶 UndoManager）與真的檢查函式
 * （`createNoteSizeGuard`，不是替身）：貼上事件經 BlockNote 自己的貼上流程走到 `handlePaste`，估的是解析好的內容。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { createNoteSizeGuard, estimateBlocksBytes, estimatePmBytes, noteStateBytes } from "@/lib/note-size-guard";
import { useNoteOverLimit } from "@/hooks/useNoteOverLimit";

vi.mock("@/components/ui/toast", () => ({ toast: vi.fn() }));
const { buildNoteEditorOptions } = await import("./NoteEditor");

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 測試用編輯器，走 repo 慣例的 BlockNoteEditor<any,any,any>
type AnyEditor = BlockNoteEditor<any, any, any>;

/** server 存的大小（新文件＋applyUpdate＋encode：本機 UndoManager 留住的墓碑會被回收）。 */
function serverSize(doc: Y.Doc): number {
  const c = new Y.Doc();
  Y.applyUpdate(c, Y.encodeStateAsUpdate(doc));
  return Y.encodeStateAsUpdate(c).byteLength;
}

const mounted: Array<{ editor: AnyEditor; el: HTMLElement }> = [];
afterEach(() => {
  for (const m of mounted.splice(0)) {
    m.editor.unmount();
    m.el.remove();
  }
  vi.useRealTimers();
});

function setup() {
  const doc = new Y.Doc();
  let limit: number | undefined;
  const notified: number[] = [];
  const guardCalls: number[] = [];
  const realGuard = createNoteSizeGuard(() => doc, () => limit, l => notified.push(l));
  const editorRef = { current: null as AnyEditor | null };
  const options = buildNoteEditorOptions({
    doc,
    provider: { awareness: null } as never,
    user: { id: "u", name: "U" },
    language: "en",
    translate: (k: string) => k,
    editorRef: editorRef as never,
    noteId: "n",
    siteLinks: { current: null },
    sizeGuard: g => {
      guardCalls.push(g);
      return realGuard(g);
    },
  });
  const editor = BlockNoteEditor.create(options) as AnyEditor;
  editorRef.current = editor;
  const el = document.createElement("div");
  document.body.appendChild(el);
  editor.mount(el);
  mounted.push({ editor, el });
  return {
    doc,
    editor,
    notified,
    guardCalls,
    setLimit: (l: number | undefined) => (limit = l),
    fill: (n: number, text = (i: number) => `paragraph ${i} with some ordinary text`) =>
      editor.replaceBlocks(editor.document, Array.from({ length: n }, (_, i) => ({ type: "paragraph", content: text(i) })) as never),
  };
}

function paste(editor: AnyEditor, data: Record<string, string>) {
  const ev = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(ev, "clipboardData", { value: { types: Object.keys(data), getData: (t: string) => data[t] ?? "", files: [], items: [] } });
  editor._tiptapEditor.view.dom.dispatchEvent(ev);
}

function drop(editor: AnyEditor, data: Record<string, string>, pos: number) {
  const view = editor._tiptapEditor.view as unknown as { posAtCoords: unknown; dom: HTMLElement };
  view.posAtCoords = () => ({ pos, inside: -1 }); // jsdom 沒有版面：落點直接給
  const ev = new Event("drop", { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(ev, "dataTransfer", { value: { types: Object.keys(data), getData: (t: string) => data[t] ?? "", files: [], items: [] } });
  Object.defineProperty(ev, "clientX", { value: 1 });
  Object.defineProperty(ev, "clientY", { value: 1 });
  view.dom.dispatchEvent(ev);
  return ev;
}

function placeCursorAtEnd(editor: AnyEditor) {
  const last = editor.document.at(-1)!;
  editor.setTextCursorPosition(last.id, "end");
}

const mdTable = (rows: number) => "| a | b | c | d | e |\n|---|---|---|---|---|\n" + Array.from({ length: rows }, (_, r) => `| ${r} | b | c | d | e |`).join("\n");
const mdList = (n: number) => Array.from({ length: n }, (_, i) => `- item ${i}`).join("\n");
const wordHtml = (n: number) =>
  '<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><style>' +
  "p.MsoNormal{margin:0cm;font-size:11.0pt;font-family:Calibri}".repeat(300) +
  "</style></head><body>" +
  Array.from({ length: n }, (_, i) => `<p class=MsoNormal style="margin:0cm;mso-pagination:none"><span lang=EN-US style="font-size:11.0pt;font-family:Calibri;mso-ascii-theme-font:minor-latin">Short line ${i}<o:p></o:p></span></p>`).join("") +
  "</body></html>";

describe("貼上的大小檢查（真的 BlockNote＋y-prosemirror）", () => {
  it("每一種貼上來源都在插入之前問到檢查（純文字、HTML、markdown、站內 blocknote/html、VS Code）；沒有空間 → 不插入、提示", async () => {
    const s = setup();
    s.fill(5);
    const src = setup();
    src.fill(20);
    const internal = await src.editor.blocksToFullHTML(src.editor.document);
    const sources: Array<[string, Record<string, string>]> = [
      ["純文字", { "text/plain": "just some plain text pasted here" }],
      ["HTML", { "text/html": "<p>some <strong>html</strong></p><p>second</p>", "text/plain": "x" }],
      ["markdown", { "text/plain": "# Title\n\n- a\n- b\n\n| a | b |\n|---|---|\n| 1 | 2 |" }],
      ["站內 blocknote/html", { "blocknote/html": internal, "text/html": internal, "text/plain": "x" }],
      ["VS Code", { "text/plain": "const a = 1;\nconst b = 2;", "vscode-editor-data": JSON.stringify({ version: 1, mode: "typescript" }) }],
    ];
    s.setLimit(serverSize(s.doc)); // 一點空間都沒有
    for (const [name, data] of sources) {
      placeCursorAtEnd(s.editor);
      const before = Y.encodeStateAsUpdate(s.doc);
      const calls = s.guardCalls.length;
      paste(s.editor, data);
      await Promise.resolve();
      expect(s.guardCalls.length, `${name}：問到檢查`).toBe(calls + 1);
      expect(s.guardCalls.at(-1)!, `${name}：估計的成長 > 0`).toBeGreaterThan(0);
      expect(Y.encodeStateAsUpdate(s.doc), `${name}：沒有插入`).toEqual(before);
    }
    expect(s.notified).toHaveLength(sources.length);
    // 有空間時同樣的貼上照常插入（檢查放行）
    s.setLimit(undefined);
    placeCursorAtEnd(s.editor);
    paste(s.editor, sources[0]![1]);
    expect(JSON.stringify(s.editor.document)).toContain("just some plain text pasted here");
  });

  it("接近上限：markdown 表格（文字只有幾 KB，存下來是它的幾十倍）→ 擋；空間夠才放", () => {
    const s = setup();
    s.fill(10);
    const md = mdTable(300);
    s.setLimit(serverSize(s.doc) + 30_000); // 剩 30 KB：比表格的文字（約 8 KB）多，但遠比存下來的（約 300 KB）少
    expect(new TextEncoder().encode(md).byteLength).toBeLessThan(30_000);
    placeCursorAtEnd(s.editor);
    const before = Y.encodeStateAsUpdate(s.doc);
    paste(s.editor, { "text/plain": md });
    expect(Y.encodeStateAsUpdate(s.doc)).toEqual(before);
    expect(s.notified).toHaveLength(1);
    s.setLimit(serverSize(s.doc) + 600_000);
    paste(s.editor, { "text/plain": md });
    const grown = serverSize(s.doc) - before.byteLength;
    expect(grown).toBeGreaterThan(30_000); // 真的長了這麼多：剛才擋得對
  });

  it("接近上限：項目清單（800 項）→ 擋", () => {
    const s = setup();
    s.fill(10);
    const md = mdList(800);
    s.setLimit(serverSize(s.doc) + 60_000); // 文字約 8 KB；存下來約 175 KB
    placeCursorAtEnd(s.editor);
    const before = Y.encodeStateAsUpdate(s.doc);
    paste(s.editor, { "text/plain": md });
    expect(Y.encodeStateAsUpdate(s.doc)).toEqual(before);
    expect(s.notified).toHaveLength(1);
  });

  it("Word 那種剪貼簿 HTML 很肥、內容很少 → 放行（估的是解析後的內容，不是剪貼簿的位元組）", () => {
    const s = setup();
    s.fill(10);
    const html = wordHtml(20);
    const headroom = 10_000;
    expect(new TextEncoder().encode(html).byteLength).toBeGreaterThan(headroom); // 用剪貼簿位元組估會擋
    s.setLimit(serverSize(s.doc) + headroom);
    placeCursorAtEnd(s.editor);
    paste(s.editor, { "text/html": html, "text/plain": "Short line" });
    expect(s.notified).toEqual([]);
    expect(JSON.stringify(s.editor.document)).toContain("Short line 19");
  });

  it("接近上限時剪下再貼上（搬移）→ 放行：本機刪掉的內容（UndoManager 留著的墓碑）不算", async () => {
    const s = setup();
    s.fill(200);
    const moved = s.editor.document.slice(50, 100);
    const html = await s.editor.blocksToFullHTML(moved);
    s.setLimit(serverSize(s.doc) + 2_000); // 只剩 2 KB；搬的那段約 12 KB
    s.editor.removeBlocks(moved.map(b => b.id)); // 剪下
    expect(Y.encodeStateAsUpdate(s.doc).byteLength, "UndoManager 留住刪掉的內容：原始大小沒變小").toBeGreaterThan(serverSize(s.doc) + 5_000);
    placeCursorAtEnd(s.editor);
    paste(s.editor, { "blocknote/html": html, "text/html": html, "text/plain": "x" });
    expect(s.notified).toEqual([]);
    const text = JSON.stringify(s.editor.document);
    expect(text).toContain("paragraph 50 with");
    expect(text).toContain("paragraph 99 with");
  });

  it("取代選取範圍、換成較短的字 → 放行（扣掉被取代的部分；筆記已超過上限也一樣）", () => {
    const s = setup();
    s.fill(30, i => (i === 5 ? "x".repeat(3_000) : `paragraph ${i}`));
    s.setLimit(serverSize(s.doc) - 1_000); // 已經超過上限
    const target = s.editor.document[5]!;
    void target;
    const view = s.editor._tiptapEditor.view;
    // 選取那一段的文字
    let from = -1;
    let to = -1;
    view.state.doc.descendants((node, pos) => {
      if (node.isText && node.text!.startsWith("xxx")) {
        from = pos;
        to = pos + node.text!.length;
        return false;
      }
      return true;
    });
    s.editor._tiptapEditor.commands.setTextSelection({ from, to });
    expect(estimatePmBytes(view.state.selection.content())).toBeGreaterThan(3_000);
    paste(s.editor, { "text/plain": "short" });
    expect(s.guardCalls.at(-1)!).toBeLessThan(0);
    expect(s.notified).toEqual([]);
    expect(JSON.stringify(s.editor.document)).not.toContain("xxxxxxxx");
    expect(JSON.stringify(s.editor.document)).toContain("short");
  });
});

describe("拖放與帶屬性的內容（真的 BlockNote＋y-prosemirror）", () => {
  it("從外面拖進來（HTML、純文字）：插入之前問到檢查；沒有空間 → 不插入、提示；有空間 → 照常插入", () => {
    const s = setup();
    s.fill(20);
    const end = s.editor._tiptapEditor.view.state.doc.content.size - 3;
    s.setLimit(serverSize(s.doc));
    const before = Y.encodeStateAsUpdate(s.doc);
    const ev = drop(s.editor, { "text/html": "<p>dropped html</p><p>two</p>", "text/plain": "dropped html" }, end);
    expect(s.guardCalls).toHaveLength(1);
    expect(ev.defaultPrevented).toBe(true);
    expect(Y.encodeStateAsUpdate(s.doc)).toEqual(before);
    drop(s.editor, { "text/plain": "dropped plain text" }, end);
    expect(s.guardCalls).toHaveLength(2);
    expect(Y.encodeStateAsUpdate(s.doc)).toEqual(before);
    expect(s.notified).toHaveLength(2);
    s.setLimit(undefined);
    drop(s.editor, { "text/html": "<p>dropped html</p><p>two</p>", "text/plain": "dropped html" }, end);
    expect(JSON.stringify(s.editor.document)).toContain("dropped html");
  });

  it("帶大屬性的 block（mermaid 原始碼）：ProseMirror 內容的估計把屬性的位元組算進去，約等於實際成長（同站內 AI 的 blocks 估法）", () => {
    const s = setup();
    const view = s.editor._tiptapEditor.view;
    const estBefore = estimatePmBytes(view.state.doc);
    const sizeBefore = serverSize(s.doc);
    const blocks = Array.from({ length: 10 }, (_, i) => ({ type: "mermaid", props: { code: "graph TD" + Array.from({ length: 200 }, (_, k) => ` A${i}_${k}-->B${k};`).join("") } }));
    s.editor.replaceBlocks(s.editor.document, blocks as never);
    const actual = serverSize(s.doc) - sizeBefore;
    expect(actual).toBeGreaterThan(20_000);
    const est = estimatePmBytes(view.state.doc) - estBefore;
    expect(est / actual).toBeGreaterThan(0.8);
    expect(est / actual).toBeLessThan(1.25);
    expect(estimateBlocksBytes(blocks) / actual).toBeGreaterThan(0.8);
  });

  it("格式很多的內容（每個字粗體、連結）：估計約等於實際成長", () => {
    const s = setup();
    s.fill(3);
    placeCursorAtEnd(s.editor);
    const before = serverSize(s.doc);
    const html = Array.from({ length: 100 }, (_, i) => "<p>" + Array.from({ length: 20 }, (_, w) => (w % 4 === 0 ? `<a href="https://example.com/p/${i}/${w}">l${w}</a> ` : `<b>w${w}</b> `)).join("") + "</p>").join("");
    paste(s.editor, { "text/html": html, "text/plain": "x" });
    const actual = serverSize(s.doc) - before;
    const est = s.guardCalls.at(-1)!;
    expect(est / actual).toBeGreaterThan(0.85);
    expect(est / actual).toBeLessThan(1.2);
  });
});

describe("超過上限的提示與墓碑（真的編輯器，有 UndoManager）", () => {
  it("長過上限 → 提示；刪掉 95% → 原始大小還很大（墓碑），回收過的大小才是 server 的；提示消失、貼上又放行", async () => {
    const s = setup();
    s.fill(400);
    const limit = serverSize(s.doc) - 5_000;
    s.setLimit(limit);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const hook = renderHook(() => useNoteOverLimit(s.doc, limit, true));
    expect(hook.result.current).toBe(true);
    act(() => s.editor.removeBlocks(s.editor.document.slice(0, 380).map(b => b.id)));
    expect(Y.encodeStateAsUpdate(s.doc).byteLength, "原始大小：墓碑還在").toBeGreaterThan(limit);
    expect(noteStateBytes(s.doc, limit), "回收過的大小").toBe(serverSize(s.doc));
    expect(serverSize(s.doc)).toBeLessThan(limit / 5);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    expect(hook.result.current, "提示消失").toBe(false);
    placeCursorAtEnd(s.editor);
    paste(s.editor, { "text/plain": mdList(50) });
    expect(s.notified).toEqual([]);
    expect(JSON.stringify(s.editor.document)).toContain("item 49");
  });
});
