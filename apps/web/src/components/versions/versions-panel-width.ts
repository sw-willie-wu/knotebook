import { useState, type CSSProperties } from "react";

/**
 * 版本面板的寬度：常數、夾值、localStorage 讀寫，結構比照 `components/sidebar-width.ts`。
 * 640 起浮動（640-1279，浮在筆記右緣）與固定（1280 起，第三欄）都吃這個寬度；手機（< 640）是整頁，不吃這裡。
 *
 * 範圍 240–560、預設 320（＝改版前的 `md:w-80`；#274）。
 * 鍵與側欄分開（`sidebar.width`），兩欄各記各的。
 */
export const VERSIONS_PANEL_WIDTH_DEFAULT = 320;
export const VERSIONS_PANEL_WIDTH_MIN = 240;
export const VERSIONS_PANEL_WIDTH_MAX = 560;
export const VERSIONS_PANEL_WIDTH_STEP = 16;
export const VERSIONS_PANEL_WIDTH_STORAGE_KEY = "versions.panelWidth";

/** 寬度以這個 CSS 變數往下傳，變數只由 NoteEditor 的列容器設一次；面板與錯誤外框（`VERSIONS_ERROR_FRAME.panel`）共用下面的定位 class，不可能不同步。 */
export const VERSIONS_PANEL_WIDTH_CSS_VAR = "--versions-panel-width";

/** 面板與其錯誤外框的定位與寬度（以完整字面給，Tailwind 靜態掃描）：
 * - 640-1279：`absolute` 貼列容器右下，上緣讓出頁首（`--note-header-h`，NoteEditor 量頁首外包層設的），浮在筆記上；
 *   寬度是設定值，但不超過卡寬減 3rem（左邊至少留一截筆記）。
 * - 1280 起（`xl:`）：回到列容器裡的第三欄（`relative`、固定設定寬度、無陰影）。 */
export const VERSIONS_PANEL_PLACEMENT =
  "absolute right-0 bottom-0 top-[var(--note-header-h,0px)] z-20 w-[min(var(--versions-panel-width),calc(100%_-_3rem))] shadow-lg " +
  "xl:relative xl:inset-auto xl:z-30 xl:w-[var(--versions-panel-width)] xl:shadow-none";

export function clampVersionsPanelWidth(px: number): number {
  return Math.min(VERSIONS_PANEL_WIDTH_MAX, Math.max(VERSIONS_PANEL_WIDTH_MIN, Math.round(px)));
}

/** 缺鍵、非整數、超出範圍、或儲存被封鎖 → 預設（不 clamp：壞值回預設最不意外，同側欄）。 */
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

/** 等於預設時移除鍵（不留一個與預設同值的殘值）。 */
export function writeVersionsPanelWidth(px: number): void {
  try {
    if (px === VERSIONS_PANEL_WIDTH_DEFAULT) window.localStorage.removeItem(VERSIONS_PANEL_WIDTH_STORAGE_KEY);
    else window.localStorage.setItem(VERSIONS_PANEL_WIDTH_STORAGE_KEY, String(px));
  } catch {
    // 寫不進去就只活在本次 session 的 state 裡。
  }
}

/** 寬度 state ＋ 提交時寫入。`onChange(px, commit)`：拖曳中 `commit=false` 只改 state，放開／鍵盤／雙擊才寫 localStorage。
 * `style` 要掛在面板與錯誤外框的共同祖先上。 */
export function useVersionsPanelWidth() {
  const [width, setWidth] = useState(readVersionsPanelWidth);
  const onChange = (px: number, commit: boolean) => {
    setWidth(px);
    if (commit) writeVersionsPanelWidth(px);
  };
  const style = { [VERSIONS_PANEL_WIDTH_CSS_VAR]: `${width}px` } as CSSProperties;
  return { width, onChange, style };
}
