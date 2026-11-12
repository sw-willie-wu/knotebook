import { useCallback, useEffect, useRef, type KeyboardEvent, type RefObject } from "react";
import { useIsOverlay } from "@/lib/layout-tiers";
import { isOverlayOpen, useVersions } from "@/lib/versions-context";

// NoteEditor 裡包住面板（含載入失敗的錯誤外框）的 `display: contents` 節點；錯誤外框沒有面板的 testid，所以認這個。
export const PANEL_SLOT = "[data-versions-panel-slot]";
// 面板（含錯誤外框）、它開出來的選單與對話框（portal 在面板外）、歷史泡泡：在這些裡面按下去不算「點到筆記區」。
const KEEP_OPEN = `${PANEL_SLOT}, [data-testid="versions-bubble"], [role="dialog"], [role="menu"], [data-radix-popper-content-wrapper]`;

/**
 * 640-1279 的版本面板浮在筆記上，不是第三欄；收起的規則跟著狀態走，固定段（>= 1280）一律不套用：
 * - 只開了清單（沒有預覽）：在面板、歷史泡泡、它們開出的選單與對話框以外按下去就收起，與側欄抽屜一致。
 * - 差異檢視中（有預覽）：點筆記區不收，只有面板的 ✕ 與面板內按 Esc 會關。
 * - 面板內按 Esc：關面板（連預覽），焦點回到歷史泡泡（面板開著時泡泡不渲染，關了才掛上）。
 * 面板是非 modal 的，所以這裡用 document 的 pointerdown（capture）判斷，不靠遮罩。
 * 回傳的 `onKeyDown` 掛在列容器上（面板在它底下，React 事件冒泡先於 window 上的預覽 Esc 監聽）。
 */
export function useFloatingPanelDismiss(): { onKeyDown: (event: KeyboardEvent<HTMLElement>) => void } {
  const overlay = useIsOverlay();
  const { panelOpen, preview, dialog, close } = useVersions();
  const restoreFocusRef = useRef(false);

  useEffect(() => {
    if (!overlay || !panelOpen || preview !== null || dialog !== null) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || event.target.closest(KEEP_OPEN) !== null) return;
      // 有 modal（含側欄抽屜）開著時，點它的遮罩只關那個 modal，面板留在原位。
      if (document.querySelector('[role="dialog"]') !== null) return;
      close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [overlay, panelOpen, preview, dialog, close]);

  useEffect(() => {
    if (panelOpen || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    document.querySelector<HTMLElement>('[data-testid="versions-bubble"]')?.focus({ preventScroll: true });
  }, [panelOpen]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (!overlay || !panelOpen || event.key !== "Escape" || event.defaultPrevented) return;
      if (!(event.target instanceof Element) || event.target.closest(PANEL_SLOT) === null || isOverlayOpen()) return;
      event.preventDefault(); // 這一下 Esc 只關面板：頁面層「預覽中 Esc 離開預覽」的監聽看到 defaultPrevented 就讓路
      restoreFocusRef.current = true;
      close();
    },
    [overlay, panelOpen, close],
  );

  return { onKeyDown };
}

/**
 * 量 `headerEl` 的高度寫成列容器上的 `--note-header-h`：浮動面板的上緣要讓出頁首。
 * 直接寫 DOM 不走 state，頁首高度變動（換行、橫幅出現）不會讓 `NoteEditor` 重繪。
 * 量的是頁首加其下的版本預覽橫幅（橫幅在 headerSlot 裡）：橫幅右端的並排／單欄鈕不能被面板蓋住。
 */
export function useNoteHeaderHeight(rowRef: RefObject<HTMLElement | null>, headerRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const row = rowRef.current;
    const header = headerRef.current;
    if (row === null || header === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) row.style.setProperty("--note-header-h", `${entry.contentRect.height}px`);
    });
    observer.observe(header);
    return () => observer.disconnect();
  }, [rowRef, headerRef]);
}
