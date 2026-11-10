import { afterEach, describe, expect, it } from "vitest";
import { Extension, InputRule } from "@tiptap/core";
import { collabUndoManager } from "@/collab/undo";
import { CB, H, IMG, P, cursorOf, integrity, mountEditor, pressKey, row, shape, textPos, withChildren, type AnyEditor, type PartialBlockLike } from "@/test/columns-fixtures";
import { createColumnEdgeKeymapExtension } from "./edge-keymap";

// 鍵盤表。期望值逐字取自實際按鍵的輸出；
// 鍵盤一律真 keydown（pressKey），不用 commands.keyboardShortcut()。

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function mount(content: PartialBlockLike[], opts?: { collab?: boolean; extra?: unknown[] }): AnyEditor {
  const m = mountEditor(content, { collab: opts?.collab, extensions: (editorRef) => [createColumnEdgeKeymapExtension({ editorRef }), ...(opts?.extra ?? [])] });
  cleanups.push(m.destroy);
  return m.editor;
}

const X = () => P("x", "x0");
const Z = () => P("z", "z9");
const W = (cols: PartialBlockLike[][]): PartialBlockLike[] => [X(), row(cols, "r"), Z()];
const E = (id: string) => P("", id);

type Act = (editor: AnyEditor) => unknown;
const bs = (id: string): Act => (editor) => {
  editor.setTextCursorPosition(id, "start");
  return pressKey(editor, "Backspace");
};
const del = (id: string): Act => (editor) => {
  editor.setTextCursorPosition(id, "end");
  return pressKey(editor, "Delete");
};
const moveKey = (id: string, key: "ArrowUp" | "ArrowDown"): Act => (editor) => {
  editor.setTextCursorPosition(id, "start");
  return pressKey(editor, key, { ctrlKey: true, shiftKey: true });
};
const select = (editor: AnyEditor, w1: string, o1: number, w2: string, o2: number) =>
  editor._tiptapEditor.commands.setTextSelection({ from: textPos(editor, w1, o1), to: textPos(editor, w2, o2) });
/** 瀏覽器的預設輸入：沒有外掛接手 handleTextInput 時以 insertText 補上（同法）。 */
const typeText = (editor: AnyEditor, text: string) => {
  const view = editor.prosemirrorView!;
  const { from, to } = view.state.selection;
  const deflt = () => view.state.tr.insertText(text, from, to);
  if (!view.someProp("handleTextInput", (f) => f(view, from, to, text, deflt))) view.dispatch(deflt());
};

const CLEAN = { dupIds: 0, nullIds: 0, nestedRows: 0, valid: true };

