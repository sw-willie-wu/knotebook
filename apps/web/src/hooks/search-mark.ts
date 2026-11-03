import { isOverlayOpen } from "@/lib/versions-context";

/**
 * 搜尋跳轉留下的常駐標記（`useBlockAnchor.ts` 的 `scrollToBlock` 帶 `findText` 時）的「取消」匯流排。
 *
 * 標記的擁有者是 `scrollToBlock`（它在編輯器的捲動容器裡疊浮層）；但「關閉搜尋」發生在側欄（`AppShell` 的搜尋字串、`sidebar-tab` 的切 tab），
 * 兩邊沒有父子關係、也不在同一棵 context 下（側欄有兩份實例）——所以用這條模組層級的匯流排：標記存在期間訂閱，側欄那邊呼叫 `clearSearchMark()`。
 * 沒有標記時沒有訂閱者，呼叫是空操作。
 */
const listeners = new Set<() => void>();

/** Radix Toast 開著的列（與 `SelectHeader.tsx` 的 OPEN_TOAST 同一個選擇器）。 */
const OPEN_TOAST = 'li[data-swipe-direction][data-state="open"]';

/**
 * 搜尋標記（與還在等筆記就緒的搜尋跳轉）共用的 Esc 監聽：別人的 Esc 不搶、也不被別人的 Esc 清掉。回傳取消監聽。
 *
 * 讓路條件（任一成立就不清）：輸入法組字中；有浮層開著（`isOverlayOpen`）；按下當下有開著的 toast（Radix Toast 關自己時不
 * `preventDefault`，一下 Esc 只關一層）；Esc 已被別人處理（`defaultPrevented`：Radix 對話框／選單、選取模式、ProseMirror 的選單）。
 * 判斷延到所有監聽都跑完之後（setTimeout 0）：不依賴監聽的註冊順序，後註冊的人才 preventDefault 也看得到。
 *
 * 例外（BlockNote 的 `OverrideEscape`）：焦點在編輯器時按 Esc，BlockNote 先 `blur()` 編輯器、再讓 ProseMirror `preventDefault`——
 * 這一下 Esc 其實沒有任何選單吃掉，只是離開編輯器。所以「已 `defaultPrevented`、目標在 `.ProseMirror` 內、而且焦點已不在編輯器」
 * 視為一般 Esc、照樣清。slash menu 的 Esc 焦點留在編輯器（不清）；AI 框與 mermaid 的 Esc 有 `stopPropagation`，window 收不到。
 */
export function watchSearchEscape(onEscape: () => void): () => void {
  let toastOpenAt: Event | null = null;
  const capture = (event: KeyboardEvent) => {
    toastOpenAt = event.key === "Escape" && document.querySelector(OPEN_TOAST) !== null ? event : null;
  };
  const handler = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.isComposing || isOverlayOpen()) return;
    if (toastOpenAt === event) return;
    setTimeout(() => {
      if (!event.defaultPrevented || blurredOutOfEditor(event)) onEscape();
    }, 0);
  };
  window.addEventListener("keydown", capture, { capture: true });
  window.addEventListener("keydown", handler);
  return () => {
    window.removeEventListener("keydown", capture, { capture: true });
    window.removeEventListener("keydown", handler);
  };
}

function blurredOutOfEditor(event: Event): boolean {
  const target = event.target;
  if (!(target instanceof Element) || target.closest(".ProseMirror") === null) return false;
  return document.activeElement?.closest(".ProseMirror") == null;
}

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
