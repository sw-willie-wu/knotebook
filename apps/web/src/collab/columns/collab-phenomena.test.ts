import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { noteSchema } from "@/collab/schema";
import type { EditorRef } from "@/components/wikilink/menu";
import { P, integrity, pressKey, row, shape, type AnyEditor, type PartialBlockLike } from "@/test/columns-fixtures";
import { createColumnEdgeKeymapExtension } from "./edge-keymap";
import { removeBlocksKeepColumns } from "./keep-columns";
import { findNodeById } from "./position";

// 雙用戶端（記錄現象）。被測的是 y-prosemirror 與 core 的合併行為，不是並排功能本身的碼——
// 「已知限制」的案把實測值寫死；其餘（標為「安全」的）紅了就是回歸。手法同 probe-collab/collab.mjs。

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

/** 兩顆共編編輯器（都掛欄首／欄尾鍵位），各自一份 Y.Doc，經 `Y.applyUpdate` 互傳。 */
async function collabPair(initial: PartialBlockLike[]) {
  const d1 = new Y.Doc();
  const d2 = new Y.Doc();
  const make = (doc: Y.Doc, n: number): AnyEditor => {
    const editorRef: EditorRef = { current: null };
    const editor = BlockNoteEditor.create(
      withCollaboration({
        schema: noteSchema,
        collaboration: {
          provider: { awareness: undefined },
          fragment: doc.getXmlFragment(YDOC_FRAGMENT),
          user: { id: `u${n}`, name: `User ${n}`, color: "hsl(0 65% 45%)" },
        },
        _tiptapOptions: { extensions: [createColumnEdgeKeymapExtension({ editorRef })] },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- withCollaboration 的選項型別要求完整的 schema 三元組
      } as any),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
    ) as any as AnyEditor;
    editorRef.current = editor;
    const el = document.createElement("div");
    document.body.appendChild(el);
    editor.mount(el);
    cleanups.push(() => {
      editor.unmount();
      el.remove();
      doc.destroy();
    });
    return editor;
  };
  const a = make(d1, 1);
  await tick();
  a.replaceBlocks(a.document, initial);
  await tick();
  Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1));
  const b = make(d2, 2);
  await tick();
  const sync = async () => {
    const u1 = Y.encodeStateAsUpdate(d1, Y.encodeStateVector(d2));
    const u2 = Y.encodeStateAsUpdate(d2, Y.encodeStateVector(d1));
    Y.applyUpdate(d2, u1);
    Y.applyUpdate(d1, u2);
    await tick();
  };
  return { a, b, sync };
}

const allText = (editor: AnyEditor) => {
  let s = "";
  editor.prosemirrorView!.state.doc.descendants((n) => {
    if (n.isText) s += n.text + "|";
  });
  return s;
};

const typeText = (editor: AnyEditor, text: string) => {
  const view = editor.prosemirrorView!;
  view.dispatch(view.state.tr.insertText(text));
};
const typeAtEnd = (editor: AnyEditor, id: string, text: string) => {
  editor.setTextCursorPosition(id, "end");
  typeText(editor, text);
};

/** 第 `index` 個表格格子的文字結尾打字（文件順序；2×2 表格 0＝左上、3＝右下）。 */
const typeInCell = (editor: AnyEditor, index: number, text: string) => {
  const view = editor.prosemirrorView!;
  const cells: number[] = [];
  view.state.doc.descendants((n, pos) => {
    if (n.type.name === "tableCell" || n.type.name === "tableHeader") cells.push(pos);
  });
  const pos = cells[index]!;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Selection 類別從現行選取的 constructor 取
  const Sel = view.state.selection.constructor as any;
  const end = Sel.near(view.state.doc.resolve(pos + view.state.doc.nodeAt(pos)!.nodeSize - 1), -1);
  view.dispatch(view.state.tr.setSelection(end).insertText(text));
};

const CLEAN = { dupIds: 0, nullIds: 0, nestedRows: 0, valid: true };
const AB = () => [P("x", "x0"), row([[P("a", "a1")], [P("b", "b1")]], "r"), P("z", "z9")];

