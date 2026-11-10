import { removeAndInsertBlocks, type Block, type BlockIdentifier, type BlockNoteEditor, type PartialBlock } from "@blocknote/core";

/**
 * **我們程式發動的**移除／取代一律走這裡，不收欄、不攤平。
 * core 的 `editor.removeBlocks`／`replaceBlocks` 預設跑 `fixColumnList`：移光某欄 → 欄被拿掉、剩一欄的列被攤平成一般 block。
 * 改用 `removeAndInsertBlocks(…, { fixColumns: false })`，列與欄數不變；被移光的欄由 PM 的 replace fitter 補一個空段落。
 * 七處：AI 套用、AI 撤回、mermaid 貼上轉換、上傳失敗清 placeholder、側選單「刪除」、自家檔案刪除鈕、`AiToolbar` 把原生刪除鈕換成自家版
 * （守衛：`keep-columns.guard.test.ts`）。
 *
 * 不在範圍：core 自己的鍵盤路徑——表格（`Table/block.ts:485`）與程式碼區塊（`Code/block.ts:193`）的刪除鍵照 core 收欄。
 *
 * 共編實測（`probe-collab` 情境 4／5）：B 用 `removeBlocks` 刪同列另一欄的圖、A 同時在剩下那欄打字 → 合併後列被攤平、
 * A 的字被吃掉；改用 `fixColumns: false` → 列仍兩欄、A 的字保留。
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組（repo 慣例）
type AnyEditor = BlockNoteEditor<any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
type AnyBlock = Block<any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
type AnyPartialBlock = PartialBlock<any, any, any>;

/** 回 removedBlocks。 */
export function removeBlocksKeepColumns(editor: Pick<AnyEditor, "transact">, ids: BlockIdentifier[]): AnyBlock[] {
  return editor.transact((tr) => removeAndInsertBlocks(tr, ids, [], { fixColumns: false }).removedBlocks);
}

export function replaceBlocksKeepColumns(
  editor: Pick<AnyEditor, "transact">,
  ids: BlockIdentifier[],
  blocks: AnyPartialBlock[],
): { insertedBlocks: AnyBlock[]; removedBlocks: AnyBlock[] } {
  return editor.transact((tr) => removeAndInsertBlocks(tr, ids, blocks, { fixColumns: false }));
}
