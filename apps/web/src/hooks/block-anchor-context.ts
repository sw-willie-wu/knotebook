import { createContext } from "react";

/**
 * #269 §10.2：段落錨點的頁層 API。NotePage／PublicNotePage 提供（Task 14 接上 `useBlockAnchor`）；wikilink 的共用點擊 handler 與
 * 複製入口讀它。`currentNoteId`：member 頁的有效 note id（公開頁不知道本篇 id——payload 刻意不帶——一律 null）。
 */
export interface BlockAnchorApi {
  currentNoteId: string | null;
  /** 同篇錨點點擊：把待處理錨點設成這個區塊（同一個錨點再點也會再捲）。 */
  requestAnchor(blockId: string): void;
  /** 同篇、無錨點的點擊：捲回頂端。 */
  scrollToTop(): void;
}

export const BlockAnchorContext = createContext<BlockAnchorApi>({ currentNoteId: null, requestAnchor: () => {}, scrollToTop: () => {} });
