import { afterEach, describe, expect, it } from "vitest";
import { collabUndoManager } from "@/collab/undo";
import { P, cursorOf, integrity, mountEditor, row, shape, textPos, withChildren, type AnyEditor, type PartialBlockLike } from "@/test/columns-fixtures";
import { canInsertColumns, insertColumns, isInColumn, ungroupColumns } from "./commands";

// `/grid N`、取消並排、撤銷步。

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function mount(content: PartialBlockLike[], opts?: { collab?: boolean }): AnyEditor {
  const m = mountEditor(content, { collab: opts?.collab });
  cleanups.push(m.destroy);
  return m.editor;
}

const CLEAN = { dupIds: 0, nullIds: 0, nestedRows: 0, valid: true };
const typeAtEnd = (editor: AnyEditor, id: string, text: string) => {
  editor.setTextCursorPosition(id, "end");
  const view = editor.prosemirrorView!;
  view.dispatch(view.state.tr.insertText(text));
};

describe("insertColumns", () => {
  it("GC1：游標在空段落 → 換成 3 欄新列、各欄 width 1、游標在第 1 欄段落開頭", () => {
    const editor = mount([P("x", "x0"), P("", "e0"), P("z", "z0")]);
    editor.setTextCursorPosition("e0", "start");
    const id = insertColumns(editor, 3);
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(paragraph) | COL(paragraph) | COL(paragraph)]  paragraph:z");
    const rowBlock = editor.document[1]!;
    expect(rowBlock.id).toBe(id);
    expect(rowBlock.children.map((c) => (c.props as { width: number }).width)).toEqual([1, 1, 1]);
    expect(cursorOf(editor)).toBe("paragraph@0");
    expect(editor.getTextCursorPosition().block.id).toBe(rowBlock.children[0]!.children[0]!.id);
    expect(integrity(editor)).toEqual(CLEAN);
  });

  it("GC2：游標在非空段落 → 新列插在它後面", () => {
    const editor = mount([P("x", "x0"), P("y", "y0"), P("z", "z0")]);
    editor.setTextCursorPosition("y0", "end");
    insertColumns(editor, 2);
    expect(shape(editor)).toBe("paragraph:x  paragraph:y  ROW[COL(paragraph) | COL(paragraph)]  paragraph:z");
    expect(cursorOf(editor)).toBe("paragraph@0");
    expect(integrity(editor)).toEqual(CLEAN);
  });

  it("GC3：新列成為最後一個 block → 後面補一個空段落（插入與取代兩種）", () => {
    const a = mount([P("x", "x0")]);
    a.setTextCursorPosition("x0", "end");
    insertColumns(a, 2);
    expect(shape(a)).toBe("paragraph:x  ROW[COL(paragraph) | COL(paragraph)]  paragraph");
    expect(integrity(a)).toEqual(CLEAN);

    const b = mount([P("x", "x0"), P("", "e0")]);
    b.setTextCursorPosition("e0", "start");
    insertColumns(b, 4);
    expect(shape(b)).toBe("paragraph:x  ROW[COL(paragraph) | COL(paragraph) | COL(paragraph) | COL(paragraph)]  paragraph");
    expect(integrity(b)).toEqual(CLEAN);
  });

  it("GC6：空段落但有子 block → 不換掉（免得子 block 跟著消失），新列插在後面", () => {
    const editor = mount([P("x", "x0"), withChildren(P("", "e0"), [P("k", "k0")]), P("z", "z0")]);
    editor.setTextCursorPosition("e0", "start");
    insertColumns(editor, 2);
    expect(shape(editor)).toBe("paragraph:x  paragraph{paragraph:k}  ROW[COL(paragraph) | COL(paragraph)]  paragraph:z");
  });

  it("GC5：一次撤銷（共編）——先打字不 stopCapturing 再建列，undo 一次只拿掉列、字還在", () => {
    const editor = mount([P("x", "x0"), P("y", "y0"), P("z", "z0")], { collab: true });
    const manager = collabUndoManager(editor)!;
    expect(manager).toBeDefined();
    typeAtEnd(editor, "y0", "Q");
    insertColumns(editor, 2);
    expect(shape(editor)).toBe("paragraph:x  paragraph:yQ  ROW[COL(paragraph) | COL(paragraph)]  paragraph:z");
    manager.undo();
    expect(shape(editor)).toBe("paragraph:x  paragraph:yQ  paragraph:z");
  });
});

