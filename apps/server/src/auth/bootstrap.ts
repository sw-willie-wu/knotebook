import type { Db } from "../db/index.js";
import { instanceSetup, users } from "../db/schema.js";
import { hashPassword } from "./password.js";

/** `ADMIN_EMAIL`/`ADMIN_PASSWORD` env bootstrap 的輸入——config.ts 的 loadConfig 已保證
 * 成對且格式/長度合法（spec rev 5.7），這裡不重複驗證。 */
export interface EnvAdminBootstrap {
  email: string;
  password: string;
}

/**
 * 實例初始化的唯一路徑（spec §14.2，setup token 已退役）：
 * - 已初始化（instance_setup 有列）→ no-op（envAdmin 被忽略——「僅首次初始化生效」）。
 * - 未初始化＋envAdmin → 原子建立 admin：INSERT instance_setup ON CONFLICT DO NOTHING
 *   當並發/重試 guard（拿不到列＝別人已完成，靜默返回）；mustChangePassword: true
 *   （env 明文密碼首登強改）。
 * - 未初始化＋無 envAdmin → throw（可行動訊息）。**這裡 throw、不 process.exit**——
 *   exit 會殺掉 vitest runner；production 的「印錯 + exit」由 index.ts 呼叫端承擔
 *   （與 migration 失敗處置同形，spec §14.2）。
 */
export async function initializeInstance(db: Db, envAdmin?: EnvAdminBootstrap): Promise<void> {
  const rows = await db.select().from(instanceSetup).limit(1);
  if (rows.length > 0) return;

  if (!envAdmin) {
    throw new Error(
      "此實例尚未初始化：請在 .env 設定 ADMIN_EMAIL 與 ADMIN_PASSWORD 後重啟（首次啟動會自動建立該管理員帳號）"
    );
  }

  const passwordHash = await hashPassword(envAdmin.password);
  const displayName = envAdmin.email.split("@")[0] || envAdmin.email;
  await db.transaction(async tx => {
    const [setupRow] = await tx.insert(instanceSetup).values({ singleton: true }).onConflictDoNothing().returning();
    if (!setupRow) return; // 已有人完成——不重複建立
    await tx.insert(users).values({ email: envAdmin.email, passwordHash, displayName, isAdmin: true, mustChangePassword: true });
  });
}
