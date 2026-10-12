import { describe, expect, it } from "vitest";
import { act, render } from "@testing-library/react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { BlockNoteEditor, getNodeById } from "@blocknote/core";
import { FormattingToolbarExtension } from "@blocknote/core/extensions";
import { BlockNoteView } from "@blocknote/mantine";
import { noteSchema } from "@/collab/schema";
import { anchorRange, blockRange, selectionFocus, selectionInsideAnchor, toolbarWouldShow } from "./selection";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組，repo 慣例
type AnyEditor = BlockNoteEditor<any, any, any>;

function createEditor(initialContent: unknown[]): AnyEditor {
  return BlockNoteEditor.create({ schema: noteSchema, initialContent: initialContent as never }) as AnyEditor;
}

/** 裸 mount（同 `ai/apply.test.ts`）：wikilink 走 toExternalHTML，elementRenderer shim 一行即足。只給純函式案用。 */
function bareMounted(initialContent: unknown[]): AnyEditor {
  const editor = createEditor(initialContent);
  const el = document.createElement("div");
  document.body.appendChild(el);
  editor.mount(el);
  editor.elementRenderer = (node: unknown, container: HTMLElement) => flushSync(() => createRoot(container).render(node as never));
  return editor;
}

const start = (editor: AnyEditor, id: string) => getNodeById(id, editor.prosemirrorState.doc)!.posBeforeNode + 2;
const end = (editor: AnyEditor, id: string) => {
  const info = getNodeById(id, editor.prosemirrorState.doc)!;
  return info.posBeforeNode + 2 + info.node.firstChild!.content.size;
};
const select = (editor: AnyEditor, from: number, to: number) => act(() => void editor._tiptapEditor.commands.setTextSelection({ from, to }));
const read = <T,>(editor: AnyEditor, fn: (tr: Parameters<Parameters<AnyEditor["transact"]>[0]>[0]) => T): T => editor.transact(fn);

const DOC = [
  { id: "p1", type: "paragraph", content: "alpha beta gamma" },
  { id: "p2", type: "paragraph", content: "second" },
  { id: "p3", type: "paragraph", content: "third" },
];

describe("toolbarWouldShow（#263 S2：照抄上游 FormattingToolbarExtension.shouldShow）", () => {
  it("逐案與上游 store 一致：空選取 false、無文字的 TextSelection false、跨 code false、NodeSelection true、一般文字 true、全選含 code false", () => {
    const editor = createEditor([
      { id: "p1", type: "paragraph", content: "alpha" },
      { id: "p2", type: "paragraph", content: "beta" },
      { id: "code", type: "codeBlock", content: "const x = 1;" },
      { id: "img", type: "image", props: { url: "https://example.com/a.png" } },
    ]);
    render(<BlockNoteView editor={editor} />);
    const store = editor.getExtension(FormattingToolbarExtension)!.store;
    const cmd = editor._tiptapEditor.commands;
    const cases: Array<[string, () => void, boolean]> = [
      ["空選取", () => void cmd.setTextSelection(start(editor, "p1") + 1), false],
      ["跨段界、沒有文字的 TextSelection", () => void cmd.setTextSelection({ from: end(editor, "p1"), to: start(editor, "p2") }), false],
      ["從段落拉進 code block", () => void cmd.setTextSelection({ from: start(editor, "p2") + 1, to: start(editor, "code") + 3 }), false],
      ["NodeSelection（圖片）", () => void cmd.setNodeSelection(getNodeById("img", editor.prosemirrorState.doc)!.posBeforeNode + 1), true],
      ["一般文字", () => void cmd.setTextSelection({ from: start(editor, "p1"), to: start(editor, "p1") + 3 }), true],
      ["全選（文件含 code block）", () => void cmd.selectAll(), false],
    ];
    for (const [name, apply, expected] of cases) {
      act(apply);
      expect({ name, ours: read(editor, (tr) => toolbarWouldShow(tr)) }).toEqual({ name, ours: expected });
      expect({ name, upstream: store.state }).toEqual({ name, upstream: expected });
    }
  });
});

