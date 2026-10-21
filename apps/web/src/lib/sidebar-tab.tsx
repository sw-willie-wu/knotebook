import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { NARROW_QUERY, SidebarDrawerContext } from "@/lib/sidebar-drawer";

/**
 * 側欄 tab 的狀態、記憶與兩個 context（`sidebar-drawer.ts` 同理由放 `lib/`，避開循環 import）。
 *
 * - 為什麼拆兩個 context（spec §5.3）：`AppShell` 以 `children` 渲染筆記頁，筆記頁若消費含 state 的
 *   context，每次切 tab 都會重繪整頁。`SidebarTabActionsContext` 只放穩定的 `showTab`（整個生命週期同一個
 *   物件），筆記頁只用它；`SidebarTabStateContext` 放目前 tab，只有側欄元件消費。
 * - `showTab` 讀 ref 而不是把抽屜 context 放進依賴：`AppShell` 的 `SidebarDrawerContext.Provider value`
 *   每次 render 都是新物件，進依賴的話 actions 會跟著換物件。
 * - `AppShell` 會隨首頁↔筆記頁重掛（各自渲染一份），所以初值每次掛載都重讀 storage，tab 靠它延續。
 * - `trash` 在步驟 1 視同無效（從步驟 2 回滾的瀏覽器可能殘留該值）。
 */
export type SidebarTab = "recent" | "myNotes" | "workspace" | "shared";

/** tab 列的順序。 */
export const SIDEBAR_TABS: readonly SidebarTab[] = ["recent", "myNotes", "workspace", "shared"];
export const DEFAULT_SIDEBAR_TAB: SidebarTab = "myNotes";
export const SIDEBAR_TAB_STORAGE_KEY = "sidebar.tab";

/** 缺鍵、不在 `SIDEBAR_TABS` 內（含 `trash`）、或儲存被封鎖 → 預設。 */
export function readSidebarTab(): SidebarTab {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_TAB_STORAGE_KEY);
    return SIDEBAR_TABS.find((tab) => tab === raw) ?? DEFAULT_SIDEBAR_TAB;
  } catch {
    return DEFAULT_SIDEBAR_TAB;
  }
}

export function writeSidebarTab(tab: SidebarTab): void {
  try {
    window.localStorage.setItem(SIDEBAR_TAB_STORAGE_KEY, tab);
  } catch {
    // 寫不進去就只活在本次 session 的 state 裡。
  }
}

export interface SidebarTabActions {
  showTab: (tab: SidebarTab) => void;
}
export interface SidebarTabState {
  tab: SidebarTab;
}

export const SidebarTabActionsContext = createContext<SidebarTabActions | null>(null);
export const SidebarTabStateContext = createContext<SidebarTabState | null>(null);

const NOOP_ACTIONS: SidebarTabActions = { showTab: () => {} };
const DEFAULT_STATE: SidebarTabState = { tab: DEFAULT_SIDEBAR_TAB };

export function SidebarTabProvider({ children }: { children: ReactNode }) {
  const [tab, setTab] = useState<SidebarTab>(readSidebarTab);
  const drawer = useContext(SidebarDrawerContext);
  const drawerRef = useRef(drawer);
  drawerRef.current = drawer;

  const showTab = useCallback((next: SidebarTab) => {
    setTab(next);
    writeSidebarTab(next);
    if (window.matchMedia(NARROW_QUERY).matches) drawerRef.current?.setOpen(true);
  }, []);

  const actions = useMemo<SidebarTabActions>(() => ({ showTab }), [showTab]);
  const state = useMemo<SidebarTabState>(() => ({ tab }), [tab]);

  return (
    <SidebarTabActionsContext.Provider value={actions}>
      <SidebarTabStateContext.Provider value={state}>{children}</SidebarTabStateContext.Provider>
    </SidebarTabActionsContext.Provider>
  );
}

/** 不在 `AppShell` 底下＝no-op、不 throw（比照 `useCloseSidebarDrawer`）。 */
export function useSidebarTabActions(): SidebarTabActions {
  return useContext(SidebarTabActionsContext) ?? NOOP_ACTIONS;
}

export function useSidebarTabState(): SidebarTabState {
  return useContext(SidebarTabStateContext) ?? DEFAULT_STATE;
}
