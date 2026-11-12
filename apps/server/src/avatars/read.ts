import { and, eq, sql } from "drizzle-orm";
import type { UserAvatarDto } from "@knotebook/shared";
import type { DbOrTx } from "../db/tx.js";
import { userAvatars } from "../db/schema.js";

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
