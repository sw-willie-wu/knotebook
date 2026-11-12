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

/** 顯示圖（瀏覽器產的 256 px 方圖）位元組上限；與 `user_avatars.display_data` 的 CHECK 字面一致。 */
export const MAX_AVATAR_DISPLAY_BYTES = 262144;

/** 顯示圖邊長（px）。 */
export const AVATAR_DISPLAY_SIZE = 256;

/** OIDC `picture` 下載的原圖位元組上限（1 MiB）；只在下載器擋，不進 DB。 */
export const MAX_OIDC_AVATAR_BYTES = 1048576;

/** 可接受的原圖與顯示圖格式（不含 GIF、SVG）。 */
export const AVATAR_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type AvatarMimeType = (typeof AVATAR_MIME_TYPES)[number];

/** `UserDto.avatar`：目前使用的頭貼。`pending`＝顯示圖尚未由本人瀏覽器補產（別人讀不到）。 */
export interface UserAvatarDto {
  id: string;
  v: number;
  pending: boolean;
}

/** 原圖上的裁切方框（原圖像素座標，方形）。 */
export interface AvatarCropDto {
  x: number;
  y: number;
  size: number;
}

/** 候選清單的一張頭貼。`providerName`＝OIDC 來源在啟用中登入服務的顯示名，對不到為 null。 */
export interface AvatarCandidateDto {
  id: string;
  source: "upload" | "oidc";
  providerName: string | null;
  avatar: AvatarRef;
  pending: boolean;
  current: boolean;
  crop: AvatarCropDto | null;
  originalWidth: number | null;
  originalHeight: number | null;
  originalSize: number;
  displaySize: number;
  createdAt: string;
}

/** `GET /api/auth/avatars`：候選（新到舊）、是否自動帶入 OIDC 頭貼、可手動重新抓取的身分。 */
export interface AvatarListDto {
  candidates: AvatarCandidateDto[];
  auto: boolean;
  refreshable: { identityId: string; providerName: string }[];
}
