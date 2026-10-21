/**
 * 一次性連結頁（網址帶一次性 token 的頁）暫存 token 的 sessionStorage 鍵與通用的頁表（spec §3.2）。
 * 目前有 #286 重設密碼與 #285 邀請註冊（`/register`）兩頁，各一列在 `ONE_TIME_TOKEN_PAGES`。檔名沿用 #286 起的名稱。
 *
 * 這支模組刻意不在 lazy chunk 裡：`main.tsx` 在 render 前呼叫 `clearStaleOneTimeTokens`。頁面自己在已登入、
 * SPA 卸載、成功、410 時刪鍵；整頁離開（打網址、外部連結）時 React cleanup 不會跑，鍵就靠這裡在下一次
 * 載入時清掉。頁面一律從這裡取鍵名，不自己再定義一份。
 */
export const RESET_TOKEN_KEY = "knotebook:reset-token";

export const INVITE_TOKEN_KEY = "knotebook:invite-token";

/** 頁面路徑（小寫、無結尾 `/`）→ 該頁的鍵。 */
export const ONE_TIME_TOKEN_PAGES: ReadonlyArray<{ path: string; key: string }> = [
  { path: "/reset-password", key: RESET_TOKEN_KEY },
  { path: "/register", key: INVITE_TOKEN_KEY },
];

/**
 * 初始路徑不是某頁時刪掉那一頁的鍵。比對前去掉結尾 `/` 並轉小寫：react-router 預設忽略結尾斜線、
 * 不分大小寫，`/reset-password/` 一樣渲染重設頁，在那裡重新整理不能刪鍵。
 */
export function clearStaleOneTimeTokens(pathname: string): void {
  const current = pathname.replace(/\/+$/, "").toLowerCase();
  for (const { path, key } of ONE_TIME_TOKEN_PAGES) {
    if (current !== path) removeSessionToken(key);
  }
}

/** sessionStorage 不可用（隱私模式、被封鎖）時讀不到就是沒有，寫不進去只是重新整理後失效。 */
export function readSessionToken(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeSessionToken(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // 見 readSessionToken
  }
}

export function removeSessionToken(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // 見 readSessionToken
  }
}
