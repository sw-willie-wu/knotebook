import { createContext, useContext, useLayoutEffect } from "react";
import type { BlockAnchorApi } from "@/hooks/block-anchor-context";
import type { NotePageControls } from "@/lib/note-page-controls";

/**
 * 側欄在頁面之外（layout route），而側欄的 ⋮、選取動作列、資料夾刪除要用「目前開著那篇」的控制，
 * 搜尋結果的片段點擊要用它的段落錨點 API。筆記頁把這兩份登記到外層，外層再以同一份 context 提供給側欄；
 * 頁面自己的子孫仍直接吃頁面內的 provider（沒有一個 render 的延遲）。
 * 沒有 provider＝no-op。
 */
export interface NotePageBridge {
  setControls: (controls: NotePageControls | null) => void;
  setAnchors: (anchors: BlockAnchorApi | null) => void;
}

export const NotePageBridgeContext = createContext<NotePageBridge | null>(null);

/** 登記目前這一頁的控制與錨點 API；卸載時清掉。 */
export function useRegisterNotePage(controls: NotePageControls | null, anchors: BlockAnchorApi): void {
  const bridge = useContext(NotePageBridgeContext);
  useLayoutEffect(() => {
    if (bridge === null) return;
    bridge.setControls(controls);
    return () => bridge.setControls(null);
  }, [bridge, controls]);
  useLayoutEffect(() => {
    if (bridge === null) return;
    bridge.setAnchors(anchors);
    return () => bridge.setAnchors(null);
  }, [bridge, anchors]);
}
