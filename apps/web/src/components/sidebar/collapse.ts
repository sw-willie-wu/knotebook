import { useCallback, useSyncExternalStore } from "react";

/**
 * 側欄群組的折疊狀態：模組層的小 store（`useSyncExternalStore`），NoteList 的靜態卡、抽屜與選取樹共用。
 * 原本每份實例各自 `useState`（初值讀 localStorage 一次）；選取模式的「全選」與 Shift 範圍要以「畫面上可見的列」計
 * （資料夾 spec §6.10），標題列得知道哪些群組收合，所以改成共用。副作用：靜態卡與抽屜的折疊即時同步。
 * 記憶體覆蓋層**先查**：Safari 私密模式或配額滿時 `getItem` 正常、`setItem` 丟例外——若「能讀就讀 localStorage」，
 * 切換會被讀回的舊值吃掉、群組永遠收不起來。寫入失敗才記進覆蓋層（只活在本次 session），寫入成功就刪掉該鍵。
 */

/** 折疊狀態的 localStorage 鍵前綴：`sidebar.collapsed.group:<id>`，值 "1"＝收合、缺鍵＝展開（spec §9-9）；資料夾是 `sidebar.collapsed.folder:<id>`（資料夾 spec §6.8）。 */
export const COLLAPSE_STORAGE_PREFIX = "sidebar.collapsed.";
export type SidebarSectionKey = `group:${string}` | `folder:${string}`;

const overlay = new Map<SidebarSectionKey, boolean>();
const listeners = new Set<() => void>();
let version = 0;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 同步讀：記憶體覆蓋層有這把鍵就用它；沒有才讀 localStorage（讀丟例外＝展開）。 */
export function isCollapsed(key: SidebarSectionKey): boolean {
  const cached = overlay.get(key);
  if (cached !== undefined) return cached;
  try {
    return window.localStorage.getItem(COLLAPSE_STORAGE_PREFIX + key) === "1";
  } catch {
    return false;
  }
}

/** 寫 localStorage；**寫入丟例外時把值記進記憶體覆蓋層**（只活在本次 session）；成功時刪掉覆蓋層的該鍵。之後通知所有訂閱者。 */
export function setCollapsed(key: SidebarSectionKey, collapsed: boolean): void {
  try {
    if (collapsed) window.localStorage.setItem(COLLAPSE_STORAGE_PREFIX + key, "1");
    else window.localStorage.removeItem(COLLAPSE_STORAGE_PREFIX + key);
    overlay.delete(key);
  } catch {
    overlay.set(key, collapsed);
  }
  version += 1;
  for (const listener of [...listeners]) listener();
}

/** `useSyncExternalStore`：任一處切換，所有實例（靜態卡、抽屜、選取樹）同步。 */
export function useCollapsed(key: SidebarSectionKey): [expanded: boolean, toggle: () => void] {
  const collapsed = useSyncExternalStore(subscribe, () => isCollapsed(key));
  const toggle = useCallback(() => setCollapsed(key, !isCollapsed(key)), [key]);
  return [!collapsed, toggle];
}

/** 任何折疊變動都讓呼叫者重繪（回單調遞增的版本號）；給選取模式標題列算「可見列」。 */
export function useCollapseVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}

/** @internal 測試用：清空覆蓋層與版本號（訂閱者由各元件卸載時自己退訂）。 */
export function __resetCollapseForTests(): void {
  overlay.clear();
  version = 0;
}
