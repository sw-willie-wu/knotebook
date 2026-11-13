import { createContext } from "react";
import { matchPath } from "react-router";

/** 三條筆記路由（舊形 `/notes/:ref`、`/n/:handle/:slug`、群組 `/g/:groupId/:slug`）；其餘路徑背後都是 HomePage。 */
export const NOTE_ROUTE_PATTERNS = ["/notes/:ref", "/n/:handle/:slug", "/g/:groupId/:slug"] as const;

/** 路徑是不是筆記路由。手機版據此決定側欄是滿版清單還是藏起來（`/groups/*`、`/admin/*` 的背景也是清單，不能只看 `pathname === "/"`）。 */
export function isNoteRoutePath(pathname: string): boolean {
  return NOTE_ROUTE_PATTERNS.some((pattern) => matchPath({ path: pattern, end: true }, pathname) !== null);
}

export interface PhoneListState {
  /** 手機上回到清單畫面（已在清單就什麼都不做）。 */
  backToList: () => void;
}

/** 由 `AppShell` 提供；側欄 tab 的 `showTab` 在手機上靠它回清單。沒有 provider＝no-op。 */
export const PhoneListContext = createContext<PhoneListState | null>(null);

export interface PhoneBrowseState {
  /** 手機筆記頁開全螢幕搜尋層（蓋在筆記上；Cancel 回到這篇，選結果就開那篇）。 */
  openSearch: () => void;
  /** 建立筆記並導向（與清單底部的「New note」同一支）；錯誤已在內部 toast。 */
  createNote: (groupId?: string, folderId?: string) => Promise<void>;
}

/** 由 `AppShell` 提供給筆記頁底部的瀏覽列。沒有 provider＝no-op。 */
export const PhoneBrowseContext = createContext<PhoneBrowseState | null>(null);
