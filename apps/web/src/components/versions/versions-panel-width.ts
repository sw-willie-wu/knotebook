import { useState, type CSSProperties } from "react";

/**
 * 版本面板（`md+` 右欄）的寬度：常數、夾值、localStorage 讀寫，結構比照 `components/sidebar-width.ts`。
 * 窄螢幕（`<md`）的底部浮出卡片不吃這裡。
 *
 * 範圍 240–560、預設 320（＝改版前的 `md:w-80`）——Willie 2026-10-14 核可（#274）。
 * 鍵與側欄分開（`sidebar.width`），兩欄各記各的。
 */
export const VERSIONS_PANEL_WIDTH_DEFAULT = 320;
export const VERSIONS_PANEL_WIDTH_MIN = 240;
export const VERSIONS_PANEL_WIDTH_MAX = 560;
export const VERSIONS_PANEL_WIDTH_STEP = 16;
export const VERSIONS_PANEL_WIDTH_STORAGE_KEY = "versions.panelWidth";

/** 寬度以這個 CSS 變數往下傳：面板與錯誤外框（`VERSIONS_ERROR_FRAME.panel`）都寫 `md:w-[var(--versions-panel-width)]`，
 * 變數只由 NoteEditor 的列容器設一次——兩者不可能不同步，窄螢幕則因為沒有 `md:` 前綴的寬度而不受影響。 */
export const VERSIONS_PANEL_WIDTH_CSS_VAR = "--versions-panel-width";

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
