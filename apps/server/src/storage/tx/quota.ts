/**
 * 儲存配額的唯一判定點（spec 2026-10-08 §5.3）。S14：只收 `tx`／純資料／型別明示測試縫。
 * 呼叫它的交易**恰為**白名單四支（U-tx 上傳、T3 移動、T4 複製、T6 轉移；Q-S3），各恰一次（Q-S1），位置在該交易全部
 * notes／groups 列鎖之後（Q-S2）、該空間 slug 範圍的任何寫入之前（Q-S7）——無環論證與鎖序表在 spec §6.1、§6.2。
 * 每一步是**獨立的一句 SQL**（M3）：
 *   1. incoming ≤ 0 → return（不取鎖，A4：只擋新增）
 *   2. set_config('lock_timeout', '<n>ms', true)——`SET` 不收綁定參數；is_local＝SET LOCAL
 *   3. pg_advisory_xact_lock(hashtextextended(key, 0))——**單獨一句**；等太久 → 55P03，路由映射 409 server_busy（§6.9）
 *   4. SET LOCAL lock_timeout TO DEFAULT——回到 role／database／設定檔層的值（不硬寫 0，m6）：只有空間鎖這一句受限，
 *      交易之後的列鎖等待行為與今天相同（S15(b) 守）
 *   4a. 測試縫 `storage-space-locked`
 *   5. 讀配額（users／groups JOIN storage_plans）；NULL → return
 *   6. SUM——**必須是取鎖之後的另一句**：READ COMMITTED 每句取新快照，才看得到前一位持鎖者已 commit 的列；併成一句時快照在
 *      取鎖之前，SUM 是舊值（R1 確定性版守）。advisory xact lock 在 commit 可見之後才釋放。
 *   7. used + incoming > quota → throw（等於上限放行，A4）
 * 呼叫它的交易一律 READ COMMITTED（REPEATABLE READ 下第 6 步看不到他人的新 commit）——結構性守衛 storage-quota-structure ⑥。
 */
import { eq, sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { groups, notes, storagePlans, uploads, users } from "../../db/schema.js";
import type { GroupTestHook } from "../../groups/test-hook.js";
import { TxAbort } from "../../http/tx-abort.js";
import { STORAGE_QUOTA_EXCEEDED_MESSAGE, spaceLockKey, spaceNotesWhere, sumUploadSizeSql, type StorageSpace } from "../space.js";

/** 空間鎖等待上限的預設值（ms）。`AppDeps.storageLockTimeoutMs` 只給測試注入，不開 env（spec §5.3 m7）。 */
export const DEFAULT_STORAGE_LOCK_TIMEOUT_MS = 5000;

export interface SpaceRoomOpts {
  /** 空間鎖那一句的等待上限（ms）；正整數。由路由從 deps 帶入（純資料）。 */
  lockTimeoutMs: number;
  /** 測試縫（生產不注入）；第 4a 步以 `"storage-space-locked"` 觸發。 */
  hook?: GroupTestHook;
  /** 縫的 ctx（純資料，呼叫端帶）。 */
  hookCtx?: { noteId?: string; groupId?: string };
}

/** 交易內的配額拒絕：繼承 `TxAbort`（漏接細節也回對的碼），另帶 `space` 與三個數字供路由在交易外決定可見性（§8.1）。 */
export class StorageQuotaExceeded extends TxAbort {
  constructor(
    readonly space: StorageSpace,
    readonly usedBytes: number,
    readonly quotaBytes: number,
    readonly incomingBytes: number,
  ) {
    super(409, "storage_quota_exceeded", STORAGE_QUOTA_EXCEEDED_MESSAGE);
    this.name = "StorageQuotaExceeded";
  }
}

export async function assertSpaceRoomInTx(tx: Tx, space: StorageSpace, incomingBytes: number, opts: SpaceRoomOpts): Promise<void> {
  if (!(incomingBytes > 0)) return;
  if (!Number.isInteger(opts.lockTimeoutMs) || opts.lockTimeoutMs <= 0) {
    throw new Error(`assertSpaceRoomInTx: lockTimeoutMs 必須是正整數（收到 ${opts.lockTimeoutMs}）`);
  }
  await tx.execute(sql`select set_config('lock_timeout', ${`${opts.lockTimeoutMs}ms`}::text, true)`);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${spaceLockKey(space)}::text, 0))`);
  await tx.execute(sql`set local lock_timeout to default`);
  await opts.hook?.("storage-space-locked", opts.hookCtx ?? {});

  const [plan] = space.kind === "user"
    ? await tx.select({ quotaBytes: storagePlans.quotaBytes }).from(users).innerJoin(storagePlans, eq(storagePlans.id, users.storagePlanId)).where(eq(users.id, space.id))
    : await tx.select({ quotaBytes: storagePlans.quotaBytes }).from(groups).innerJoin(storagePlans, eq(storagePlans.id, groups.storagePlanId)).where(eq(groups.id, space.id));
  if (!plan) throw new Error(`assertSpaceRoomInTx: 找不到空間 ${space.kind}:${space.id}`);
  if (plan.quotaBytes === null) return;

  const [row] = await tx.select({ used: sumUploadSizeSql() }).from(uploads).innerJoin(notes, eq(notes.id, uploads.noteId)).where(spaceNotesWhere(space));
  const usedBytes = row?.used ?? 0;
  if (usedBytes + incomingBytes > plan.quotaBytes) {
    throw new StorageQuotaExceeded(space, usedBytes, plan.quotaBytes, incomingBytes);
  }
}
