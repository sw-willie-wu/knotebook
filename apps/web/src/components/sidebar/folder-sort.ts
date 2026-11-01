import { useSyncExternalStore } from "react";

/**
 * 每個資料夾的筆記排序（資料夾 spec §6.7）：模組層小 store，結構同 `collapse.ts`——靜態卡、抽屜、選取樹共用，
 * 記憶體覆蓋層**先查**（`setItem` 丟例外時寫進覆蓋層，否則讀回的舊值會蓋掉剛選的排序）。首包模組：不 import `tree.ts`。
 */

export type FolderSort = "name" | "recent" | "size";

/** spec §6.7：`sidebar.sort.folder:<id>`。 */
export const FOLDER_SORT_PREFIX = "sidebar.sort.folder:";
/** D10、稿 FolderMenu 勾的是最近修改。 */
export const DEFAULT_FOLDER_SORT: FolderSort = "recent";

const overlay = new Map<string, FolderSort>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function isFolderSort(value: string | null): value is FolderSort {
  return value === "name" || value === "recent" || value === "size";
}

/** 不認得的值＝預設；讀丟例外＝預設。 */
export function folderSortOf(folderId: string): FolderSort {
  const cached = overlay.get(folderId);
  if (cached !== undefined) return cached;
  try {
    const stored = window.localStorage.getItem(FOLDER_SORT_PREFIX + folderId);
    return isFolderSort(stored) ? stored : DEFAULT_FOLDER_SORT;
  } catch {
    return DEFAULT_FOLDER_SORT;
  }
}

/** 每次寫入換一個新的查詢函式：`useFolderSortOf` 的呼叫者拿它當 useMemo 依賴，換了才會重組樹。 */
let currentSortOf: (folderId: string) => FolderSort = (folderId) => folderSortOf(folderId);

/** 寫入字面值（含 "recent"）；寫入丟例外時記進覆蓋層、成功時刪掉覆蓋層的該鍵。之後通知所有訂閱者。 */
export function setFolderSort(folderId: string, sort: FolderSort): void {
  try {
    window.localStorage.setItem(FOLDER_SORT_PREFIX + folderId, sort);
    overlay.delete(folderId);
  } catch {
    overlay.set(folderId, sort);
  }
  currentSortOf = (id) => folderSortOf(id);
  for (const listener of [...listeners]) listener();
}

export function useFolderSort(folderId: string): FolderSort {
  return useSyncExternalStore(subscribe, () => folderSortOf(folderId));
}

/**
 * 回一個查排序的函式；store 每次寫入時換一個新的，這裡直接回它（不用 useMemo、沒有依賴陣列）。
 * 給 `buildTabNodes` 的 `sortOf`，並當 useMemo 依賴。
 */
export function useFolderSortOf(): (folderId: string) => FolderSort {
  return useSyncExternalStore(subscribe, () => currentSortOf);
}

/** @internal 測試用：清空覆蓋層、換新的查詢函式（訂閱者由各元件卸載時自己退訂）。 */
export function __resetFolderSortForTests(): void {
  overlay.clear();
  currentSortOf = (folderId) => folderSortOf(folderId);
}
