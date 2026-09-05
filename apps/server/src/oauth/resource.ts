/**
 * #132：canonical resource identifier（D11：全站只有一個）的唯一比對處。
 * authorize 的 T2 與 `/oauth/token` 的兩個 grant 分支共用，不得各寫一份字串比較。
 *
 * ⚠ 簽章**刻意**比 spec §2 多一個 `issuer` 參數：讓這個模組保持純函式、不讀 config。
 * 不要「修回」單參數形。
 */

/** `<issuer>/api/mcp`，無尾斜線。 */
export function canonicalResource(issuer: string): string {
  return `${issuer}/api/mcp`;
}

/**
 * RFC 8707 的 `resource` 參數是否指向本站唯一的 resource。
 *
 * scheme／host 由 `new URL` 正規化成小寫、預設 port 也由它消去；**path 大小寫敏感**、
 * 不去尾斜線、不接受 query／fragment（帶了就不是同一個 identifier）。
 */
export function isCanonicalResource(input: string | undefined, issuer: string): boolean {
  if (input === undefined) return false;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return false;
  }
  if (url.search !== "" || url.hash !== "") return false;
  return `${url.origin}${url.pathname}` === canonicalResource(issuer);
}
