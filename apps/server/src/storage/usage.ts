/**
 * 儲存配額的非交易讀（spec 2026-10-08 §5.4）。收 `Db`／`DbOrTx`、會借 pool——**只准在交易外呼叫**（S14）。
 * 不在 `tx/` 目錄：它們不是交易本體。
 */
import { eq, sql } from "drizzle-orm";
import { emptyStorageByKind, kindOfMime, type GroupStorageMemberUsageDto, type StorageByKind, type StorageQuotaErrorDetail } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import type { DbOrTx } from "../db/tx.js";
import { groups, notes, storagePlans, uploads, users } from "../db/schema.js";
import { groupAccess } from "../groups/queries.js";
import { spaceNotesWhere, sumUploadSizeSql, type StorageSpace } from "./space.js";
import type { StorageQuotaExceeded } from "./tx/quota.js";

export interface SpaceUsage {
  usedBytes: number;
  quotaBytes: number | null;
  planId: string;
  planName: string;
}

/** 空間的方案與用量；空間不存在 → null。兩句（方案、SUM），不持鎖——只給預檢與顯示用，權威判定在 `assertSpaceRoomInTx`。 */
export async function readSpaceUsage(db: DbOrTx, space: StorageSpace): Promise<SpaceUsage | null> {
  const cols = { planId: storagePlans.id, planName: storagePlans.name, quotaBytes: storagePlans.quotaBytes };
  const [plan] = space.kind === "user"
    ? await db.select(cols).from(users).innerJoin(storagePlans, eq(storagePlans.id, users.storagePlanId)).where(eq(users.id, space.id))
    : await db.select(cols).from(groups).innerJoin(storagePlans, eq(storagePlans.id, groups.storagePlanId)).where(eq(groups.id, space.id));
  if (!plan) return null;
  const [row] = await db.select({ used: sumUploadSizeSql() }).from(uploads).innerJoin(notes, eq(notes.id, uploads.noteId)).where(spaceNotesWhere(space));
  return { usedBytes: row?.used ?? 0, quotaBytes: plan.quotaBytes, planId: plan.planId, planName: plan.planName };
}

/**
 * #247 §9.1：空間內上傳依 mime 分組加總，JS 端以 shared 的 `kindOfMime` 歸類（分類規則只有一份）。只給兩支用量 GET 用——
 * **不得**搬進 `readSpaceUsage`：那句也是上傳 preHandler 與複製的「已滿」預檢（熱路徑），不加 GROUP BY。
 */
export async function readSpaceUsageByKind(db: DbOrTx, space: StorageSpace): Promise<StorageByKind> {
  const rows = await db
    .select({ mime: uploads.mime, bytes: sumUploadSizeSql() })
    .from(uploads)
    .innerJoin(notes, eq(notes.id, uploads.noteId))
    .where(spaceNotesWhere(space))
    .groupBy(uploads.mime);
  const out = emptyStorageByKind();
  for (const r of rows) out[kindOfMime(r.mime)] += r.bytes;
  return out;
}

/**
 * #247 §9.2（rev 9）：群組筆記的附件依**佔用者**（`uploads.charged_to_id`：把位元組帶進群組空間的人——直接上傳＝上傳者，
 * 移入／複製進群組＝執行者）分組。佔用者帳號已刪除（on delete set null）或回滾到 v0.9 期間新建的列（NULL）彙總成
 * `userId: null` 一列——**不**用 `COALESCE(charged_to_id, uploader_id)`：佔用者已刪而上傳者仍在時會錯算給上傳者。
 * 不看是否仍是成員（已離開的人照列）。只回 bytes > 0；bytes 降冪，同 bytes 依 charged_to_id 升冪、null 最後。
 */
export async function readGroupUsageByMember(db: DbOrTx, groupId: string): Promise<GroupStorageMemberUsageDto[]> {
  const rows = await db
    .select({ userId: uploads.chargedToId, handle: users.handle, displayName: users.displayName, bytes: sumUploadSizeSql() })
    .from(uploads)
    .innerJoin(notes, eq(notes.id, uploads.noteId))
    .leftJoin(users, eq(users.id, uploads.chargedToId))
    .where(spaceNotesWhere({ kind: "group", id: groupId }))
    .groupBy(uploads.chargedToId, users.handle, users.displayName)
    .having(sql`sum(${uploads.size}) > 0`)
    .orderBy(sql`sum(${uploads.size}) desc`, sql`${uploads.chargedToId} asc nulls last`);
  return rows.map(r => ({ userId: r.userId, handle: r.handle, displayName: r.displayName, bytes: r.bytes }));
}

/**
 * 能否檢視該空間的用量數字（spec §5.4、§8.1 Q3）：個人＝本人或站台 admin；群組＝`groupAccess(...).manageGroup`（已含非成員的站台 admin）。
 * 刪群組・轉移的「接收者本人或站台 admin」就是個人空間這條（§8.1 轉移那格）。
 * `user.id` 來自 DB（恆小寫）；`space.id` 可能是路由傳入的原值，故以小寫比。
 */
export async function canViewSpaceUsage(db: Db, user: { id: string; isAdmin: boolean }, space: StorageSpace): Promise<boolean> {
  if (space.kind === "user") return user.id === space.id.toLowerCase() || user.isAdmin;
  return (await groupAccess(db, space.id, user))?.manageGroup === true;
}

/** 交易內判定被拒後（rollback 之後、交易外）組 409 的 `storage` 欄（§8.1）。可見性判定的 TOCTOU 可接受（m10）。 */
export async function quotaErrorDetail(db: Db, user: { id: string; isAdmin: boolean }, err: StorageQuotaExceeded): Promise<StorageQuotaErrorDetail> {
  return (await canViewSpaceUsage(db, user, err.space))
    ? { incomingBytes: err.incomingBytes, usedBytes: err.usedBytes, quotaBytes: err.quotaBytes }
    : { incomingBytes: err.incomingBytes };
}

/** 交易前「已滿」預檢被拒時的 `storage` 欄：`incomingBytes` 為 null（尚未量測；上傳 preHandler、複製 3a）。 */
export async function precheckDetail(db: Db, user: { id: string; isAdmin: boolean }, space: StorageSpace, usage: SpaceUsage): Promise<StorageQuotaErrorDetail> {
  return (await canViewSpaceUsage(db, user, space))
    ? { incomingBytes: null, usedBytes: usage.usedBytes, quotaBytes: usage.quotaBytes }
    : { incomingBytes: null };
}

/** 「已滿」：有上限且 used ≥ quota（上傳 preHandler、複製 3a 的同一判準——spec §6.3-1、§6.4-3a）。 */
export function isSpaceFull(usage: SpaceUsage | null): usage is SpaceUsage & { quotaBytes: number } {
  return usage !== null && usage.quotaBytes !== null && usage.usedBytes >= usage.quotaBytes;
}

/** 站台管理列表用：一次 GROUP BY 得「空間 id → 用量」；沒有附件的空間不在 Map 裡（呼叫端以 0 補）。 */
export async function listSpaceUsage(db: DbOrTx, kind: "user" | "group"): Promise<Map<string, number>> {
  const key = kind === "user" ? notes.ownerId : notes.groupId;
  const rows = await db.select({ id: key, used: sumUploadSizeSql() }).from(uploads).innerJoin(notes, eq(notes.id, uploads.noteId)).groupBy(key);
  const m = new Map<string, number>();
  for (const r of rows) if (r.id !== null) m.set(r.id, r.used);
  return m;
}
