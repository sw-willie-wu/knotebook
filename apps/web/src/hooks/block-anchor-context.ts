import { createContext } from "react";

/**
 * #269：段落錨點的頁層 API。NotePage／PublicNotePage 提供（接 `useBlockAnchor`）；wikilink 的共用點擊 handler 與
 * 複製入口讀它。`currentNoteId`：member 頁的有效 note id（公開頁不知道本篇 id——payload 刻意不帶——一律 null）。
 */
export interface BlockAnchorApi {
  currentNoteId: string | null;
  /**
   * 同篇錨點點擊：把待處理錨點設成這個區塊（同一個錨點再點也會再捲）。`findText`（#93，側欄搜尋）：改捲到該段落範圍內
   * 第一個含這串字的 block；`blockId` 可為 `_top`。
   */
  requestAnchor(blockId: string, findText?: string): void;
  /** 同篇、無錨點的點擊：捲回頂端。 */
  scrollToTop(): void;
}

/** 沒有任何筆記頁登記時的預設（首頁、管理頁）：不指向任何一篇，點擊皆為 no-op。 */
export const NO_BLOCK_ANCHOR: BlockAnchorApi = { currentNoteId: null, requestAnchor: () => {}, scrollToTop: () => {} };

export const BlockAnchorContext = createContext<BlockAnchorApi>(NO_BLOCK_ANCHOR);
