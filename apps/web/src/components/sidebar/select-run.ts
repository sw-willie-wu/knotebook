import { useCallback, useSyncExternalStore } from "react";
import type { SidebarTabActions } from "@/lib/sidebar-tab";

/**
 * 一般 tab 選取模式「批次進行中」的狀態（#181）：每個 `SidebarTabProvider` 一份，鍵＝它穩定的
 * actions 物件（擁有 session 計數器的那一個）。所有 `SelectActionBar` 實例讀同一份——重開抽屜、Done→Select 後新掛上的
 * 動作列也顯示「處理中」、三顆鈕 disabled，不能在舊那輪跑完前開第二輪（避免重複複製）。
 * 鍵不用 session：Done→Select 開出的新 session 查不到舊那輪，動作列就會變成可按。結果要不要套用由呼叫端比對 session。
 * 只准被 SelectLazy 鏈與測試 import（lazy chunk 內，首包零成本）。
 */

export interface SelectRun {
  progress: { done: number; total: number };
}

const runs = new WeakMap<SidebarTabActions, SelectRun>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSelectRun(owner: SidebarTabActions): SelectRun | null {
  const getSnapshot = useCallback(() => runs.get(owner) ?? null, [owner]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** 同步搶鎖：已有進行中的就回 false（跨實例也擋連點）。起始進度 `{ done: 0, total }`。 */
export function beginSelectRun(owner: SidebarTabActions, total: number): boolean {
  if (runs.has(owner)) return false;
  runs.set(owner, { progress: { done: 0, total } });
  emit();
  return true;
}

export function updateSelectRun(owner: SidebarTabActions, done: number): void {
  const run = runs.get(owner);
  if (!run) return;
  runs.set(owner, { progress: { done, total: run.progress.total } });
  emit();
}

/** 只在 `SelectActionBar` 收尾那個 `finally` 呼叫。 */
export function endSelectRun(owner: SidebarTabActions): void {
  if (runs.delete(owner)) emit();
}
