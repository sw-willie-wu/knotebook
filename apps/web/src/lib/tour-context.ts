import { createContext, useContext } from "react";

/**
 * 功能導覽的開關（`components/tour/TourProvider.tsx` 在 App 層提供）。這裡只放 context 宣告與型別，比照 `shortcuts-dialog.ts`：
 * 打開導覽的元件（說明視窗）只 import 這支，不會把導覽本體帶進自己的 chunk。
 */

export interface TourStartOptions {
  /** 結束後要回到的位置（路徑＋search＋hash）。由打開導覽的地方傳入：打開當下的位置。 */
  returnTo: string;
  /**
   * 結束後要聚焦的元素的查找函式，不是元素本身：從首頁打開時那份側欄會隨導頁卸載、
   * 窄視窗的觸發鈕在已經關掉的抽屜裡，開始時記下的元素到結束時多半已經不在了。
   */
  returnFocus: () => Element | null;
}

export interface TourApi {
  /** 開始一輪功能導覽；已經有一輪在進行（含還在準備示範筆記）時不動作。 */
  start: (options: TourStartOptions) => void;
}

/** null＝不在 `TourProvider` 底下（例如單獨渲染說明視窗的測試）：入口就不渲染，不給一顆按了沒反應的鈕。 */
export const TourContext = createContext<TourApi | null>(null);

export function useTour(): TourApi | null {
  return useContext(TourContext);
}
