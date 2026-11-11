import { afterEach, describe, expect, it } from "vitest";
import { COLUMN_LIST_TYPE, COLUMN_TYPE } from "@knotebook/shared";
import { collabUndoManager } from "@/collab/undo";
import { P, integrity, mountEditor, row, shape, textPos, withChildren, type AnyEditor, type PartialBlockLike } from "@/test/columns-fixtures";
import { removeBlocksKeepColumns } from "./keep-columns";
import { blockIdsForMenuDelete, blockIdsInSelectionForDelete } from "./selection-delete";

// ⋮⋮ Delete 的刪除對象。表一（展開）、表二（多選判斷）的期望值逐字取自實際選取的輸出。

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function mount(content: PartialBlockLike[]): AnyEditor {
  const m = mountEditor(content);
  cleanups.push(m.destroy);
  return m.editor;
}

const W = (cols: PartialBlockLike[][]): PartialBlockLike[] => [P("x", "x0"), row(cols, "r"), P("z", "z9")];
const TWO_ROWS = (): PartialBlockLike[] => [
  P("x", "x0"),
  row([[P("a", "a1")], [P("b", "b1")]], "r"),
  P("m", "m1"),
  row([[P("c", "c1")], [P("d", "d1")]], "s"),
  P("z", "z9"),
];
const C1 = () => W([[P("a", "a1")], [P("b", "b1"), P("q", "q1")]]);
const C4 = () => W([[P("a", "a1")], [P("b", "b1")], [P("c", "c1")]]);
const AK_BQ = () => W([[P("a", "a1"), P("k", "k1")], [P("b", "b1"), P("q", "q1")]]);
const AB = () => W([[P("a", "a1")], [P("b", "b1")]]);
const C11 = () => W([[P("a", "a1")], [withChildren(P("b", "b1"), [P("k", "k1")]), P("q", "q1")]]);
const BB_KQ = () => [P("x", "x0"), withChildren(P("bb", "b1"), [P("k", "k1"), P("q", "q1")]), P("z", "z9")];
const A_BK = () => [P("a", "a1"), withChildren(P("b", "b1"), [P("k", "k1")]), P("z", "z9")];
const ROW_BB_KQ = () => W([[P("a", "a1")], [withChildren(P("bb", "b1"), [P("k", "k1"), P("q", "q1")])]]);

/** `bb` 裡選第 1 個字（不跨 block 的文字選取）。 */
function selectFirstCharOfBb(editor: AnyEditor): void {
  editor.setTextCursorPosition("b1", "start");
  editor.transact((tr) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TextSelection 從現行選取的 constructor 取，沒有可 import 的型別
    tr.setSelection((tr.selection.constructor as any).create(tr.doc, textPos(editor, "bb", 0), textPos(editor, "bb", 1))),
  );
}

const blocksOf = (editor: AnyEditor) => editor.getSelection()!.blocks.map((b) => `${b.id}:${b.type}`).join(", ");

type Sd1Row = [string, () => PartialBlockLike[], string, string, string, string[], string];
const SD1: Sd1Row[] = [
    ["C1", C1, "a1", "b1", "a1:paragraph, rc1:column", ["a1", "b1"], "paragraph:x  ROW[COL(paragraph) | COL(paragraph:q)]  paragraph:z"],
    [
      "C2",
      () => W([[P("a", "a1"), P("k", "k1")], [P("b", "b1")]]),
      "a1",
      "k1",
      "a1:paragraph, k1:paragraph",
      ["a1", "k1"],
      "paragraph:x  ROW[COL(paragraph) | COL(paragraph:b)]  paragraph:z",
    ],
    ["C3", AK_BQ, "k1", "b1", "k1:paragraph, rc1:column", ["k1", "b1"], "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:q)]  paragraph:z"],
    ["C4", C4, "a1", "b1", "a1:paragraph, rc1:column", ["a1", "b1"], "paragraph:x  ROW[COL(paragraph) | COL(paragraph) | COL(paragraph:c)]  paragraph:z"],
    [
      "C5",
      () => W([[P("a", "a1")], [P("b", "b1")], [P("c", "c1"), P("r", "r1")]]),
      "a1",
      "c1",
      "a1:paragraph, rc1:column, rc2:column",
      ["a1", "b1", "c1"],
      "paragraph:x  ROW[COL(paragraph) | COL(paragraph) | COL(paragraph:r)]  paragraph:z",
    ],
    [
      "C6",
      () => W([[P("a", "a1")], [P("b", "b1"), P("q", "q1")], [P("c", "c1"), P("r", "r1")]]),
      "b1",
      "c1",
      "b1:paragraph, q1:paragraph, rc2:column",
      ["b1", "q1", "c1"],
      "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph) | COL(paragraph:r)]  paragraph:z",
    ],
    ["C7", C1, "x0", "b1", "x0:paragraph, r:columnList", ["x0", "a1", "b1"], "ROW[COL(paragraph) | COL(paragraph:q)]  paragraph:z"],
    ["C8", AK_BQ, "b1", "z9", "b1:paragraph, q1:paragraph, z9:paragraph", ["b1", "q1", "z9"], "paragraph:x  ROW[COL(paragraph:a,paragraph:k) | COL(paragraph)]"],
    [
      "C9",
      AK_BQ,
      "a1",
      "z9",
      "a1:paragraph, k1:paragraph, rc1:column, z9:paragraph",
      ["a1", "k1", "b1", "q1", "z9"],
      "paragraph:x  ROW[COL(paragraph) | COL(paragraph)]",
    ],
    ["C10", AB, "x0", "z9", "x0:paragraph, r:columnList, z9:paragraph", ["x0", "r", "z9"], "paragraph"],
    ["C11", C11, "a1", "b1", "a1:paragraph, rc1:column", ["a1", "b1"], "paragraph:x  ROW[COL(paragraph) | COL(paragraph:q)]  paragraph:z"],
    [
      "C12",
      TWO_ROWS,
      "b1",
      "c1",
      "b1:paragraph, m1:paragraph, s:columnList",
      ["b1", "m1", "c1"],
      "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph)]  ROW[COL(paragraph) | COL(paragraph:d)]  paragraph:z",
    ],
];

