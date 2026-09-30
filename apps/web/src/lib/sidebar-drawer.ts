import { createContext, useCallback, useContext } from "react";

export interface SidebarDrawerState {
  setOpen: (open: boolean) => void;
}

/** #115：側欄抽屜的開關。刻意 null 起始＋throwing hook——`AppErrorFallback`
 * 那類「零 context 相依」的畫面本來就不該掛 `SidebarDrawerButton`，掛了要大聲
 * 炸在開發期，而不是渲染一顆點了沒反應的死鈕。
 * （從 `AppShell.tsx` 搬來：側欄筆記列 ⋮〔`NoteMenu.tsx`〕也要關抽屜，放在這裡才不會
 * 讓 `NoteMenu.tsx` 去 import `AppShell.tsx`——AppShell→NoteList→NoteMenu→AppShell 的循環。） */
export const SidebarDrawerContext = createContext<SidebarDrawerState | null>(null);

export function useSidebarDrawer(): SidebarDrawerState {
  const ctx = useContext(SidebarDrawerContext);
  if (!ctx) throw new Error("SidebarDrawerButton must be rendered inside AppShell");
  return ctx;
}

/** 側欄 ⋮ 用：在抽屜裡的話關掉它；不在 AppShell 底下（例如單獨渲染 NoteList 的測試）就什麼都不做。
 * 刻意不用會 throw 的 `useSidebarDrawer`——那支的 fail-loud 是給漢堡鈕的。 */
export function useCloseSidebarDrawer(): () => void {
  const ctx = useContext(SidebarDrawerContext);
  return useCallback(() => ctx?.setOpen(false), [ctx]);
}
