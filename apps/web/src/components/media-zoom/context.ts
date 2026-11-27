import { createContext, useContext } from "react";

/**
 * `naturalWidth`/`naturalHeight` are the zoom baseline (zoom scale 1 equals it): the natural size, enlarged to the size the image
 * is rendered at in the note when that is bigger, so opening the zoom never shrinks it.
 *
 * `svg` is inserted as raw HTML (`dangerouslySetInnerHTML`): only output of `lib/mermaid.ts` may go here (the same string the page
 * diagram uses; same safety argument as there). Never a user or external string.
 */
export type ZoomSource =
  | { kind: "image"; src: string; alt: string; caption: string; naturalWidth: number; naturalHeight: number }
  | { kind: "svg"; svg: string; naturalWidth: number; naturalHeight: number };

/** After close, focus returns to `button`; if it's gone (or null), to the nearest focusable ancestor of `media`. */
export interface ZoomOrigin {
  button: HTMLElement | null;
  media: Element;
}

export interface MediaZoomApi {
  open(source: ZoomSource, origin: ZoomOrigin): void;
  readonly isOpen: boolean;
}

/** Default `null` = no zoom here (e.g. version preview); callers hide the zoom button accordingly. */
export const MediaZoomContext = createContext<MediaZoomApi | null>(null);

export function useMediaZoom(): MediaZoomApi | null {
  return useContext(MediaZoomContext);
}
