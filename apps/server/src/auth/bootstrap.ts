import { randomUUID } from "node:crypto";
import { normalizeEmail } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { handles, instanceSetup, users } from "../db/schema.js";
import { deriveHandle } from "./handle.js";
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

  // 寫入端正規化（spec §14.3 單一漏斗）：與 admin-users.ts 建帳、routes/auth.ts 讀取
  // 比對共用同一套正規化規則，displayName 亦從正規化後的值切，避免大寫 env
  // 造成同一帳號在「查詢比對用小寫、顯示用原始大小寫殘留」兩套來源不一致。
  const email = normalizeEmail(envAdmin.email);
  const passwordHash = await hashPassword(envAdmin.password);
  const displayName = email.split("@")[0] || email;
  const id = randomUUID();
  await db.transaction(async tx => {
    const [setupRow] = await tx.insert(instanceSetup).values({ singleton: true }).onConflictDoNothing().returning();
    if (!setupRow) return; // 已有人完成——不重複建立
    // #122 registry-first（spec §2a）：**必須在上面的 setupRow 早退之後**——早退是正常
    // COMMIT，若 registry INSERT 先於守衛，並發敗方會 commit 一列指向不存在使用者的
    // live 墓碑、永久燒掉該名字並讓下次 boot 撞 PK。tx 內**不做裸重試**（aborted
    // transaction）：探測後仍撞 PK＝真競態→整個啟動 fail-closed（重啟重試）。
    const handle = await deriveHandle(tx, [email.split("@")[0]], id);
    await tx.insert(handles).values({ handle, userId: id, state: "live" });
    await tx.insert(users).values({ id, email, passwordHash, displayName, isAdmin: true, mustChangePassword: true, handle });
  });
}
