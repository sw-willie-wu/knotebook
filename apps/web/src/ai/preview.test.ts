import { describe, expect, it } from "vitest";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { BlockNoteEditor } from "@blocknote/core";
import { noteSchema } from "@/collab/schema";
import type { DiffBlock } from "@/lib/version-diff";
import { captureAnchor, verifyAnchor } from "./anchor";
import { buildPreview, isNoChange, normalizeMarkdown, stripTextWrapper } from "./preview";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組，repo 慣例
function mounted(initialContent: unknown[]): BlockNoteEditor<any, any, any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
  const editor = BlockNoteEditor.create({ schema: noteSchema, initialContent: initialContent as never }) as BlockNoteEditor<any, any, any>;
  const el = document.createElement("div");
  document.body.appendChild(el);
  editor.mount(el);
  editor.elementRenderer = (node: unknown, container: HTMLElement) => flushSync(() => createRoot(container).render(node as never));
  return editor;
}

function ids(blocks: readonly DiffBlock[]): string[] {
  return blocks.flatMap((b) => [b.id ?? "?", ...ids(b.children ?? [])]);
}

const AFTER: DiffBlock[] = [{ id: "new-1", type: "paragraph", props: {}, content: [{ type: "text", text: "ONE", styles: {} }], children: [] }];

describe("stripTextWrapper（#263 §5.2 第 0 步）", () => {
  it("整段以 <text> 開頭、</text> 結尾（忽略前後空白）才剝；標記內緊鄰的一個換行一併去掉", () => {
    expect(stripTextWrapper("<text>\nA\n\nB\n</text>")).toBe("A\n\nB");
    expect(stripTextWrapper("  <text>A</text>\n")).toBe("A");
    expect(stripTextWrapper("<text></text>")).toBe("");
  });
  it("只有開頭或只有結尾、或前面還有別的字 → 原樣", () => {
    expect(stripTextWrapper("<text>A")).toBe("<text>A");
    expect(stripTextWrapper("A</text>")).toBe("A</text>");
    expect(stripTextWrapper("B <text>A</text>")).toBe("B <text>A</text>");
  });
});

describe("isNoChange（#263 §5.2 第 3 步，RF5）", () => {
  it("兩端 trim、統一換行後相等 → true", () => {
    expect(normalizeMarkdown("\r\nA\r\nB  \r\n")).toBe("A\nB");
    expect(isNoChange("alpha beta  \r\n", "alpha beta\n")).toBe(true);
    expect(isNoChange("A\r\nB", "A\nB\n")).toBe(true);
  });
  it("內容不同 → false", () => {
    expect(isNoChange("alpha", "beta")).toBe(false);
  });
});

describe("buildPreview（#263 §5.4：上下文塊與 surroundIds）", () => {
  const DOC = [
    { id: "p0", type: "paragraph", content: "zero" },
    { id: "p1", type: "paragraph", content: "one" },
    { id: "p2", type: "paragraph", content: "two", children: [
      { id: "c1", type: "paragraph", content: "kid one" },
      { id: "c2", type: "paragraph", content: "kid two" },
    ] },
    { id: "p3", type: "paragraph", content: "three" },
    { id: "p4", type: "paragraph", content: "four" },
  ];

  it("平面：前後各一個同層兄弟當上下文、不帶子樹；after 中間是傳入的區塊（同一物件）", () => {
    const editor = mounted(DOC);
    const preview = buildPreview(editor, ["p1"], AFTER, false);
    expect(ids(preview.before)).toEqual(["p0", "p1", "p2"]);
    expect(ids(preview.after)).toEqual(["p0", "new-1", "p2"]);
    expect(preview.surroundIds).toEqual(["p0", "p2"]);
    expect(preview.before[2]!.children).toEqual([]);
    expect(preview.after[1]).toBe(AFTER[0]);
    expect(preview.noChange).toBe(false);
  });

  it("巢狀（選取從子區塊 c2 拉到 p3，getSelection 回 [c2, p3]）：prev 是 c2 同層的 c1、next 是 p4；祖先 p2 不出現", () => {
    const editor = mounted(DOC);
    const preview = buildPreview(editor, ["c2", "p3"], AFTER, true);
    expect(ids(preview.before)).toEqual(["c1", "c2", "p3", "p4"]);
    expect(preview.surroundIds).toEqual(["c1", "p4"]);
    expect(ids(preview.before)).not.toContain("p2");
    expect(ids(preview.after)).not.toContain("p2");
    expect(preview.noChange).toBe(true);
  });

  it("首區塊沒有前一個兄弟、末區塊沒有後一個兄弟 → 不放上下文", () => {
    const editor = mounted(DOC);
    const preview = buildPreview(editor, ["c1", "c2"], AFTER, false);
    expect(preview.surroundIds).toEqual([]);
    expect(ids(preview.before)).toEqual(["c1", "c2"]);
  });

  it("I-1：open() 之後、串流完成之前文件被搬動：prev 兄弟變成錨點區塊的祖先時不放（錨點仍 verify ok）", () => {
    const editor = mounted([
      { id: "p0", type: "paragraph", content: "zero" },
      { id: "p1", type: "paragraph", content: "one" },
      { id: "p2", type: "paragraph", content: "two" },
      { id: "p3", type: "paragraph", content: "three" },
    ]);
    const anchor = captureAnchor(editor, "note-1", ["p1", "p2"]);
    const p2 = editor.getBlock("p2")!;
    editor.removeBlocks(["p2"]);
    editor.updateBlock("p0", { children: [p2] });
    expect(verifyAnchor(editor, anchor)).toBe("ok");
    const preview = buildPreview(editor, ["p1", "p2"], AFTER, false);
    expect(preview.surroundIds).not.toContain("p0");
    expect(ids(preview.before)).not.toContain("p0");
    expect(ids(preview.after)).not.toContain("p0");
    expect(preview.surroundIds).toEqual([]);
    expect(preview.before.map((b) => b.id)).toEqual(["p1", "p2"]);
  });

  it("m-1：prev 落在某錨點區塊的子樹內（錨點 [p1,p2]，p1 被拖成 p2 的最後一個子區塊）→ 不放；verify 會是 changed", () => {
    const editor = mounted([
      { id: "p1", type: "paragraph", content: "one" },
      { id: "p2", type: "paragraph", content: "two", children: [{ id: "c", type: "paragraph", content: "kid" }] },
    ]);
    const anchor = captureAnchor(editor, "note-1", ["p1", "p2"]);
    const p1 = editor.getBlock("p1")!;
    editor.removeBlocks(["p1"]);
    editor.insertBlocks([p1], "c", "after");
    expect(verifyAnchor(editor, anchor)).toBe("changed");
    expect(editor.getPrevBlock("p1")?.id).toBe("c");
    const preview = buildPreview(editor, ["p1", "p2"], AFTER, false);
    expect(preview.surroundIds).not.toContain("c");
    expect(preview.surroundIds).toEqual([]);
    expect(preview.before.map((b) => b.id)).toEqual(["p1", "p2"]);
  });

  it("before 是呼叫當下的現值：之後再改文件，已產出的 preview 不變（凍結由呼叫端保管這份物件）", () => {
    const editor = mounted(DOC);
    const preview = buildPreview(editor, ["p1"], AFTER, false);
    editor.updateBlock("p1", { content: "changed later" });
    expect(JSON.stringify(preview.before)).toContain("one");
    expect(JSON.stringify(preview.before)).not.toContain("changed later");
  });
});
