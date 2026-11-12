import { createContext, useContext } from "react";

/**
 * 說明視窗（快捷鍵、功能導覽、這一版新增）的開關（Ctrl+/ 的監聽器與 state 在 `AppShell`；這裡只放 context 宣告，比照 `sidebar-drawer.ts`，
 * 讓 `UserMenu` 不必 import `AppShell.tsx`——AppShell→SidebarContent→UserMenu→AppShell 的循環）。
 */

/** 打開時停在哪一頁：`tour`＝「功能導覽」頁，`global`＝快捷鍵的「通用」頁。 */
export type ShortcutsStartPage = "tour" | "global";

export interface ShortcutsDialogApi {
  /**
   * 打開說明視窗；`returnFocusTo`＝關閉時要還焦點的元素（選單開的＝UserMenu 觸發鈕），不給就用開啟當下的焦點元素。
   * `page` 不給＝快捷鍵的「通用」頁。
   */
  open: (returnFocusTo?: HTMLElement | null, page?: ShortcutsStartPage) => void;
}

/** null＝不在 AppShell 底下（例如單獨渲染 UserMenu 的測試）：選單就不渲染這一項，不給一顆點了沒反應的死項。 */
export const ShortcutsDialogContext = createContext<ShortcutsDialogApi | null>(null);

export function useShortcutsDialog(): ShortcutsDialogApi | null {
  return useContext(ShortcutsDialogContext);
}