describe("雙用戶端（記錄現象）", () => {
  it("CO1（安全）：A 在第 1 欄打字、B 在第 2 欄結尾 Enter 再打字 → 兩邊都保有兩人的字、列仍是合法兩欄", async () => {
    const { a, b, sync } = await collabPair(AB());
    typeAtEnd(a, "a1", "AAA");
    b.setTextCursorPosition("b1", "end");
    expect(pressKey(b, "Enter")).toBe(true);
    typeText(b, "BBB");
    await sync();
    for (const e of [a, b]) {
      expect(allText(e)).toContain("AAA");
      expect(allText(e)).toContain("BBB");
      expect(integrity(e)).toEqual(CLEAN);
    }
    expect(shape(a)).toBe("paragraph:x  ROW[COL(paragraph:aAAA) | COL(paragraph:b,paragraph:BBB)]  paragraph:z");
    expect(shape(b)).toBe(shape(a));
  });

  it("CO2（已知限制）：A 在第 1 欄打字、B 同時在 b 開頭 Backspace（攤平）→ A 的字消失", async () => {
    const { a, b, sync } = await collabPair(AB());
    typeAtEnd(a, "a1", "AAA");
    b.setTextCursorPosition("b1", "start");
    expect(pressKey(b, "Backspace")).toBe(true);
    expect(shape(b)).toBe("paragraph:x  paragraph:a  paragraph:b  paragraph:z");
    await sync();
    for (const e of [a, b]) {
      expect(allText(e)).not.toContain("AAA");
      expect(integrity(e)).toEqual(CLEAN);
    }
    expect(shape(a)).toBe("paragraph:x  paragraph:a  paragraph:b  paragraph:z");
    expect(shape(b)).toBe(shape(a));
  });

  it("CO3（已知限制）：同一欄兩個 block 被兩人分別刪掉 → 整列被 y-prosemirror 刪掉", async () => {
    const { a, b, sync } = await collabPair([P("x", "x0"), row([[P("a", "a1"), P("q", "q1")], [P("b", "b1")]], "r"), P("z", "z9")]);
    removeBlocksKeepColumns(a, ["a1"]);
    removeBlocksKeepColumns(b, ["q1"]);
    expect(shape(a)).toBe("paragraph:x  ROW[COL(paragraph:q) | COL(paragraph:b)]  paragraph:z");
    expect(shape(b)).toBe("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b)]  paragraph:z");
    await sync();
    for (const e of [a, b]) {
      expect(shape(e)).toBe("paragraph:x  paragraph:z");
      expect(integrity(e)).toEqual(CLEAN);
    }
  });

  it("CO4（安全）：欄內 2×2 表格，A 在左上格、B 在右下格各打字 → 兩格都有各自的字、列與表格合法", async () => {
    const table: PartialBlockLike = {
      id: "t1",
      type: "table",
      content: { type: "tableContent", rows: [{ cells: ["c00", "c01"] }, { cells: ["c10", "c11"] }] },
    };
    const { a, b, sync } = await collabPair([P("x", "x0"), row([[table], [P("b", "b1")]], "r"), P("z", "z9")]);
    typeInCell(a, 0, "_A");
    typeInCell(b, 3, "_B");
    await sync();
    for (const e of [a, b]) {
      expect(allText(e)).toBe("x|c00_A|c01|c10|c11_B|b|z|");
      expect(shape(e)).toBe("paragraph:x  ROW[COL(table) | COL(paragraph:b)]  paragraph:z");
      expect(integrity(e)).toEqual(CLEAN);
    }
  });

  it("CO5（安全）：A 在第 1 欄打字、B 同時加第 3 欄並在列下方加一段 → 字還在、列有 3 欄、下方段落在", async () => {
    const { a, b, sync } = await collabPair(AB());
    typeAtEnd(a, "a1", "AAA");
    b.transact((tr) => {
      const list = findNodeById(tr.doc, "r", "columnList")!;
      const column = tr.doc.type.schema.nodes.column!.createAndFill()!;
      tr.insert(list.pos + list.node.nodeSize - 1, column);
    });
    expect(shape(b)).toBe("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b) | COL(paragraph)]  paragraph:z");
    b.insertBlocks([P("below", "n1")], "r", "after");
    await sync();
    for (const e of [a, b]) {
      expect(shape(e)).toBe("paragraph:x  ROW[COL(paragraph:aAAA) | COL(paragraph:b) | COL(paragraph)]  paragraph:below  paragraph:z");
      expect(integrity(e)).toEqual(CLEAN);
    }
  });
});
