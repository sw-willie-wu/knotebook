import { exitOwnedFullscreen } from "./fullscreen";

/**
 * #229 簡報模式的網址小工具（入口側，首包）。
 * - `?present`：五種筆記網址形自動適用（D4）；開簡報時 search 一律正規化成恰好這個字串（§6.4-1、F14）。
 * - 進入旗標：從 ⋮／公開頁按鈕 push 進來的 entry 只帶這一鍵（§6.3-3：不展開既有 state）；離開時有旗標
 *   → navigate(-1)，否則 replace 拿掉 present（§6.3-4）。
 * - hash：`#/<slide id>`（D4）；id 是 block id 或 `_title`。
 */
export const PRESENT_SEARCH = "?present";
const PRESENT_PARAM = "present";
export const PRESENT_PUSHED_KEY = "knotebookPresentPushed";

export function isPresentingSearch(search: string): boolean {
  return new URLSearchParams(search).has(PRESENT_PARAM);
}

export function searchWithoutPresent(search: string): string {
  const params = new URLSearchParams(search);
  params.delete(PRESENT_PARAM);
  const rest = params.toString();
  return rest === "" ? "" : `?${rest}`;
}

export function presentPushedState(): Record<string, true> {
  return { [PRESENT_PUSHED_KEY]: true };
}

export function wasPresentPushed(state: unknown): boolean {
  return typeof state === "object" && state !== null && (state as Record<string, unknown>)[PRESENT_PUSHED_KEY] === true;
}

export function hashForSlide(id: string): string {
  return `#/${encodeURIComponent(id)}`;
}

/** `#/<id>` → id；畸形百分比編碼、空 id、不是 `#/` 開頭 → null（RF1：不得 throw）。 */
export function slideIdFromHash(hash: string): string | null {
  if (!hash.startsWith("#/") || hash.length <= 2) return null;
  try {
    return decodeURIComponent(hash.slice(2));
  } catch {
    return null;
  }
}

/**
 * §6.5 卸載型呼叫點（外殼卸載、NotePage／PublicNotePage 卸載）：只在**真的離開**時退出。讀的是瀏覽器真實
 * 網址（不是 router 的 location）——真的離開時網址已不含 present；StrictMode 在 dev 的假卸載（掛→拆→掛）時
 * 網址仍含 present，不退出（gate K 案）。
 */
export function exitFullscreenIfLeftPresentation(): void {
  if (!isPresentingSearch(window.location.search)) exitOwnedFullscreen();
}
