import { createContext, useContext } from "react";

/**
 * 要放大的內容。`naturalWidth`／`naturalHeight` 是原尺寸（圖片的像素、SVG 自己的尺寸），縮放倍率以它為 1。
 *
 * ⚠ `svg` 會以 HTML 原樣插進頁面（`dangerouslySetInnerHTML`）：只准放 `lib/mermaid.ts` 產生的輸出
 * （頁面上那張圖用的同一份字串），安全前提與防線同 `lib/mermaid.ts`。任何使用者或外部來源的字串都不得放進來。
 */
export type ZoomSource =
  | { kind: "image"; src: string; alt: string; caption: string; naturalWidth: number; naturalHeight: number }
  | { kind: "svg"; svg: string; naturalWidth: number; naturalHeight: number };

/** 關閉後焦點回 `button`；它已不在頁面上（或是 null）就回 `media` 最近的可聚焦祖先。 */
export interface ZoomOrigin {
  button: HTMLElement | null;
  media: Element;
}

export interface MediaZoomApi {
  open(source: ZoomSource, origin: ZoomOrigin): void;
  readonly isOpen: boolean;
}

/** 預設 `null`＝這裡沒有放大功能（例如版本歷史預覽），呼叫端據此不顯示放大鈕。 */
export const MediaZoomContext = createContext<MediaZoomApi | null>(null);

export function useMediaZoom(): MediaZoomApi | null {
  return useContext(MediaZoomContext);
}
