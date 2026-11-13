import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { AvatarRef, UserAvatarDto } from "@knotebook/shared";
import type { DbOrTx } from "../db/tx.js";
import { userAvatars } from "../db/schema.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 某人目前使用的頭貼（`UserDto.avatar` 的值）；沒有則 null。只選 id、版本與「顯示圖是否尚未補產」，不讀 `display_data` 本體。
 * 回應前、交易外呼叫（登入、重設密碼、待定連結的手組 DTO）。
 */
export async function readCurrentAvatar(db: DbOrTx, userId: string): Promise<UserAvatarDto | null> {
  const [row] = await db
    .select({ id: userAvatars.id, v: userAvatars.version, pending: sql<boolean>`${userAvatars.displayData} is null` })
    .from(userAvatars)
    .where(and(eq(userAvatars.userId, userId), eq(userAvatars.isCurrent, true)))
    .limit(1);
  return row ?? null;
}

/**
 * 列表端點補 `avatar` 用：一次查多人的目前頭貼，回 userId → `{ id, v }`；沒有頭貼的人不在 Map 裡。
 * 單句查詢（查詢數不隨人數成長）；空輸入、全是非 UUID 形的輸入不發查詢。
 *
 * 顯示圖尚未補產的候選（`display_data` 為 NULL）一律排除：別人讀不到它的圖（`GET /api/avatars/:id` 對非本人回 404），
 * 列表帶出去只會是破圖；本人自己的畫面走 `UserDto.avatar`（帶 `pending`）。停用帳號照常查得到。
 *
 * 輸入只能是該端點本來就輸出的使用者 id（群組成員、分享對象、建議結果、版本編輯者……）——helper 自己不做權限判斷，
 * 把任意 id 丟進來等於讓呼叫者查任何人的頭貼 id。
 */
export async function readAvatarRefs(db: DbOrTx, userIds: readonly string[]): Promise<Map<string, AvatarRef>> {
  const ids = [...new Set(userIds)].filter(id => UUID_RE.test(id));
  const out = new Map<string, AvatarRef>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ userId: userAvatars.userId, id: userAvatars.id, v: userAvatars.version })
    .from(userAvatars)
    .where(and(inArray(userAvatars.userId, ids), eq(userAvatars.isCurrent, true), isNotNull(userAvatars.displayData)));
  for (const r of rows) out.set(r.userId, { id: r.id, v: r.v });
  return out;
}
