import { useSyncExternalStore } from "react";

/** 寬＝`NARROW_QUERY`（`(width < 48rem)`）的反面，且滑鼠可 hover。不支援 range 語法的瀏覽器整條不成立 -> 窄。 */
export const WIDE_POINTER_QUERY = "(width >= 48rem) and (hover: hover) and (pointer: fine)";

/** 沒有 matchMedia（SSR／極舊環境）回 false。 */
export function isWidePointer(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(WIDE_POINTER_QUERY).matches;
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mql = window.matchMedia(WIDE_POINTER_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

/** 訂閱 `matchMedia(WIDE_POINTER_QUERY)` 的 change，翻轉即重繪。 */
export function useWidePointer(): boolean {
  return useSyncExternalStore(subscribe, isWidePointer, () => false);
}
