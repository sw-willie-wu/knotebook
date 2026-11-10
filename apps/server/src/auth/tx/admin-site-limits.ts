import { eq, inArray, sql } from "drizzle-orm";
import type { SiteLimitKey } from "@knotebook/shared";
import type { Tx } from "../../db/tx.js";
import { siteLimitChanges, siteLimits } from "../../db/schema.js";

/**
 * #397：`SiteLimits.update` 在交易前組好的輸入。`set` 已驗過（env 鎖、範圍、刻度）；
 * `effective` 是在行程內鎖下、以記憶體的 `rows` 試算出的改前／改後生效值，`set` 裡每個 key 都有一筆。
 */
export interface UpdateSiteLimitsInput {
  actorUserId: string;
  set: Partial<Record<SiteLimitKey, number | null>>;
  effective: Partial<Record<SiteLimitKey, { old: number; new: number }>>;
}

/**
 * #397：站台限制 PATCH 的交易本體。讀 `set` 那些 key 的現有列（不另取任何鎖；序列化靠 `SiteLimits` 的行程內鎖
 * ——**不取** `lockSiteSettingsInTx`：`actor_user_id` 的外鍵檢查會鎖帳號列，持那把鎖的交易不得這樣做）→ 逐 key：
 * `null` 且有列 → 刪；數字且（沒列或值不同）→ upsert；存的值真的變了才寫一列 `site_limit_changes`（`old_value`／`new_value`
 * 用交易內讀到的列與 `set`，`old_effective`／`new_effective` 取 `input.effective`；同一交易的 `changed_at` 都是 `now()`）
 * → 回傳寫入後的整張 `site_limits`（含註冊表沒有、或越界被忽略的列）。
 */
export async function updateSiteLimitsInTx(tx: Tx, input: UpdateSiteLimitsInput): Promise<Array<{ key: string; value: number }>> {
  const keys = (Object.keys(input.set) as SiteLimitKey[]).filter(k => input.set[k] !== undefined);
  const current =
    keys.length === 0
      ? []
      : await tx.select({ key: siteLimits.key, value: siteLimits.value }).from(siteLimits).where(inArray(siteLimits.key, keys));
  const before = new Map(current.map(r => [r.key, r.value]));

  const records: Array<typeof siteLimitChanges.$inferInsert> = [];
  for (const key of keys) {
    const next = input.set[key]!;
    const old = before.get(key) ?? null;
    if (next === null) {
      if (old !== null) await tx.delete(siteLimits).where(eq(siteLimits.key, key));
    } else if (old !== next) {
      await tx
        .insert(siteLimits)
        .values({ key, value: next, updatedAt: sql`now()` })
        .onConflictDoUpdate({ target: siteLimits.key, set: { value: next, updatedAt: sql`now()` } });
    }
    if (old !== next) {
      const eff = input.effective[key];
      if (eff === undefined) throw new Error(`updateSiteLimitsInTx: effective is missing ${key}`);
      records.push({ key, oldValue: old, newValue: next, oldEffective: eff.old, newEffective: eff.new, actorUserId: input.actorUserId });
    }
  }
  if (records.length > 0) await tx.insert(siteLimitChanges).values(records);

  return tx.select({ key: siteLimits.key, value: siteLimits.value }).from(siteLimits);
}