// [案, 起始, 動作, 結果 shape, 游標（null＝表上無值）]
const TABLE: [string, () => PartialBlockLike[], Act, string, string | null][] = [
  ["P1", () => W([[P("a", "a1")], [P("b", "b1")]]), bs("b1"), "paragraph:x  paragraph:a  paragraph:b  paragraph:z", "b@0"],
  ["P2", () => W([[P("a", "a1")], [P("b", "b1")], [E("e3")]]), bs("b1"), "paragraph:x  ROW[COL(paragraph:a,paragraph:b) | COL(paragraph)]  paragraph:z", "b@0"],
  ["P2b", () => W([[P("a", "a1")], [P("b", "b1")], [P("c", "c1")]]), bs("b1"), "paragraph:x  ROW[COL(paragraph:a,paragraph:b) | COL(paragraph:c)]  paragraph:z", "b@0"],
  [
    "P3",
    () => W([[P("a", "a1")], [P("b", "b1"), P("q", "q1")], [P("c", "c1")]]),
    bs("b1"),
    "paragraph:x  ROW[COL(paragraph:a,paragraph:b) | COL(paragraph:q) | COL(paragraph:c)]  paragraph:z",
    "b@0",
  ],
  [
    "P3b",
    () => W([[P("a", "a1")], [E("e2")], [P("b", "b1"), P("q", "q1")]]),
    bs("b1"),
    "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b) | COL(paragraph:q)]  paragraph:z",
    "b@0",
  ],
  ["P5", () => W([[P("a", "a1")], [P("b", "b1")]]), del("a1"), "paragraph:x  paragraph:a  paragraph:b  paragraph:z", "a@1"],
  ["P5b", () => W([[P("a", "a1")], [P("b", "b1")], [P("c", "c1")]]), del("a1"), "paragraph:x  ROW[COL(paragraph:a,paragraph:b) | COL(paragraph:c)]  paragraph:z", "a@1"],
  ["P5c", () => W([[P("a", "a1")], [P("b", "b1"), P("q", "q1")]]), del("a1"), "paragraph:x  ROW[COL(paragraph:a,paragraph:b) | COL(paragraph:q)]  paragraph:z", "a@1"],
  ["P5d", () => W([[P("a", "a1")], [E("e2")], [P("c", "c1")]]), del("a1"), "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:c)]  paragraph:z", "a@1"],
  ["P5e", () => W([[P("a", "a1"), P("q", "q1")], [P("b", "b1")]]), del("q1"), "paragraph:x  paragraph:a  paragraph:q  paragraph:b  paragraph:z", "q@1"],
  ["P5f", () => W([[P("a", "a1")], [E("e2"), P("q", "q1")]]), del("a1"), "paragraph:x  ROW[COL(paragraph:a,paragraph) | COL(paragraph:q)]  paragraph:z", "a@1"],
  ["P6", () => W([[P("a", "a1")], [P("b", "b1")]]), del("b1"), "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b,paragraph:z)]", "z@0"],
  ["P6b", () => [X(), row([[P("a", "a1")], [P("b", "b1")]], "r")], del("b1"), "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b)]", "b@1"],
  ["P10", () => W([[P("a", "a1")], [H("h", "h1")]]), bs("h1"), "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:h)]  paragraph:z", "h@0"],
  ["P11", () => W([[P("a", "a1")], [withChildren(P("b", "b1"), [P("k", "k1")])]]), bs("b1"), "paragraph:x  paragraph:a  paragraph:b{paragraph:k}  paragraph:z", "b@0"],
  // 欄內 block 的子 block 開頭 BS 不是欄首：交還 core（k 升成 b 的同層）。
  ["P11k", () => W([[P("a", "a1")], [withChildren(P("b", "b1"), [P("k", "k1")])]]), bs("k1"), "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b,paragraph:k)]  paragraph:z", "k@0"],
  // 以下四案不是欄首／欄尾：交還 core（守欄首／欄尾的位置條件）。P1m／P5m 在 PM 沒有 keymap 接手（瀏覽器原生刪字），
  // jsdom 沒有原生行為，所以文件不變。
  ["P3c", () => W([[P("a", "a1")], [P("b", "b1"), P("q", "q1")]]), bs("q1"), "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:bq)]  paragraph:z", "bq@1"],
  ["P5g", () => W([[P("a", "a1"), P("q", "q1")], [P("b", "b1")]]), del("a1"), "paragraph:x  ROW[COL(paragraph:aq) | COL(paragraph:b)]  paragraph:z", "aq@1"],
  [
    "P1m",
    () => W([[P("a", "a1")], [P("bb", "b1")]]),
    (editor) => {
      editor._tiptapEditor.commands.setTextSelection(textPos(editor, "bb", 1));
      return pressKey(editor, "Backspace");
    },
    "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:bb)]  paragraph:z",
    "bb@1",
  ],
  [
    "P5m",
    () => W([[P("aa", "a1")], [P("b", "b1")]]),
    (editor) => {
      editor._tiptapEditor.commands.setTextSelection(textPos(editor, "aa", 1));
      return pressKey(editor, "Delete");
    },
    "paragraph:x  ROW[COL(paragraph:aa) | COL(paragraph:b)]  paragraph:z",
    "aa@1",
  ],
  ["P12", () => W([[withChildren(P("a", "a1"), [P("k", "k1")])], [P("b", "b1")]]), del("a1"), "paragraph:x  ROW[COL(paragraph:ak) | COL(paragraph:b)]  paragraph:z", "ak@1"],
  ["E1", () => W([[P("a", "a1")], [E("e2")]]), bs("e2"), "paragraph:x  paragraph:a  paragraph:z", "a@1"],
  ["E2", () => W([[P("a", "a1")], [E("e2")], [P("c", "c1")]]), bs("e2"), "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:c)]  paragraph:z", "a@1"],
  ["E3", () => W([[E("e1")], [P("b", "b1")]]), bs("e1"), "paragraph:x  paragraph:b  paragraph:z", "b@0"],
  ["E3'", () => [row([[E("e1")], [P("b", "b1")]], "r"), Z()], bs("e1"), "paragraph:b  paragraph:z", "b@0"],
  ["E4", () => W([[P("a", "a1")], [E("e2")], [E("e3")]]), bs("e3"), "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph)]  paragraph:z", "paragraph@0"],
  ["E5", () => W([[E("e1")], [E("e2")]]), bs("e2"), "paragraph:x  paragraph  paragraph:z", "paragraph@0"],
  ["E6", () => W([[IMG("i1", 300)], [E("e2")]]), bs("e2"), "paragraph:x  image  paragraph:z", "image@0"],
  // 收欄後游標目標是圖片（非 textblock）：選到圖片本身，不跑到列下方。
  ["E3img", () => W([[E("e1")], [IMG("i1", 300)]]), bs("e1"), "paragraph:x  image  paragraph:z", "image@0"],
  ["E10img", () => W([[E("e1")], [IMG("i1", 300)]]), del("e1"), "paragraph:x  image  paragraph:z", "image@0"],
  ["E7", () => W([[IMG("i1", 300)], [P("b", "b1")]]), bs("b1"), "paragraph:x  image  paragraph:b  paragraph:z", "b@0"],
  ["E8", () => W([[P("a", "a1")], [IMG("i1", 300)]]), del("a1"), "paragraph:x  paragraph:a  image  paragraph:z", "a@1"],
  ["E9", () => W([[P("a", "a1")], [E("e2")]]), del("a1"), "paragraph:x  paragraph:a  paragraph:z", "a@1"],
  ["E10", () => W([[E("e1")], [P("b", "b1")]]), del("e1"), "paragraph:x  paragraph:b  paragraph:z", "b@0"],
  ["E10b", () => W([[E("e1")], [P("b", "b1"), P("q", "q1")]]), del("e1"), "paragraph:x  ROW[COL(paragraph:b) | COL(paragraph:q)]  paragraph:z", "b@0"],
  ["E11b", () => W([[E("e1")], [P("b", "b1"), P("q", "q1")]]), bs("b1"), "paragraph:x  ROW[COL(paragraph:b) | COL(paragraph:q)]  paragraph:z", "b@0"],
  ["E12", () => W([[P("a", "a1")], [E("e2")], [E("e3")]]), bs("e2"), "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph)]  paragraph:z", "a@1"],
  ["E14", () => W([[P("a", "a1")], [P("b", "b1"), E("e2")]]), bs("b1"), "paragraph:x  paragraph:a  paragraph:b  paragraph:z", "b@0"],
  [
    "E15",
    () => W([[P("a", "a1")], [P("b", "b1")], [P("c", "c1")], [P("d", "d1")]]),
    bs("c1"),
    "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b,paragraph:c) | COL(paragraph:d)]  paragraph:z",
    "c@0",
  ],
  ["E16", () => W([[E("e1")], [P("b", "b1")], [P("c", "c1")]]), bs("e1"), "paragraph:x  ROW[COL(paragraph:b) | COL(paragraph:c)]  paragraph:z", "b@0"],
  ["E19", () => W([[P("a", "a1")], [IMG("i1", 300), P("b", "b1")]]), del("a1"), "paragraph:x  ROW[COL(paragraph:a,image) | COL(paragraph:b)]  paragraph:z", "a@1"],
  ["E20", () => W([[P("a", "a1")], [E("e2")], [P("c", "c1")]]), del("e2"), "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:c)]  paragraph:z", "c@0"],
  ["C1", () => W([[CB("cb")], [P("b", "b1")]]), del("cb"), "paragraph:x  paragraph:b  paragraph:z", "b@0"],
  ["C3", () => [X(), row([[P("a", "a1")], [CB("cb")]], "r")], del("cb"), "paragraph:x  paragraph:a", "a@1"],
  ["C4", () => W([[P("a", "a1"), CB("cb")], [P("b", "b1")]]), del("cb"), "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b)]  paragraph:z", "b@0"],
  ["P4", () => W([[P("a", "a1")], [P("b", "b1")]]), bs("a1"), "paragraph:x  paragraph:a  paragraph:b  paragraph:z", null],
  ["P7", () => W([[P("a", "a1")], [P("b", "b1")]]), del("x0"), "paragraph:x  paragraph:a  paragraph:b  paragraph:z", null],
  ["P7c", () => W([[P("a", "a1"), P("q", "q1")], [P("b", "b1")]]), del("x0"), "paragraph:x  paragraph:a  ROW[COL(paragraph:q) | COL(paragraph:b)]  paragraph:z", null],
  ["P8", () => W([[P("a", "a1")], [P("b", "b1")]]), bs("z9"), "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b,paragraph:z)]", "z@0"],
  [
    "P12b",
    () => W([[withChildren(P("a", "a1"), [P("k", "k1")])], [P("b", "b1")]]),
    del("k1"),
    "paragraph:x  ROW[COL(paragraph:a{paragraph:kz}) | COL(paragraph:b)]",
    "kz@1",
  ],
  ["M1", () => W([[P("a", "a1")], [P("b", "b1")]]), moveKey("b1", "ArrowUp"), "paragraph:x  ROW[COL(paragraph:a,paragraph:b) | COL(paragraph)]  paragraph:z", "b@0"],
  ["M2", () => W([[P("a", "a1")], [P("b", "b1")]]), moveKey("a1", "ArrowDown"), "paragraph:x  ROW[COL(paragraph) | COL(paragraph:a,paragraph:b)]  paragraph:z", "a@0"],
  [
    "S1",
    () => W([[P("aa", "a1")], [P("bb", "b1")], [P("cc", "c1")]]),
    (editor) => {
      select(editor, "aa", 1, "cc", 1);
      return pressKey(editor, "Backspace");
    },
    "paragraph:x  ROW[COL(paragraph:ac) | COL(paragraph)]  paragraph:z",
    "ac@1",
  ],
  [
    "S2",
    () => W([[P("aa", "a1")], [P("bb", "b1")], [P("cc", "c1")]]),
    (editor) => {
      select(editor, "aa", 1, "cc", 1);
      typeText(editor, "Q");
    },
    "paragraph:x  ROW[COL(paragraph:aQc) | COL(paragraph)]  paragraph:z",
    "aQc@2",
  ],
  [
    "空欄",
    () => W([[P("a", "a1")], [P("bb", "b1")]]),
    (editor) => {
      select(editor, "bb", 0, "bb", 2);
      return pressKey(editor, "Backspace");
    },
    "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph)]  paragraph:z",
    "paragraph@0",
  ],
];

