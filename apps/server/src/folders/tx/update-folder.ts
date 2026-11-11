/**
 * 改名／搬資料夾的交易本體。
 * S14：只收 `tx`／純資料／測試縫。搬移只限同空間。
 * 順序：（群組空間）groups KS → 結構鎖 → 自己（帶 `name` → `FOR UPDATE`；只搬 → 一般讀；UPDATE `parent_id` 取的是
 * NO KEY UPDATE，不必擋住對它的放置）→ 自己的可見性 →（搬到資料夾底下）新父層 KS → 新父層的可見性 → 同空間 → 管理權
 * →（搬移）成環 → 深度 → UPDATE。值都沒變 → 不發 UPDATE（`changed: false`）。
 * 失敗一律 throw `TxAbort`。同層撞名的 23505 交給服務層映射 409 `folder_name_taken`。呼叫端一律 READ COMMITTED（`lock.ts` 檔頭）。
 */
import { eq, sql } from "drizzle-orm";
import { FOLDER_DEPTH_MAX, type FolderPermissionsDto } from "@knotebook/shared";
import type { Tx } from "../../db/tx.js";
import { folders } from "../../db/schema.js";
import type { GroupHookCtx, GroupTestHook } from "../../groups/test-hook.js";
import { TxAbort } from "../../http/tx-abort.js";
import {
  FOLDER_CROSS_SPACE_MESSAGE,
  FOLDER_CYCLE_MESSAGE,
  FOLDER_FORBIDDEN_MESSAGE,
  FOLDER_NOT_FOUND_MESSAGE,
  FOLDER_TOO_DEEP_MESSAGE,
} from "../messages.js";
import type { FolderRow } from "../queries.js";
import { folderSpaceOfRow, sameFolderSpace, type FolderSpace } from "../space.js";
import { folderAncestorIdsSql, folderDepthSql, subtreeHeightSql } from "../sql.js";
import { folderAccessInTx, lockFolderInTx, lockFolderSpacesInTx, lockGroupsKeyShareInTx } from "./lock.js";

export interface UpdateFolderInput {
  by: string;
  /** 交易外預讀的資料夾 id 與空間；id 皆已小寫。 */
  folderId: string;
  space: FolderSpace;
  /** 已正規化（`normalizeFolderName`）。undefined＝不改名。 */
  name?: string;
  /** undefined＝不搬；null＝根層。 */
  parentId?: string | null;
  lockTimeoutMs: number;
}

export async function updateFolderInTx(
  tx: Tx,
  input: UpdateFolderInput,
  hook?: GroupTestHook,
): Promise<{ row: FolderRow; permissions: FolderPermissionsDto; changed: boolean }> {
  const { space } = input;
  const notFound = (): TxAbort => new TxAbort(404, "folder_not_found", FOLDER_NOT_FOUND_MESSAGE);
  const hookCtx: GroupHookCtx = { folderId: input.folderId, ...(space.kind === "group" ? { groupId: space.groupId } : {}) };

  if (space.kind === "group") {
    const present = await lockGroupsKeyShareInTx(tx, [space.groupId]);
    if (!present.has(space.groupId)) throw notFound();
  }
  await lockFolderSpacesInTx(tx, [space], { lockTimeoutMs: input.lockTimeoutMs, ...(hook ? { hook } : {}), hookCtx });

  const self = input.name !== undefined
    ? await lockFolderInTx(tx, input.folderId, "update")
    : (await tx.select().from(folders).where(eq(folders.id, input.folderId)))[0];
  if (!self || !sameFolderSpace(folderSpaceOfRow(self), space)) throw notFound();
  const access = await folderAccessInTx(tx, input.by, self);
  if (access === null) throw notFound();

  // 搬到原父層＝不搬（不檢查深度：轉移造出的超深樹照常能改名；深度只在建立、搬移時檢查）。
  const moving = input.parentId !== undefined && input.parentId !== self.parentId;
  // 兩者的可見性（看不到＝不存在，即使同時也跨空間）→ 同空間 → 管理權 → 成環 → 深度。
  if (moving && input.parentId !== null && input.parentId !== undefined) {
    const parent = await lockFolderInTx(tx, input.parentId, "key share");
    if (!parent || (await folderAccessInTx(tx, input.by, parent)) === null) throw notFound();
    if (!sameFolderSpace(folderSpaceOfRow(parent), space)) throw new TxAbort(400, "folder_cross_space", FOLDER_CROSS_SPACE_MESSAGE);
  }
  if (!access.permissions.manage) throw new TxAbort(403, "forbidden", FOLDER_FORBIDDEN_MESSAGE);
  if (moving) {
    let parentDepth = 0;
    if (input.parentId !== null && input.parentId !== undefined) {
      const cycle = await tx.execute<{ hit: boolean }>(
        sql`select exists (${folderAncestorIdsSql(input.parentId)} where kf_anc_ids.id = ${self.id}::uuid) as hit`,
      );
      if (cycle.rows[0]?.hit) throw new TxAbort(409, "folder_cycle", FOLDER_CYCLE_MESSAGE);
      parentDepth = Number((await tx.execute<{ d: number | null }>(sql`select ${folderDepthSql(input.parentId)} as d`)).rows[0]?.d ?? 0);
    }
    const height = Number((await tx.execute<{ h: number | null }>(sql`select ${subtreeHeightSql(self.id)} as h`)).rows[0]?.h ?? 1);
    if (parentDepth + height > FOLDER_DEPTH_MAX) throw new TxAbort(409, "folder_too_deep", FOLDER_TOO_DEEP_MESSAGE);
  }

  const set: { name?: string; parentId?: string | null } = {
    ...(input.name !== undefined && input.name !== self.name ? { name: input.name } : {}),
    ...(moving ? { parentId: input.parentId ?? null } : {}),
  };
  if (Object.keys(set).length === 0) return { row: self, permissions: access.permissions, changed: false };
  const [row] = await tx.update(folders).set(set).where(eq(folders.id, self.id)).returning();
  return { row: row!, permissions: access.permissions, changed: true };
}
