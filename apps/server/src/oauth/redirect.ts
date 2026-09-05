/** D10：redirect_uri 只收 loopback，且授權時的比對忽略 port。兩個判準的唯一實作。 */
import { hasUnstorableChar } from "./storable.js";

// `new URL("http://[::1]/x").hostname` 回傳含方括號的 `[::1]`，集合要照這個形狀寫。
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function parse(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * DCR 的收件判準：http／https、loopback hostname、無 query、無 fragment、無 userinfo。
 * query 若放行會與 `matchesLoopbackRedirect` 的「search 必須為空」永遠不匹配，
 * 形成「移除重加也沒用」的死循環。
 *
 * ⚠ userinfo 那條比 spec §5.2 的清單**多一條**（方向是更嚴），別當成多餘的而砍掉。
 */
export function isLoopbackRedirectUri(raw: string): boolean {
  if (hasUnstorableChar(raw)) return false;
  const url = parse(raw);
  if (url === null) return false;
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (!LOOPBACK_HOSTNAMES.has(url.hostname)) return false;
  // userinfo 一併拒收：比對那頭完全忽略它，收了兩邊對「這是誰」的認知就不一致。
  if (url.username !== "" || url.password !== "") return false;
  return url.search === "" && url.hash === "";
}

/**
 * 授權時的比對：scheme／hostname／path 逐字相等，**port 忽略**（RFC 8252 §7.3 MUST
 * ——MCP client 每次授權向 OS 取 ephemeral port 是常態）。
 */
export function matchesLoopbackRedirect(registered: string, actual: string): boolean {
  // 兩側都要擋：`.../cb\u0000` 的 pathname 正規化成 `/cb%00`，會與合法註冊的
  // `.../cb%00` 比對相等——放行就等於把 raw actual 存進 DB 再炸成 500。
  if (hasUnstorableChar(registered) || hasUnstorableChar(actual)) return false;
  const a = parse(registered);
  const b = parse(actual);
  if (a === null || b === null) return false;
  if (a.search !== "" || a.hash !== "" || b.search !== "" || b.hash !== "") return false;
  // userinfo 兩側都要空：DCR 端已拒收，這裡一併要求，免得 actual 夾帶帳密仍相符。
  if (a.username !== "" || a.password !== "" || b.username !== "" || b.password !== "") return false;
  return a.protocol === b.protocol && a.hostname === b.hostname && a.pathname === b.pathname;
}
