/**
 * #132：無認證端點收到的字串**在落庫之前**必須過這一關。
 *
 * NUL 與落單代理都能通過 `new URL()`／長度檢查，但 Postgres 一律拒收：NUL 進 text 欄或
 * bind 參數是 22021、進 jsonb 是 22P05，落單代理進 jsonb 是 22P02。不擋就是「任何人
 * 都打得出來的 500」。
 *
 * `\p{Surrogate}` 只命中落單的——成對代理是合法 astral 字元，不能誤擋。
 */
const UNSTORABLE_CHAR_RE = /[\0]|\p{Surrogate}/u;

export function hasUnstorableChar(value: string): boolean {
  return UNSTORABLE_CHAR_RE.test(value);
}
