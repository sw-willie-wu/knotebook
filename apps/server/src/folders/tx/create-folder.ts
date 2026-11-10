/**
 * 建立資料夾的交易本體（表第 1、2 列）。S14：只收 `tx`／純資料／測試縫。
 * 順序：（群組空間）groups KS → 結構鎖 →（父資料夾形）父列 KS → 重判可見性、同空間、管理權（與服務層同一個入口順序） → 深度 → 數量 → INSERT。
 * 失敗一律 throw `TxAbort`。同層撞名的 23505 不在這裡接（交易已 abort），交給服務層映射 409 `folder_name_taken`。
 * 呼叫端一律 READ COMMITTED（結構鎖之後的下一句才拿新快照，見 `lock.ts` 檔頭）。
 * 錯誤訊息在 `../messages.ts`（服務層的交易外快速路徑 import 同一份，404／403 逐位元組相同）。
 */
import { count, sql } from "drizzle-orm";
import { FOLDER_DEPTH_MAX, FOLDERS_PER_SPACE_MAX, type FolderPermissionsDto } from "@knotebook/shared";
import type { Tx } from "../../db/tx.js";
import { folders } from "../../db/schema.js";
import { GROUP_NOT_FOUND_MESSAGE } from "../../groups/queries.js";
import type { GroupHookCtx, GroupTestHook } from "../../groups/test-hook.js";
import { TxAbort } from "../../http/tx-abort.js";
import {
  FOLDER_FORBIDDEN_MESSAGE,
  FOLDER_GROUP_ROOT_FORBIDDEN_MESSAGE,
  FOLDER_LIMIT_MESSAGE,
  FOLDER_NOT_FOUND_MESSAGE,
  FOLDER_TOO_DEEP_MESSAGE,
} from "../messages.js";
import { folderPermissions } from "../permissions.js";
import type { FolderRow } from "../queries.js";
import { folderSpaceOfRow, sameFolderSpace, type FolderSpace } from "../space.js";
import { folderDepthSql, folderSpaceWhere } from "../sql.js";
import { folderAccessInTx, lockFolderInTx, lockFolderSpacesInTx, lockGroupsKeyShareInTx, memberFlagsInTx } from "./lock.js";

export interface CreateFolderInput {
  by: string;
  name: string;
  lockTimeoutMs: number;
  /** 交易外預讀的位置；space 由父資料夾或請求決定。id 皆已小寫。 */
  target: { kind: "parent"; folderId: string; space: FolderSpace } | { kind: "root"; space: FolderSpace };
}

export async function createFolderInTx(
  tx: Tx,
  input: CreateFolderInput,
  hook?: GroupTestHook,
): Promise<{ row: FolderRow; permissions: FolderPermissionsDto }> {
  const { target } = input;
  const space = target.space;
  // 以資料夾 id 進來 → folder_not_found；以群組 id 進來 → group_not_found（n-2）。
  const notFound = (): TxAbort =>
    target.kind === "parent"
      ? new TxAbort(404, "folder_not_found", FOLDER_NOT_FOUND_MESSAGE)
      : new TxAbort(404, "group_not_found", GROUP_NOT_FOUND_MESSAGE);
  const hookCtx: GroupHookCtx = {
    ...(target.kind === "parent" ? { folderId: target.folderId } : {}),
    ...(space.kind === "group" ? { groupId: space.groupId } : {}),
  };

  if (space.kind === "group") {
    const present = await lockGroupsKeyShareInTx(tx, [space.groupId]);
    if (!present.has(space.groupId)) throw notFound();
  }
  await lockFolderSpacesInTx(tx, [space], { lockTimeoutMs: input.lockTimeoutMs, ...(hook ? { hook } : {}), hookCtx });

  let permissions: FolderPermissionsDto;
  if (target.kind === "parent") {
    const parent = await lockFolderInTx(tx, target.folderId, "key share");
    if (!parent || !sameFolderSpace(folderSpaceOfRow(parent), space)) throw notFound();
    const access = await folderAccessInTx(tx, input.by, parent);
    if (access === null) throw notFound();
    if (!access.permissions.manage) throw new TxAbort(403, "forbidden", FOLDER_FORBIDDEN_MESSAGE);
    permissions = access.permissions;
    const depth = (await tx.execute<{ d: number | null }>(sql`select ${folderDepthSql(target.folderId)} as d`)).rows[0]?.d;
    if (Number(depth ?? 0) + 1 > FOLDER_DEPTH_MAX) throw new TxAbort(409, "folder_too_deep", FOLDER_TOO_DEEP_MESSAGE);
  } else {
    const flags = space.kind === "group" ? await memberFlagsInTx(tx, input.by, space.groupId) : null;
    const perms = folderPermissions(space, input.by, flags);
    if (perms === null) throw notFound();
    if (!perms.manage) throw new TxAbort(403, "forbidden", FOLDER_GROUP_ROOT_FORBIDDEN_MESSAGE);
    permissions = perms;
  }

  const [counted] = await tx.select({ n: count() }).from(folders).where(folderSpaceWhere(space));
  if ((counted?.n ?? 0) >= FOLDERS_PER_SPACE_MAX) throw new TxAbort(409, "folder_limit", FOLDER_LIMIT_MESSAGE);

  const [row] = await tx
    .insert(folders)
    .values({
      kind: space.kind,
      ownerId: space.kind === "group" ? null : space.ownerId,
      groupId: space.kind === "group" ? space.groupId : null,
      parentId: target.kind === "parent" ? target.folderId : null,
      name: input.name,
      createdBy: input.by,
    })
    .returning();
  return { row: row!, permissions };
}
