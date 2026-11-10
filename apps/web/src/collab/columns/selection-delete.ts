import type { BlockNoteEditor } from "@blocknote/core";
import { COLUMN_LIST_TYPE, COLUMN_TYPE } from "@knotebook/shared";

/**
 * 側選單 ⋮⋮「刪除」要刪哪些 block。
 *
 * core 的跨欄選取：`getSelection().blocks` 先放起點所在的 block，再從起點那層逐層往上、放每層在它之後的兄弟，
 * 到起點與終點的共同祖先那層為止，最後放該層到終點為止的節點——跨欄時含 **column 節點本身**，
 * 從列上方選進來時含**整個 columnList**。照 core 逐項刪會把整欄（含選取終點以下沒選到的 block）一起刪掉，
 * 所以先把欄／列項展開成「節點範圍與選取重疊的直接子 block」；只有選取從列上方跨到列下方時才保留整列（整列刪掉，同 core）。
 *
 * 多選判斷用展開後的集合：core 只在點的 block 出現在 `blocks` 裡時才當多選，跨欄時點第 2 欄以後的 block 會只刪那一顆。
 * 另認一種：點的 block 的祖先 **columnList** 在集合裡（整列被選、點列內的 block）。只認列、不認一般父 block——
 * 否則在父 block 裡選一個字、再對子 block 開 ⋮⋮，會把父 block 連沒選的兄弟一起刪掉。
 *
 * 不變量：`blocks` 不含欄／列項時，回傳的 id 串與 core 的規則（點的 block 在 `blocks` 裡 → 全部、否則只刪它）完全相同。
 * 刪除本身由呼叫端交給 `removeBlocksKeepColumns`（一個交易、撤銷一步）。
 * 若要動 core 內部、或與 core 選取／撤銷衝突，就退回 core 行為。
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組（repo 慣例）
type AnyEditor = BlockNoteEditor<any, any, any>;
type SelectionDeleteEditor = Pick<AnyEditor, "prosemirrorState" | "getSelection" | "getParentBlock">;
type PMNode = AnyEditor["prosemirrorState"]["doc"];

function findBlockNode(doc: PMNode, id: string): { node: PMNode; pos: number } | undefined {
  let hit: { node: PMNode; pos: number } | undefined;
  doc.descendants((node, pos) => {
    if (hit) return false;
    if (node.type.isInGroup("bnBlock") && node.attrs.id === id) {
      hit = { node, pos };
      return false;
    }
    return true;
  });
  return hit;
}

/** 把 getSelection().blocks 裡的 column／columnList 項展開成選取範圍內的 block id（調整 2 補充第 1 點）。 */
export function blockIdsInSelectionForDelete(editor: Pick<AnyEditor, "prosemirrorState">, blocks: readonly { id: string; type: string }[]): string[] {
  const { doc, selection } = editor.prosemirrorState;
  const { from, to } = selection;
  const out: string[] = [];
  const childrenInRange = (column: PMNode, columnPos: number) => {
    let start = columnPos + 1;
    column.forEach((child) => {
      const end = start + child.nodeSize;
      if (start < to && end > from) out.push(child.attrs.id as string);
      start = end;
    });
  };
  for (const block of blocks) {
    const hit = block.type === COLUMN_TYPE || block.type === COLUMN_LIST_TYPE ? findBlockNode(doc, block.id) : undefined;
    if (!hit) {
      out.push(block.id);
    } else if (block.type === COLUMN_TYPE) {
      childrenInRange(hit.node, hit.pos);
    } else if (from <= hit.pos && hit.pos + hit.node.nodeSize <= to) {
      out.push(block.id);
    } else {
      let columnPos = hit.pos + 1;
      hit.node.forEach((column) => {
        childrenInRange(column, columnPos);
        columnPos += column.nodeSize;
      });
    }
  }
  return [...new Set(out)];
}

function insideSelectedRow(editor: Pick<AnyEditor, "getParentBlock">, id: string, ids: readonly string[]): boolean {
  for (let parent = editor.getParentBlock(id); parent; parent = editor.getParentBlock(parent.id)) {
    if (parent.type === COLUMN_LIST_TYPE && ids.includes(parent.id)) return true;
  }
  return false;
}

/** ⋮⋮ Delete 開在 clickedId 上時要刪的 id（補充第 3 點）：沒有選取 → [clickedId]；點的 block 屬於多選 → 展開後的集合；否則 [clickedId]。 */
export function blockIdsForMenuDelete(editor: SelectionDeleteEditor, clickedId: string): string[] {
  const selected = editor.getSelection()?.blocks;
  if (!selected) return [clickedId];
  const ids = blockIdsInSelectionForDelete(editor, selected);
  const multi = ids.includes(clickedId) || selected.some((b) => b.id === clickedId) || insideSelectedRow(editor, clickedId, ids);
  return multi ? ids : [clickedId];
}
