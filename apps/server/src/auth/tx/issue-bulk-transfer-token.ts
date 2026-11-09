import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { apiTokens, transferTokens } from "../../db/schema.js";
import type { BulkAccess, BulkRange } from "../transfer-token.js";

/** 交易外算好的純資料（S14）：明文產生與 `hashToken()` 都在呼叫端，SQL 參數只有雜湊、id 與範圍。 */
export interface IssueBulkTransferTokenInput {
  tokenHash: string;
  parentTokenId: string;
  access: BulkAccess;
  /** id 一律小寫（呼叫端正規化）。 */
  range: BulkRange;
  /** `MAX_ACTIVE_BULK_TOKENS`；以參數傳入讓本檔只依賴型別。 */
  maxActive: number;
  /** `BULK_TRANSFER_TTL_MINUTES`；以 bind 參數進 `make_interval`。 */
  ttlMinutes: number;
}

/** 測試縫（生產不注入）：`beforeLock` 在 ① 之前 await（可刪母列造 revoked）；`afterCount` 在 ② 之後、③ 之前 await。 */
export interface IssueBulkTransferTokenSeam {
  beforeLock?: () => Promise<void>;
  afterCount?: () => Promise<void>;
}

export type IssueBulkTransferTokenResult = { kind: "issued"; id: string; expiresAt: Date } | { kind: "revoked" } | { kind: "too_many_active" };

/**
 * bulk transfer spec 2026-11-02 §5.2-4：簽發一支 bulk 權杖。三句（比照 `issueTransferTokenInTx`）：
 * ① 鎖母列 `FOR NO KEY UPDATE`——序列化同一支母憑證的簽發，② 的計數因此不會兩邊都讀到 2；0 列＝認證後母憑證被撤銷。
 * ② 數這支母憑證「未過期」的 bulk 權杖（`purpose = 'bulk'`；upload／download 不佔名額）；≥ `maxActive` → too_many_active。
 * ③ INSERT：`note_id` 不給、`access`／`range` 落庫，`expires_at = least(now() + ttl, 母憑證到期)`（§21 D3）。
 * 母憑證恰在 `now()` 到期撞 `transfer_tokens_expiry_chk` 由呼叫端在交易外映射。
 */
export async function issueBulkTransferTokenInTx(tx: Tx, input: IssueBulkTransferTokenInput, seam?: IssueBulkTransferTokenSeam): Promise<IssueBulkTransferTokenResult> {
  await seam?.beforeLock?.();
  const [parent] = await tx.select({ id: apiTokens.id }).from(apiTokens).where(eq(apiTokens.id, input.parentTokenId)).for("no key update");
  if (parent === undefined) return { kind: "revoked" };

  const [active] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(transferTokens)
    .where(and(eq(transferTokens.parentTokenId, input.parentTokenId), eq(transferTokens.purpose, "bulk"), sql`${transferTokens.expiresAt} > now()`));
  if (active!.n >= input.maxActive) return { kind: "too_many_active" };
  await seam?.afterCount?.();

  const [row] = await tx
    .insert(transferTokens)
    .values({
      tokenHash: input.tokenHash,
      parentTokenId: input.parentTokenId,
      purpose: "bulk",
      access: input.access,
      range: input.range,
      expiresAt: sql`least(now() + make_interval(mins => ${input.ttlMinutes}::int), coalesce((select ${apiTokens.accessExpiresAt} from ${apiTokens} where ${apiTokens.id} = ${input.parentTokenId}), 'infinity'::timestamptz))`,
    })
    .returning({ id: transferTokens.id, expiresAt: transferTokens.expiresAt });
  return { kind: "issued", id: row!.id, expiresAt: row!.expiresAt };
}