describe("K-TABLE 鍵盤矩陣（欄邊鍵盤處理＋core）", () => {
  it.each(TABLE)("%s", (_name, content, act, expected, cursor) => {
    const editor = mount(content());
    const before = shape(editor);
    act(editor);
    expect(shape(editor)).toBe(expected);
    if (cursor !== null) expect(cursorOf(editor)).toBe(cursor);
    expect(integrity(editor)).toEqual(CLEAN);
    editor.undo();
    expect(shape(editor)).toBe(before);
  });

  it("空欄（續）：選取 bb 全部刪掉後在空欄開頭再按 Backspace → 收欄攤平 x a z、游標 a@1；撤銷一次回到起始（非共編：history 把相鄰兩鍵併成一步；共編組態見 K-UNDO-COLLAB）", () => {
    const editor = mount(W([[P("a", "a1")], [P("bb", "b1")]]));
    const before = shape(editor);
    select(editor, "bb", 0, "bb", 2);
    pressKey(editor, "Backspace");
    const mid = shape(editor);
    expect(mid).toBe("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph)]  paragraph:z");
    expect(pressKey(editor, "Backspace")).toBe(true);
    expect(shape(editor)).toBe("paragraph:x  paragraph:a  paragraph:z");
    expect(cursorOf(editor)).toBe("a@1");
    expect(integrity(editor)).toEqual(CLEAN);
    editor.undo();
    expect(shape(editor)).toBe(before);
  });
});

