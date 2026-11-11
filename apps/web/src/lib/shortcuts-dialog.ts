import { createContext, useContext } from "react";

/**
 * 快捷鍵介紹頁的開關（Ctrl+/ 的監聽器與 state 在 `AppShell`；這裡只放 context 宣告，比照 `sidebar-drawer.ts`，
 * 讓 `UserMenu` 不必 import `AppShell.tsx`——AppShell→SidebarContent→UserMenu→AppShell 的循環）。
 */
export interface ShortcutsDialogApi {
  /** 打開快捷鍵頁；`returnFocusTo`＝關閉時要還焦點的元素（選單開的＝UserMenu 觸發鈕）。不給就用開啟當下的焦點元素。 */
  open: (returnFocusTo?: HTMLElement | null) => void;
}

/** null＝不在 AppShell 底下（例如單獨渲染 UserMenu 的測試）：選單就不渲染這一項，不給一顆點了沒反應的死項。 */
export const ShortcutsDialogContext = createContext<ShortcutsDialogApi | null>(null);

export function useShortcutsDialog(): ShortcutsDialogApi | null {
  return useContext(ShortcutsDialogContext);
}
