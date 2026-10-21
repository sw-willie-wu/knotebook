import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import type { UserDto } from "@knotebook/shared";
import { readSessionToken, removeSessionToken, writeSessionToken } from "@/auth/resetTokenStorage";

/** `#<param>=<值>`；沒有或是空字串都當作沒有。 */
function parseFragmentParam(hash: string, param: string): string | null {
  const value = new URLSearchParams(hash.replace(/^#/, "")).get(param);
  return value === null || value === "" ? null : value;
}

/**
 * 一次性連結頁（#286 重設密碼、#285 邀請註冊）共用的 token 處理（#286 spec §3.2）：
 * 1. token 在 fragment（`#<param>=…`），不送到 server、不進 log 與 Referer；第一次 render 就同步取得（fragment 或 storage），不等 effect；
 *    同一頁之後 fragment 換成新 token（貼新連結）時，render 期間改採新 token，不被舊的 `forget()` 擋住；
 * 2. 掛載時立刻以 react-router 的 `navigate(…, { replace: true })` 清掉 fragment。不用 `history.replaceState`：router 的
 *    location 不會跟著更新，傳 `null` 還會清掉 router 放在 `history.state` 的 key／idx；
 * 3. 確定未登入（`user === null`）時才寫進 sessionStorage；已登入時只放 state，鍵若存在就刪掉；
 * 4. `forget()`（成功、確定無效）與頁面卸載都刪鍵；整頁離開時由 `main.tsx` 呼叫的清除函式處理。
 */
export function useOneTimeLinkToken(opts: { param: string; storageKey: string; user: UserDto | null | undefined }): { token: string | null; forget: () => void } {
  const { param, storageKey, user } = opts;
  const location = useLocation();
  const navigate = useNavigate();
  const fragmentToken = parseFragmentParam(location.hash, param);
  const [token, setToken] = useState(() => fragmentToken ?? readSessionToken(storageKey));
  if (fragmentToken !== null && fragmentToken !== token) setToken(fragmentToken);
  const forgotten = useRef<string | null>(null);

  // `#<param>=` 空值也清：網址列不留 token 參數。
  const hasFragmentParam = new URLSearchParams(location.hash.replace(/^#/, "")).has(param);
  useEffect(() => {
    if (hasFragmentParam) navigate({ pathname: location.pathname, search: location.search }, { replace: true });
  }, [hasFragmentParam, location.pathname, location.search, navigate]);

  useEffect(() => {
    if (user === null && token !== null && forgotten.current !== token) writeSessionToken(storageKey, token);
    else if (user) removeSessionToken(storageKey);
  }, [user, token, storageKey]);

  useEffect(() => () => removeSessionToken(storageKey), [storageKey]);

  const forget = useCallback(() => {
    forgotten.current = token;
    // 舊 token 的請求晚到時，storage 裡已是新 token：不刪別人的鍵。
    if (readSessionToken(storageKey) === token) removeSessionToken(storageKey);
  }, [storageKey, token]);

  return { token, forget };
}