describe("K-P6B 列在文件尾、最後一欄結尾 Delete", () => {
  it("吞掉：pressKey 回 true、不丟例外、文件不變", () => {
    const editor = mount([X(), row([[P("a", "a1")], [P("b", "b1")]], "r")]);
    const before = shape(editor);
    editor.setTextCursorPosition("b1", "end");
    let handled: boolean | undefined;
    expect(() => {
      handled = pressKey(editor, "Delete");
    }).not.toThrow();
    expect(handled).toBe(true);
    expect(shape(editor)).toBe(before);
    expect(cursorOf(editor)).toBe("b@1");
  });
});

describe("K-INPUTRULE 剛觸發的 input rule 先被 Backspace 撤銷", () => {
  const doubleGt = () =>
    Extension.create({
      name: "testDoubleGt",
      addInputRules() {
        return [
          new InputRule({
            find: /^>>$/,
            handler: ({ state, range }) => {
              state.tr.delete(range.from, range.to);
            },
          }),
        ];
      },
    });

  it("[a｜空] 規則剛把那欄清成空欄 → Backspace 撤銷規則得 [a｜>>]、不收欄", () => {
    const editor = mount(W([[P("a", "a1")], [E("e2")]]), { extra: [doubleGt()] });
    editor.setTextCursorPosition("e2", "start");
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.insertText(">"));
    const { from } = view.state.selection;
    expect(view.someProp("handleTextInput", (f) => f(view, from, from, ">", () => view.state.tr.insertText(">", from, from)))).toBe(true);
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph)]  paragraph:z");
    expect(pressKey(editor, "Backspace")).toBe(true);
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:>>)]  paragraph:z");
  });

  it("[a｜空,q] 在空段落打 >> 觸發規則 → Backspace 撤銷規則、不做搬移", () => {
    const editor = mount(W([[P("a", "a1")], [E("e2"), P("q", "q1")]]), { extra: [doubleGt()] });
    editor.setTextCursorPosition("e2", "start");
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.insertText(">"));
    const { from } = view.state.selection;
    expect(view.someProp("handleTextInput", (f) => f(view, from, from, ">", () => view.state.tr.insertText(">", from, from)))).toBe(true);
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph,paragraph:q)]  paragraph:z");
    expect(pressKey(editor, "Backspace")).toBe(true);
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:>>,paragraph:q)]  paragraph:z");
  });
});

