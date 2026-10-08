import { and, eq, isNull, sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { apiTokens, transferTokens } from "../../db/schema.js";
import type { TransferPurpose } from "../transfer-token.js";

/** 交易外算好的純資料（S14）：明文產生與 `hashToken()` 都在呼叫端，SQL 參數只有雜湊與 id。 */
export interface IssueTransferTokenInput {
  tokenHash: string;
  parentTokenId: string;
  noteId: string;
  purpose: TransferPurpose;
  /** `MAX_PENDING_UPLOAD_TOKENS`；以參數傳入讓本檔只依賴型別。 */
  maxPendingUploads: number;
}

/**
 * 測試縫（生產不注入）。`beforeLock` 在 ① 之前 await（此時不持任何鎖，測試可在裡面刪母列造出 revoked）；
 * `afterCount` 在 ② 的位置之後、③ 之前 await，**upload 與 download 都會觸發**（download 跳過 ② 的查詢但仍呼叫），
 * 讓 M2a 能確定地造出「兩發都讀完計數、都還沒插入」的交錯，也讓 M2 在 ③ 之前刪筆記（spec §4.2）。
 */
export interface IssueTransferTokenSeam {
  beforeLock?: () => Promise<void>;
  afterCount?: () => Promise<void>;
}

export type IssueTransferTokenResult =
  | { kind: "issued"; id: string; noteId: string; expiresAt: Date }
  | { kind: "revoked" }
  | { kind: "too_many_pending" };

/**
 * #200 spec §4.2：簽發一支 transfer token。三句：
 * ① 鎖母列 `FOR NO KEY UPDATE`——序列化同一支母憑證的簽發（② 的計數因此不會兩邊都讀到 4），並讓並發的撤銷（DELETE）
 *    等本交易結束後再 cascade 帶走新列：「母列在 ① 與 ③ 之間消失」的 FK 競態由構造消除。與 ③ 的 FK 檢查取的
 *    `FOR KEY SHARE` 相容。0 列＝這發請求認證後母憑證被撤銷了。
 * ② 只有 upload：未消費、未過期（DB `now()`）的子 token 數；不帶 `note_id`——上限是每支母憑證。
 * ③ INSERT，`expires_at = least(now()+10 分, 母憑證到期)`；母憑證不到期（PAT 預設 NULL）時取 10 分。
 *
 * 不在這裡處理的（呼叫端在交易外，spec §4.2）：③ 撞 note FK（筆記在 `resolveNoteAccess` 之後被刪）、母憑證恰在
 * `now()` 到期撞 `transfer_tokens_expiry_chk`、其餘 DB 錯誤的遮蔽。
 */
export async function issueTransferTokenInTx(
  tx: Tx,
  input: IssueTransferTokenInput,
  seam?: IssueTransferTokenSeam
): Promise<IssueTransferTokenResult> {
  await seam?.beforeLock?.();
  const [parent] = await tx
    .select({ id: apiTokens.id })
    .from(apiTokens)
    .where(eq(apiTokens.id, input.parentTokenId))
    .for("no key update");
  if (parent === undefined) return { kind: "revoked" };

  if (input.purpose === "upload") {
    const [pending] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(transferTokens)
      .where(
        and(
          eq(transferTokens.parentTokenId, input.parentTokenId),
          eq(transferTokens.purpose, "upload"),
          isNull(transferTokens.consumedAt),
          sql`${transferTokens.expiresAt} > now()`
        )
      );
    if (pending!.n >= input.maxPendingUploads) return { kind: "too_many_pending" };
  }
  await seam?.afterCount?.();

  const [row] = await tx
    .insert(transferTokens)
    .values({
      tokenHash: input.tokenHash,
      parentTokenId: input.parentTokenId,
      noteId: input.noteId,
      purpose: input.purpose,
      // 母憑證到期以同一交易內（① 已鎖住）的那一列為準，不經 JS Date 轉一手。
      expiresAt: sql`least(now() + interval '10 minutes', coalesce((select ${apiTokens.accessExpiresAt} from ${apiTokens} where ${apiTokens.id} = ${input.parentTokenId}), 'infinity'::timestamptz))`,
    })
    .returning({ id: transferTokens.id, noteId: transferTokens.noteId, expiresAt: transferTokens.expiresAt });
  return { kind: "issued", id: row!.id, noteId: row!.noteId, expiresAt: row!.expiresAt };
}
