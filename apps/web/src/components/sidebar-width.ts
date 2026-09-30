/**
 * 靜態側欄（`md+`）的寬度：常數、夾值、localStorage 讀寫。抽屜（`<md`）仍固定 `w-64`，不吃這裡。
 *
 * 範圍 200–480（Willie 2026-09-30 核准）：下限讓群組內筆記列還留得下約 3 個中文字的標題；
 * 上限不相對視窗（不自動收窄），拉太寬時雙擊把手回預設。推導見 `AppShell.tsx` 檔頭「側欄寬度」。
 */
export const SIDEBAR_WIDTH_DEFAULT = 256; // ＝改版前的 w-64
export const SIDEBAR_WIDTH_MIN = 200;
export const SIDEBAR_WIDTH_MAX = 480;
export const SIDEBAR_WIDTH_STEP = 16;
export const SIDEBAR_WIDTH_STORAGE_KEY = "sidebar.width";

export function clampSidebarWidth(px: number): number {
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(px)));
}

/** 缺鍵、非整數、超出範圍、或儲存被封鎖 → 預設（不 clamp：壞值多半是舊版本或手改，回預設最不意外）。 */
export function readSidebarWidth(): number {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (raw === null) return SIDEBAR_WIDTH_DEFAULT;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < SIDEBAR_WIDTH_MIN || value > SIDEBAR_WIDTH_MAX) return SIDEBAR_WIDTH_DEFAULT;
    return value;
  } catch {
    // Safari 隱私模式／被封鎖的儲存：當作沒存過。
    return SIDEBAR_WIDTH_DEFAULT;
  }
}

/** 等於預設時移除鍵（不留一個與預設同值的殘值）。 */
export function writeSidebarWidth(px: number): void {
  try {
    if (px === SIDEBAR_WIDTH_DEFAULT) window.localStorage.removeItem(SIDEBAR_WIDTH_STORAGE_KEY);
    else window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(px));
  } catch {
    // 寫不進去就只活在本次 session 的 state 裡。
  }
}
