/**
 * 資料夾的 SQL 片段。只組不執行、每次呼叫現造，
 * 不 import `Db`。遞迴 CTE 各用自己的名字（`kf_*`），同一句裡並用也不撞名。
 * 成環由結構鎖內的應用層擋，DB 不守；每支遞迴 CTE 另以 `FOLDER_CTE_DEPTH_LIMIT` 封頂，萬一出現環也會結束。
 */
import { sql, type SQL } from "drizzle-orm";
import { FOLDER_DEPTH_MAX } from "@knotebook/shared";
import { folders } from "../db/schema.js";
import type { FolderSpace } from "./space.js";

/**
 * 遞迴 CTE 最多走的層數（含起點）。正常可達的最深是 `FOLDER_DEPTH_MAX + 1`（刪群組轉移多套一層新頂層；照路徑重建不超過快照長度），
 * 取 4 倍留寬裕：合法的樹永遠不會被截，成環時每支查詢最多走這麼多層就停。
 * ⚠ 超過上限的結果是**靜默截斷**、不完整（path 少掉根端、subtree 少掉深處子孫）——合法的樹到不了這裡；真的遇到就是成環或超深，
 * 不變量已破。呼叫端（例如刪資料夾）不得假設截斷後的 subtree 仍完整。
 */
export const FOLDER_CTE_DEPTH_LIMIT = FOLDER_DEPTH_MAX * 4;
const LIMIT = (): SQL => sql.raw(String(FOLDER_CTE_DEPTH_LIMIT));

/**
 * 外層筆記的 `folder_id` 引用：相關子查詢裡一律帶表名字面。drizzle 0.44 在單表 SELECT 把直接插進 template 的欄位渲染成裸
 * `"folder_id"`（單表 UPDATE 則帶表名）。
 */
export const NOTES_FOLDER_ID = (): SQL => sql.raw('"notes"."folder_id"');

/** 根 → 葉的名稱 jsonb 陣列；`outer` 為 NULL（根層）→ NULL。相關遞迴 CTE，可放進 `UPDATE notes SET trash_folder_path = …`。 */
export function folderPathJsonSql(outer: SQL): SQL<string[] | null> {
  return sql<string[] | null>`(with recursive kf_up(id, parent_id, name, d) as (
    select f.id, f.parent_id, f.name, 0 from ${folders} f where f.id = ${outer}
    union all
    select p.id, p.parent_id, p.name, kf_up.d + 1 from ${folders} p join kf_up on p.id = kf_up.parent_id where kf_up.d + 1 < ${LIMIT()}
  ) select jsonb_agg(kf_up.name order by kf_up.d desc) from kf_up)`;
}

/** `rootId` 本身＋所有子孫的 id（`select id from (…)`），可放 `IN (…)`。 */
export function subtreeFolderIdsSql(rootId: string): SQL {
  return sql`select kf_sub_ids.id from (with recursive kf_sub(id, lvl) as (
    select f.id, 1 from ${folders} f where f.id = ${rootId}::uuid
    union all
    select c.id, kf_sub.lvl + 1 from ${folders} c join kf_sub on c.parent_id = kf_sub.id where kf_sub.lvl < ${LIMIT()}
  ) select kf_sub.id from kf_sub) kf_sub_ids`;
}

/** 深度：根層資料夾 = 1；不存在 → NULL。 */
export function folderDepthSql(folderId: string): SQL<number> {
  return sql<number>`(with recursive kf_depth(id, parent_id, d) as (
    select f.id, f.parent_id, 1 from ${folders} f where f.id = ${folderId}::uuid
    union all
    select p.id, p.parent_id, kf_depth.d + 1 from ${folders} p join kf_depth on p.id = kf_depth.parent_id where kf_depth.d < ${LIMIT()}
  ) select max(kf_depth.d) from kf_depth)`;
}

/** 子樹高度：單一資料夾 = 1；不存在 → NULL。 */
export function subtreeHeightSql(rootId: string): SQL<number> {
  return sql<number>`(with recursive kf_height(id, h) as (
    select f.id, 1 from ${folders} f where f.id = ${rootId}::uuid
    union all
    select c.id, kf_height.h + 1 from ${folders} c join kf_height on c.parent_id = kf_height.id where kf_height.h < ${LIMIT()}
  ) select max(kf_height.h) from kf_height)`;
}

/** `folderId` 本身＋所有祖先的 id（`select id from (…)`），可放 `IN (…)`。 */
export function folderAncestorIdsSql(folderId: string): SQL {
  return sql`select kf_anc_ids.id from (with recursive kf_anc(id, parent_id, lvl) as (
    select f.id, f.parent_id, 1 from ${folders} f where f.id = ${folderId}::uuid
    union all
    select p.id, p.parent_id, kf_anc.lvl + 1 from ${folders} p join kf_anc on p.id = kf_anc.parent_id where kf_anc.lvl < ${LIMIT()}
  ) select kf_anc.id from kf_anc) kf_anc_ids`;
}

/** `folders` 表上「屬於這個空間」的述詞。 */
export function folderSpaceWhere(space: FolderSpace): SQL {
  return space.kind === "group"
    ? sql`(${folders.kind} = 'group' and ${folders.groupId} = ${space.groupId}::uuid)`
    : sql`(${folders.kind} = ${space.kind} and ${folders.ownerId} = ${space.ownerId}::uuid)`;
}
