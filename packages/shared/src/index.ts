export const YDOC_FRAGMENT = "knotebook";

export const SESSION_COOKIE = "knotebook_session";

export type Role = "owner" | "editor" | "viewer" | "none";

export interface ApiError {
  error: { code: string; message: string };
}

export interface NoteDto {
  id: string;
  title: string;
  ownerId: string;
  role: Role;
  createdAt: string;
  updatedAt: string;
  // 選配:server 的 toNoteDto 要到 Task 8 才回填;設必填會讓 Task 3–7 的 tsc 全紅。
  // Task 8 收緊為必填 `slug: string | null`。
  slug?: string | null;
}

// 分享名單上的角色只會是 'editor'/'viewer'——note_shares 表的 DB check constraint
// 本就不允許存 'owner'/'none'（owner 不會出現在 note_shares 裡；'none' 純粹是
// resolveRole 用來表示「無權限」的哨兵值，從不落地成一筆分享列）。與 NoteDto 的
// `Role`（涵蓋全部四種狀態）刻意分開成獨立型別，讓「這欄位只可能是這兩種角色」
// 這件事在型別層就看得出來。
export type ShareRole = "editor" | "viewer";

export interface ShareDto {
  userId: string;
  email: string;
  displayName: string;
  role: ShareRole;
}

// 權威清單：`grep -rn "sendError(" apps/server/src` + auth.ts 手寫 429（`too_many_attempts`）
// 逐一核對後的全集，另加本 plan 新增碼 `too_many_requests`（Task 8 slug limiter）與
// `slug_taken`（Task 8 slug unique violation）——這兩碼尚未落地於 grep 結果，屬預先保留。
export const ERROR_CODES = [
  "unauthorized",
  "forbidden",
  "not_found",
  "invalid_body",
  "bad_request",
  "internal",
  "unsupported_media_type",
  "server_busy",
  "too_many_attempts",
  "too_many_requests",
  "invalid_setup_token",
  "already_setup",
  "invalid_email",
  "invalid_display_name",
  "bootstrap_email_mismatch",
  "password_too_short",
  "invalid_credentials",
  "account_disabled",
  "email_taken",
  "user_not_found",
  "cannot_disable_self",
  "cannot_share_with_self",
  "share_not_found",
  "slug_taken",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const COLLAB_CLOSE_REVOKED = "knotebook:revoked";
export const COLLAB_CLOSE_NOTE_DELETED = "knotebook:note-deleted";
export const COLLAB_TOKEN_TTL_SECONDS = 120;
export interface CollabTokenClaims {
  noteId: string;
  userId: string;
  role: Role;
  tv: number;
}

const SLUG_CHARSET_RE = /^[\p{L}\p{N}-]+$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_SUFFIX_RE = /-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESERVED_SLUGS = new Set(["new"]);

/** slug 正規化：NFC 合成 + Unicode-aware 小寫。給 `validateSlug` 與 DB 唯一比對用。 */
export function normalizeSlug(input: string): string {
  return input.normalize("NFC").toLowerCase();
}

/**
 * 驗證已正規化（已過 `normalizeSlug`）的字串是否為合法自訂 slug。spec §11.4 逐字：
 * 1–100 code points；charset 僅 `\p{L}\p{N}-`（刻意不含 `\p{M}` combining marks——
 * 例如 `İ`.toLowerCase() 產生的 U+0307 會被擋）；不可頭尾/連續/純 `-`；保留字
 * `new`；整串 uuid 或以 `-<uuid>` 結尾 → `uuid_like`（避免與 `canonicalNotePath`
 * 的 `<titleSlug>-<id>` vanity path 混淆——見該函式與 `extractRefUuid` 的說明）。
 * 檢查順序即為分支優先序：length → charset → dash → reserved → uuid_like。
 */
export function validateSlug(normalized: string): "length" | "charset" | "dash" | "reserved" | "uuid_like" | null {
  const length = Array.from(normalized).length;
  if (length < 1 || length > 100) return "length";
  if (!SLUG_CHARSET_RE.test(normalized)) return "charset";
  if (normalized.startsWith("-") || normalized.endsWith("-") || normalized.includes("--")) return "dash";
  if (RESERVED_SLUGS.has(normalized)) return "reserved";
  if (UUID_RE.test(normalized) || UUID_SUFFIX_RE.test(normalized)) return "uuid_like";
  return null;
}

/**
 * 從標題產生「vanity slug」——僅供 `canonicalNotePath` 組裝好看、非唯一的 URL 片段
 * （真正查找靠 `<id>` 尾碼，見 `extractRefUuid`），因此刻意不做大小寫正規化
 * （與需要唯一比對的自訂 slug 不同，那條路徑一律經 `normalizeSlug`）。
 * pipeline：NFC → 保留 `\p{L}\p{N}`，其餘一段段轉單一 `-` → 去頭尾 `-` →
 * 以 code point（`Array.from`，避免切斷 surrogate pair）截斷至 60 → 截斷後再去尾
 * `-` 一次（截斷點可能恰好落在 `-` 後）。全空 → `""`。
 */
export function titleSlug(title: string): string {
  let s = title.normalize("NFC").replace(/[^\p{L}\p{N}]+/gu, "-");
  s = s.replace(/^-+|-+$/g, "");
  const chars = Array.from(s);
  if (chars.length > 60) {
    s = chars.slice(0, 60).join("");
  }
  s = s.replace(/-+$/, "");
  return s;
}

/**
 * 從 ref 字串（可能是純 uuid，或 `<vanity>-<uuid>` 形式）擷取尾碼 uuid，供
 * `GET /api/notes/:ref` 在 slug 精確比對失敗後的第二段查找路徑。找不到回傳 null。
 */
export function extractRefUuid(ref: string): string | null {
  if (UUID_RE.test(ref)) return ref.toLowerCase();
  const match = UUID_SUFFIX_RE.exec(ref);
  if (match) return match[0].slice(1).toLowerCase();
  return null;
}

/**
 * 組出筆記的「canonical」路徑，供 NoteList href、TitleInput 存檔後
 * `history.replaceState`、分享 dialog 複製連結共用。三態：
 * 1. 有自訂 slug（DB 已驗證合法且唯一）→ `/notes/<slug>`。
 * 2. 無 slug、但 title 轉得出非空 vanity slug → `/notes/<titleSlug>-<id>`。
 * 3. 無 slug 且 title 轉出空字串（例如全符號標題）→ 純 `/notes/<id>`。
 */
export function canonicalNotePath(note: { id: string; slug: string | null; title: string }): string {
  if (note.slug) return `/notes/${note.slug}`;
  const vanity = titleSlug(note.title);
  return vanity ? `/notes/${vanity}-${note.id}` : `/notes/${note.id}`;
}
