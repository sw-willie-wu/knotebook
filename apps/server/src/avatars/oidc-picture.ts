/**
 * OIDC `picture` claim 解析。
 *
 * IdP 回報的值是不受信任的字串：這裡只決定「值得拿去下載嗎」——必須是 http／https 的
 * 絕對網址、長度有上限、不含會讓後續處理出怪事的字元。連線目標是否安全（位址、埠、
 * 重導）由下載器逐跳檢查，不在這裡。
 */

/**
 * 網址長度上限：UTF-16 code unit 數（JS 的 `.length`），不是位元組。它恆 ≥ PG 的
 * `char_length`，所以通過這裡的值一定滿足資料庫的長度 CHECK。
 */
export const MAX_PICTURE_URL_LENGTH = 2048;

/** NUL 與落單代理（well-formed 的代理對不算）。 */
const FORBIDDEN_CHARS = /[\0]|\p{Surrogate}/u;

/** 回傳 trim 後的網址；不合格一律 null。 */
export function parsePictureClaim(x: unknown): string | null {
  if (typeof x !== "string") return null;
  const value = x.trim();
  if (value.length === 0 || value.length > MAX_PICTURE_URL_LENGTH) return null;
  if (FORBIDDEN_CHARS.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return value;
}

/**
 * ID token 的值優先；ID token 沒有（或值不合格）才取 userinfo 回應的。
 * 兩邊都是 claims 物件（可能缺 `picture`），userinfo 只在登入流程本來就打過它時存在。
 */
export function pickPicture(
  idTokenClaims: Record<string, unknown>,
  userinfo: Record<string, unknown> | undefined,
): string | null {
  return parsePictureClaim(idTokenClaims.picture) ?? parsePictureClaim(userinfo?.picture);
}