describe("canInsertColumns", () => {
  it("GC4：頂層段落 true；欄內、子 block、頂層表格格子 false", () => {
    const editor = mount([
      P("x", "x0"),
      row([[P("a", "a1")], [P("b", "b1")]], "r"),
      withChildren(P("p", "p0"), [P("k", "k0")]),
      { id: "t0", type: "table", content: { type: "tableContent", rows: [{ cells: ["cell"] }] } } as PartialBlockLike,
      P("z", "z0"),
    ]);
    editor.setTextCursorPosition("x0", "end");
    expect(canInsertColumns(editor)).toBe(true);
    editor.setTextCursorPosition("b1", "end");
    expect(canInsertColumns(editor)).toBe(false);
    editor.setTextCursorPosition("k0", "end");
    expect(canInsertColumns(editor)).toBe(false);
    editor._tiptapEditor.commands.setTextSelection(textPos(editor, "cell", 1));
    expect(editor.getTextCursorPosition().block.type).toBe("table");
    expect(canInsertColumns(editor)).toBe(false);
  });
});

describe("ungroupColumns", () => {
  it("UG1：順序＝第 1 欄全部、第 2 欄全部…，空段落丟掉，游標在第一個保留 block 開頭", () => {
    const editor = mount([P("x", "x0"), row([[P("a", "a1"), P("", "e1")], [P("", "e2")], [P("b", "b1"), P("c", "c1")]], "r"), P("z", "z0")]);
    expect(isInColumn(editor, "b1")).toBe(true);
    expect(ungroupColumns(editor, "b1")).toBe(true);
    expect(shape(editor)).toBe("paragraph:x  paragraph:a  paragraph:b  paragraph:c  paragraph:z");
    expect(cursorOf(editor)).toBe("a@0");
    expect(integrity(editor)).toEqual(CLEAN);
  });

  it("UG1b：第 1 欄有兩顆時先排完第 1 欄（不是逐列交錯）", () => {
    const editor = mount([P("x", "x0"), row([[P("a", "a1"), P("q", "q1")], [P("b", "b1")]], "r"), P("z", "z0")]);
    expect(ungroupColumns(editor, "a1")).toBe(true);
    expect(shape(editor)).toBe("paragraph:x  paragraph:a  paragraph:q  paragraph:b  paragraph:z");
  });

  it("UG2：全空的列 → 留一個空段落", () => {
    const editor = mount([P("x", "x0"), row([[P("", "e1")], [P("", "e2")]], "r"), P("z", "z0")]);
    expect(ungroupColumns(editor, "e2")).toBe(true);
    expect(shape(editor)).toBe("paragraph:x  paragraph  paragraph:z");
    expect(cursorOf(editor)).toBe("paragraph@0");
    expect(integrity(editor)).toEqual(CLEAN);
  });

  it("UG2b：列是唯一的 block 且全空 → 留一個空段落", () => {
    const editor = mount([row([[P("", "e1")], [P("", "e2")]], "r")]);
    expect(ungroupColumns(editor, "e1")).toBe(true);
    expect(shape(editor)).toBe("paragraph");
    expect(integrity(editor)).toEqual(CLEAN);
  });

  it("UG3：欄內 block 的子 block 保留", () => {
    const editor = mount([row([[withChildren(P("a", "a1"), [P("k", "k1")])], [P("b", "b1")]], "r")]);
    expect(ungroupColumns(editor, "a1")).toBe(true);
    expect(shape(editor)).toBe("paragraph:a{paragraph:k}  paragraph:b");
    expect(integrity(editor)).toEqual(CLEAN);
  });

  it("UG4：不在欄內的 block → 回 false、文件不變", () => {
    const editor = mount([P("x", "x0"), row([[P("a", "a1")], [P("b", "b1")]], "r"), withChildren(P("p", "p0"), [P("k", "k0")])]);
    const before = shape(editor);
    expect(isInColumn(editor, "x0")).toBe(false);
    expect(ungroupColumns(editor, "x0")).toBe(false);
    expect(ungroupColumns(editor, "k0")).toBe(false);
    expect(shape(editor)).toBe(before);
  });

  it("UG5：一次撤銷（共編）——先打字不 stopCapturing 再取消並排，undo 一次回到原列、字還在", () => {
    const editor = mount([P("x", "x0"), row([[P("a", "a1")], [P("b", "b1")]], "r"), P("z", "z0")], { collab: true });
    const manager = collabUndoManager(editor)!;
    expect(manager).toBeDefined();
    typeAtEnd(editor, "b1", "Q");
    expect(ungroupColumns(editor, "b1")).toBe(true);
    expect(shape(editor)).toBe("paragraph:x  paragraph:a  paragraph:bQ  paragraph:z");
    manager.undo();
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:bQ)]  paragraph:z");
  });
});
