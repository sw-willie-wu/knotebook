/** 頭貼參照：awareness 與 DTO 只傳這個，不傳網址。 */
export interface AvatarRef {
  id: string;
  v: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * awareness 是 client 自報：web 讀別人的 `knotebook.avatar` 一律先過這支。id 須為 UUID 形
 * （不分大小寫，回傳轉小寫），v 須 Number.isSafeInteger 且 > 0；多餘欄接受並忽略
 * （回傳只含 id、v）；其餘一律 null。
 */
export function parseAvatarRef(x: unknown): AvatarRef | null {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return null;
  const { id, v } = x as { id?: unknown; v?: unknown };
  if (typeof id !== "string" || !UUID_RE.test(id)) return null;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) return null;
  return { id: id.toLowerCase(), v };
}

/**
 * 站內頭貼讀圖網址（帶 `?v=` 版本）——全 repo 唯一組出它的地方（web 的 `<img>` 只經它）。id 經 encodeURIComponent。
 * id 須是 `parseAvatarRef` 通過的 UUID 或 server DTO 的 uuid（呼叫端只能拿 `AvatarRef`）；本函式不驗，
 * 因為 `.`／`..` 不會被編碼，亂傳會組出退一層的站內路徑。
 */
export function avatarUrl(id: string, v: number): string {
  return `/api/avatars/${encodeURIComponent(id)}?v=${v}`;
}
