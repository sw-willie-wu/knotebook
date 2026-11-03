/**
 * 搜尋跳轉留下的常駐標記（`useBlockAnchor.ts` 的 `scrollToBlock` 帶 `findText` 時）的「取消」匯流排。
 *
 * 標記的擁有者是 `scrollToBlock`（它在編輯器的捲動容器裡疊浮層）；但「關閉搜尋」發生在側欄（`AppShell` 的搜尋字串、`sidebar-tab` 的切 tab），
 * 兩邊沒有父子關係、也不在同一棵 context 下（側欄有兩份實例）——所以用這條模組層級的匯流排：標記存在期間訂閱，側欄那邊呼叫 `clearSearchMark()`。
 * 沒有標記時沒有訂閱者，呼叫是空操作。
 */
const listeners = new Set<() => void>();

/** 標記（或還在等 block 出現的搜尋跳轉）訂閱；回傳取消訂閱。 */
export function onSearchMarkClear(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 關閉搜尋（搜尋字清空、切 tab）時呼叫：移除現有的常駐標記。 */
export function clearSearchMark(): void {
  for (const fn of Array.from(listeners)) fn();
}
