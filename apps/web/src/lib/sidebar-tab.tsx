import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { clearSearchMark } from "@/hooks/search-mark";
import { NARROW_QUERY, SidebarDrawerContext } from "@/lib/sidebar-drawer";
import { EMPTY_SELECTION, reduceSelection, type SelectionOp, type SidebarSelection } from "@/lib/sidebar-selection";

/**
 * 側欄 tab 的狀態、記憶與兩個 context（`sidebar-drawer.ts` 同理由放 `lib/`，避開循環 import）。
 *
 * - 為什麼拆兩個 context：`AppShell` 以 `children` 渲染筆記頁，筆記頁若消費含 state 的
 *   context，每次切 tab 都會重繪整頁。`SidebarTabActionsContext` 只放穩定的函式（整個生命週期同一個
 *   物件），筆記頁只用它；`SidebarTabStateContext` 放目前 tab 與選取，只有側欄元件消費。
 * - 選取狀態也在這裡：靜態卡與抽屜兩份要看到同一份；actions 只放穩定函式，勾選不讓
 *   `children` 重繪。切 tab、抽屜 Esc（`actionsRef`，`AppShell` 用）與開始搜尋都會結束選取。
 * - `showTab` 讀 ref 而不是把抽屜 context 放進依賴：`AppShell` 的 `SidebarDrawerContext.Provider value`
 *   每次 render 都是新物件，進依賴的話 actions 會跟著換物件。
 * - `AppShell` 會隨首頁↔筆記頁重掛（各自渲染一份），所以初值每次掛載都重讀 storage，tab 靠它延續。
 * - `trash` 從步驟 2 起是合法值。
 */
export type SidebarTab = "recent" | "myNotes" | "workspace" | "shared" | "trash";

/** tab 列的順序。 */
export const SIDEBAR_TABS: readonly SidebarTab[] = ["recent", "myNotes", "workspace", "shared", "trash"];
export const DEFAULT_SIDEBAR_TAB: SidebarTab = "myNotes";
export const SIDEBAR_TAB_STORAGE_KEY = "sidebar.tab";

/** 缺鍵、不在 `SIDEBAR_TABS` 內、或儲存被封鎖 → 預設。 */
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
  /** 換到別的 tab 時另外結束選取；點目前那顆不結束。 */
  showTab: (tab: SidebarTab) => void;
  updateSelection: (op: SelectionOp) => void;
  /** 在選取模式就結束並回 true；否則回 false、不動 state。抽屜 Esc 用。 */
  endSelectionIfActive: () => boolean;
  /** 目前這一輪選取的序號：每次 `updateSelection({ type: "start" })` 遞增；不在選取模式回 null。穩定函式（讀 ref）。
   *  批次動作開跑時記下，結束時相同才套用選取結果——與元件是否還掛著無關（抽屜關掉會卸載動作列，但選取還在）。 */
  getSelectionSession: () => number | null;
  /** 目前的 tab。穩定函式（讀 ref）：給 `SidebarTabProvider` 外面、拿不到 `useSidebarTabState` 的呼叫端（`AppShell` 交給功能導覽）。 */
  getTab: () => SidebarTab;
}
export interface SidebarTabState {
  tab: SidebarTab;
  selection: SidebarSelection;
}

export const SidebarTabActionsContext = createContext<SidebarTabActions | null>(null);
export const SidebarTabStateContext = createContext<SidebarTabState | null>(null);

const NOOP_ACTIONS: SidebarTabActions = {
  showTab: () => {},
  updateSelection: () => {},
  endSelectionIfActive: () => false,
  getSelectionSession: () => null,
  getTab: () => DEFAULT_SIDEBAR_TAB,
};
const DEFAULT_STATE: SidebarTabState = { tab: DEFAULT_SIDEBAR_TAB, selection: EMPTY_SELECTION };

export function SidebarTabProvider({
  children,
  actionsRef,
}: {
  children: ReactNode;
  actionsRef?: MutableRefObject<SidebarTabActions | null>;
}) {
  const [tab, setTab] = useState<SidebarTab>(readSidebarTab);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const [selection, dispatchSelection] = useReducer(reduceSelection, EMPTY_SELECTION);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const sessionRef = useRef(0);
  const drawer = useContext(SidebarDrawerContext);
  const drawerRef = useRef(drawer);
  drawerRef.current = drawer;

  const showTab = useCallback((next: SidebarTab) => {
    setTab(next);
    writeSidebarTab(next);
    if (next !== tabRef.current) {
      dispatchSelection({ type: "end" });
      clearSearchMark(); // 搜尋框已空時切到別的 tab ＝離開搜尋：清掉搜尋跳轉留在筆記裡的標記
    }
    if (window.matchMedia(NARROW_QUERY).matches) drawerRef.current?.setOpen(true);
  }, []);

  const endSelectionIfActive = useCallback(() => {
    if (!selectionRef.current.active) return false;
    dispatchSelection({ type: "end" });
    return true;
  }, []);

  const updateSelection = useCallback((op: SelectionOp) => {
    if (op.type === "start") sessionRef.current += 1;
    dispatchSelection(op);
  }, []);

  const getSelectionSession = useCallback(() => (selectionRef.current.active ? sessionRef.current : null), []);

  const getTab = useCallback(() => tabRef.current, []);

  const actions = useMemo<SidebarTabActions>(
    () => ({ showTab, updateSelection, endSelectionIfActive, getSelectionSession, getTab }),
    [showTab, updateSelection, endSelectionIfActive, getSelectionSession, getTab],
  );
  if (actionsRef) actionsRef.current = actions;
  const state = useMemo<SidebarTabState>(() => ({ tab, selection }), [tab, selection]);

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
