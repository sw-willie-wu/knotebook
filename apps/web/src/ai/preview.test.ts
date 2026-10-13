import { describe, expect, it } from "vitest";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { BlockNoteEditor } from "@blocknote/core";
import { noteSchema } from "@/collab/schema";
import type { DiffBlock } from "@/lib/version-diff";
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

describe("buildPreview（#263 §5.4；後續 2026-10-13：只放被改的區塊，不再帶前後上下文）", () => {
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

  it("平面：before 只有錨點區塊、after 只有傳入的區塊（同一物件）；前後兄弟 p0／p2 都不出現；沒有 surroundIds 欄位", () => {
    const editor = mounted(DOC);
    const preview = buildPreview(editor, ["p1"], AFTER, false);
    expect(ids(preview.before)).toEqual(["p1"]);
    expect(ids(preview.after)).toEqual(["new-1"]);
    expect(preview.after[0]).toBe(AFTER[0]);
    expect(Object.keys(preview).sort()).toEqual(["after", "before", "noChange"]);
    expect(preview.noChange).toBe(false);
  });

  it("巢狀（選取從子區塊 c2 拉到 p3，getSelection 回 [c2, p3]）：before 恰為 [c2, p3]，同層的 c1、p4 與祖先 p2 都不出現", () => {
    const editor = mounted(DOC);
    const preview = buildPreview(editor, ["c2", "p3"], AFTER, true);
    expect(ids(preview.before)).toEqual(["c2", "p3"]);
    expect(ids(preview.after)).toEqual(["new-1"]);
    expect(preview.noChange).toBe(true);
  });

  it("錨點區塊帶子樹：before 照 getBlock 帶上子區塊（被改的範圍本來就含子樹）", () => {
    const editor = mounted(DOC);
    const preview = buildPreview(editor, ["p2"], AFTER, false);
    expect(ids(preview.before)).toEqual(["p2", "c1", "c2"]);
  });

  it("錨點裡找不到的 id（已被刪）略過，其餘照放", () => {
    const editor = mounted(DOC);
    editor.removeBlocks(["p3"]);
    const preview = buildPreview(editor, ["p1", "p3"], AFTER, false);
    expect(ids(preview.before)).toEqual(["p1"]);
  });

  it("before 是呼叫當下的現值：之後再改文件，已產出的 preview 不變（凍結由呼叫端保管這份物件）", () => {
    const editor = mounted(DOC);
    const preview = buildPreview(editor, ["p1"], AFTER, false);
    editor.updateBlock("p1", { content: "changed later" });
    expect(JSON.stringify(preview.before)).toContain("one");
    expect(JSON.stringify(preview.before)).not.toContain("changed later");
  });
});