describe("selectionInsideAnchor（#263 §5.2：D12 與工具列壓制共用的唯一判斷）", () => {
  it("在範圍內 true；部分重疊、範圍外 false；錨點區塊不在了 false", () => {
    const editor = bareMounted(DOC);
    select(editor, start(editor, "p1") + 1, start(editor, "p1") + 4);
    expect(read(editor, (tr) => selectionInsideAnchor(tr, ["p1"]))).toBe(true);
    select(editor, start(editor, "p1") + 1, start(editor, "p2") + 2);
    expect(read(editor, (tr) => selectionInsideAnchor(tr, ["p1"]))).toBe(false);
    expect(read(editor, (tr) => selectionInsideAnchor(tr, ["p1", "p2"]))).toBe(true);
    select(editor, start(editor, "p3"), start(editor, "p3") + 2);
    expect(read(editor, (tr) => selectionInsideAnchor(tr, ["p1", "p2"]))).toBe(false);
    expect(read(editor, (tr) => selectionInsideAnchor(tr, ["gone"]))).toBe(false);
  });

  it("RF1：Ctrl+A（AllSelection，from=0、to=doc.content.size）對「全部頂層區塊」的錨點算在範圍內；只錨首區塊時不算", () => {
    const editor = bareMounted(DOC);
    act(() => void editor._tiptapEditor.commands.selectAll());
    expect(read(editor, (tr) => [tr.selection.from, tr.selection.to])).toEqual([0, editor.prosemirrorState.doc.content.size]);
    expect(read(editor, (tr) => selectionInsideAnchor(tr, ["p1", "p2", "p3"]))).toBe(true);
    expect(read(editor, (tr) => selectionInsideAnchor(tr, ["p1"]))).toBe(false);
  });

  it("blockRange／anchorRange：posBefore～posAfter；任一端找不到回 null", () => {
    const editor = bareMounted(DOC);
    const doc = editor.prosemirrorState.doc;
    const p1 = getNodeById("p1", doc)!;
    const p3 = getNodeById("p3", doc)!;
    expect(blockRange(doc, "p1")).toEqual({ from: p1.posBeforeNode, to: p1.posBeforeNode + p1.node.nodeSize });
    expect(anchorRange(doc, ["p1", "p2", "p3"])).toEqual({ from: p1.posBeforeNode, to: p3.posBeforeNode + p3.node.nodeSize });
    expect(anchorRange(doc, ["p1", "gone"])).toBeNull();
  });
});

describe("selectionFocus（#263 §5.2 open()、D8）", () => {
  it("整塊選取（首區塊開頭到末區塊結尾）→ 空字串；Ctrl+A 對全部區塊 → 空字串", () => {
    const editor = bareMounted(DOC);
    select(editor, start(editor, "p1"), end(editor, "p2"));
    expect(read(editor, (tr) => selectionFocus(tr, ["p1", "p2"]))).toBe("");
    act(() => void editor._tiptapEditor.commands.selectAll());
    expect(read(editor, (tr) => selectionFocus(tr, ["p1", "p2", "p3"]))).toBe("");
  });

  it("部分選取取子字串；跨區塊以換行分隔", () => {
    const editor = bareMounted(DOC);
    select(editor, start(editor, "p1") + 6, start(editor, "p1") + 10);
    expect(read(editor, (tr) => selectionFocus(tr, ["p1"]))).toBe("beta");
    select(editor, start(editor, "p1") + 6, start(editor, "p2") + 3);
    expect(read(editor, (tr) => selectionFocus(tr, ["p1", "p2"]))).toBe("beta gamma\nsec");
  });

  it("wikilink（leaf 節點）輸出 [[標題]]，與送出的 markdown 寫法一致", () => {
    const editor = bareMounted([
      { id: "w", type: "paragraph", content: ["see ", { type: "wikilink", props: { targetNoteId: "x", snapshotTitle: "Plan" } }, " end"] },
      { id: "z", type: "paragraph", content: "zz" },
    ]);
    // wikilink 是 atom，在 PM 裡只佔 1 個位置："see "（4）＋wikilink（1）＝5（起草時 jsdom 實跑校正）
    select(editor, start(editor, "w"), start(editor, "w") + 5);
    expect(read(editor, (tr) => selectionFocus(tr, ["w"]))).toBe("see [[Plan]]");
  });

  it("RF2：超過 2000 code point 截到 2000，不切半個 emoji", () => {
    const editor = bareMounted([{ id: "e", type: "paragraph", content: `${"😀".repeat(2100)}x` }]);
    // emoji 在 PM 裡佔 2 個位置（UTF-16），選到 x 之前
    select(editor, start(editor, "e"), start(editor, "e") + 4200);
    const focus = read(editor, (tr) => selectionFocus(tr, ["e"]));
    expect(Array.from(focus)).toHaveLength(2000);
    expect(focus).toBe("😀".repeat(2000));
  });
});