describe("SD1 blockIdsInSelectionForDelete：表一", () => {
  it.each<Sd1Row>(SD1)("%s", (_name, content, from, to, blocks, ids, after) => {
    const editor = mount(content());
    const before = shape(editor);
    editor.setSelection(from, to);
    // 事實釘：core 的跨欄選取清單（core 升版時第一個紅）。
    expect(blocksOf(editor)).toBe(blocks);
    const got = blockIdsInSelectionForDelete(editor, editor.getSelection()!.blocks);
    expect(got).toEqual(ids);
    expect(() => removeBlocksKeepColumns(editor, got)).not.toThrow();
    expect(shape(editor)).toBe(after);
    expect(integrity(editor).valid).toBe(true);
    editor.undo();
    expect(shape(editor)).toBe(before);
  });
});

// 「撤銷一次就還原」也要在共編 UndoManager 下成立（app 的實際組態）；挑四形，期望與非共編逐字相同。
describe("SD1-COLLAB 表一四形在共編下：刪除結果相同、manager.undo() 一次回起始", () => {
  const COLLAB = SD1.filter(([name]) => ["C1", "C7", "C10", "C12"].includes(name));
  it("挑到的恰是四形（改名時不得靜默少跑）", () => {
    expect(COLLAB.map(([name]) => name)).toEqual(["C1", "C7", "C10", "C12"]);
  });

  it.each<Sd1Row>(COLLAB)("%s（共編）", (_name, content, from, to, blocks, ids, after) => {
    const m = mountEditor(content(), { collab: true });
    cleanups.push(m.destroy);
    const editor = m.editor;
    const manager = collabUndoManager(editor)!;
    expect(manager).toBeDefined();
    const before = shape(editor);
    editor.setSelection(from, to);
    expect(blocksOf(editor)).toBe(blocks);
    const got = blockIdsInSelectionForDelete(editor, editor.getSelection()!.blocks);
    expect(got).toEqual(ids);
    removeBlocksKeepColumns(editor, got);
    expect(shape(editor)).toBe(after);
    expect(integrity(editor).valid).toBe(true);
    manager.undo();
    expect(shape(editor)).toBe(before);
  });
});

describe("SD2 沒有欄／列項時原樣", () => {
  it("C2：回傳的就是 blocks 的 id 串、順序不變", () => {
    const editor = mount(W([[P("a", "a1"), P("k", "k1")], [P("b", "b1")]]));
    editor.setSelection("a1", "k1");
    const blocks = editor.getSelection()!.blocks;
    expect(blockIdsInSelectionForDelete(editor, blocks)).toEqual(blocks.map((b) => b.id));
    expect(blockIdsInSelectionForDelete(editor, blocks)).toEqual(["a1", "k1"]);
  });
});

