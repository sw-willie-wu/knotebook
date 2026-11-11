/**
 * 功能導覽交易過濾的開關（外掛本體在 `tour-transaction-filter.ts`）。
 *
 * 這支在首包（`lib/tour-bridge.ts` 經它開關），所以**不 import 任何東西**：外掛那支會拉進 tiptap 與 ProseMirror，
 * 只有筆記頁的 chunk 用得到。由 `lib/tour-bridge.guard.test.ts` 守住。
 */

/** 導覽自己的交易帶這個 meta，開著時照樣放行。 */
export const TOUR_TRANSACTION_META = "knotebook:tour";

/** 開著過濾的 tiptap 編輯器實例。 */
const filtering = new WeakSet<object>();

/** 開關某個 tiptap 編輯器（BlockNote 的 `_tiptapEditor`）的過濾。不 dispatch 任何交易，編輯器卸載後呼叫也安全。 */
export function setTourTransactionFilter(tiptapEditor: object, on: boolean): void {
  if (on) filtering.add(tiptapEditor);
  else filtering.delete(tiptapEditor);
}

export function isTourTransactionFilterOn(tiptapEditor: object): boolean {
  return filtering.has(tiptapEditor);
}
