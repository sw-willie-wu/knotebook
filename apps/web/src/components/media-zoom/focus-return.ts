const FOCUSABLE = '[tabindex]:not([tabindex="-1"]), button, a[href], [contenteditable="true"]';

/**
 * 放大畫面關閉後焦點要回到哪裡：`preferred`（開啟它的放大鈕）還在頁面上就回它；
 * 否則（放大鈕在檢視期間被移除，或本來就沒有）回 `fallback`（圖）自己或最近的可聚焦祖先；都沒有回 `null`。
 */
export function focusReturnTarget(preferred: HTMLElement | null, fallback: Element | null): HTMLElement | null {
  if (preferred?.isConnected) return preferred;
  for (let el = fallback; el !== null; el = el.parentElement) {
    if (el instanceof HTMLElement && el.isConnected && el.matches(FOCUSABLE)) return el;
  }
  return null;
}