describe("SD3 blockIdsForMenuDelete：表二", () => {
  const sel = (from: string, to: string) => (editor: AnyEditor) => editor.setSelection(from, to);
  it.each<[string, () => PartialBlockLike[], (editor: AnyEditor) => void, string, string[], string]>([
    ["R1", AB, sel("a1", "b1"), "b1", ["a1", "b1"], "paragraph:x  ROW[COL(paragraph) | COL(paragraph)]  paragraph:z"],
    ["R2", C1, sel("a1", "b1"), "b1", ["a1", "b1"], "paragraph:x  ROW[COL(paragraph) | COL(paragraph:q)]  paragraph:z"],
    ["R2q", C1, sel("a1", "b1"), "q1", ["q1"], "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b)]  paragraph:z"],
    ["R3", C1, sel("x0", "b1"), "a1", ["x0", "a1", "b1"], "ROW[COL(paragraph) | COL(paragraph:q)]  paragraph:z"],
    ["R4", C1, sel("x0", "b1"), "b1", ["x0", "a1", "b1"], "ROW[COL(paragraph) | COL(paragraph:q)]  paragraph:z"],
    ["R6", C4, sel("b1", "c1"), "c1", ["b1", "c1"], "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph) | COL(paragraph)]  paragraph:z"],
    ["C10-a", AB, sel("x0", "z9"), "a1", ["x0", "r", "z9"], "paragraph"],
    ["C10-x", AB, sel("x0", "z9"), "x0", ["x0", "r", "z9"], "paragraph"],
    ["C11-k", C11, sel("a1", "b1"), "k1", ["k1"], "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b,paragraph:q)]  paragraph:z"],
    ["N1", BB_KQ, selectFirstCharOfBb, "k1", ["k1"], "paragraph:x  paragraph:bb{paragraph:q}  paragraph:z"],
    ["N2", A_BK, sel("a1", "b1"), "k1", ["k1"], "paragraph:a  paragraph:b  paragraph:z"],
    [
      "C12-b",
      TWO_ROWS,
      sel("b1", "c1"),
      "b1",
      ["b1", "m1", "c1"],
      "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph)]  ROW[COL(paragraph) | COL(paragraph:d)]  paragraph:z",
    ],
    [
      "C12-c",
      TWO_ROWS,
      sel("b1", "c1"),
      "c1",
      ["b1", "m1", "c1"],
      "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph)]  ROW[COL(paragraph) | COL(paragraph:d)]  paragraph:z",
    ],
    [
      "C12-d",
      TWO_ROWS,
      sel("b1", "c1"),
      "d1",
      ["d1"],
      "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b)]  paragraph:m  ROW[COL(paragraph:c) | COL(paragraph)]  paragraph:z",
    ],
  ])("%s", (_name, content, select, clicked, ids, after) => {
    const editor = mount(content());
    const before = shape(editor);
    select(editor);
    const got = blockIdsForMenuDelete(editor, clicked);
    expect(got).toEqual(ids);
    removeBlocksKeepColumns(editor, got);
    expect(shape(editor)).toBe(after);
    expect(integrity(editor).valid).toBe(true);
    editor.undo();
    expect(shape(editor)).toBe(before);
  });

  // 函式契約：⋮⋮ 只開在 blockContainer 上（core `getDraggableBlockFromElement`），UI 開不到欄節點；整列把手才會用到。
  it("點的 id 是 blocks 裡的欄節點本身（core 原本的條件；函式契約，UI 開不到）→ 展開後的集合", () => {
    const editor = mount(C1());
    editor.setSelection("a1", "b1");
    expect(blockIdsForMenuDelete(editor, "rc1")).toEqual(["a1", "b1"]);
  });

  it("沒有選取（游標在 b 內）→ 只刪點的 block", () => {
    const editor = mount(AB());
    editor.setTextCursorPosition("b1", "end");
    expect(editor.getSelection()).toBeUndefined();
    expect(blockIdsForMenuDelete(editor, "a1")).toEqual(["a1"]);
  });
});

describe("SD4 不變量：選取裡沒有欄／列項時與 core 規則完全相同", () => {
  it.each<[string, () => PartialBlockLike[], (editor: AnyEditor) => void, string, string[], string]>([
    ["N1", BB_KQ, selectFirstCharOfBb, "k1", ["k1"], "paragraph:x  paragraph:bb{paragraph:q}  paragraph:z"],
    ["N2", A_BK, (editor) => editor.setSelection("a1", "b1"), "k1", ["k1"], "paragraph:a  paragraph:b  paragraph:z"],
    ["N3", ROW_BB_KQ, selectFirstCharOfBb, "k1", ["k1"], "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:bb{paragraph:q})]  paragraph:z"],
    ["N4", BB_KQ, selectFirstCharOfBb, "q1", ["q1"], "paragraph:x  paragraph:bb{paragraph:k}  paragraph:z"],
    // 多選那一支：點的 block 在選取裡 → 刪整個選取。
    ["N5", () => [P("a", "a1"), P("b", "b1"), P("c", "c1")], (editor) => editor.setSelection("a1", "b1"), "a1", ["a1", "b1"], "paragraph:c"],
    [
      "N6",
      () => W([[P("a", "a1"), P("k", "k1")], [P("b", "b1")]]),
      (editor) => editor.setSelection("a1", "k1"),
      "k1",
      ["a1", "k1"],
      "paragraph:x  ROW[COL(paragraph) | COL(paragraph:b)]  paragraph:z",
    ],
  ])("%s", (_name, content, select, clicked, ids, after) => {
    const editor = mount(content());
    select(editor);
    const selected = editor.getSelection()!.blocks;
    expect(selected.filter((b) => b.type === COLUMN_TYPE || b.type === COLUMN_LIST_TYPE)).toEqual([]);
    const core = selected.some((b) => b.id === clicked) ? selected.map((b) => b.id) : [clicked];
    const got = blockIdsForMenuDelete(editor, clicked);
    expect(got).toEqual(core);
    expect(got).toEqual(ids);
    removeBlocksKeepColumns(editor, got);
    expect(shape(editor)).toBe(after);
  });
});
