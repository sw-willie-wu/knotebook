/**
 * #175 §6.9（gate r1 I2）：交易內寫 slug 的唯一 helper——移動（T3）、複製（T4，經 `insertNoteWithAutoSlug` 的
 * `inTx` 模式）、PR4 的轉移（T6）三條路徑共用。每一輪：交易內探測（scope 範圍、排除本列）→ 在 savepoint 裡寫
 * （drizzle 巢狀 `tx.transaction` ＝ `savepoint sp<n>`）→ 撞兩把 slug 唯一索引之一 → savepoint 已回滾、外層交易
 * 仍可用 → 重探測；`MAX_AUTO_SLUG_RETRIES` 輪後改用 `fallbackAutoSlug()` 不探測直接寫。其他錯誤（含別的 23505、
 * FK 23503）原樣拋出。交易外的兩條（PATCH 格 3／4、`insertNoteWithAutoSlug` 預設模式）每輪本來就是新交易，不經這裡。
 * S14：只收 `tx`；`write` 是呼叫端（同一個 `*InTx` 內）組的閉包，只用外層 `tx`（同一條連線、savepoint 範圍內）。
 */
import { autoSlugFromTitle } from "@knotebook/shared";
import type { Tx } from "../../db/tx.js";
import { MAX_AUTO_SLUG_RETRIES, fallbackAutoSlug, isSlugUniqueViolation, probeUniqueSlug, type SlugScope } from "../slug.js";

export interface WriteSlugOptions {
  /** 探測排除的列（移動：本列；建立：不給）。 */
  excludeNoteId?: string;
  /** 測試縫：每輪探測後、savepoint 寫入前呼叫（帶本輪候選）。生產不注入。 */
  beforeWrite?: (candidate: string) => void | Promise<void>;
}

export async function writeSlugInTx(
  tx: Tx,
  scope: SlugScope,
  source: { base: string } | { title: string },
  write: (slug: string) => Promise<void>,
  opts: WriteSlugOptions = {},
): Promise<string> {
  const base = "base" in source ? source.base : autoSlugFromTitle(source.title);
  for (let attempt = 1; ; attempt++) {
    const slug = attempt > MAX_AUTO_SLUG_RETRIES ? fallbackAutoSlug() : await probeUniqueSlug(tx, scope, opts.excludeNoteId ?? null, base);
    await opts.beforeWrite?.(slug);
    try {
      await tx.transaction(async () => {
        await write(slug);
      });
      return slug;
    } catch (err) {
      if (isSlugUniqueViolation(err) && attempt <= MAX_AUTO_SLUG_RETRIES) continue;
      throw err;
    }
  }
}
