/**
 * 欄首 Backspace／欄尾 Delete。
 *
 * - 理由是**結構與順序正確、接住例外**，不是防丟字（core 不丟字）。core 在這兩個位置會多留一個空段落、
 *   把同列其他空欄一起收掉、把 block 插到錯的位置，列在文件尾時最後一欄結尾 Delete 還會丟例外。
 * - **不呼叫 `fixColumnList`**：它收的是同列**所有**空欄，使用者刻意留的空欄會被一起拿掉。這裡只處理來源欄：
 *   空了才刪；列只剩兩欄時用另一欄的內容一步取代整列（分兩步先刪欄，PM 會補回一個空欄）。
 * - `priority: 1000`：要先於 core `KeyboardShortcutsExtension`（50）的 Backspace／Delete 鏈；條件不成立一律回 false 交還 core。
 * - 位置條件成立後先試 `undoInputRule`（排在空欄特例之前）：core 的 Backspace 鏈第一步就是它，我們搶在前面接手就得自己先試，否則剛觸發的 input rule
 *   撤不回、反而被搬走。
 * - Delete 端排除程式碼區塊：交還 core 自己的程式碼區塊 Delete（空程式碼區塊會被刪掉並收欄）；吞掉的情形也不含它。
 * - 測試必須用真 keydown（`view.someProp("handleKeyDown", …)`）；`commands.keyboardShortcut()` 會把多 step 交易重播、量到假象。
 *
 * tiptap 的回呼只給 tiptap 編輯器；`transact`／`asUndoStep` 要 BlockNote 編輯器，從 `editorRef` 取（同 markdown-link）。
 */
import { Extension, isTextSelection, type Editor } from "@tiptap/core";
import { isEmptyColumn, removeAndInsertBlocks } from "@blocknote/core";
import { COLUMN_LIST_TYPE, COLUMN_TYPE } from "@knotebook/shared";
import type { EditorRef } from "@/components/wikilink/menu";
import { columnContextOf, findNodeById, type ColumnContext, type PMNodeLike } from "./position";
import { asUndoStep } from "./undo-step";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- PM Transaction／Node 在 apps/web 值層級拿不到
type Any = any;
type BnEditor = NonNullable<EditorRef["current"]>;

interface EdgeContext extends ColumnContext {
  atStart: boolean;
  atEnd: boolean;
}

function edgeContext(state: Editor["state"]): EdgeContext | null {
  const { selection } = state;
  if (!isTextSelection(selection) || !selection.empty) return null;
  const { $from } = selection;
  // 列開頭的文件剛載入時，y-prosemirror 的 _forceRerender 可能留下 parent 是 column 的 TextSelection。
  if (!$from.parent.isTextblock) return null;
  const ctx = columnContextOf($from as Any);
  if (!ctx) return null;
  return { ...ctx, atStart: $from.parentOffset === 0, atEnd: $from.parentOffset === $from.parent.content.size };
}

const idOf = (node: PMNodeLike) => node.attrs.id as string;
/** block 開頭；非 textblock（圖片等 leaf）給它前面的位置，交給 `Selection.near`（bias 1）選到那個節點。 */
const blockStart = (doc: Any, id: string) => {
  const b = findNodeById(doc, id, "blockContainer")!;
  return b.pos + (b.node.firstChild!.isTextblock ? 2 : 1);
};
const blockEnd = (doc: Any, id: string) => {
  const b = findNodeById(doc, id, "blockContainer")!;
  return b.pos + b.node.firstChild!.nodeSize;
};

/** 刪掉一欄；列只有兩欄時以另一欄的內容一步取代整列。 */
function dropColumn(tr: Any, listId: string, colId: string): void {
  const list = findNodeById(tr.doc, listId, COLUMN_LIST_TYPE)!;
  if (list.node.childCount === 2) {
    const other = list.node.child(0).attrs.id === colId ? list.node.child(1) : list.node.child(0);
    tr.replaceWith(list.pos, list.pos + list.node.nodeSize, (other as Any).content);
    return;
  }
  const col = findNodeById(tr.doc, colId, COLUMN_TYPE)!;
  tr.delete(col.pos, col.pos + col.node.nodeSize);
}

