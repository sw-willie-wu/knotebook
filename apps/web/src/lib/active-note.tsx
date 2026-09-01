import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

/**
 * 「目前開啟中的筆記」單一真相（#122 spec §3b M4-6：廢掉 URL 判斷）。
 *
 * 為什麼不能從網址推：標題存檔後網址靠 `history.replaceState` 換（react-router 的
 * location/params 不會跟著動），slug 又會隨標題重算——任何「比對路由參數」的高亮
 * 判斷都會在改標題後失準（前身 `lib/note-ref.ts` 的 matchesNoteRef 就是為此而生、
 * 也因此隨本 context 退役）。id 永不變，拿 id 當唯一判準就沒有這個問題。
 *
 * 寫入點三個：
 * - `NoteList` 點擊當下**樂觀** set（僅 plain left-click——cmd/ctrl/shift＋左鍵是
 *   開新分頁、不導航，樂觀 set 會把高亮留在沒開的那篇）；
 * - `NotePage` 解析成功後 set（**最終校正點**：直接進網址/書籤的路徑晚幀亮——體感
 *   取捨明記；也校正樂觀誤 set）。卸載時**條件清除**（current === 自己才清——換頁
 *   時新頁的 set 可能先於舊頁的 cleanup 跑）；
 * - `NotePage` 的 404 出口 set(null)（A6：清掉指向解析失敗那篇的樂觀殘留）。
 *
 * 公開頁（/p/…）在 provider 樹內但**不消費也不 set**——匿名頁沒有側欄。
 */
interface ActiveNoteContextValue {
  activeNoteId: string | null;
  setActiveNoteId: (id: string | null) => void;
  /** 只在「目前 active 正是這個 id」時清除（NotePage 卸載用，見檔頭）。 */
  clearActiveNoteId: (id: string) => void;
}

const ActiveNoteContext = createContext<ActiveNoteContextValue | null>(null);

export function ActiveNoteProvider({ children }: { children: ReactNode }) {
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const clearActiveNoteId = useCallback((id: string) => {
    setActiveNoteId((current) => (current === id ? null : current));
  }, []);
  const value = useMemo(
    () => ({ activeNoteId, setActiveNoteId, clearActiveNoteId }),
    [activeNoteId, clearActiveNoteId],
  );
  return <ActiveNoteContext.Provider value={value}>{children}</ActiveNoteContext.Provider>;
}

export function useActiveNote(): ActiveNoteContextValue {
  const value = useContext(ActiveNoteContext);
  if (!value) {
    // fail-loud：消費端（NoteList/NotePage）忘了包 provider 是接線錯誤，不該靜默
    // 退化成「永遠沒有高亮」。
    throw new Error("useActiveNote 必須在 <ActiveNoteProvider> 內使用");
  }
  return value;
}