describe("K-UNDO-COLLAB 欄邊鍵盤處理的搬移自成一個撤銷步（共編 UndoManager）", () => {
  it("打字後不 stopCapturing 立刻 Backspace、再立刻打字 → undo 依序只還原後打的字、搬移、先打的字", () => {
    const editor = mount(W([[P("a", "a1")], [P("b", "b1")]]), { collab: true });
    const manager = collabUndoManager(editor)!;
    expect(manager).toBeDefined();
    editor.setTextCursorPosition("b1", "start");
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.insertText("Q"));
    editor.setTextCursorPosition("b1", "start");
    expect(pressKey(editor, "Backspace")).toBe(true);
    expect(shape(editor)).toBe("paragraph:x  paragraph:a  paragraph:Qb  paragraph:z");
    view.dispatch(view.state.tr.insertText("W"));
    expect(shape(editor)).toBe("paragraph:x  paragraph:a  paragraph:WQb  paragraph:z");
    manager.undo();
    expect(shape(editor)).toBe("paragraph:x  paragraph:a  paragraph:Qb  paragraph:z");
    manager.undo();
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:Qb)]  paragraph:z");
    manager.undo();
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b)]  paragraph:z");
  });
});

describe("K-WHOLE 選取完整跨過整列再刪除", () => {
  it("[xx, [aa｜bb], zz] 從 xx 中間選到 zz 中間 → Backspace：列消失、前後段落照 core 合併、文件合法", () => {
    const editor = mount([P("xx", "x0"), row([[P("aa", "a1")], [P("bb", "b1")]], "r"), P("zz", "z9")]);
    select(editor, "xx", 1, "zz", 1);
    pressKey(editor, "Backspace");
    expect(shape(editor)).toBe("paragraph:xz");
    expect(shape(editor)).not.toContain("ROW");
    expect(integrity(editor)).toEqual(CLEAN);
  });
});

