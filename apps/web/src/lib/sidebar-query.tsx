import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import type { SearchTagToken } from "@/components/sidebar/search-tags";

/**
 * Sidebar search text (#93 / #369), kept at App level: `AppShell` remounts when leaving and re-entering its layout route
 * (re-login, change-password page), and the search box must keep its text so "clear search" can still remove the
 * persistent mark left by a search jump. Without a provider it falls back to local state.
 * The text belongs to one user: `claim(userId)` clears it if the owner changed, `release()` (logout) clears it.
 * The provider never touches the session (public pages must make zero fetches).
 * `tagTokens` follow the same ownership.
 */
interface SidebarQueryValue {
  query: string;
  setQuery: (q: string) => void;
  tagTokens: SearchTagToken[];
  setTagTokens: (tokens: SearchTagToken[]) => void;
  /** Text and tag tokens together. */
  clearSearch: () => void;
  claim: (userId: string) => void;
  release: () => void;
}
/** Exported so `AppShell` can hand its own value (the fallback one, without a provider) to the search box and result list below it. */
export const SidebarQueryContext = createContext<SidebarQueryValue | null>(null);

const NO_TOKENS: SearchTagToken[] = [];

function useSearchState(): Omit<SidebarQueryValue, "claim" | "release"> {
  const [query, setQuery] = useState("");
  const [tagTokens, setTagTokens] = useState<SearchTagToken[]>(NO_TOKENS);
  const clearSearch = useCallback(() => {
    setQuery("");
    setTagTokens(NO_TOKENS);
  }, []);
  return useMemo(
    () => ({ query, setQuery, tagTokens, setTagTokens, clearSearch }),
    [query, tagTokens, clearSearch],
  );
}

export function SidebarQueryProvider({ children }: { children: ReactNode }) {
  const state = useSearchState();
  const { clearSearch } = state;
  const ownerRef = useRef<string | null>(null);
  const claim = useCallback(
    (userId: string) => {
      if (ownerRef.current !== null && ownerRef.current !== userId) clearSearch();
      ownerRef.current = userId;
    },
    [clearSearch],
  );
  const release = useCallback(() => {
    ownerRef.current = null;
    clearSearch();
  }, [clearSearch]);
  const value = useMemo(() => ({ ...state, claim, release }), [state, claim, release]);
  return <SidebarQueryContext.Provider value={value}>{children}</SidebarQueryContext.Provider>;
}

const noop = () => {};
export function useSidebarQuery(): SidebarQueryValue {
  const ctx = useContext(SidebarQueryContext);
  const local = useSearchState();
  return ctx ?? { ...local, claim: noop, release: noop };
}
