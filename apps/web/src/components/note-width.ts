import { useCallback, useSyncExternalStore } from "react";
import { NOTE_WIDTHS, type NoteWidth } from "@knotebook/shared";

/**
 * #297 §4.1：站內內文寬度——每人（這台瀏覽器）每篇各自記，鍵 `note.width.<小寫 noteId>`，
 * 值 `"wide"`／`"full"`（標準＝沒有鍵）。
 *
 * 同分頁的真相是模組層的 `values` Map：第一次讀某篇時由 localStorage 種入；寫入先更新 Map、
 * 通知訂閱者，再盡力寫 localStorage——儲存被封鎖時畫面照樣套用，只是不記住。他分頁的變更
 * 經 `storage` 事件進 Map。
 *
 * `storage` 監聽只在有訂閱者時掛著；最後一個訂閱者離開時一併清空 Map（沒監聽的期間收不到
 * 他分頁的變更，留著會在回到該篇時顯示過期值；清掉後下次讀取由 localStorage 重新種入）。
 * 代價：儲存被封鎖時，換篇之間 NotePage 先渲染載入卡、訂閱數歸零，這時記在 Map 的寬度會
 * 跟著清掉——符合「封鎖時只是不記住」。
 */
export const NOTE_WIDTH_STORAGE_PREFIX = "note.width.";

const values = new Map<string, NoteWidth>();
const listeners = new Map<string, Set<() => void>>();

/** 不在 `NOTE_WIDTHS` 的值（缺鍵、壞值、舊 server 沒帶）一律當標準。 */
export function toNoteWidth(value: unknown): NoteWidth {
  return (NOTE_WIDTHS as readonly unknown[]).includes(value) ? (value as NoteWidth) : "standard";
}

function keyOf(noteId: string): string {
  return noteId.toLowerCase();
}

function notify(id: string): void {
  for (const entry of [...(listeners.get(id) ?? [])]) entry();
}

function notifyAll(): void {
  for (const id of [...listeners.keys()]) notify(id);
}

function onStorage(event: StorageEvent): void {
  if (event.key === null) {
    // 他分頁整個清空了 localStorage。
    values.clear();
    notifyAll();
    return;
  }
  if (!event.key.startsWith(NOTE_WIDTH_STORAGE_PREFIX)) return;
  const id = keyOf(event.key.slice(NOTE_WIDTH_STORAGE_PREFIX.length));
  values.set(id, toNoteWidth(event.newValue));
  notify(id);
}

export function getNoteWidth(noteId: string): NoteWidth {
  const id = keyOf(noteId);
  const cached = values.get(id);
  if (cached !== undefined) return cached;
  let width: NoteWidth;
  try {
    width = toNoteWidth(window.localStorage.getItem(NOTE_WIDTH_STORAGE_PREFIX + id));
  } catch {
    width = "standard";
  }
  values.set(id, width);
  return width;
}

export function setNoteWidth(noteId: string, width: NoteWidth): void {
  const id = keyOf(noteId);
  values.set(id, width);
  notify(id);
  try {
    if (width === "standard") window.localStorage.removeItem(NOTE_WIDTH_STORAGE_PREFIX + id);
    else window.localStorage.setItem(NOTE_WIDTH_STORAGE_PREFIX + id, width);
  } catch {
    // 寫不進去：只活在這個分頁的 Map 裡。
  }
}

export function subscribeNoteWidth(noteId: string, listener: () => void): () => void {
  const id = keyOf(noteId);
  // 每次訂閱一個新函式：同一個 listener 訂兩次也各算一次；取消訂閱只刪自己。
  const entry = () => listener();
  if (listeners.size === 0) window.addEventListener("storage", onStorage);
  let set = listeners.get(id);
  if (!set) {
    set = new Set();
    listeners.set(id, set);
  }
  set.add(entry);
  return () => {
    // 已取消過、或測試重置後的舊訂閱 → no-op。
    if (!listeners.get(id)?.delete(entry)) return;
    if (listeners.get(id)!.size === 0) listeners.delete(id);
    if (listeners.size === 0) {
      window.removeEventListener("storage", onStorage);
      values.clear();
    }
  };
}

const NOOP_UNSUBSCRIBE = () => {};

/** 這篇的站內寬度與 setter；`noteId` 為 null → 恆標準、setter 不作用。 */
export function useNoteWidth(noteId: string | null): [NoteWidth, (width: NoteWidth) => void] {
  const subscribe = useCallback(
    (listener: () => void) => (noteId === null ? NOOP_UNSUBSCRIBE : subscribeNoteWidth(noteId, listener)),
    [noteId],
  );
  const width = useSyncExternalStore(subscribe, () => (noteId === null ? "standard" : getNoteWidth(noteId)));
  const setWidth = useCallback(
    (next: NoteWidth) => {
      if (noteId !== null) setNoteWidth(noteId, next);
    },
    [noteId],
  );
  return [width, setWidth];
}

/** 測試用（`src/test/setup.ts` 的 afterEach）：清 Map 與訂閱、移除 storage 監聽。 */
export function resetNoteWidthsForTest(): void {
  values.clear();
  listeners.clear();
  window.removeEventListener("storage", onStorage);
}
