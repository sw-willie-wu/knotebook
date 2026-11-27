import { useState, type CSSProperties } from "react";

/** Structure as `components/sidebar-width.ts`. Range 240–560, default 320 (the pre-change `md:w-80`). The key is separate from the sidebar's (`sidebar.width`). Phones (< 640) use the full page and ignore it. */
export const VERSIONS_PANEL_WIDTH_DEFAULT = 320;
export const VERSIONS_PANEL_WIDTH_MIN = 240;
export const VERSIONS_PANEL_WIDTH_MAX = 560;
export const VERSIONS_PANEL_WIDTH_STEP = 16;
export const VERSIONS_PANEL_WIDTH_STORAGE_KEY = "versions.panelWidth";

/** Width flows down as this CSS variable, set once by NoteEditor's row container; the panel and the error frame (`VERSIONS_ERROR_FRAME.panel`) share the positioning classes below, so they can't drift apart. */
export const VERSIONS_PANEL_WIDTH_CSS_VAR = "--versions-panel-width";

/** Positioning and width of the panel and error frame (full literals for Tailwind's static scan): 640–1279 `absolute` at the row container's right, top leaving room for the header (`--note-header-h`, set by NoteEditor from the header wrapper), bottom leaving room for the corner bubbles (`--corner-stack-clearance`, from `useCornerStackRoom`), width = setting but at most card width − 3rem (some note stays visible); from 1280 (`xl:`) back to the third column in the row container (`relative`, fixed setting width, no shadow). */
export const VERSIONS_PANEL_PLACEMENT =
  "absolute right-0 bottom-[var(--corner-stack-clearance,0px)] top-[var(--note-header-h,0px)] z-20 w-[min(var(--versions-panel-width),calc(100%_-_3rem))] shadow-lg " +
  "xl:relative xl:inset-auto xl:z-30 xl:w-[var(--versions-panel-width)] xl:shadow-none";

export function clampVersionsPanelWidth(px: number): number {
  return Math.min(VERSIONS_PANEL_WIDTH_MAX, Math.max(VERSIONS_PANEL_WIDTH_MIN, Math.round(px)));
}

/** Missing key, non-integer, out of range, or blocked storage → default (no clamp: a bad value returning the default is least surprising, as the sidebar). */
export function readVersionsPanelWidth(): number {
  try {
    const raw = window.localStorage.getItem(VERSIONS_PANEL_WIDTH_STORAGE_KEY);
    if (raw === null) return VERSIONS_PANEL_WIDTH_DEFAULT;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < VERSIONS_PANEL_WIDTH_MIN || value > VERSIONS_PANEL_WIDTH_MAX) {
      return VERSIONS_PANEL_WIDTH_DEFAULT;
    }
    return value;
  } catch {
    return VERSIONS_PANEL_WIDTH_DEFAULT;
  }
}

export function writeVersionsPanelWidth(px: number): void {
  try {
    if (px === VERSIONS_PANEL_WIDTH_DEFAULT) window.localStorage.removeItem(VERSIONS_PANEL_WIDTH_STORAGE_KEY);
    else window.localStorage.setItem(VERSIONS_PANEL_WIDTH_STORAGE_KEY, String(px));
  } catch {
    // If it can't be written, it lives only in this session's state.
  }
}

/** `onChange(px, commit)`: during a drag `commit=false` changes state only; release/keyboard/double-click writes localStorage. `style` goes on a common ancestor of the panel and error frame. */
export function useVersionsPanelWidth() {
  const [width, setWidth] = useState(readVersionsPanelWidth);
  const onChange = (px: number, commit: boolean) => {
    setWidth(px);
    if (commit) writeVersionsPanelWidth(px);
  };
  const style = { [VERSIONS_PANEL_WIDTH_CSS_VAR]: `${width}px` } as CSSProperties;
  return { width, onChange, style };
}
