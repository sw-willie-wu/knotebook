import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

/**
 * 側欄搜尋字（#93 PR2 / #369）。住在 App 層（`ActiveNoteProvider` 旁），讓首頁與筆記頁各自的 `AppShell`——包括 lazy NotePage 的
 * Suspense fallback 自帶的那一份——共用同一個搜尋字：點搜尋結果換殼之後搜尋框還是原來的字，「清空搜尋」才清得掉搜尋跳轉留下的常駐標記。
 * 沒有 provider（單獨 render `AppShell` 的測試）退回各自的本地 state，行為與提升前相同。抽屜開關、tab 狀態不在這裡。
 */
interface SidebarQueryValue {
  query: string;
  setQuery: (q: string) => void;
}
const SidebarQueryContext = createContext<SidebarQueryValue | null>(null);

export function SidebarQueryProvider({ children }: { children: ReactNode }) {
  const [query, setQuery] = useState("");
  const value = useMemo(() => ({ query, setQuery }), [query]);
  return <SidebarQueryContext.Provider value={value}>{children}</SidebarQueryContext.Provider>;
}

export function useSidebarQuery(): SidebarQueryValue {
  const ctx = useContext(SidebarQueryContext);
  const [local, setLocal] = useState("");
  return ctx ?? { query: local, setQuery: setLocal };
}
