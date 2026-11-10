/**
 * 還原的照路徑重建。S14：只收 `tx`／純資料。
 * 呼叫端（`restoreNotesInTx`）必持該空間的結構鎖：改名、建立也取同一把，所以「找不到 → INSERT」之間不會被搶名、不撞 23505。
 */
import { and, asc, sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { folders } from "../../db/schema.js";
import type { FolderSpace } from "../space.js";
import { folderSpaceWhere } from "../sql.js";

/**
 * 由根到葉逐層 `select id from folders where <space> and parent_id is not distinct from $p and lower(name) = lower($seg)
 * order by id limit 1`；沒有就 INSERT（`created_by = by`）。比對在 SQL 以 `lower()`（與同層唯一索引同一個）；段名由呼叫端先做 NFC。
 * **不檢查深度與數量上限**（還原不因上限失敗）。segments 不得為空。回葉 id。
 */
export async function ensureFolderPathInTx(tx: Tx, space: FolderSpace, segments: readonly string[], by: string): Promise<string> {
  if (segments.length === 0) throw new Error("ensureFolderPathInTx: segments 不得為空");
  let parentId: string | null = null;
  for (const seg of segments) {
    const [hit]: Array<{ id: string }> = await tx
      .select({ id: folders.id })
      .from(folders)
      .where(and(
        folderSpaceWhere(space),
        sql`${folders.parentId} is not distinct from ${parentId}::uuid`,
        sql`lower(${folders.name}) = lower(${seg})`,
      ))
      .orderBy(asc(folders.id))
      .limit(1);
    if (hit) {
      parentId = hit.id;
      continue;
    }
    const [row]: Array<{ id: string }> = await tx
      .insert(folders)
      .values({
        kind: space.kind,
        ownerId: space.kind === "group" ? null : space.ownerId,
        groupId: space.kind === "group" ? space.groupId : null,
        parentId,
        name: seg,
        createdBy: by,
      })
      .returning({ id: folders.id });
    parentId = row!.id;
  }
  return parentId!;
}
