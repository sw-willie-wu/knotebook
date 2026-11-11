import type { BlockNoteEditor, PartialBlock } from "@blocknote/core";
import { COLUMN_LIST_TYPE, COLUMN_TYPE } from "@knotebook/shared";
import { replaceBlocksKeepColumns } from "./keep-columns";
import { findNodeById } from "./position";
import { asUndoStep } from "./undo-step";

/**
 * 建立與拆除並排（`/grid N` 與取消並排）。
 * 兩者都是一個結構操作＝一個撤銷步：`asUndoStep` 包住單一 `editor.transact`。
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組（repo 慣例）
type AnyEditor = BlockNoteEditor<any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
type AnyPartialBlock = PartialBlock<any, any, any>;

/** /grid 可用：游標所在 block 是頂層（getParentBlock 為 undefined）且不是 table。 */
export function canInsertColumns(editor: AnyEditor): boolean {
  const { block } = editor.getTextCursorPosition();
  return block.type !== "table" && editor.getParentBlock(block.id) === undefined;
}

/** 空段落＝沒有文字也沒有子 block（有子 block 時換掉會丟內容，改插在後面）。 */
function isEmptyParagraph(block: { type: string; content?: unknown; children: unknown[] }): boolean {
  return block.type === "paragraph" && Array.isArray(block.content) && block.content.length === 0 && block.children.length === 0;
}

/** 空段落 → 換成新列；否則插在後面。N 欄、各一空段落、width 1；游標進第 1 欄；新列是最後一個 block 時後面補空段落。單一撤銷步。回新列 id。 */
export function insertColumns(editor: AnyEditor, n: 2 | 3 | 4): string {
  return asUndoStep(editor, () =>
    editor.transact((tr) => {
      const { block } = editor.getTextCursorPosition();
      const newRow: AnyPartialBlock = {
        type: COLUMN_LIST_TYPE,
        children: Array.from({ length: n }, () => ({ type: COLUMN_TYPE, props: { width: 1 }, children: [{ type: "paragraph" }] })),
      };
      const inserted = isEmptyParagraph(block)
        ? replaceBlocksKeepColumns(editor, [block.id], [newRow]).insertedBlocks[0]!
        : editor.insertBlocks([newRow], block.id, "after")[0]!;
      // 文件結尾的列用鍵盤出不去。
      if (tr.doc.firstChild?.lastChild?.attrs.id === inserted.id) editor.insertBlocks([{ type: "paragraph" }], inserted.id, "after");
      editor.setTextCursorPosition(inserted.children[0]!.children[0]!.id, "start");
      return inserted.id;
    }),
  );
}

export function isInColumn(editor: AnyEditor, blockId: string): boolean {
  return editor.getParentBlock(blockId)?.type === COLUMN_TYPE;
}

/** 取消並排：block 所在列攤平成「第 1 欄全部、第 2 欄全部…」，丟掉「無文字且無子 block 的段落」；全部丟光時留一個空段落。單一交易、單一撤銷步。不在欄內 → 回 false 不動。 */
export function ungroupColumns(editor: AnyEditor, blockId: string): boolean {
  if (!isInColumn(editor, blockId)) return false;
  const rowId = editor.getParentBlock(editor.getParentBlock(blockId)!.id)!.id;
  return asUndoStep(editor, () =>
    editor.transact((tr) => {
      const hit = findNodeById(tr.doc, rowId, COLUMN_LIST_TYPE);
      const list = hit && tr.doc.nodeAt(hit.pos);
      if (!hit || !list) return false;
      const all: NonNullable<typeof list>[] = [];
      list.forEach((col) => col.forEach((container) => void all.push(container)));
      const kept = all.filter(
        (container) => !(container.childCount === 1 && container.firstChild!.type.name === "paragraph" && container.firstChild!.content.size === 0),
      );
      // 全部丟光：留第 1 欄的第一顆空段落（沿用它的 id）。
      if (kept.length === 0) kept.push(all[0]!);
      tr.replaceWith(hit.pos, hit.pos + list.nodeSize, kept);
      editor.setTextCursorPosition(kept[0]!.attrs.id as string, "start");
      return true;
    }),
  );
}
