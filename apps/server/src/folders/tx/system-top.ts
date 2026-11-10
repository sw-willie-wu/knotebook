/**
 * 刪群組轉移的新頂層（系統代建名）。S14：只收 `tx`／純資料。
 * 呼叫端（`transferGroupInTx`）必持接收者個人空間的結構鎖：改名、建立、照路徑重建也取同一把，探測與 INSERT 之間不會被搶名、不撞 23505。
 */
import { and, isNull, sql } from "drizzle-orm";
import { FOLDERS_PER_SPACE_MAX } from "@knotebook/shared";
import type { Tx } from "../../db/tx.js";
import { folders } from "../../db/schema.js";
import { folderNameWithSuffix } from "../names.js";
import { folderSpaceWhere } from "../sql.js";

/**
 * 接收者個人根層建系統資料夾：n = 1, 2, … 試 `folderNameWithSuffix(baseName, n)`，以 SQL `lower()` 比對同層（與同層唯一索引同一個）；
 * 空的就 INSERT（`created_by = by`）。baseName 由呼叫端先過 `normalizeFolderNameLoose`。不檢查深度與數量上限。
 * 至多 `FOLDERS_PER_SPACE_MAX + 2` 次，用完 throw（實務上不可能：系統代建不受數量上限，但根層要先累積這麼多同基名的資料夾）。回實際寫入的名稱（含尾碼）。
 */
export async function createSystemTopFolderInTx(tx: Tx, input: { ownerId: string; baseName: string; by: string }): Promise<{ id: string; name: string }> {
  for (let n = 1; n <= FOLDERS_PER_SPACE_MAX + 2; n++) {
    const name = folderNameWithSuffix(input.baseName, n);
    const [taken] = await tx
      .select({ id: folders.id })
      .from(folders)
      .where(and(
        folderSpaceWhere({ kind: "personal", ownerId: input.ownerId }),
        isNull(folders.parentId),
        sql`lower(${folders.name}) = lower(${name})`,
      ))
      .limit(1);
    if (taken) continue;
    const [row] = await tx
      .insert(folders)
      .values({ kind: "personal", ownerId: input.ownerId, groupId: null, parentId: null, name, createdBy: input.by })
      .returning({ id: folders.id, name: folders.name });
    return { id: row!.id, name: row!.name };
  }
  throw new Error("createSystemTopFolderInTx: 尾碼探測用完");
}
