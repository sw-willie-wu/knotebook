import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

/**
 * 側欄搜尋字（#93 / #369）。住在 App 層（`ActiveNoteProvider` 旁），讓首頁與筆記頁各自的 `AppShell`——包括 lazy NotePage 的
 * Suspense fallback 自帶的那一份——共用同一個搜尋字：點搜尋結果換殼之後搜尋框還是原來的字，「清空搜尋」才清得掉搜尋跳轉留下的常駐標記。
 * 沒有 provider（單獨 render `AppShell` 的測試）退回各自的本地 state，行為與提升前相同。抽屜開關、tab 狀態不在這裡。
 *
 * 搜尋字屬於某個使用者：`claim(userId)`（AppShell 掛載且 session 有人時呼叫）發現擁有者換人就清空；`release()`（登出）清空並放掉擁有者。
 * provider 自己不碰 session（公開頁要求零 fetch）。
 */
interface SidebarQueryValue {
  query: string;
  setQuery: (q: string) => void;
  /** 目前的使用者是 `userId`：和上一個擁有者不同就清掉搜尋字，並換成新的擁有者。 */
  claim: (userId: string) => void;
  /** 登出：清掉搜尋字、放掉擁有者。 */
  release: () => void;
}
const SidebarQueryContext = createContext<SidebarQueryValue | null>(null);

export function SidebarQueryProvider({ children }: { children: ReactNode }) {
  const [query, setQuery] = useState("");
  const ownerRef = useRef<string | null>(null);
  const claim = useCallback((userId: string) => {
    if (ownerRef.current !== null && ownerRef.current !== userId) setQuery("");
    ownerRef.current = userId;
  }, []);
  const release = useCallback(() => {
    ownerRef.current = null;
    setQuery("");
  }, []);
  const value = useMemo(() => ({ query, setQuery, claim, release }), [query, claim, release]);
  return <SidebarQueryContext.Provider value={value}>{children}</SidebarQueryContext.Provider>;
}

const noop = () => {};
export function useSidebarQuery(): SidebarQueryValue {
  const ctx = useContext(SidebarQueryContext);
  const [local, setLocal] = useState("");
  return ctx ?? { query: local, setQuery: setLocal, claim: noop, release: noop };
}