/** 把 `movedId` 搬到目標欄（尾端，或 `afterId` 之後）；目標欄是空欄時取代它的空段落。來源欄空了就刪。 */
function moveBlock(tr: Any, movedId: string, srcColId: string, tgtColId: string, listId: string, afterId: string | null): void {
  const moved = findNodeById(tr.doc, movedId, "blockContainer")!.node;
  removeAndInsertBlocks(tr, [movedId], [], { fixColumns: false });
  const target = findNodeById(tr.doc, tgtColId, COLUMN_TYPE)!;
  if (isEmptyColumn(target.node as Any)) {
    const empty = target.node.firstChild!;
    tr.replaceWith(target.pos + 1, target.pos + 1 + empty.nodeSize, moved);
  } else if (afterId === null) {
    tr.insert(target.pos + target.node.nodeSize - 1, moved);
  } else {
    const after = findNodeById(tr.doc, afterId, "blockContainer")!;
    tr.insert(after.pos + after.node.nodeSize, moved);
  }
  const src = findNodeById(tr.doc, srcColId, COLUMN_TYPE);
  if (src && isEmptyColumn(src.node as Any)) dropColumn(tr, listId, srcColId);
}

/** 一筆交易、一個撤銷步；`build` 回傳游標位置，在同一交易以 `Selection.near` 設定。 */
function apply(editor: BnEditor, state: Editor["state"], build: (tr: Any) => number): true {
  const SelectionCtor = state.selection.constructor as Any;
  asUndoStep(editor, () =>
    editor.transact((tr) => {
      const pos = build(tr);
      tr.setSelection(SelectionCtor.near(tr.doc.resolve(pos)));
    }),
  );
  return true;
}

export function createColumnEdgeKeymapExtension(opts: { editorRef: EditorRef }): Extension {
  return Extension.create({
    name: "knotebookColumnEdgeKeys",
    priority: 1000,
    addKeyboardShortcuts() {
      return {
        Backspace: ({ editor: tiptap }) => {
          const editor = opts.editorRef.current;
          if (!editor) return false;
          const c = edgeContext(tiptap.state);
          if (!c || !c.atStart || c.blockIndex !== 0) return false;
          if (tiptap.commands.undoInputRule()) return true;
          const listId = idOf(c.list);
          const colId = idOf(c.col);
          // 特例：那欄唯一的空段落（含第 1 欄）→ 只刪這一欄。
          if (isEmptyColumn(c.col as Any)) {
            const prev = c.colIndex > 0 ? c.list.child(c.colIndex - 1) : null;
            const cursorId = prev ? idOf(prev.lastChild!) : idOf(c.list.child(1).firstChild!);
            return apply(editor, tiptap.state, (tr) => {
              dropColumn(tr, listId, colId);
              return prev ? blockEnd(tr.doc, cursorId) : blockStart(tr.doc, cursorId);
            });
          }
          if (c.colIndex === 0) return false;
          if (c.block.firstChild!.type.name !== "paragraph") return false;
          const movedId = idOf(c.block);
          const prevColId = idOf(c.list.child(c.colIndex - 1));
          return apply(editor, tiptap.state, (tr) => {
            moveBlock(tr, movedId, colId, prevColId, listId, null);
            return blockStart(tr.doc, movedId);
          });
        },
        Delete: ({ editor: tiptap }) => {
          const editor = opts.editorRef.current;
          if (!editor) return false;
          const c = edgeContext(tiptap.state);
          if (!c || !c.atEnd || c.blockIndex !== c.col.childCount - 1) return false;
          if (c.block.childCount !== 1 || c.block.firstChild!.type.name === "codeBlock") return false;
          // 最後一欄：列之後沒有任何 block 時吞掉（core 會丟例外）；否則交還 core。
          if (c.colIndex === c.list.childCount - 1) return !tiptap.state.doc.resolve(c.listPos + c.list.nodeSize).nodeAfter;
          const listId = idOf(c.list);
          const colId = idOf(c.col);
          const curId = idOf(c.block);
          const next = c.list.child(c.colIndex + 1);
          if (isEmptyColumn(next as Any)) {
            return apply(editor, tiptap.state, (tr) => {
              dropColumn(tr, listId, idOf(next));
              return blockEnd(tr.doc, curId);
            });
          }
          const movedId = idOf(next.firstChild!);
          return apply(editor, tiptap.state, (tr) => {
            moveBlock(tr, movedId, idOf(next), colId, listId, curId);
            // 原 block 就是被取代的空段落時，游標放被搬 block 開頭。
            return findNodeById(tr.doc, curId, "blockContainer") ? blockEnd(tr.doc, curId) : blockStart(tr.doc, movedId);
          });
        },
      };
    },
  });
}
