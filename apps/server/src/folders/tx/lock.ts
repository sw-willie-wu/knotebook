/**
 * 資料夾交易的鎖與交易內讀取。S14：只收 `tx`／純資料／測試縫。
 * 全域鎖序：① groups 列鎖 → ② 結構鎖（依鍵字串）→ ③ 資料夾列（依 id）→ ④ 筆記列 → ⑤ 容量 advisory 鎖；呼叫端照序呼叫。
 * 結構鎖形同 `storage/tx/quota.ts`：每把鍵三句——`set_config('lock_timeout', …, true)` → `pg_advisory_xact_lock`（單獨一句；
 * 等太久 → 55P03，路由映射 409 server_busy）→ `set local lock_timeout to default`。鍵前綴 `knotebook.folders:`，與容量鎖的
 * `knotebook.storage:` 不共用 key 空間。
 * 呼叫結構鎖的交易一律 READ COMMITTED（比照 quota.ts）：取鎖之後的下一句才拿新快照，看得到前一位持鎖者已 commit 的資料夾；
 * REPEATABLE READ 下快照在第一句就定了，深度／成環／撞名檢查會讀到舊樹。
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { folders, groupMembers, groupRoles, groups } from "../../db/schema.js";
import type { GroupHookCtx, GroupTestHook } from "../../groups/test-hook.js";
import type { FolderRoleFlags } from "../permissions.js";
import { folderAccessOf, type FolderAccess, type FolderRow } from "../queries.js";
import { folderSpaceOfRow, sortedSpaceLockKeys, type FolderSpace } from "../space.js";

/** 一句 `select id from groups where id in (…) order by id for key share`；回實際存在的 id。空陣列不發語句。 */
export async function lockGroupsKeyShareInTx(tx: Tx, groupIds: readonly string[]): Promise<Set<string>> {
  if (groupIds.length === 0) return new Set();
  const rows = await tx.select({ id: groups.id }).from(groups).where(inArray(groups.id, [...groupIds])).orderBy(asc(groups.id)).for("key share");
  return new Set(rows.map(r => r.id));
}

export interface FolderSpaceLockOpts {
  /** 每把鍵取鎖那一句的等待上限（ms）；正整數。沿用 `storageLockTimeoutMs`，由呼叫端帶入（純資料）。 */
  lockTimeoutMs: number;
  /** 測試縫（生產不注入）：取完所有鍵之後以 `"folder-structure-locked"` 觸發一次。 */
  hook?: GroupTestHook;
  hookCtx?: GroupHookCtx;
}

/** 依 `sortedSpaceLockKeys` 逐把取結構鎖，全部取完呼叫縫一次。鍵空 → 不發任何語句、不呼叫縫。 */
export async function lockFolderSpacesInTx(tx: Tx, spaces: readonly FolderSpace[], opts: FolderSpaceLockOpts): Promise<void> {
  const keys = sortedSpaceLockKeys(spaces);
  if (keys.length === 0) return;
  if (!Number.isInteger(opts.lockTimeoutMs) || opts.lockTimeoutMs <= 0) {
    throw new Error(`lockFolderSpacesInTx: lockTimeoutMs 必須是正整數（收到 ${opts.lockTimeoutMs}）`);
  }
  for (const key of keys) {
    await tx.execute(sql`select set_config('lock_timeout', ${`${opts.lockTimeoutMs}ms`}::text, true)`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}::text, 0))`);
    await tx.execute(sql`set local lock_timeout to default`);
  }
  await opts.hook?.("folder-structure-locked", opts.hookCtx ?? {});
}

/** 單表 `select … from folders where id = $f for key share|for update`（LEFT JOIN 不能同句加列鎖）。 */
export async function lockFolderInTx(tx: Tx, folderId: string, strength: "key share" | "update"): Promise<FolderRow | undefined> {
  const [row] = await tx.select().from(folders).where(eq(folders.id, folderId)).for(strength);
  return row;
}

/** 群組角色旗標（以 tx 讀、不鎖；呼叫端已持 groups KS，成員資格穩定）。非成員 → null。 */
export async function memberFlagsInTx(tx: Tx, userId: string, groupId: string): Promise<FolderRoleFlags | null> {
  const [row] = await tx
    .select({ canRead: groupRoles.canRead, canCreate: groupRoles.canCreate, canEdit: groupRoles.canEdit, canDelete: groupRoles.canDelete })
    .from(groupMembers)
    .innerJoin(groupRoles, eq(groupRoles.id, groupMembers.roleId))
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)))
    .limit(1);
  return row ?? null;
}

/** 交易內的資料夾可見性與權限（與 `folderAccessFromRow` 同一個推導 `folderAccessOf`）。看不到 → null。 */
export async function folderAccessInTx(tx: Tx, userId: string, folder: FolderRow): Promise<FolderAccess | null> {
  const space = folderSpaceOfRow(folder);
  const flags = space.kind === "group" ? await memberFlagsInTx(tx, userId, space.groupId) : null;
  return folderAccessOf(folder, flags, userId);
}
