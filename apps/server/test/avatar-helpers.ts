/**
 * 頭貼整合測試共用的種子。直插只在測試裡；真路由的行為由各自的測試檔守。
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { Db } from "../src/db/index.js";
import { userAvatars } from "../src/db/schema.js";

export interface SeedAvatarOpts {
  userId: string;
  /** 原圖位元組數（落在 `original_size` 的 CHECK 範圍內：1 ~ 10 MiB）。 */
  originalSize: number;
  /** 顯示圖位元組數；0＝顯示圖尚未補產（只有 OIDC 候選有這個狀態）。 */
  displaySize: number;
  isCurrent?: boolean;
}

/** 直插一列頭貼；回列 id。顯示圖大於 0 → 上傳來源；等於 0 → OIDC 候選（待補產）。 */
export async function seedAvatarRow(db: Db, o: SeedAvatarOpts): Promise<string> {
  const pending = o.displaySize === 0;
  const [row] = await db
    .insert(userAvatars)
    .values({
      userId: o.userId,
      source: pending ? "oidc" : "upload",
      oidcPictureUrl: pending ? `https://idp.example.com/pic/${randomUUID()}` : null,
      originalFile: randomUUID(),
      originalSha256: randomBytes(32),
      originalMime: "image/png",
      originalSize: o.originalSize,
      displayData: pending ? null : Buffer.alloc(o.displaySize, 0x41),
      displayMime: pending ? null : "image/webp",
      displaySize: o.displaySize,
      isCurrent: o.isCurrent ?? false,
    })
    .returning({ id: userAvatars.id });
  return row!.id;
}