describe("K-MOUNT 列開頭的文件 mount 後不點擊直接按鍵", () => {
  it.each(["Backspace", "Delete"])("%s：選取落在 column 裡（非 textblock）→ 不丟錯、不改文件", (key) => {
    const editor = mount([row([[P("a", "a1")], [P("b", "b1")]], "r"), Z()], { collab: true });
    const before = shape(editor);
    expect(editor.prosemirrorView!.state.selection.$from.parent.type.name).toBe("column");
    expect(() => pressKey(editor, key)).not.toThrow();
    expect(shape(editor)).toBe(before);
  });

  it("Delete：TextSelection 落在欄內表格節點結尾（parent 是 table、非 textblock）→ 欄邊鍵盤處理不接手，結果與不裝它的 core 相同", () => {
    const table: PartialBlockLike = { id: "t1", type: "table", content: { type: "tableContent", rows: [{ cells: ["c1", "c2"] }] } };
    const run = (editor: AnyEditor) => {
      const view = editor.prosemirrorView!;
      const t = findTable(editor);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TextSelection 從現行選取的 constructor 取
      const Sel = view.state.selection.constructor as any;
      view.dispatch(view.state.tr.setSelection(Sel.create(view.state.doc, t.pos + t.size - 1)));
      expect(view.state.selection.$from.parent.type.name).toBe("table");
      pressKey(editor, "Delete");
      return shape(editor);
    };
    const core = mountEditor(W([[table], [P("b", "b1")]]));
    cleanups.push(core.destroy);
    const coreShape = run(core.editor);
    expect(coreShape).toBe("paragraph:x  table  paragraph  paragraph:b  paragraph:z");
    expect(run(mount(W([[table], [P("b", "b1")]])))).toBe(coreShape);
  });
});

function findTable(editor: AnyEditor): { pos: number; size: number } {
  let hit: { pos: number; size: number } | undefined;
  editor.prosemirrorView!.state.doc.descendants((node, pos) => {
    if (node.type.name === "table") hit = { pos, size: node.nodeSize };
  });
  return hit!;
}

describe("K-NOREF editorRef 還沒設好（current 為 null）", () => {
  it.each([
    ["Backspace", "b1", "start", "paragraph:x  paragraph:a  paragraph  paragraph:b  paragraph:z / b@0"],
    ["Delete", "a1", "end", "paragraph:x  paragraph:a  paragraph  paragraph:b  paragraph:z / b@0"],
  ] as const)("%s：欄邊鍵盤處理不接手、不丟錯，結果是 core 的", (key, id, where, expected) => {
    const m = mountEditor(W([[P("a", "a1")], [P("b", "b1")]]), { extensions: [createColumnEdgeKeymapExtension({ editorRef: { current: null } })] });
    cleanups.push(m.destroy);
    m.editor.setTextCursorPosition(id, where);
    expect(() => pressKey(m.editor, key)).not.toThrow();
    expect(shape(m.editor) + " / " + cursorOf(m.editor)).toBe(expected);
  });
});
